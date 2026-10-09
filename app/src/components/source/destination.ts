import { api } from '../../lib/api.ts'
import type { Connection } from '../../lib/api.ts'
import type { ProviderView, ChannelView, SourceDetail, StreamCreate, ProviderMemberRef, StreamMember } from '../../lib/types.ts'
import { sourceSlug } from '../../lib/source.ts'

/** The slice of a Stream/ChannelStream this module needs: id + its member projection.
 *  Both `Stream` and `ChannelStream` satisfy it, so callers pass either verbatim. */
export type StreamLike = { id: string; description?: string; sources: (StreamMember | RawOrNestedMember)[] }

export type ConfigTarget =
  | { kind: 'pick' }
  | { kind: 'stream'; streamId: string; memberIndex?: number }
  | { kind: 'provider'; providerId: string; memberIndex?: number }

export type ResolvedDestination =
  | { action: 'create-stream'; channelId: string }
  | { action: 'append-stream'; streamId: string }
  | { action: 'append-provider'; providerId: string }
  | { action: 'edit-stream-member'; streamId: string; memberIndex: number }
  | { action: 'edit-provider-member'; providerId: string; memberIndex: number }

export function initialDestination(t: ConfigTarget): ResolvedDestination | null {
  if (t.kind === 'pick') return null
  if (t.kind === 'stream')
    return t.memberIndex === undefined
      ? { action: 'append-stream', streamId: t.streamId }
      : { action: 'edit-stream-member', streamId: t.streamId, memberIndex: t.memberIndex }
  return t.memberIndex === undefined
    ? { action: 'append-provider', providerId: t.providerId }
    : { action: 'edit-provider-member', providerId: t.providerId, memberIndex: t.memberIndex }
}

/**
 * Reconstruct the raw `{plugin,source,params}` write shape from a Stream's members.
 *
 * **两个端点吐的成员形状不一样，这里必须两种都认**：
 *
 * - `/api/channels`（频道视图）→ 嵌套的 `{ source: {id,pluginId}, params }`。「添加来源」走它。
 * - `/api/streams`（订阅原样）→ 扁的 `{ plugin_id, source_template_id, params }`。整理向导走它。
 *
 * 只认嵌套那种时，扁的那种是**运行时 TypeError**——而类型检查一声不吭，因为 `Stream.sources`
 * 的类型描述的是嵌套形状，与 `/api/streams` 的实际返回不符。活体后果（2026-08-05 撞到）：整理
 * 向导保存到一半整条链断掉，界面只说「保存失败」，而目录和绑定都已经建出来了，还留下孤儿绑定
 * （回滚只兜更后面的 putConfig 那一步）。
 */
export function streamRawMembers(s: StreamLike): StreamCreate['members'] {
  return s.sources.map((m) => ({ plugin: memberPlugin(m), source: memberSource(m), params: m.params }))
}

/** 成员的插件 id，两种形状通吃。 */
export function memberPlugin(m: RawOrNestedMember): string {
  return m.source?.pluginId ?? m.plugin_id ?? ''
}

/** 成员的 source id，两种形状通吃。 */
export function memberSource(m: RawOrNestedMember): string {
  return m.source?.id ?? m.source_template_id ?? ''
}

/** 上面两个端点各自的成员形状的并集。字段全可选——判形状靠取值，不靠 discriminator。 */
export type RawOrNestedMember = {
  source?: { id: string; pluginId: string }
  plugin_id?: string
  source_template_id?: string
  params: Record<string, unknown>
}

/** Build the full members array for appending an alist-audio netdisk directory as a source to a
 *  playlist stream, preserving every existing member — `PATCH /api/streams/:id` overwrites members
 *  wholesale, so dropping this would silently unsubscribe the stream's existing sources.
 *
 *  `{plugin:'alist', source:'alist-audio'}` 是宿主网盘底座的离线成员——领域模型，不是按站分支
 *  （`docs/PACKAGE.md` "The host/package boundary"豁免栏）。前端的**分支**一律按 `/api/packages` 的 `role`。 */
export function buildNetdiskMountMembers(stream: StreamLike, path: string): StreamCreate['members'] {
  return [...streamRawMembers(stream), { plugin: 'alist', source: 'alist-audio', params: { path } }]
}

/**
 * Append a netdisk directory to a stream as an `alist-audio` source.
 *
 * **这不是用户「把网盘目录当节目源订阅」走的路**——那是普通的「添加来源」（挑 `alist-audio`
 * 源、填 `path`，走 `submitDestination`）。这里剩下的唯一调用方是**整理的建立向导**：它替
 * 用户把「下架」目录配成订阅的一条来源（下架集本身就是一条扫网盘目录的 stream, spec §6 P8），
 * 用户并没有在挑源，所以走不了那条通用入口。
 *
 * 住在这个叶子模块而不是某个界面组件里，是因为它写的成员表形状（`streamRawMembers` 的两种
 * 成员形状通吃）和通用入口是同一份；搬进界面组件会让整理向导反过来 import 那个界面。
 */
export async function mountNetdiskDir(conn: Connection, stream: StreamLike, path: string): Promise<void> {
  await api.patchStreamMembers(conn, stream.id, buildNetdiskMountMembers(stream, path))
}

export type SubmitArgs = {
  conn: Connection
  source: SourceDetail
  dest: ResolvedDestination
  name: string
  /** Provider 成员的**实例名**（寻址键）。同一个源带不同 params 多次进一条梯子时必须有它
   *  （perInstance 源就是这种）；不传 = 沿用旧形状，键仍是 source id。与 `name`（Stream 显示名）
   *  是两回事，别合并。 */
  memberName?: string
  params: Record<string, string>
  streams: StreamLike[]
  providers: ProviderView[]
  channels: ChannelView[]
}

export async function submitDestination(a: SubmitArgs): Promise<void> {
  const { conn, source, dest, params } = a
  const streamMember = { plugin: source.pluginId, source: source.id, params }
  const providerMember: ProviderMemberRef = { source: source.id, ...(a.memberName ? { name: a.memberName } : {}), params }

  switch (dest.action) {
    case 'create-stream': {
      const ch = a.channels.find((c) => c.id === dest.channelId)
      if (!ch) throw new Error('channel not found')
      const slug = sourceSlug(source.id)
      const streamId = slug + '-' + Math.random().toString(36).slice(2, 7)
      await api.subscribe(conn, {
        id: streamId,
        label: a.name || source.id,
        strategy: 'fanout',
        // 2d 默认采集周期（172800s）——与后端其它新建路径（agent/intent/一键关注）保持一致
        cadence_seconds: 172800,
        members: [streamMember],
        options: { vault_subdir: slug },
        // Consumption mode (audio vs timeline) is derived from Channel.present — this binding
        // IS what makes it an audio stream. No kind stamp.
        //
        // 归属随建流一起提交，不是建完再 PATCH 频道：拆成两步的话，中间那一刻这条流不属于任何
        // 频道，后端据此判它为采集流并当场抓一次——归 live present 频道的流会因此落一次库。
        channel_id: ch.id,
      })
      return
    }
    case 'append-stream': {
      const s = a.streams.find((x) => x.id === dest.streamId)
      if (!s) throw new Error('stream not found')
      await api.patchStreamMembers(conn, s.id, [...streamRawMembers(s), streamMember])
      return
    }
    case 'edit-stream-member': {
      const s = a.streams.find((x) => x.id === dest.streamId)
      if (!s) throw new Error('stream not found')
      const members = streamRawMembers(s)
      members[dest.memberIndex] = streamMember
      await api.patchStreamMembers(conn, s.id, members)
      return
    }
    case 'append-provider': {
      const p = a.providers.find((x) => x.id === dest.providerId)
      if (!p) throw new Error('provider not found')
      await api.patchProvider(conn, p.id, { members: [...p.members, providerMember] })
      return
    }
    case 'edit-provider-member': {
      const p = a.providers.find((x) => x.id === dest.providerId)
      if (!p) throw new Error('provider not found')
      // 只换 params：成员的实例名（name）是这一档的寻址键（exclude/reorder/调用账本都按它），
      // 重建时丢掉它 = 静默把这档改名，用户的排除项和计数会当场对不上。
      const members = p.members.map((m, i) =>
        i === dest.memberIndex && 'source' in m
          ? { source: m.source, ...(m.name ? { name: m.name } : {}), params }
          : m)
      await api.patchProvider(conn, p.id, { members })
      return
    }
  }
}
