import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntentStore } from './store.ts'
import { runRecruit, type RecruitDeps, type RecruitCandidate } from './recruit.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'intent-recruit-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const CANDS: RecruitCandidate[] = [
  { id: 'rsshub:juejin/trending', description: '掘金热榜', cadence_hint_seconds: 3600 },
  { id: 'rsshub:v2ex/topics', description: 'v2ex 主题', params_schema: { required: ['type'], properties: { type: {} } } },
  { id: 'rsshub:dead/route', description: '试吃会空的源' },
]

function makeDeps(store: IntentStore, over: Partial<RecruitDeps> = {}): RecruitDeps {
  return {
    store,
    llm: { pickSources: async () => [
      { sourceId: 'rsshub:juejin/trending', params: {} },
      { sourceId: 'rsshub:v2ex/topics', params: { type: 'huasr' } },
      { sourceId: 'rsshub:dead/route', params: {} },
    ] },
    search: () => CANDS,
    preview: async (sid) => ({ items: sid === 'rsshub:dead/route' ? [] : [{}] }),
    findExisting: () => null,
    subscribe: () => {},
    ensureChannel: () => {},
    ...over,
  }
}

describe('runRecruit', () => {
  it('全链路：挑中且试吃通过的订进意图频道，试吃空的丢弃，记录与事件齐全', async () => {
    const store = new IntentStore(dir)
    const rec = store.create({ goal: '跟踪AI硬件最新发展', criteria: 'c' })
    const subs: Array<{ streamId: string; channelId: string }> = []
    const channels: string[] = []
    const events: Array<{ title: string; dedupeKey?: string }> = []
    const out = await runRecruit(rec.id, makeDeps(store, {
      subscribe: (s, cid) => subs.push({ streamId: s.id, channelId: cid }),
      ensureChannel: (id) => channels.push(id),
      events: { append: (e) => events.push(e) },
    }))
    expect(out.subscribed.length).toBe(2)
    expect(out.dropped).toBe(1) // dead/route 试吃空
    const expectChannel = `intent-${rec.id.slice(0, 8)}`
    expect(channels).toEqual([expectChannel])
    expect(subs.every((s) => s.channelId === expectChannel)).toBe(true)
    const after = store.get(rec.id)!
    expect(after.channelId).toBe(expectChannel)
    expect(after.recruitedStreamIds).toEqual(out.subscribed.map((s) => s.streamId))
    expect(after.streamIds).toEqual(out.subscribed.map((s) => s.streamId))
    expect(events.length).toBe(1)
    expect(events[0].title).toContain('2')
  })

  it('required 参数缺值 → 丢弃不猜', async () => {
    const store = new IntentStore(dir)
    const rec = store.create({ goal: 'g', criteria: 'c' })
    const out = await runRecruit(rec.id, makeDeps(store, {
      llm: { pickSources: async () => [{ sourceId: 'rsshub:v2ex/topics', params: {} }] }, // 缺 required 的 type
    }))
    expect(out.subscribed).toEqual([])
    expect(out.dropped).toBe(1)
  })

  it('查重命中 → 复用 streamId：挂 streamIds、不挂 recruitedStreamIds、不建频道不订阅', async () => {
    const store = new IntentStore(dir)
    const rec = store.create({ goal: 'g', criteria: 'c' })
    const subs: unknown[] = []
    const out = await runRecruit(rec.id, makeDeps(store, {
      llm: { pickSources: async () => [{ sourceId: 'rsshub:juejin/trending', params: {} }] },
      findExisting: () => 'existing-stream-1',
      subscribe: (s) => subs.push(s),
    }))
    expect(out.reused).toEqual(['existing-stream-1'])
    expect(subs).toEqual([])
    const after = store.get(rec.id)!
    expect(after.streamIds).toEqual(['existing-stream-1'])
    expect(after.recruitedStreamIds ?? []).toEqual([])
    expect(after.channelId).toBeUndefined()
  })

  it('一条没招到也发事件，讲明原因', async () => {
    const store = new IntentStore(dir)
    const rec = store.create({ goal: 'g', criteria: 'c' })
    const events: Array<{ title: string; body?: string }> = []
    const out = await runRecruit(rec.id, makeDeps(store, {
      llm: { pickSources: async () => [] },
      events: { append: (e) => events.push(e) },
    }))
    expect(out.subscribed).toEqual([])
    expect(events.length).toBe(1)
    // makeDeps 的 search 返回 3 条候选、pickSources 全拒——文案要如实说"不对口"，
    // 而不是谎报"注册表里没有匹配的候选"（活体验收撞过：场景一命中 3 条噪声全被拒）
    expect(events[0].body).toContain('不对口')
  })

  it('注册表零候选时文案才是"没有匹配的候选"', async () => {
    const store = new IntentStore(dir)
    const rec = store.create({ goal: 'g', criteria: 'c' })
    const events: Array<{ body?: string }> = []
    await runRecruit(rec.id, makeDeps(store, {
      search: () => [],
      llm: { pickSources: async () => [] },
      events: { append: (e) => events.push(e) },
    }))
    expect(events[0].body).toBe('注册表里没有匹配的候选')
  })

  it('dedupeKey 编入本轮 subscribed/reused，总数相同但本轮颗粒无收时 key 仍要变', async () => {
    const store = new IntentStore(dir)
    const rec = store.create({ goal: 'g', criteria: 'c' })
    store.put(rec.id, { streamIds: ['existing-stream-1'] }) // 已有 1 条，与下面查重命中后的总数打平
    const events: Array<{ dedupeKey?: string }> = []
    const out = await runRecruit(rec.id, makeDeps(store, {
      llm: { pickSources: async () => [{ sourceId: 'rsshub:juejin/trending', params: {} }] },
      findExisting: () => 'existing-stream-1', // 复用，总数不变（仍是 1）
      events: { append: (e) => events.push(e) },
    }))
    expect(out.reused).toEqual(['existing-stream-1'])
    // key 里带上本轮 subscribed(0)/reused(1)，不是只有总数(1)
    expect(events[0].dedupeKey).toBe(`intent:${rec.id}:recruit:1:0:1`)
  })

  it('意图不存在 → throw', async () => {
    const store = new IntentStore(dir)
    await expect(runRecruit('nope', makeDeps(store))).rejects.toThrow('意图不存在')
  })

  it('subscribe 抛错 → 该条计 dropped，后续条继续跑，不 rethrow', async () => {
    const store = new IntentStore(dir)
    const rec = store.create({ goal: 'g', criteria: 'c' })
    const subs: string[] = []
    const out = await runRecruit(rec.id, makeDeps(store, {
      llm: { pickSources: async () => [
        { sourceId: 'rsshub:juejin/trending', params: {} },
        { sourceId: 'rsshub:v2ex/topics', params: { type: 'huasr' } },
      ] },
      subscribe: (s) => {
        if (s.description === '掘金热榜') throw new Error('订阅落盘失败')
        subs.push(s.id)
      },
    }))
    expect(out.subscribed).toEqual([{ streamId: subs[0], sourceId: 'rsshub:v2ex/topics' }])
    expect(out.dropped).toBe(1)
    expect(subs.length).toBe(1)
  })
})
