import { describe, it, expect } from 'vitest'
import { FacilityCooldown, CoolingDownError } from './facility-cooldown.ts'
import { EnvironmentUnavailableError } from '../failure.ts'

/** 可控时钟：真实墙钟在这台机器上会飘（单调时钟偏快约 7.6%），退避的倍数不该靠"跑得够快"来验。 */
function at(t: { ms: number }) {
  return new FacilityCooldown({ now: () => t.ms })
}

describe('FacilityCooldown — 被拦之后先别去打', () => {
  it('没被拦过 → 一路放行', () => {
    const t = { ms: 0 }
    expect(() => at(t).assertReady('google')).not.toThrow()
  })

  it('被拦一次 → 冷却 60s，期间抛 CoolingDownError；到点自己放行', () => {
    const t = { ms: 0 }
    const cd = at(t)
    cd.blocked('google', '撞上 /sorry 拦截页')
    expect(() => cd.assertReady('google')).toThrow(CoolingDownError)
    t.ms = 59_000
    expect(() => cd.assertReady('google')).toThrow(CoolingDownError)
    t.ms = 60_001
    expect(() => cd.assertReady('google')).not.toThrow()
  })

  it('冷却只圈住被拦的那个 facility，别的照跑（这正是备胎顶得上的前提）', () => {
    const t = { ms: 0 }
    const cd = at(t)
    cd.blocked('google', 'x')
    expect(() => cd.assertReady('google')).toThrow()
    expect(() => cd.assertReady('brave')).not.toThrow()
  })

  it('连着被拦 → 翻倍（60s → 120s → 240s），封顶 30 分钟', () => {
    const t = { ms: 0 }
    const cd = at(t)
    cd.blocked('g', 'x')
    t.ms = 60_001 // 第一轮到点
    cd.blocked('g', 'x')
    t.ms += 119_000
    expect(() => cd.assertReady('g')).toThrow() // 还在第二轮的 120s 里
    t.ms += 2_000
    cd.blocked('g', 'x') // 第三轮：240s
    t.ms += 239_000
    expect(() => cd.assertReady('g')).toThrow()
    t.ms += 2_000
    // 一路撞到封顶：再撞很多次也不会超过 30 分钟
    for (let i = 0; i < 20; i++) {
      cd.blocked('g', 'x')
      t.ms += 30 * 60_000 + 1
    }
    cd.blocked('g', 'x')
    t.ms += 30 * 60_000 + 1
    expect(() => cd.assertReady('g')).not.toThrow()
  })

  it('冷却期内又被拦（并发的另一发）不额外加码 —— 否则一次并发就能顶到封顶', () => {
    const t = { ms: 0 }
    const cd = at(t)
    cd.blocked('g', 'x')
    cd.blocked('g', 'x') // 同一轮里的第二发
    cd.blocked('g', 'x')
    t.ms = 60_001
    expect(() => cd.assertReady('g')).not.toThrow() // 仍然只是第一轮的 60s
  })

  it('跑成一次 → 清零，下一次被拦从 60s 重新起算', () => {
    const t = { ms: 0 }
    const cd = at(t)
    cd.blocked('g', 'x')
    t.ms = 60_001
    cd.blocked('g', 'x') // 第二轮 120s
    cd.cleared('g')
    expect(() => cd.assertReady('g')).not.toThrow()
    cd.blocked('g', 'x')
    t.ms += 60_001
    expect(() => cd.assertReady('g')).not.toThrow() // 又是 60s，不是 240s
  })

  it('冷却必须**说得出自己是冷却**，且不邀请重试', () => {
    // 这一格是关键：冷却如果退化成一个空结果，「整条腿在冷却」和「这次没搜到」就长得一模一样，
    // 而它们对下一步的意思完全相反。
    const t = { ms: 0 }
    const cd = at(t)
    cd.blocked('google', '撞上 /sorry 拦截页')
    try {
      cd.assertReady('google')
      throw new Error('该抛没抛')
    } catch (e) {
      const err = e as CoolingDownError
      expect(err).toBeInstanceOf(CoolingDownError)
      // 「不记失败、不记成功、只出声」那一档：冷却期内连标签都没开，既不是源坏了，也不是没搜到。
      expect(err).toBeInstanceOf(EnvironmentUnavailableError)
      expect(err.message).toContain('冷却')
      expect(err.message).toContain('/sorry')
      expect(err.message).toContain('60s')
      // 这句话会一路传到模型面前，读到"再试"它就真的会再打一次同一条查询。
      expect(err.message).not.toContain('稍后')
      expect(err.message).not.toContain('再试')
    }
  })

  it('给人看的那句话里不许出现原始报错和 JS 栈', () => {
    // 活体里这句话真的长成过：一句人话后面拖着英文报错 + `at <anonymous>:1:1569`。
    // 原文不是不要了——它留在 `because` 字段上给排错用，只是不进面向人的提示。
    const raw = '站方在动作之后弹出风控挑战：Error: douyin: search/item did not settle in 5s — risk-control challenge (captcha overlay) swallows the promise\n    at <anonymous>:1:1569'
    const err = new CoolingDownError('douyin', 39_000, raw)
    expect(err.message).toContain('站方在动作之后弹出风控挑战')
    expect(err.message).not.toContain('at <anonymous>')
    expect(err.message).not.toContain('Error:')
    expect(err.message).not.toContain('\n')
    expect(err.message).toContain('39s')
    // 原文一个字没少，排错照旧看得到
    expect(err.because).toBe(raw)
  })

  it('短理由原样保留——别为了防栈痕把正常的话也切了', () => {
    const err = new CoolingDownError('douyin', 60_000, '撞上 /sorry')
    expect(err.message).toContain('撞上 /sorry')
  })
})

describe('FacilityCooldown × 撞墙台账 —— 底数和封顶由实测喂', () => {
  /** 假台账：不碰文件系统，只负责回答"学到了什么"并记下被调用的账。 */
  function ledgerOf(learned: { baseMs: number; capMs: number }) {
    const calls: Array<{ kind: 'blocked' | 'recovered'; facility: string; spentLastHour?: number }> = []
    return {
      calls,
      blocked(facility: string, _because: string, ctx?: { spentLastHour?: number }) {
        calls.push({ kind: 'blocked', facility, spentLastHour: ctx?.spentLastHour })
      },
      recovered(facility: string) {
        calls.push({ kind: 'recovered', facility })
      },
      learn: () => ({ ...learned, samples: 1 }),
    }
  }

  it('学到「这个站点 3 分钟就凉」→ 第一次退让就是 3 分钟，不是写死的 60s', () => {
    const t = { ms: 0 }
    const cd = new FacilityCooldown({ now: () => t.ms }, ledgerOf({ baseMs: 180_000, capMs: 30 * 60_000 }))
    cd.blocked('g', 'x')
    t.ms = 179_000
    expect(() => cd.assertReady('g')).toThrow(CoolingDownError)
    t.ms = 181_000
    expect(() => cd.assertReady('g')).not.toThrow()
  })

  it('学到「见过 3h10m 还没凉」→ 封顶跟着抬，30 分钟不再是天花板', () => {
    const t = { ms: 0 }
    const capMs = 6 * 3600_000
    const cd = new FacilityCooldown({ now: () => t.ms }, ledgerOf({ baseMs: 60_000, capMs }))
    for (let i = 0; i < 20; i++) {
      cd.blocked('douyin', 'x')
      t.ms += capMs + 1 // 每轮都等到点，好让 strikes 一路往上翻
    }
    cd.blocked('douyin', 'x')
    t.ms += 45 * 60_000 // 远超旧的 30 分钟封顶
    expect(() => cd.assertReady('douyin')).toThrow(CoolingDownError)
    t.ms += capMs
    expect(() => cd.assertReady('douyin')).not.toThrow()
  })

  it('这一发本身也是一个"还没凉"的观察 —— 先记账再取数', () => {
    const t = { ms: 0 }
    const l = ledgerOf({ baseMs: 60_000, capMs: 30 * 60_000 })
    const cd = new FacilityCooldown({ now: () => t.ms }, l)
    cd.blocked('g', 'x', { spentLastHour: 97 })
    expect(l.calls).toEqual([{ kind: 'blocked', facility: 'g', spentLastHour: 97 }])
  })

  it('跑成一次 → 给台账封口（恢复时间的上界就是这么来的）', () => {
    const t = { ms: 0 }
    const l = ledgerOf({ baseMs: 60_000, capMs: 30 * 60_000 })
    const cd = new FacilityCooldown({ now: () => t.ms }, l)
    cd.blocked('g', 'x')
    cd.cleared('g')
    expect(l.calls.at(-1)).toEqual({ kind: 'recovered', facility: 'g' })
  })

  it('没有台账 → 一字不变地退回 60s/30min 阶梯', () => {
    const t = { ms: 0 }
    const cd = new FacilityCooldown({ now: () => t.ms })
    cd.blocked('g', 'x')
    t.ms = 59_000
    expect(() => cd.assertReady('g')).toThrow()
    t.ms = 60_001
    expect(() => cd.assertReady('g')).not.toThrow()
  })
})
