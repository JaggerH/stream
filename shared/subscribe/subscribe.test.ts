import { describe, it, expect, vi } from 'vitest'
import { buildStreamCreate, subscribe, unsubscribe } from './subscribe.ts'
import { candidateKey } from './memberKey.ts'
import type { Candidate, ChannelSummary, SubscribeTransport } from './types.ts'

const cand: Candidate = { sourceId: 'rsshub:xiaohongshu/user', params: { id: '42' }, title: '小红书用户' }
const emptyChannel: ChannelSummary = { id: 'ch1', label: 'A', variant: 'timeline', streamIds: [], members: [] }

function fakeTransport(overrides: Partial<SubscribeTransport> = {}): SubscribeTransport {
  return {
    createStream: vi.fn(async (b) => ({ id: b.id })),
    setChannelStreams: vi.fn(async () => {}),
    deleteStream: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('buildStreamCreate', () => {
  it('builds a single-member StreamCreate with labelAuto + a client id', () => {
    const body = buildStreamCreate(cand)
    expect(body.id.length).toBeGreaterThan(0)
    expect(body.strategy).toBe('fanout')
    expect(body.members).toEqual([{ plugin: 'rsshub', source: 'xiaohongshu/user', params: { id: '42' } }])
    expect(body.options.labelAuto).toBe(true)
  })

  // 后缀只在它真的区分得了东西时才该出现。这三条钉的是同一件事的三个面：多余的尾巴一旦
  // 进了 id 就是这条流的永久身份，而库里已经躺着 600 行属于这种 id 的无主数据
  // （`douyin-follow-follow` 500 行 + `douyin-collection-collection` 100 行）。
  it('源没有参数 → 不拼后缀（原来会拼出 `-x`，等于给同一个源造第二个主人）', () => {
    const body = buildStreamCreate({ ...cand, sourceId: 'replay:douyin-collection', params: {} })
    expect(body.id).toBe('douyin-collection')
  })

  it('参数值已被源 id 含着 → 不拼后缀（`douyin-follow` + mode:follow 曾拼成 douyin-follow-follow）', () => {
    const body = buildStreamCreate({ ...cand, sourceId: 'x:douyin-follow', params: { mode: 'follow' } })
    expect(body.id).toBe('douyin-follow')
  })

  // 24 字符的预算只留给源自己的名字，不给命名空间前缀。前缀能把预算整个吃光：
  // `@streamapp/builtin/article-defuddle` 与 `@streamapp/builtin/article-readability`
  // 截断后是同一个 slug，而两者都无参数（keyish 为空）→ 同一个 stream id → 第二次订阅
  // 409 撞上第一条流。**静默的归属错误，不是崩溃**，所以由测试钉住。
  it('全名订阅 → id 里只有局部名，两个同前缀的长源不会截断成同一个 id', () => {
    const a = buildStreamCreate({ ...cand, sourceId: '@streamapp/builtin/article-defuddle', params: {} })
    const b = buildStreamCreate({ ...cand, sourceId: '@streamapp/builtin/article-readability', params: {} })
    expect(a.id).toBe('article-defuddle')
    expect(b.id).toBe('article-readability')
    expect(a.id).not.toBe(b.id)
  })

  // 命名空间化不该动存量流的身份：裸名与 `plugin:裸名` 两种旧形铸出的 id 逐字符不变。
  it('裸名 / plugin:裸名 铸出的 id 与命名空间化之前相同', () => {
    expect(buildStreamCreate({ ...cand, sourceId: 'douyin-collection', params: {} }).id).toBe('douyin-collection')
    expect(buildStreamCreate({ ...cand, sourceId: 'replay:douyin-collection', params: {} }).id).toBe('douyin-collection')
  })

  it('参数真的能区分 → 后缀照留（同一个源订阅多次靠它分开）', () => {
    const a = buildStreamCreate({ ...cand, sourceId: 'rsshub:lizhi-user', params: { id: '2513816802261356588' } })
    const b = buildStreamCreate({ ...cand, sourceId: 'rsshub:lizhi-user', params: { id: '5122088256299183916' } })
    expect(a.id).toBe('lizhi-user-356588')
    expect(a.id).not.toBe(b.id)
  })
})

describe('subscribe', () => {
  // 一步建流：归属随 `channel_id` 一起提交，**不再**跟一条 setChannelStreams。
  // 两步之间那条流不属于任何频道，后端据此判它为采集流并当场抓一次——归 research 频道的
  // 流因此仍会落一次库（见 src/http/app.ts 的 POST /api/streams）。
  it('creates the Stream already bound to the channel (one request, no follow-up attach)', async () => {
    const t = fakeTransport()
    const res = await subscribe(t, cand, emptyChannel)
    expect(res.created).toBe(true)
    expect(t.createStream).toHaveBeenCalledOnce()
    expect((t.createStream as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ id: res.streamId, channel_id: 'ch1' })
    expect(t.setChannelStreams).not.toHaveBeenCalled()
  })

  it('is a no-op when the candidate key is already reachable from the channel', async () => {
    const key = candidateKey(cand.sourceId, cand.params)
    const dupChannel: ChannelSummary = {
      ...emptyChannel, streamIds: ['s-existing'], members: [{ key, streamId: 's-existing' }],
    }
    const t = fakeTransport()
    const res = await subscribe(t, cand, dupChannel)
    expect(res.created).toBe(false)
    expect(res.streamId).toBe('s-existing')
    expect(t.createStream).not.toHaveBeenCalled()
    expect(t.setChannelStreams).not.toHaveBeenCalled()
  })

  it('attaches the SHARED Stream (no new create) when the member exists on another channel', async () => {
    const key = candidateKey(cand.sourceId, cand.params)
    const otherChannel: ChannelSummary = {
      id: 'ch-other', label: 'B', variant: 'timeline', streamIds: ['s-shared'], members: [{ key, streamId: 's-shared' }],
    }
    const t = fakeTransport()
    const res = await subscribe(t, cand, emptyChannel, [emptyChannel, otherChannel])
    expect(res.created).toBe(false)
    expect(res.streamId).toBe('s-shared')
    expect(t.createStream).not.toHaveBeenCalled() // no duplicate id → no 409
    expect(t.setChannelStreams).toHaveBeenCalledWith('ch1', ['s-shared'])
  })
})

describe('unsubscribe', () => {
  const key = candidateKey(cand.sourceId, cand.params)
  const chWith = (id: string): ChannelSummary => ({
    id, label: id, variant: 'timeline', streamIds: ['s1'], members: [{ key, streamId: 's1' }],
  })

  it('drops the ref and GCs an orphaned Stream', async () => {
    const t = fakeTransport()
    const ch = chWith('ch1')
    const res = await unsubscribe(t, cand, ch, [ch])
    expect(t.setChannelStreams).toHaveBeenCalledWith('ch1', [])
    expect(t.deleteStream).toHaveBeenCalledWith('s1')
    expect(res).toEqual({ removed: true, deleted: true })
  })

  it('keeps a Stream referenced by another channel', async () => {
    const t = fakeTransport()
    const ch1 = chWith('ch1')
    const ch2 = chWith('ch2')
    const res = await unsubscribe(t, cand, ch1, [ch1, ch2])
    expect(t.setChannelStreams).toHaveBeenCalledWith('ch1', [])
    expect(t.deleteStream).not.toHaveBeenCalled()
    expect(res).toEqual({ removed: true, deleted: false })
  })

  it('is a no-op when the candidate is not in the channel', async () => {
    const t = fakeTransport()
    const res = await unsubscribe(t, cand, emptyChannel, [emptyChannel])
    expect(t.setChannelStreams).not.toHaveBeenCalled()
    expect(res).toEqual({ removed: false, deleted: false })
  })
})
