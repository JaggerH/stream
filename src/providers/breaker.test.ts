import { describe, it, expect } from 'vitest'
import { SourceBreaker, BREAKER_COOLDOWN_CAP_MS } from './breaker.ts'

const T0 = Date.parse('2026-08-25T00:00:00Z')
const mk = (rec: { lastOutcome: 'ok' | 'empty' | 'error'; consecutiveError: number; ageMs: number } | undefined, nowOffset = 0) =>
  new SourceBreaker(
    { get: () => rec && { lastOutcome: rec.lastOutcome, consecutiveError: rec.consecutiveError, lastAt: new Date(T0 - rec.ageMs).toISOString() } },
    () => T0 + nowOffset,
  )

describe('source breaker', () => {
  it('无账本 / 无记录 / 上次成功 → 放行（冷启动全 healthy）', () => {
    expect(new SourceBreaker(undefined).admit('s').allow).toBe(true)
    expect(mk(undefined).admit('s').allow).toBe(true)
    expect(mk({ lastOutcome: 'ok', consecutiveError: 0, ageMs: 0 }).admit('s').allow).toBe(true)
  })

  it('空永不触发：连续空再多（lastOutcome empty）也放行——4 个冷门词不误伤梯子', () => {
    expect(mk({ lastOutcome: 'empty', consecutiveError: 0, ageMs: 0 }).admit('s').allow).toBe(true)
    // 账本正常记账时 consecutiveError 只在 lastOutcome==='error' 才非零（见 source-health-store.ts）,
    // 这条 consecutiveError>=1 却 lastOutcome!=='error' 的组合在正常运行下不会出现——但 admit()
    // 仍显式判两个条件，belt-and-suspenders 防账本被别处写坏。这条断言就是钉住这道第二道闸。
    expect(mk({ lastOutcome: 'empty', consecutiveError: 2, ageMs: 0 }).admit('s').allow).toBe(true)
  })

  it('1 次错：30s 内拒并报剩余，30s 后放行（这一放行就是探针）', () => {
    const denied = mk({ lastOutcome: 'error', consecutiveError: 1, ageMs: 10_000 }).admit('s')
    expect(denied).toEqual({ allow: false, retryInMs: 20_000 })
    expect(mk({ lastOutcome: 'error', consecutiveError: 1, ageMs: 30_000 }).admit('s').allow).toBe(true)
  })

  it('冷却递增：2 错→2min，3 错→10min，4+ 错封顶 30min', () => {
    expect(mk({ lastOutcome: 'error', consecutiveError: 2, ageMs: 0 }).admit('s')).toEqual({ allow: false, retryInMs: 120_000 })
    expect(mk({ lastOutcome: 'error', consecutiveError: 3, ageMs: 0 }).admit('s')).toEqual({ allow: false, retryInMs: 600_000 })
    expect(mk({ lastOutcome: 'error', consecutiveError: 99, ageMs: 0 }).admit('s')).toEqual({ allow: false, retryInMs: BREAKER_COOLDOWN_CAP_MS })
  })

  it('封顶 = 不会永久降级的数学保证：连错 99 次，封顶期一过照样放行', () => {
    expect(mk({ lastOutcome: 'error', consecutiveError: 99, ageMs: BREAKER_COOLDOWN_CAP_MS }).admit('s').allow).toBe(true)
  })

  it('成功即复位由账本承担：consecutiveError 归 0 后放行', () => {
    expect(mk({ lastOutcome: 'ok', consecutiveError: 0, ageMs: 0 }).admit('s').allow).toBe(true)
  })
})

/** plan() 是顺次策略与 ResolveEngine 共用的那一份整表裁决——兜底不变量（全员冷却时强行放行
 *  剩余最短的那一格）只有一个家，两个调用点各自映射。 */
describe('source breaker — plan（整表裁决 + 兜底不变量）', () => {
  /** 按 id 给每个源一条账本记录。 */
  const planner = (recs: Record<string, { lastOutcome: 'ok' | 'empty' | 'error'; consecutiveError: number; ageMs: number }>) =>
    new SourceBreaker(
      { get: (id) => { const r = recs[id]; return r && { lastOutcome: r.lastOutcome, consecutiveError: r.consecutiveError, lastAt: new Date(T0 - r.ageMs).toISOString() } } },
      () => T0,
    )

  it('空表 → 空数组（没有可探的，就没有兜底可言）', () => {
    expect(planner({}).plan([])).toEqual([])
  })

  it('同序返回，逐格就是 admit 的答案', () => {
    const p = planner({ b: { lastOutcome: 'error', consecutiveError: 1, ageMs: 10_000 } }).plan(['a', 'b', 'c'])
    expect(p).toEqual([{ allow: true }, { allow: false, retryInMs: 20_000 }, { allow: true }])
  })

  it('只要还有一格放行，就不动兜底（不误放冷却中的那些）', () => {
    const p = planner({
      a: { lastOutcome: 'error', consecutiveError: 3, ageMs: 0 }, // 600s
      c: { lastOutcome: 'error', consecutiveError: 1, ageMs: 0 }, // 30s
    }).plan(['a', 'b', 'c'])
    expect(p).toEqual([{ allow: false, retryInMs: 600_000 }, { allow: true }, { allow: false, retryInMs: 30_000 }])
  })

  it('全员冷却 → 放行剩余最短的那一格，**不是原序第一个**', () => {
    const p = planner({
      a: { lastOutcome: 'error', consecutiveError: 3, ageMs: 0 }, // 600s（原序第一）
      b: { lastOutcome: 'error', consecutiveError: 99, ageMs: 0 }, // 30min
      c: { lastOutcome: 'error', consecutiveError: 1, ageMs: 25_000 }, // 剩 5s ← 探这一格
    }).plan(['a', 'b', 'c'])
    expect(p).toEqual([{ allow: false, retryInMs: 600_000 }, { allow: false, retryInMs: BREAKER_COOLDOWN_CAP_MS }, { allow: true }])
  })

  it('全员冷却且剩余相同 → 探原序靠前的那一格（并列不重排）', () => {
    const rec = { lastOutcome: 'error' as const, consecutiveError: 1, ageMs: 10_000 }
    expect(planner({ a: rec, b: rec }).plan(['a', 'b'])).toEqual([{ allow: true }, { allow: false, retryInMs: 20_000 }])
  })

  it('单员全冷却 → 那一员照样被探（绝不"什么都没试就回空"）', () => {
    expect(planner({ a: { lastOutcome: 'error', consecutiveError: 99, ageMs: 0 } }).plan(['a'])).toEqual([{ allow: true }])
  })
})
