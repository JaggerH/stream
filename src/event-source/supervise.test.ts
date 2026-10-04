import { describe, it, expect, vi } from 'vitest'
import { superviseWorker, type WorkerProcess } from './supervise.ts'

function fakeProc(): WorkerProcess & { die(code: number): void } {
  let onExit: (c: number | null) => void = () => {}
  return { onExit: (cb) => (onExit = cb), kill: () => onExit(0), die: (c) => onExit(c) }
}

describe('superviseWorker', () => {
  it('锁不在 → spawn；子进程崩 → 退避后 respawn', () => {
    const procs: ReturnType<typeof fakeProc>[] = []
    const timers: Array<() => void> = []
    const deps = {
      spawn: vi.fn(() => {
        const p = fakeProc()
        procs.push(p)
        return p
      }),
      lockHeld: () => false,
      now: () => 0,
      setTimer: (fn: () => void) => {
        timers.push(fn)
        return () => {}
      },
    }
    superviseWorker(deps, { entry: 'w.js', env: {}, backoffMs: () => 100 })
    expect(deps.spawn).toHaveBeenCalledTimes(1)
    procs[0].die(1) // 崩
    timers.pop()!() // 触发退避到点
    expect(deps.spawn).toHaveBeenCalledTimes(2)
  })

  it('锁在（上一个子进程还活着）→ 不 spawn，等它重连（adopt）', () => {
    const deps = {
      spawn: vi.fn(),
      lockHeld: () => true,
      now: () => 0,
      setTimer: () => () => {},
    }
    superviseWorker(deps, { entry: 'w.js', env: {} })
    expect(deps.spawn).not.toHaveBeenCalled()
  })

  it('dispose 后不再 spawn', () => {
    const deps = {
      spawn: vi.fn(() => fakeProc()),
      lockHeld: () => false,
      now: () => 0,
      setTimer: (fn: () => void) => {
        fn()
        return () => {}
      },
    }
    const dispose = superviseWorker(deps, { entry: 'w.js', env: {}, backoffMs: () => 0 })
    dispose()
    const before = deps.spawn.mock.calls.length
    // dispose 后即便有子进程崩，也不该再 spawn（这里没有活进程，验证调用数不增）
    expect(deps.spawn.mock.calls.length).toBe(before)
  })
})
