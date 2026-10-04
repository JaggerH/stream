import { describe, it, expect, vi } from 'vitest'
import { StoryFoldWorker, type TextSource } from './worker.ts'
import { StoryFoldRecorder } from './recorder.ts'
import { StoryFoldStore } from './store.ts'
import type { StreamItem } from '../types.ts'
import type { FpSource } from './fp-source.ts'
import { indexRowOf } from './inbox.ts'

const SPEECH = `这是我这两天做出来的一个小产品 我来给大家做一个简单的介绍
就是我们这个主要是去监控全球的媒体信息 然后并且能通过这些信息来去观察舆情背后的议题
那么我们一共监控了172个国家和地区 包括408家主流的媒体`
const OTHER = `今天我们来聊一聊完全不同的另一件事情，关于怎么挑选一台适合自己的相机，
以及镜头该怎么配，预算有限的时候优先买什么，这些都值得说一说。`

const item = (o: { id: string; stream: string; title: string; dur?: number; ts?: string }): StreamItem =>
  ({
    id: o.id, stream_id: o.stream, source_type: 'rsshub-bridge', source_route: '/x',
    fetched_at: '2026-08-13T00:00:00Z', timestamp: o.ts ?? '2026-08-13T00:00:00Z',
    title: o.title, raw: {},
    content: o.dur ? ({ archetype: 'video', media: [{ kind: 'video', duration_s: o.dur }] } as never) : undefined,
  }) as StreamItem

/** 一份可控的文本源：texts 里有就立刻给，pending 集合里的返回"已去取"，其余 null。 */
function textSource(texts: Record<string, string>, pending = new Set<string>()): TextSource & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    textFor: async (itemId) => {
      calls.push(itemId)
      if (pending.has(itemId)) return 'pending'
      const t = texts[itemId]
      return t ? { text: t, source: 'stt' } : null
    },
  }
}

function rig(texts: Record<string, string>, pending?: Set<string>) {
  const store = new StoryFoldStore(':memory:')
  const src = textSource(texts, pending)
  return { store, src, rec: new StoryFoldRecorder({ store }), worker: new StoryFoldWorker({ store, texts: src }) }
}

/**
 * 假指纹源：itemId → 指纹/pending/null，并记谁被问过（asked = 真正走到 fpFor 的，
 * 也就是**会排队**的那一跳；requested 记的是"真排了一次 audio-fp"）。
 * `media` 缺省时把所有 id 都当媒体——只有跨形态那条用例需要显式区分。
 */
function fpSource(
  map: Record<string, { fp: Uint32Array; totalS: number } | 'pending' | null>,
  media?: Set<string>,
): FpSource & { asked: string[]; requested: string[] } {
  const asked: string[] = []
  const requested: string[] = []
  return {
    asked,
    requested,
    hasFingerprintableMedia: (id) => (media ? media.has(id) : true),
    async fpFor(id) {
      asked.push(id)
      const v = map[id] ?? null
      if (v === 'pending') requested.push(id) // 真实实现里 pending 意味着刚排了一次
      return v
    },
  }
}

/** 可复现的伪随机 uint32 序列——与 audio-fingerprint.test.ts 同款 xorshift。 */
function seqFp(n: number, seed = 0x9e3779b9): Uint32Array {
  const out = new Uint32Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0
    out[i] = s
  }
  return out
}

/** rig 的变体：多传一个 fps（媒体对媒体的判据源）。 */
function rigWith(o: { texts: TextSource & { calls: string[] }; fps: FpSource }) {
  const store = new StoryFoldStore(':memory:')
  return {
    store,
    rec: new StoryFoldRecorder({ store }),
    worker: new StoryFoldWorker({ store, texts: o.texts, fps: o.fps }),
  }
}

/** 两条时长一致、标题互不相似、跨 Stream 的媒体条目——今天必走 need-text 的形状。 */
function mediaPair(store: StoryFoldStore, dur = 1200) {
  const rec = new StoryFoldRecorder({ store })
  rec.record([item({ id: 'a', stream: 's1', title: '甲电台的深夜节目', dur })])
  rec.record([item({ id: 'b', stream: 's2', title: '完全不相干的乙类内容', dur })])
}

/** 同上的候选对，但 b 只写进索引（当候选看得见），不排进待判队列——
 *  用于「只有 a 在队列里」的场景，避免 b 自己那一轮也被判定并算进 deferred。 */
function mediaCandidateOnly(store: StoryFoldStore, dur = 1200) {
  const rec = new StoryFoldRecorder({ store })
  rec.record([item({ id: 'a', stream: 's1', title: '甲电台的深夜节目', dur })])
  store.index(indexRowOf(item({ id: 'b', stream: 's2', title: '完全不相干的乙类内容', dur })))
}

describe('StoryFoldRecorder — 入库那一跳只记账', () => {
  it('记候选信号 + 排队，**不下任何结论**（判据要文本，转写十几秒）', () => {
    const { rec, store } = rig({})
    rec.record([item({ id: 'a', stream: 's1', title: '甲', dur: 96 })])
    expect(store.row('a')).toBeDefined()
    expect(store.row('a')!.textSig).toBeUndefined()
    expect(store.pendingCount()).toBe(1)
    expect(store.membership('a')).toBeUndefined()
  })

  it('记账失败绝不外溢到入库', () => {
    const { rec, store } = rig({})
    vi.spyOn(store, 'index').mockImplementation(() => { throw new Error('db is on fire') })
    expect(() => rec.record([item({ id: 'a', stream: 's1', title: '甲' })])).not.toThrow()
  })
})

describe('StoryFoldWorker — 判据在后台，看的是文本', () => {
  it('两条转写几乎一样 → 并；标题差得再远也不影响', async () => {
    const { rec, worker, store } = rig({ a: SPEECH, b: `${SPEECH} 记得点赞关注` })
    rec.record([item({ id: 'a', stream: 's1', title: '原标题', dur: 96 })])
    rec.record([item({ id: 'b', stream: 's2', title: '平台改写过的完全不同的说法', dur: 96 })])
    await worker.runOnce()
    const [ga, gb] = [store.membership('a'), store.membership('b')]
    expect(ga?.groupId).toBe(gb?.groupId) // 一堆
    expect([...(ga?.why ?? []), ...(gb?.why ?? [])][0].kind).toBe('text-identity')
  })

  it('**时长一样但内容不同 → 不并**（这正是活体误折过的那一类）', async () => {
    const { rec, worker, store } = rig({ a: SPEECH, b: OTHER })
    rec.record([item({ id: 'a', stream: 's1', title: '甲歌', dur: 226 })])
    rec.record([item({ id: 'b', stream: 's2', title: '乙歌', dur: 226 })])
    await worker.runOnce()
    expect(store.membership('b')).toBeUndefined()
    expect(store.pendingCount()).toBe(0) // 判完了，不是悬着
  })

  it('**没有候选就绝不取文本**——转写只花在疑似重复的那几条上', async () => {
    const { rec, worker, src } = rig({ a: SPEECH })
    rec.record([item({ id: 'a', stream: 's1', title: '孤零零的一条', dur: 96 })])
    await worker.runOnce()
    expect(src.calls).toEqual([])
  })

  it('文本还在取（转写排队中）→ 留在队列里，下一轮再判', async () => {
    const { rec, worker, store } = rig({ a: SPEECH }, new Set(['b']))
    rec.record([item({ id: 'a', stream: 's1', title: '同一条内容', dur: 96 })])
    rec.record([item({ id: 'b', stream: 's2', title: '同一条内容', dur: 96 })])
    const stats = await worker.runOnce()
    expect(stats.deferred).toBeGreaterThan(0)
    expect(store.pendingCount()).toBeGreaterThan(0)
    expect(store.membership('b')).toBeUndefined()
  })

  it('取过一次文本就不再取第二次（不重复计费）', async () => {
    const { rec, worker, src } = rig({ a: SPEECH, b: OTHER })
    rec.record([item({ id: 'a', stream: 's1', title: '甲', dur: 96 })])
    rec.record([item({ id: 'b', stream: 's2', title: '甲', dur: 96 })])
    await worker.runOnce()
    await worker.runOnce()
    expect(new Set(src.calls).size).toBe(src.calls.length)
  })

  it('取不到文本的条目最终出队，不会永远占着队列', async () => {
    const { rec, worker, store } = rig({}, new Set(['a', 'b']))
    rec.record([item({ id: 'a', stream: 's1', title: '同一条内容', dur: 96 })])
    rec.record([item({ id: 'b', stream: 's2', title: '同一条内容', dur: 96 })])
    for (let i = 0; i < 6; i++) await worker.runOnce()
    expect(store.pending(20, 5)).toHaveLength(0)
  })

  it('同链接不用等文本，当场就并', async () => {
    const { rec, worker, store, src } = rig({})
    const withUrl = (id: string, stream: string) => ({ ...item({ id, stream, title: id }), url: 'https://x.com/p/1' })
    rec.record([withUrl('a', 's1') as StreamItem])
    rec.record([withUrl('b', 's2') as StreamItem])
    await worker.runOnce()
    const why = [...(store.membership('a')?.why ?? []), ...(store.membership('b')?.why ?? [])]
    expect(why[0].kind).toBe('url-identity')
    expect(src.calls).toEqual([])
  })

  it('**一对只记一次**：两条都在队列里，后判的那条不能把领先数记第二遍', async () => {
    const { rec, worker, store } = rig({ a: SPEECH, b: SPEECH })
    rec.record([item({ id: 'a', stream: 's1', title: '同一条', dur: 96, ts: '2026-08-13T08:00:00Z' })])
    rec.record([item({ id: 'b', stream: 's2', title: '同一条', dur: 96, ts: '2026-08-13T09:00:00Z' })])
    await worker.runOnce()
    expect(store.leaderboard()[0]).toMatchObject({ streamId: 's1', leads: 1, avgLeadS: 3600 })
  })

  it('一条判不动不影响同一轮的其它条', async () => {
    const { rec, worker, store } = rig({ a: SPEECH, b: SPEECH })
    rec.record([item({ id: 'a', stream: 's1', title: '同一条', dur: 96 })])
    rec.record([item({ id: 'b', stream: 's2', title: '同一条', dur: 96 })])
    const orig = store.row.bind(store)
    let first = true
    vi.spyOn(store, 'row').mockImplementation((id: string) => {
      if (first) { first = false; throw new Error('boom') }
      return orig(id)
    })
    await expect(worker.runOnce()).resolves.toBeDefined()
  })
})

describe('StoryFoldWorker — 指纹路', () => {
  it('两边指纹吻合 → 并堆，证据是 audio-identity，且一次 textFor 都不发', async () => {
    const base = seqFp(7 * 1200)
    const fps = fpSource({
      a: { fp: base, totalS: 1200 },
      b: { fp: base.slice(7 * 20), totalS: 1180 }, // 偏移 20s 的同一录音
    })
    const texts = textSource({}) // 空文本源：被调用就说明指纹路没拦住
    const { store, worker } = rigWith({ texts, fps })
    mediaPair(store)
    await worker.runOnce()
    const m = store.membership('a')
    expect(m).toBeTruthy()
    expect(store.membership('b')?.groupId).toBe(m!.groupId)
    expect(JSON.stringify(m)).toContain('audio-identity')
    expect(texts.calls).toEqual([]) // 媒体对绝不触发取文本/转写
  })

  it('指纹不吻合 → 判不同，settle，不落回文本路', async () => {
    const fps = fpSource({
      a: { fp: seqFp(7 * 1200, 1), totalS: 1200 },
      b: { fp: seqFp(7 * 1200, 2), totalS: 1200 },
    })
    const texts = textSource({})
    const { store, worker } = rigWith({ texts, fps })
    mediaPair(store)
    await worker.runOnce()
    expect(store.membership('a')).toBeUndefined()
    expect(texts.calls).toEqual([])
  })

  it('一边 pending → defer 等下一轮', async () => {
    const fps = fpSource({ a: { fp: seqFp(7 * 1200), totalS: 1200 }, b: 'pending' })
    const { store, worker } = rigWith({ texts: textSource({}), fps })
    mediaCandidateOnly(store)
    const stats = await worker.runOnce()
    expect(stats.deferred).toBe(1) // a 留在队列
  })

  it('跨形态对（长播客 × 文章）→ 直接走文本路，绝不给媒体那侧排指纹', async () => {
    // a 是媒体（真去问 fpFor 会回 pending 并排一次 audio-fp——3 小时 ≈ 几百 MB 过网），
    // b 是文章。spec §2：这种对的行为必须与改动前一字不差。
    const fps = fpSource({ a: 'pending', b: null }, new Set(['a']))
    const texts = textSource({ a: '同一段正文'.repeat(50), b: '同一段正文'.repeat(50) })
    const { store, worker } = rigWith({ texts, fps })
    const rec = new StoryFoldRecorder({ store })
    rec.record([item({ id: 'a', stream: 's1', title: '甲电台的深夜节目', dur: 10800 })])
    rec.record([item({ id: 'b', stream: 's2', title: '甲电台的深夜节目' })]) // 无 media = 文章
    await worker.runOnce()
    expect(fps.asked).toEqual([]) // fpFor 一次都没调 → 一次都没排
    expect(fps.requested).toEqual([])
    expect(texts.calls.length).toBeGreaterThan(0) // 走的是文本路
    expect(store.membership('a')).toBeTruthy()
  })

  it('fpFor 回 null（非媒体/引擎不可用）→ 落回文本路，行为与今天一致', async () => {
    const fps = fpSource({ a: null, b: null })
    const texts = textSource({ a: '同一段正文'.repeat(50), b: '同一段正文'.repeat(50) })
    const { store, worker } = rigWith({ texts, fps })
    mediaPair(store)
    await worker.runOnce()
    expect(store.membership('a')).toBeTruthy() // 文本路照常并堆
    expect(texts.calls.length).toBeGreaterThan(0)
  })
})
