import { describe, it, expect, vi } from 'vitest'
import { createKernel, quiesceKernel } from '../context.ts'
import { bindModuleHook, reportUnboundHooks, MODULE_HOOKS, type HookProbe } from './module-hooks.ts'

describe('bindModuleHook', () => {
  it('bind 同步立刻跑（包装不推迟调用时机），dispose 时 unbind', async () => {
    const kernel = createKernel()
    const bind = vi.fn()
    const unbind = vi.fn()
    bindModuleHook(kernel, bind, unbind)
    // 「早于下游构造」这条约束靠的就是这一步：effect 回调不是异步排队的。
    expect(bind).toHaveBeenCalledTimes(1)
    expect(unbind).not.toHaveBeenCalled()
    await quiesceKernel(kernel)
    expect(unbind).toHaveBeenCalledTimes(1)
  })

  it('没有内核（单测直连 bootstrap）时退化为直接 bind，行为与包装前一致', () => {
    const bind = vi.fn()
    const unbind = vi.fn()
    bindModuleHook(undefined, bind, unbind)
    expect(bind).toHaveBeenCalledTimes(1)
    expect(unbind).not.toHaveBeenCalled()
  })

  it('真的复位那个全局：绑了再销毁，探测回到未接线', async () => {
    const kernel = createKernel()
    let value: string | null = null
    bindModuleHook(kernel, () => { value = 'wired' }, () => { value = null })
    expect(value).toBe('wired')
    await quiesceKernel(kernel)
    expect(value).toBeNull()
  })
})

describe('reportUnboundHooks', () => {
  const probes = (bound: Record<string, boolean>): HookProbe[] =>
    Object.entries(bound).map(([name, b]) => ({ name, bound: () => b }))

  it('全绑 → 一个字都不打', () => {
    const log = vi.fn()
    reportUnboundHooks({ log, probes: probes({ a: true, b: true }) })
    expect(log).not.toHaveBeenCalled()
  })

  it('只剩申报过的降级档 → 也不打（故意没配不是告警）', () => {
    const log = vi.fn()
    reportUnboundHooks({ log, degraded: ['standby'], probes: probes({ standby: false, a: true }) })
    expect(log).not.toHaveBeenCalled()
  })

  it('有没申报的未接线 → 报它，并把同时降级的那些注明成 intentionally off', () => {
    const log = vi.fn()
    reportUnboundHooks({ log, degraded: ['standby'], probes: probes({ standby: false, taskDeps: false }) })
    expect(log).toHaveBeenCalledTimes(1)
    const line = log.mock.calls[0][0] as string
    expect(line).toContain('hooks unbound: taskDeps')
    expect(line).toContain('intentionally off: standby')
  })

  it('名册钉住三个模块级全局——再加一个就得在这里加一行', () => {
    expect(MODULE_HOOKS.map((p) => p.name)).toEqual(['pluginTarget', 'standby', 'taskDeps'])
  })
})
