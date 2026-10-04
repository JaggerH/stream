import { describe, expect, it } from 'vitest'
import { openNetdiskDb } from '../db.ts'
import { agreementOf, SuggestionLog, summarize, type SuggestionRow } from './suggestions.ts'

const row = (p: Partial<SuggestionRow>): SuggestionRow => ({
  id: 'x', at: 1, path: '/lib/a.mp3', verdict: 'is-episode', leftKey: 'L1', quotes: 1, candidates: ['L1'], ...p,
})

describe('agreementOf', () => {
  it('is-episode：认领同一集 = 一致，认领别的集 = 分歧', () => {
    expect(agreementOf(row({ humanVerdict: 'is-episode', humanLeftKey: 'L1' }))).toBe('agree')
    expect(agreementOf(row({ humanVerdict: 'is-episode', humanLeftKey: 'L2' }))).toBe('disagree')
  })

  it('is-episode：人在 AI 指的那一集上答「不是」= 分歧；答别的集 = 没法比', () => {
    expect(agreementOf(row({ humanVerdict: 'not-episode', humanLeftKey: 'L1' }))).toBe('disagree')
    expect(agreementOf(row({ humanVerdict: 'not-episode', humanLeftKey: 'L2' }))).toBeNull()
  })

  it('none-of-these：人答「不是」= 一致，人反而认领了 = 分歧', () => {
    const base = { verdict: 'none-of-these' as const, leftKey: undefined }
    expect(agreementOf(row({ ...base, humanVerdict: 'not-episode', humanLeftKey: 'L1' }))).toBe('agree')
    expect(agreementOf(row({ ...base, humanVerdict: 'is-episode', humanLeftKey: 'L1' }))).toBe('disagree')
  })

  it('unsure / 判读失败 / 没引文 / 还没答 —— 一律不计入', () => {
    expect(agreementOf(row({ verdict: 'unsure', humanVerdict: 'is-episode', humanLeftKey: 'L1' }))).toBeNull()
    expect(agreementOf(row({ verdict: 'failed', humanVerdict: 'is-episode', humanLeftKey: 'L1' }))).toBeNull()
    expect(agreementOf(row({ quotes: 0, humanVerdict: 'is-episode', humanLeftKey: 'L1' }))).toBeNull()
    expect(agreementOf(row({}))).toBeNull()
  })
})

describe('summarize', () => {
  it('四格互斥且穷尽：相加恰好等于 countable', () => {
    const s = summarize([
      row({ humanVerdict: 'is-episode', humanLeftKey: 'L1' }),            // agree
      row({ humanVerdict: 'is-episode', humanLeftKey: 'L9' }),            // disagree
      row({ humanVerdict: 'not-episode', humanLeftKey: 'L9' }),           // 答了但没法比
      row({}),                                                            // 还没答
      row({ verdict: 'unsure' }),                                         // 出局
      row({ quotes: 0, humanVerdict: 'is-episode', humanLeftKey: 'L1' }), // 出局
    ])
    expect(s.total).toBe(6)
    expect(s.countable).toBe(4)
    expect(s.agreed + s.disagreed + s.inconclusive + s.open).toBe(s.countable)
    expect(s).toMatchObject({ agreed: 1, disagreed: 1, inconclusive: 1, open: 1 })
  })

  it('两种结论各自成一格——放开自动采纳只看 is-episode 那一格', () => {
    const s = summarize([
      row({ humanVerdict: 'is-episode', humanLeftKey: 'L1' }),
      row({ verdict: 'none-of-these', leftKey: undefined, humanVerdict: 'not-episode', humanLeftKey: 'L1' }),
    ])
    expect(s.byKind['is-episode']).toMatchObject({ countable: 1, agreed: 1, disagreed: 0 })
    expect(s.byKind['none-of-these']).toMatchObject({ countable: 1, agreed: 1, disagreed: 0 })
  })
})

describe('SuggestionLog', () => {
  const open = () => new SuggestionLog(openNetdiskDb(':memory:'))

  it('建议先落，人答了再回填', () => {
    const log = open()
    log.record({ path: '/lib/a.mp3', verdict: 'is-episode', leftKey: 'L1', quotes: 2, candidates: ['L1', 'L2'] })
    expect(log.list().items[0]).toMatchObject({ path: '/lib/a.mp3', leftKey: 'L1', candidates: ['L1', 'L2'] })
    expect(log.list().summary).toMatchObject({ countable: 1, open: 1 })

    log.answer('/lib/a.mp3', 'is-episode', 'L1')
    expect(log.list().summary).toMatchObject({ countable: 1, agreed: 1, open: 0 })
  })

  it('没听过的文件被裁决 —— 不凭空补一行', () => {
    const log = open()
    log.answer('/lib/never-listened.mp3', 'is-episode', 'L1')
    expect(log.list().items).toEqual([])
  })

  it('同一份文件听过两轮：答案记在最近那条未答的上，旧那条不动', () => {
    const log = open()
    log.record({ path: '/lib/a.mp3', verdict: 'is-episode', leftKey: 'L1', quotes: 1, candidates: ['L1'] })
    log.record({ path: '/lib/a.mp3', verdict: 'is-episode', leftKey: 'L2', quotes: 1, candidates: ['L2'] })
    log.answer('/lib/a.mp3', 'is-episode', 'L2')
    const [newest, oldest] = log.list().items
    expect(newest).toMatchObject({ leftKey: 'L2', humanLeftKey: 'L2' })
    expect(oldest!.humanVerdict).toBeUndefined()
    expect(log.list().summary).toMatchObject({ agreed: 1, open: 1 })
  })

  it('答第二次不再回填（那一轮已经答完了）', () => {
    const log = open()
    log.record({ path: '/lib/a.mp3', verdict: 'is-episode', leftKey: 'L1', quotes: 1, candidates: ['L1'] })
    log.answer('/lib/a.mp3', 'is-episode', 'L1')
    log.answer('/lib/a.mp3', 'not-episode', 'L1')
    expect(log.list().summary).toMatchObject({ agreed: 1, disagreed: 0 })
  })

  it('「都不是」逐个候选写否定：AI 指的那一集排第二发也要判成分歧', () => {
    const log = open()
    log.record({ path: '/lib/a.mp3', verdict: 'is-episode', leftKey: 'L2', quotes: 1, candidates: ['L1', 'L2'] })
    log.answer('/lib/a.mp3', 'not-episode', 'L1') // 先到的与这条建议无关
    log.answer('/lib/a.mp3', 'not-episode', 'L2') // 这一发才是在否定它
    expect(log.list().summary).toMatchObject({ disagreed: 1, inconclusive: 0 })
  })

  it('多发否定里没有一发落在 AI 那一集上 —— 停在「没法比」，不硬凑成分歧', () => {
    const log = open()
    log.record({ path: '/lib/a.mp3', verdict: 'is-episode', leftKey: 'L9', quotes: 1, candidates: ['L1', 'L2'] })
    log.answer('/lib/a.mp3', 'not-episode', 'L1')
    log.answer('/lib/a.mp3', 'not-episode', 'L2')
    expect(log.list().summary).toMatchObject({ disagreed: 0, inconclusive: 1 })
  })

  it('筛选与分页只切 items，汇总永远是全表', () => {
    const log = open()
    for (const k of ['L1', 'L2', 'L3']) {
      log.record({ path: `/lib/${k}.mp3`, verdict: 'is-episode', leftKey: k, quotes: 1, candidates: [k] })
    }
    log.answer('/lib/L1.mp3', 'is-episode', 'L1')  // agree
    log.answer('/lib/L2.mp3', 'is-episode', 'zzz') // disagree

    const bad = log.list({ agreement: 'disagree' })
    expect(bad.items.map((i) => i.path)).toEqual(['/lib/L2.mp3'])
    expect(bad.summary).toMatchObject({ total: 3, agreed: 1, disagreed: 1, open: 1 })

    const first = log.list({ limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).toBeTypeOf('number')
    expect(first.summary.total).toBe(3)
    const second = log.list({ limit: 1, cursor: first.nextCursor })
    expect(second.items[0]!.path).not.toBe(first.items[0]!.path)
  })

  it('state 分开「还没答」和「已经答了」', () => {
    const log = open()
    log.record({ path: '/lib/a.mp3', verdict: 'is-episode', leftKey: 'L1', quotes: 1, candidates: ['L1'] })
    log.record({ path: '/lib/b.mp3', verdict: 'is-episode', leftKey: 'L1', quotes: 1, candidates: ['L1'] })
    log.answer('/lib/a.mp3', 'is-episode', 'L1')
    expect(log.list({ state: 'answered' }).items.map((i) => i.path)).toEqual(['/lib/a.mp3'])
    expect(log.list({ state: 'open' }).items.map((i) => i.path)).toEqual(['/lib/b.mp3'])
  })
})
