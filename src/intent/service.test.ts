// src/intent/service.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntentStore } from './store.ts'
import { IntentService, type IntentServiceDeps } from './service.ts'
import type { IntentLlm } from './llm.ts'

const fakeLlm: IntentLlm = {
  parseIntent: async (goal) => ({ criteria: `criteria(${goal})` }),
  judgeItem: async () => ({ relevant: true, summary: 's' }),
  mergeDossier: async () => 'dossier',
  pickSources: async () => [],
}

/** helper: 构造一个 IntentService，deps 可局部覆盖；共用 store 供测试直接读写记录形状。 */
function makeService(
  overrides: {
    llm?: IntentLlm
    digestDeps?: IntentServiceDeps['digestDeps']
    recruit?: IntentServiceDeps['recruit']
  },
  store: IntentStore,
  events: Array<{ type: string }>,
): IntentService {
  return new IntentService({
    store,
    llm: overrides.llm ?? fakeLlm,
    digestDeps: overrides.digestDeps ?? {
      listItems: () => [{ id: 'i1', title: 't' }],
      streamExists: () => true,
      events: { append: (e) => events.push(e) },
    },
    ...(overrides.recruit ? { recruit: overrides.recruit } : {}),
  })
}

describe('IntentService', () => {
  let store: IntentStore
  let events: Array<{ type: string }>
  let svc: IntentService
  beforeEach(() => {
    store = new IntentStore(mkdtempSync(join(tmpdir(), 'intent-svc-')))
    events = []
    svc = new IntentService({
      store,
      llm: fakeLlm,
      digestDeps: {
        listItems: () => [{ id: 'i1', title: 't' }],
        streamExists: () => true,
        events: { append: (e) => events.push(e) },
      },
    })
  })

  it('create 走 LLM 解析 criteria', async () => {
    const rec = await svc.create({ goal: '盯 AI 硬件' })
    expect(rec.criteria).toBe('criteria(盯 AI 硬件)')
    expect(svc.list()[0].ledgerCount).toBe(0)
  })

  it('create 时 LLM 不可用 → throw，意图不立', async () => {
    const broken = new IntentService({
      store,
      llm: { ...fakeLlm, parseIntent: async () => { throw new Error('LLM 未配置') } },
      digestDeps: { listItems: () => [], streamExists: () => true },
    })
    await expect(broken.create({ goal: 'g' })).rejects.toThrow('LLM 未配置')
    expect(store.list()).toHaveLength(0)
  })

  it('digestNow 跑一轮并计账；整轮失败发 intent.digest.error 且 rethrow', async () => {
    const rec = await svc.create({ goal: 'g', streamIds: ['s1'] })
    const out = await svc.digestNow(rec.id)
    expect(out.judged).toBe(1)
    const broken = new IntentService({
      store,
      llm: { ...fakeLlm, mergeDossier: async () => { throw new Error('down') } },
      digestDeps: { listItems: () => [{ id: 'i2' }], streamExists: () => true, events: { append: (e) => events.push(e) } },
    })
    // judgeItem 失败是单条级（不 rethrow，这里沿用 fakeLlm 让 item 判 relevant 以走到 merge 这步）；
    // 用 mergeDossier 失败模拟整轮炸
    const rec2 = await svc.create({ goal: 'g2', streamIds: ['s1'] })
    await expect(broken.digestNow(rec2.id)).rejects.toThrow()
    expect(events.some((e) => e.type === 'intent.digest.error')).toBe(true)
  })

  it('整轮 throw 也计失败轮退避（不只是"判过但全错"那条路径）', async () => {
    const broken = new IntentService({
      store,
      llm: { ...fakeLlm, mergeDossier: async () => { throw new Error('端点整体不可用') } },
      digestDeps: { listItems: () => [{ id: 'i-throw' }], streamExists: () => true, events: { append: (e) => events.push(e) } },
    })
    const rec = await broken.create({ goal: 'g-throw', streamIds: ['s1'] })
    await expect(broken.digestNow(rec.id)).rejects.toThrow('端点整体不可用')
    const after = broken.get(rec.id)!
    expect(after.digestFailStreak).toBe(1)
    expect(after.digestBackoffUntil).toBeGreaterThan(Date.now())
    // 退避期内 scanDue 不再排它
    expect(await broken.scanDue()).toEqual([])
  })

  it('scanDue 只跑到期的；retired 不跑', async () => {
    const due = await svc.create({ goal: 'a', streamIds: ['s1'] }) // 从未消化 → due
    const fresh = await svc.create({ goal: 'b', streamIds: ['s1'] })
    store.put(fresh.id, { lastDigestAt: Date.now() }) // 刚消化过 → 不 due
    const retired = await svc.create({ goal: 'c', streamIds: ['s1'] })
    svc.retire(retired.id)
    const ran = await svc.scanDue()
    expect(ran).toEqual([due.id])
  })

  it('remaining>0 时 scanDue 立即再次判 due（不等 cadence）；排完才不再 due（复审 Important）', async () => {
    // 3 条待判，maxJudged=2 → 第一轮排不完
    const svc2 = new IntentService({
      store,
      llm: fakeLlm,
      digestDeps: {
        listItems: () => [{ id: 'a', title: 't' }, { id: 'b', title: 't' }, { id: 'c', title: 't' }],
        streamExists: () => true,
        events: { append: (e) => events.push(e) },
        maxJudged: 2,
      },
    })
    const rec = await svc2.create({ goal: 'g', streamIds: ['s1'] })

    const ran1 = await svc2.scanDue()
    expect(ran1).toEqual([rec.id]) // 从未消化过 → due
    expect(store.get(rec.id)?.lastDigestAt).toBeUndefined() // remaining>0，没推进

    const ran2 = await svc2.scanDue()
    expect(ran2).toEqual([rec.id]) // lastDigestAt 仍未推进 → 立即又 due，不必等 cadence
    expect(store.get(rec.id)?.lastDigestAt).toBeGreaterThan(0) // 这轮把剩下的排完了，推进

    const ran3 = await svc2.scanDue()
    expect(ran3).toEqual([]) // 排完了，cadence(24h) 内不再 due
  })

  it('recruit 走 runRecruit：同步返回结果，记录被更新', async () => {
    const s = makeService(
      {
        recruit: {
          search: () => [{ id: 'src-a', description: 'A' }],
          preview: async () => ({ items: [{}] }),
          findExisting: () => null,
          subscribe: () => {},
          ensureChannel: () => {},
          unsubscribe: () => {},
          removeChannel: () => {},
        },
        llm: { ...fakeLlm, pickSources: async () => [{ sourceId: 'src-a', params: {} }] },
      },
      store,
      events,
    )
    const rec = await s.create({ goal: 'g' })
    const out = await s.recruit(rec.id)
    expect(out.subscribed.length).toBe(1)
    expect(s.get(rec.id)!.streamIds).toEqual(out.subscribed.map((x) => x.streamId))
  })

  it('recruit 未配置 → throw', async () => {
    const s = makeService({}, store, events)
    const rec = await s.create({ goal: 'g' })
    await expect(s.recruit(rec.id)).rejects.toThrow('recruit 未配置')
  })

  it('recruit 拒绝已退休意图 → throw', async () => {
    const s = makeService(
      {
        recruit: {
          search: () => [{ id: 'src-a', description: 'A' }],
          preview: async () => ({ items: [{}] }),
          findExisting: () => null,
          subscribe: () => {},
          ensureChannel: () => {},
          unsubscribe: () => {},
          removeChannel: () => {},
        },
      },
      store,
      events,
    )
    const rec = await s.create({ goal: 'g' })
    s.retire(rec.id)
    await expect(s.recruit(rec.id)).rejects.toThrow('意图已退休')
  })

  it('retire 回退：unsubscribe 招源流、删意图频道、复用流不动', async () => {
    const unsubs: string[] = []
    const removedChannels: string[] = []
    const s = makeService(
      {
        recruit: {
          search: () => [],
          preview: async () => ({ items: [] }),
          findExisting: () => null,
          subscribe: () => {},
          ensureChannel: () => {},
          unsubscribe: (sid) => unsubs.push(sid),
          removeChannel: (cid) => removedChannels.push(cid),
        },
      },
      store,
      events,
    )
    const rec = await s.create({ goal: 'g', streamIds: ['manual-1'] })
    store.put(rec.id, { streamIds: ['manual-1', 'r-1', 'r-2'], recruitedStreamIds: ['r-1', 'r-2'], channelId: 'intent-abc' })
    s.retire(rec.id)
    expect(unsubs.sort()).toEqual(['r-1', 'r-2'])
    expect(removedChannels).toEqual(['intent-abc'])
    const after = s.get(rec.id)!
    expect(after.status).toBe('retired')
    // 回退动作发过了，记录不留死 id——不然会让人误以为还挂着招源结果
    expect(after.recruitedStreamIds ?? []).toEqual([])
    expect(after.channelId).toBeUndefined()
  })

  it('retire 清理单步失败不回滚 retire', async () => {
    const s = makeService(
      {
        recruit: {
          search: () => [],
          preview: async () => ({ items: [] }),
          findExisting: () => null,
          subscribe: () => {},
          ensureChannel: () => {},
          unsubscribe: () => { throw new Error('boom') },
          removeChannel: () => {},
        },
      },
      store,
      events,
    )
    const rec = await s.create({ goal: 'g' })
    store.put(rec.id, { recruitedStreamIds: ['r-1'], channelId: 'intent-abc' })
    expect(s.retire(rec.id)!.status).toBe('retired')
  })

  it('失败轮（errors===judged>0）→ 退避递增；成功轮清零；scanDue 退避未到期跳过', async () => {
    let mode: 'fail' | 'ok' = 'fail'
    const s = makeService(
      {
        llm: {
          ...fakeLlm,
          judgeItem: async () => {
            if (mode === 'fail') throw new Error('端点挂了')
            return { relevant: false }
          },
        },
        digestDeps: { listItems: () => [{ id: `it-${Math.random()}` }], streamExists: () => true },
      },
      store,
      events,
    )
    const rec = await s.create({ goal: 'g', streamIds: ['s1'] })
    await s.digestNow(rec.id)
    const after1 = s.get(rec.id)!
    expect(after1.digestFailStreak).toBe(1)
    expect(after1.digestBackoffUntil).toBeGreaterThan(Date.now())
    expect(after1.digestBackoffUntil! - Date.now()).toBeLessThanOrEqual(30 * 60_000)
    expect(await s.scanDue()).toEqual([])
    store.put(rec.id, { digestBackoffUntil: 0 })
    await s.digestNow(rec.id)
    expect(s.get(rec.id)!.digestFailStreak).toBe(2)
    mode = 'ok'
    store.put(rec.id, { digestBackoffUntil: 0 })
    await s.digestNow(rec.id)
    const cleared = s.get(rec.id)!
    expect(cleared.digestFailStreak ?? 0).toBe(0)
    expect(cleared.digestBackoffUntil ?? 0).toBe(0)
  })
})
