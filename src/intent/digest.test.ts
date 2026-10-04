// src/intent/digest.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntentStore } from './store.ts'
import { runDigestRound, type DigestDeps } from './digest.ts'
import type { IntentLlm } from './llm.ts'
import type { IntentRecord } from './types.ts'

const fakeLlm = (overrides?: Partial<IntentLlm>): IntentLlm => ({
  parseIntent: async () => ({ criteria: 'c' }),
  judgeItem: async (_c, text) => (text.includes('AI') ? { relevant: true, summary: `摘要:${text.slice(0, 10)}` } : { relevant: false }),
  mergeDossier: async (_g, current, entries) => `${current}\n${entries.map((e) => e.title).join(',')}`.trim(),
  pickSources: async () => [],
  ...overrides,
})

describe('runDigestRound', () => {
  let store: IntentStore
  let events: Array<{ type: string; title?: string; dedupeKey?: string }>
  beforeEach(() => {
    store = new IntentStore(mkdtempSync(join(tmpdir(), 'intent-digest-')))
    events = []
  })

  const deps = (items: Record<string, Array<{ id: string; title?: string; body_text?: string }>>, llm = fakeLlm()): DigestDeps => ({
    store,
    llm,
    listItems: (sid) => items[sid] ?? [],
    streamExists: (sid) => sid in items,
    events: { append: (e) => events.push(e) },
  })

  it('只消化账本外的新条目；relevant 入档案；发 intent.digest 事件', async () => {
    const rec = store.create({ goal: '盯 AI 硬件', criteria: 'c', streamIds: ['s1'] })
    store.appendLedger(rec.id, { old1: { relevant: true, at: 1 } })
    const d = deps({ s1: [{ id: 'old1', title: '旧', body_text: 'AI' }, { id: 'n1', title: '新AI', body_text: 'AI 芯片' }, { id: 'n2', title: '无关', body_text: '猫' }] })
    const out = await runDigestRound(rec, d)
    expect(out.judged).toBe(2) // old1 跳过
    expect(out.relevantNew).toBe(1)
    const led = store.ledger(rec.id)
    expect(led.n1.relevant).toBe(true)
    expect(led.n2.relevant).toBe(false)
    expect(store.dossier(rec.id)).toContain('新AI')
    expect(events.some((e) => e.type === 'intent.digest' && e.dedupeKey === `intent:${rec.id}:digest:2`)).toBe(true)
    expect(store.get(rec.id)?.lastDigestAt).toBeGreaterThan(0)
  })

  it('开轮重读记录：入队后新挂的 stream 也会被消化', async () => {
    // stale 快照里只有 s1；store 里的最新记录挂了 s1+s2
    const rec = store.create({ goal: 'g', criteria: 'c', streamIds: ['s1'] })
    store.put(rec.id, { streamIds: ['s1', 's2'] })
    const stale = { ...rec, streamIds: ['s1'] }
    const items = { s1: [{ id: 's1-item', title: 's1' }], s2: [{ id: 's2-item', title: 's2' }] }
    await runDigestRound(stale, deps(items, fakeLlm({ judgeItem: async () => ({ relevant: false }) })))
    expect(Object.keys(store.ledger(rec.id)).sort()).toEqual(['s1-item', 's2-item'])
  })

  it('记录已被删 → 返回全零 outcome，不写任何东西', async () => {
    const ghost: IntentRecord = { id: 'gone', goal: 'g', criteria: 'c', streamIds: ['s1'], cadenceHours: 24, status: 'active', createdAt: 0 }
    const out = await runDigestRound(ghost, deps({ s1: [{ id: 'a', title: 'AI' }] }))
    expect(out).toEqual({ judged: 0, relevantNew: 0, errors: 0, remaining: 0, windowSaturated: [] })
  })

  it('digest 事件报累计：title 含新增与累计数，dedupeKey 编入累计终态', async () => {
    const rec = store.create({ goal: '跟踪AI硬件', criteria: 'c', streamIds: ['s1'] })
    store.appendLedger(rec.id, { old1: { relevant: true, at: 1 }, old2: { relevant: false, at: 1 } })
    await runDigestRound(rec, deps({ s1: [{ id: 'new1', title: 'AI新品' }] }))
    expect(events[0].title).toContain('新增 1 条相关（累计 2）')
    expect(events[0].dedupeKey).toBe(`intent:${rec.id}:digest:2`)
  })

  it('单条判定失败：跳过不入账本，计入 errors，其余照常', async () => {
    const rec = store.create({ goal: 'g', criteria: 'c', streamIds: ['s1'] })
    const llm = fakeLlm({
      judgeItem: async (_c, text) => {
        if (text.includes('炸')) throw new Error('boom')
        return { relevant: false }
      },
    })
    const out = await runDigestRound(rec, deps({ s1: [{ id: 'a', title: '炸' }, { id: 'b', title: '好' }] }, llm))
    expect(out.errors).toBe(1)
    const led = store.ledger(rec.id)
    expect(led.a).toBeUndefined()
    expect(led.b).toBeDefined()
  })

  it('无新相关条目：不改档案、不发 intent.digest 事件，但 lastDigestAt 更新', async () => {
    const rec = store.create({ goal: 'g', criteria: 'c', streamIds: ['s1'] })
    store.writeDossier(rec.id, '原档案')
    await runDigestRound(rec, deps({ s1: [{ id: 'x', title: '猫' }] }))
    expect(store.dossier(rec.id)).toBe('原档案')
    expect(events.filter((e) => e.type === 'intent.digest')).toHaveLength(0)
    expect(store.get(rec.id)?.lastDigestAt).toBeGreaterThan(0)
  })

  it('mergeDossier 抛出：整轮 rethrow，账本为空，档案未变，lastDigestAt 未更新', async () => {
    const rec = store.create({ goal: 'g', criteria: 'c', streamIds: ['s1'] })
    store.writeDossier(rec.id, '原档案')
    const llm = fakeLlm({ mergeDossier: async () => { throw new Error('merge boom') } })
    const d = deps({ s1: [{ id: 'n1', title: 'AI 新闻', body_text: 'AI' }] }, llm)
    await expect(runDigestRound(rec, d)).rejects.toThrow('merge boom')
    expect(store.ledger(rec.id)).toEqual({})
    expect(store.dossier(rec.id)).toBe('原档案')
    expect(store.get(rec.id)?.lastDigestAt).toBeUndefined()
  })

  it('stream 已删：跳过并从记录里清掉', async () => {
    const rec = store.create({ goal: 'g', criteria: 'c', streamIds: ['gone', 's1'] })
    await runDigestRound(rec, deps({ s1: [] }))
    expect(store.get(rec.id)?.streamIds).toEqual(['s1'])
  })

  it('maxJudged 截断：本轮只判够数的，剩下的算 remaining，下轮接着判（F3）', async () => {
    const rec = store.create({ goal: 'g', criteria: 'c', streamIds: ['s1'] })
    const items = { s1: [{ id: 'a', title: 'AI 1' }, { id: 'b', title: 'AI 2' }, { id: 'c', title: 'AI 3' }] }
    const d = { ...deps(items), maxJudged: 2 }
    const out1 = await runDigestRound(rec, d)
    expect(out1.judged).toBe(2)
    expect(out1.remaining).toBe(1)
    expect(Object.keys(store.ledger(rec.id))).toHaveLength(2)

    const out2 = await runDigestRound(rec, d)
    expect(out2.judged).toBe(1) // 剩下那条被下一轮判掉
    expect(out2.remaining).toBe(0)
    expect(Object.keys(store.ledger(rec.id))).toHaveLength(3)
  })

  it('remaining > 0 时不推进 lastDigestAt；排完（remaining=0）才推进（复审 Important）', async () => {
    const rec = store.create({ goal: 'g', criteria: 'c', streamIds: ['s1'] })
    const items = { s1: [{ id: 'a', title: 'AI 1' }, { id: 'b', title: 'AI 2' }, { id: 'c', title: 'AI 3' }] }
    const d = { ...deps(items), maxJudged: 2 }

    const out1 = await runDigestRound(rec, d)
    expect(out1.remaining).toBe(1)
    expect(store.get(rec.id)?.lastDigestAt).toBeUndefined() // 没排完，不推进——让下一次 scanDue 立即接着排

    const out2 = await runDigestRound(rec, d)
    expect(out2.remaining).toBe(0)
    expect(store.get(rec.id)?.lastDigestAt).toBeGreaterThan(0) // 排完了才推进
  })

  it('不传 maxJudged 时默认 100，不截断（现有条数远小于默认值）', async () => {
    const rec = store.create({ goal: 'g', criteria: 'c', streamIds: ['s1'] })
    const out = await runDigestRound(rec, deps({ s1: [{ id: 'a', title: 'AI' }] }))
    expect(out.remaining).toBe(0)
  })

  it('windowSize 已满且整窗未判 → windowSaturated 报出该 stream 并记日志（F4）', async () => {
    const rec = store.create({ goal: 'g', criteria: 'c', streamIds: ['s1'] })
    const items = { s1: Array.from({ length: 3 }, (_, i) => ({ id: `n${i}`, title: 'AI' })) }
    const logs: string[] = []
    const d = { ...deps(items), windowSize: 3, log: (m: string) => logs.push(m) }
    const out = await runDigestRound(rec, d)
    expect(out.windowSaturated).toEqual(['s1'])
    expect(logs.some((m) => m.includes('s1'))).toBe(true)
  })

  it('windowSize 给了但窗口未满或有已判条目 → 不报饱和', async () => {
    const rec = store.create({ goal: 'g', criteria: 'c', streamIds: ['s1'] })
    // 窗口大小 5，只回 2 条 → 未满，不算饱和
    const out1 = await runDigestRound(rec, { ...deps({ s1: [{ id: 'a', title: 'x' }, { id: 'b', title: 'y' }] }), windowSize: 5 })
    expect(out1.windowSaturated).toEqual([])

    // 窗口大小 3，回满 3 条，但其中一条已在账本里 → 不算"整窗未判"，不报饱和
    const rec2 = store.create({ goal: 'g2', criteria: 'c', streamIds: ['s1'] })
    store.appendLedger(rec2.id, { m0: { relevant: false, at: 1 } })
    const items2 = { s1: [{ id: 'm0', title: 'x' }, { id: 'm1', title: 'y' }, { id: 'm2', title: 'z' }] }
    const out2 = await runDigestRound(rec2, { ...deps(items2), windowSize: 3 })
    expect(out2.windowSaturated).toEqual([])
  })

  it('不传 windowSize → 不做饱和检测', async () => {
    const rec = store.create({ goal: 'g', criteria: 'c', streamIds: ['s1'] })
    const items = { s1: Array.from({ length: 3 }, (_, i) => ({ id: `n${i}`, title: 'AI' })) }
    const out = await runDigestRound(rec, deps(items))
    expect(out.windowSaturated).toEqual([])
  })
})
