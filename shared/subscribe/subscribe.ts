import { candidateKey, splitSourceId } from './memberKey.ts'
import type { Candidate, ChannelSummary, StreamCreateBody, SubscribeTransport } from './types.ts'

/**
 * Deterministic Stream id from the candidate.
 *
 * 后缀是用来区分**同一个源被订阅多次**的（同一个视频站的两个 UP 主 uid、两个歌单）。有两种情况它
 * 区分不了任何东西、只留下一条多余的尾巴——而尾巴一旦进了 id 就是这条流的永久身份，
 * 改不动也认不出：
 *
 * ① **这个源没有参数**：它只可能有一条流，`slug` 自己就唯一。原来会拼出 `-x`
 *    （`douyin-collection-x`），等于给同一个源造了第二个主人。
 * ② **参数值已经被源 id 含着**：`douyin-follow` + `{mode:'follow'}` → `douyin-follow-follow`。
 *    库里那 500 行无主残骸就是这么来的（另有 100 行 `douyin-collection-collection`）。
 *    这条判据前端修过一次（`7ace9d13`），**逻辑搬进 shared/ 的时候判据没跟过来**——所以它
 *    换了个样子活到今天：`{mode:'collection'}` 现在拼的是 `douyin-collection-ection`。
 */
function streamIdFor(candidate: Candidate): string {
  const slug = slugOf(candidate.sourceId)
  const keyish = Object.values(candidate.params).join('-').replace(/[^\w-]+/g, '').slice(-6)
  if (!keyish || slug.includes(keyish)) return slug
  return `${slug}-${keyish}`
}

/**
 * 一个 sourceId → 这条流 id 里那截可读的名字。**24 字符的预算只留给源自己的名字**，
 * 不给命名空间前缀。
 *
 * 为什么必须先剥前缀：全名是 `<npm 包名>/<局部名>`，前缀能吃掉整个预算——
 * `@streamapp/builtin/article-defuddle` 与 `@streamapp/builtin/article-readability`
 * 截断到 24 字符后是**同一个** slug，无参数时（`keyish` 为空）两者就铸出同一个 stream id，
 * 第二次订阅 409 撞上第一条流。那是静默的归属错误，不是崩溃。
 *
 * 怎么剥而不误伤 catalog：**含 `:` 的是 catalog id**（`rsshub:<ns>/search/:keyword`），
 * 走老路——剥掉 `plugin:` 前缀、其余整段做 slug；不含 `:` 的是全名或裸名，取最后一段
 * （局部名不含 `/`，见 registry/source-id.ts）。两族分得干净，而且裸名与旧的
 * `plugin:裸名` 两种形态铸出的 id 与命名空间化之前逐字符相同——存量流的 id 一个都没变。
 */
function slugOf(sourceId: string): string {
  const name = sourceId.includes(':')
    ? splitSourceId(sourceId).templateId
    : sourceId.slice(sourceId.lastIndexOf('/') + 1)
  return name.replace(/[^\w-]+/g, '-').slice(0, 24) || 'src'
}

/** T1 harvest policy applied to every freshly-subscribed Stream: pull the deep backfill on the
 *  first harvest (dedup-count 0), then a shallow incremental page each tick after. Without this,
 *  a new Stream has no policy → scheduler injects no `limit` → RSSHub's default page (~50) becomes
 *  the backfill depth. Users tune it in StreamSettingSheet「更多设置」. */
export const DEFAULT_HARVEST = { backfillLimit: 1000, incrementalLimit: 50 } as const

export function buildStreamCreate(candidate: Candidate): StreamCreateBody {
  const { pluginId, templateId } = splitSourceId(candidate.sourceId)
  const slug = slugOf(candidate.sourceId)
  return {
    id: streamIdFor(candidate),
    label: candidate.title || `${pluginId}:${templateId}`, // placeholder; overwritten on first harvest
    strategy: 'fanout',
    cadence_seconds: 1800,
    members: [{ plugin: pluginId, source: templateId, params: candidate.params }],
    options: { vault_subdir: slug, labelAuto: true, harvest: { ...DEFAULT_HARVEST } },
  }
}

/** Subscribe a candidate to a channel by composing existing endpoints.
 *  - No-op (created:false) when the candidate's memberKey is already reachable from THIS channel.
 *  - When the same member already exists on ANOTHER channel, its Stream is SHARED: attach the
 *    existing streamId to this channel (created:false) instead of creating a duplicate. The
 *    Stream id is deterministic from the candidate, so a blind create would 409; this also makes
 *    the shared-Stream state (which unsubscribe's 0-ref GC is built around) actually reachable.
 *  - Otherwise create a fresh single-member Stream **already bound to the channel** (created:true).
 *  `allChannels` defaults to just this channel (single-channel callers keep working). */
export async function subscribe(
  t: SubscribeTransport, candidate: Candidate, channel: ChannelSummary, allChannels: ChannelSummary[] = [channel],
): Promise<{ streamId: string; created: boolean }> {
  const key = candidateKey(candidate.sourceId, candidate.params)
  const here = channel.members.find((m) => m.key === key)
  if (here) return { streamId: here.streamId, created: false }
  const elsewhere = allChannels.flatMap((c) => c.members).find((m) => m.key === key)
  if (elsewhere) {
    if (!channel.streamIds.includes(elsewhere.streamId)) {
      await t.setChannelStreams(channel.id, [...channel.streamIds, elsewhere.streamId])
    }
    return { streamId: elsewhere.streamId, created: false }
  }
  // 建流 + 绑频道是**一次**请求：拆成两步的话，第一步那一刻这条流不属于任何频道，后端据此
  // 判它为采集流并当场抓一次（归 research 这类 live present 频道的流因此仍会落一次库）。
  const { id } = await t.createStream({ ...buildStreamCreate(candidate), channel_id: channel.id })
  return { streamId: id, created: true }
}

/** Unsubscribe = remove the Stream ref from the current channel; if no other channel still
 *  references it, delete the Stream (GC). Mirrors ChannelsPage.confirmStreamDelete. */
export async function unsubscribe(
  t: SubscribeTransport, candidate: Candidate, channel: ChannelSummary, allChannels: ChannelSummary[],
): Promise<{ removed: boolean; deleted: boolean }> {
  const key = candidateKey(candidate.sourceId, candidate.params)
  const hit = channel.members.find((m) => m.key === key)
  if (!hit) return { removed: false, deleted: false }
  const nextIds = channel.streamIds.filter((id) => id !== hit.streamId)
  await t.setChannelStreams(channel.id, nextIds)
  const orphan = !allChannels.some(
    (c) => c.id !== channel.id && c.streamIds.includes(hit.streamId),
  )
  if (orphan) await t.deleteStream(hit.streamId)
  return { removed: true, deleted: orphan }
}
