import { describe, expect, it, vi, beforeEach } from 'vitest'
import { api } from '../../lib/api.ts'
import { initialDestination, streamRawMembers, submitDestination } from './destination.ts'
import type { SourceDetail, Stream, ProviderView, ChannelView } from '../../lib/types.ts'

const conn = { baseUrl: '', token: undefined } as const
const source = { id: 'rsshub:foo', pluginId: 'rsshub', title: 'Foo', paramsSchema: {} } as unknown as SourceDetail
const channel = (id: string, kind: 'timeline' | 'audio', streamIds: string[] = []): ChannelView => ({
  id, label: id, kind, streams: streamIds.map((sid) => ({ id: sid })),
} as unknown as ChannelView)
const stream = (id: string): Stream => ({
  id, description: id, cadence_seconds: 1800, vault_subdir: id,
  sources: [{ source: { id: 'rsshub:old', pluginId: 'rsshub' } as never, params: { a: '1' } }],
} as unknown as Stream)
const provider = (id: string): ProviderView => ({
  id, label: id, variant: 'search', serves: [], strategy: 'concurrent', status: 'live',
  callSites: [], members: [{ source: 'old', params: { a: '1' } }],
  resolvedMembers: [{ name: 'old', priority: 1, health: 'unknown', source: { id: 'old' } as never }],
  calls: { total: 0, byMember: {}, lastCalledAt: null }, options: {},
} as unknown as ProviderView)

beforeEach(() => vi.restoreAllMocks())

describe('initialDestination', () => {
  it('pick → null (needs user choice)', () => expect(initialDestination({ kind: 'pick' })).toBeNull())
  it('stream + idx → edit', () => expect(initialDestination({ kind: 'stream', streamId: 's', memberIndex: 2 }))
    .toEqual({ action: 'edit-stream-member', streamId: 's', memberIndex: 2 }))
  it('provider no idx → append', () => expect(initialDestination({ kind: 'provider', providerId: 'p' }))
    .toEqual({ action: 'append-provider', providerId: 'p' }))
})

/**
 * **两个端点吐的成员形状不一样**，而这个模块两边都被调用：
 *
 * - `/api/channels`（频道视图）→ 成员是嵌套的 `{ source: {...}, params }`；「添加来源」走它。
 * - `/api/streams`（订阅原样）→ 成员是扁的 `{ plugin_id, source_template_id, params }`；
 *   整理的设置向导走它。
 *
 * 只认前一种时，后一种是**运行时 TypeError**，而类型检查一声不吭（`Stream.sources` 的类型
 * 描述的是前一种，与该端点的实际返回不符）。活体后果：整理向导保存到一半整条链断掉，界面只
 * 说「保存失败」，而目录和绑定已经建出来了——留下孤儿绑定（回滚只兜更后面那一步）。
 */
describe('streamRawMembers —— 两种成员形状都要认', () => {
  it('嵌套形状（频道视图）', () => {
    expect(streamRawMembers({ id: 's', sources: [
      { source: { id: 'rsshub:old', pluginId: 'rsshub' }, params: { a: '1' } },
    ] } as never)).toEqual([{ plugin: 'rsshub', source: 'rsshub:old', params: { a: '1' } }])
  })

  it('扁平形状（/api/streams 原样）', () => {
    expect(streamRawMembers({ id: 's', sources: [
      { plugin_id: 'replay', source_template_id: 'lizhi-user', params: { id: '26' } },
    ] } as never)).toEqual([{ plugin: 'replay', source: 'lizhi-user', params: { id: '26' } }])
  })

  it('扁平形状也认得出已经挂着的网盘成员——认不出就会给同一条流挂第二个下架目录', () => {
    const members = streamRawMembers({ id: 's', sources: [
      { plugin_id: 'replay', source_template_id: 'lizhi-user', params: {} },
      { plugin_id: 'alist', source_template_id: 'alist-audio', params: { path: '/x/下架' } },
    ] } as never)
    expect(members.some((m) => m.plugin === 'alist')).toBe(true)
  })
})

describe('submitDestination', () => {
  it('create-stream → subscribe (no kind stamp) 一步带上归属，不再补一条 PATCH 频道', async () => {
    const sub = vi.spyOn(api, 'subscribe').mockResolvedValue({} as never)
    const upd = vi.spyOn(api, 'updateChannel').mockResolvedValue({} as never)
    await submitDestination({ conn, source, dest: { action: 'create-stream', channelId: 'c1' }, name: 'N', params: {},
      streams: [], providers: [], channels: [channel('c1', 'audio', ['s0'])] })
    const body = sub.mock.calls[0][1]
    expect(body.members).toEqual([{ plugin: 'rsshub', source: 'rsshub:foo', params: {} }])
    // audio-ness is NOT stamped on the stream — it's derived from Channel.present. The
    // channel binding submitted alongside the create IS what makes this an audio stream.
    expect(body.options.kind).toBeUndefined()
    // 归属随建流一起提交：中间不存在「不属于任何频道」的那一刻（后端会把它当采集流抓一次）。
    expect(body.channel_id).toBe('c1')
    expect(upd).not.toHaveBeenCalled()
  })

  it('append-stream → PATCH existing + new member', async () => {
    const spy = vi.spyOn(api, 'patchStreamMembers').mockResolvedValue({} as never)
    await submitDestination({ conn, source, dest: { action: 'append-stream', streamId: 's1' }, name: '', params: { x: '9' }, streams: [stream('s1')], providers: [], channels: [] })
    expect(spy.mock.calls[0][2]).toEqual([
      { plugin: 'rsshub', source: 'rsshub:old', params: { a: '1' } },
      { plugin: 'rsshub', source: 'rsshub:foo', params: { x: '9' } },
    ])
  })

  it('append-provider 带实例名 → 成员写成 {source, name, params}', async () => {
    const spy = vi.spyOn(api, 'patchProvider').mockResolvedValue({} as never)
    await submitDestination({ conn, source, dest: { action: 'append-provider', providerId: 'p1' }, name: '', memberName: 'kimi',
      params: { baseUrl: 'https://k/v1', model: 'k2', tokenName: 'llm:kimi' }, streams: [], providers: [provider('p1')], channels: [] })
    expect(spy.mock.calls[0][2]).toEqual({ members: [
      { source: 'old', params: { a: '1' } },
      { source: 'rsshub:foo', name: 'kimi', params: { baseUrl: 'https://k/v1', model: 'k2', tokenName: 'llm:kimi' } },
    ] })
  })

  it('append-provider 不带实例名 → 成员形状逐字节不变（不塞空 name）', async () => {
    const spy = vi.spyOn(api, 'patchProvider').mockResolvedValue({} as never)
    await submitDestination({ conn, source, dest: { action: 'append-provider', providerId: 'p1' }, name: '', params: { x: '1' }, streams: [], providers: [provider('p1')], channels: [] })
    expect(spy.mock.calls[0][2]).toEqual({ members: [
      { source: 'old', params: { a: '1' } },
      { source: 'rsshub:foo', params: { x: '1' } },
    ] })
  })

  it('edit-provider-member → PATCH replaces params at index', async () => {
    const spy = vi.spyOn(api, 'patchProvider').mockResolvedValue({} as never)
    await submitDestination({ conn, source, dest: { action: 'edit-provider-member', providerId: 'p1', memberIndex: 0 }, name: '', params: { a: '2' }, streams: [], providers: [provider('p1')], channels: [] })
    expect(spy.mock.calls[0][2]).toEqual({ members: [{ source: 'old', params: { a: '2' } }] })
  })

  it('edit-provider-member 保住成员实例名——只换 params,不把这一档改名', async () => {
    const spy = vi.spyOn(api, 'patchProvider').mockResolvedValue({} as never)
    const p = {
      ...provider('p1'),
      members: [
        { source: 'llm-openai', name: 'deepseek', params: { model: 'v3' } },
        { source: 'llm-openai', name: 'kimi', params: { model: 'k2' } },
      ],
    } as unknown as ProviderView
    await submitDestination({ conn, source, dest: { action: 'edit-provider-member', providerId: 'p1', memberIndex: 1 }, name: '', params: { model: 'k2-turbo' }, streams: [], providers: [p], channels: [] })
    // 实例名是寻址键(exclude/reorder/byMember 都按它)——丢了它 = 静默改名,排除项和计数当场对不上
    expect(spy.mock.calls[0][2]).toEqual({ members: [
      { source: 'llm-openai', name: 'deepseek', params: { model: 'v3' } },
      { source: 'llm-openai', name: 'kimi', params: { model: 'k2-turbo' } },
    ] })
  })
})
