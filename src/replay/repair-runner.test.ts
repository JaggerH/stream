import { describe, it, expect } from 'vitest'
import { forwardingRepairRunner, LoggingRepairRunner } from './repair-runner.ts'
import type { RepairRunner } from './repair-runner.ts'

describe('LoggingRepairRunner', () => {
  it('logs a repair-needed line naming the source, reason, and the skill', async () => {
    const lines: string[] = []
    const runner = new LoggingRepairRunner((...a) => lines.push(a.join(' ')))
    await runner.requestRepair({ sourceId: 'xhs-search', reason: 'no items array' })
    expect(lines[0]).toMatch(/repair-needed/)
    expect(lines[0]).toMatch(/xhs-search/)
    expect(lines[0]).toMatch(/no items array/)
    expect(lines[0]).toMatch(/building-browser-recipes/)
  })
})

describe('状态机的三个提议口', () => {
  const collect = () => {
    const lines: string[] = []
    return { lines, log: (...a: unknown[]) => lines.push(a.join(' ')) }
  }

  it('proposeState 打日志并点明没有改 recipe', async () => {
    const { lines, log } = collect()
    await new LoggingRepairRunner(log).proposeState({
      sourceId: 'qq/send',
      kind: 'state',
      reason: '认不出当前界面',
      observed: ['dom:.foo'],
    })
    expect(lines[0]).toContain('qq/send')
    expect(lines[0]).toContain('认不出当前界面')
    expect(lines[0]).toContain('没有改 recipe')
  })

  it('proposeDiscriminator 带上撞车的那几个状态', async () => {
    const { lines, log } = collect()
    await new LoggingRepairRunner(log).proposeDiscriminator({
      sourceId: 'qq/send',
      kind: 'discriminator',
      reason: '多个状态同时命中',
      candidates: ['a', 'b'],
      observed: [],
    })
    expect(lines[0]).toContain('a、b')
  })

  it('proposeTransition 带上目标状态', async () => {
    const { lines, log } = collect()
    await new LoggingRepairRunner(log).proposeTransition({
      sourceId: 'qq/send',
      kind: 'transition',
      reason: '认出来了但没有到目标的路',
      from: 'a',
      goal: 'z',
      observed: [],
    })
    expect(lines[0]).toContain('a')
    expect(lines[0]).toContain('z')
  })
})

describe('forwardingRepairRunner', () => {
  it('每次调用时现取目标；目标缺席落到 fallback', async () => {
    const { forwardingRepairRunner, LoggingRepairRunner } = await import('./repair-runner.ts')
    const lines: string[] = []
    let target: RepairRunner | undefined
    const fwd = forwardingRepairRunner(() => target, new LoggingRepairRunner((...a) => lines.push(a.join(' '))))
    await fwd.requestRepair({ sourceId: 'a', reason: 'r' })
    expect(lines).toHaveLength(1)
    const got: string[] = []
    target = { requestRepair: async (j) => { got.push(j.sourceId) }, proposeLocator: async () => {}, proposeState: async () => {}, proposeDiscriminator: async () => {}, proposeTransition: async () => {} }
    await fwd.requestRepair({ sourceId: 'b', reason: 'r' })
    expect(got).toEqual(['b'])
    expect(lines).toHaveLength(1)
  })

  /**
   * 五个口逐个钉：转发层是「把 N 个方法假装成一个对象」的那类结构，漏转发一个不会报错，
   * 只会让那一路的提议永远落进 fallback 的日志里——而"收不到"和"没有提议"长得一模一样。
   */
  it.each([
    ['requestRepair'], ['proposeLocator'], ['proposeState'], ['proposeDiscriminator'], ['proposeTransition'],
  ] as const)('%s 落到目标的同名方法', async (method) => {
    const hit: string[] = []
    const target = Object.fromEntries(
      ['requestRepair', 'proposeLocator', 'proposeState', 'proposeDiscriminator', 'proposeTransition']
        .map((m) => [m, async () => { hit.push(m) }]),
    ) as unknown as RepairRunner
    const fwd = forwardingRepairRunner(() => target, new LoggingRepairRunner(() => {}))
    await (fwd[method] as (a: unknown) => Promise<void>)({ sourceId: 'a', reason: 'r', observed: [] })
    expect(hit).toEqual([method])
  })
})
