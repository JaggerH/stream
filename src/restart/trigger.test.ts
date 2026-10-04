import { describe, it, expect, vi } from 'vitest'
import { makeRestartTrigger, type Shutdown } from './trigger.ts'
import type { RestartMode } from './policy.ts'

function harness(mode: RestartMode, shutdown: Shutdown | undefined) {
  const scheduled: (() => void)[] = []
  const exit = vi.fn()
  const reexec = vi.fn()
  const touch = vi.fn()
  const trigger = makeRestartTrigger({
    mode,
    shutdown: () => shutdown,
    schedule: (fn) => { scheduled.push(fn) },
    exit: exit as never,
    reexec,
    touch,
    log: () => {},
  })
  return { trigger, scheduled, exit, reexec, touch }
}

describe('makeRestartTrigger', () => {
  it('shutdown 还没接好（开机窗口）→ reject，不排任何关停；不能变成 setImmediate 里的未捕获异常', async () => {
    const h = harness('reexec', undefined)
    await expect(h.trigger()).rejects.toThrow(/booting/)
    expect(h.scheduled).toHaveLength(0)
  })

  it('先 resolve mode，关停只排到下一拍；supervised 的收尾是 exit(75)', async () => {
    const shutdown = vi.fn(async (finale: () => void) => { finale() })
    const h = harness('supervised', shutdown)
    await expect(h.trigger()).resolves.toBe('supervised')
    expect(shutdown).not.toHaveBeenCalled()      // 同步没开始关——202 还得从这条 socket 出去
    h.scheduled.forEach((fn) => fn())
    expect(shutdown).toHaveBeenCalledWith(expect.any(Function), 'restart(supervised)')
    expect(h.exit).toHaveBeenCalledWith(75)
    expect(h.reexec).not.toHaveBeenCalled()
  })

  it('reexec 的收尾：先起新的一份，再 exit(0)', async () => {
    const order: string[] = []
    const shutdown = vi.fn(async (finale: () => void) => { finale() })
    const h = harness('reexec', shutdown)
    h.reexec.mockImplementation(() => { order.push('reexec') })
    h.exit.mockImplementation(() => { order.push('exit') })
    await expect(h.trigger()).resolves.toBe('reexec')
    h.scheduled.forEach((fn) => fn())
    expect(order).toEqual(['reexec', 'exit'])
    expect(h.exit).toHaveBeenCalledWith(0)
  })

  // 监视器不看退出码：自己退了它不拉起。所以 watch 档只碰哨兵，SIGTERM 由监视器发、优雅关走信号处理器。
  it('watch 的收尾：resolve watch、不自己关、下一拍碰哨兵', async () => {
    const shutdown = vi.fn(async (finale: () => void) => { finale() })
    const h = harness('watch', shutdown)
    await expect(h.trigger()).resolves.toBe('watch')
    expect(h.touch).not.toHaveBeenCalled()          // 同步不碰——202 还得先出去
    h.scheduled.forEach((fn) => fn())
    expect(h.touch).toHaveBeenCalledTimes(1)
    expect(shutdown).not.toHaveBeenCalled()
    expect(h.exit).not.toHaveBeenCalled()
    expect(h.reexec).not.toHaveBeenCalled()
  })
})
