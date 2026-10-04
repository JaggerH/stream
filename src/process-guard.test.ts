import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { installProcessGuards, describeThrown } from './process-guard.ts'
import type { EventInput } from './events/store.ts'

/**
 * 这几条钉的是「它确实吵」，不是「进程没退」——后者是最容易假绿的写法（把 emit 那行删掉、
 * 把日志降成一行摘要，"进程没退" 照样绿）。所以每一条都同时断言**完整堆栈进了日志**
 * 和**事件真的发出去了**。
 *
 * 钩子挂在注入的假 emitter 上，不碰真 `process`：往真 process 上挂 uncaughtException
 * 会把 vitest 自己的失败处理一起接管。
 */
function harness() {
  const target = new EventEmitter() as unknown as Pick<NodeJS.Process, 'on' | 'off'>
  const logs: string[] = []
  const events: EventInput[] = []
  const exit = vi.fn()
  const off = installProcessGuards({
    target,
    logError: (m) => logs.push(m),
    notify: (e) => events.push(e),
    exit,
  })
  return { target: target as unknown as EventEmitter, logs, events, exit, off }
}

/** 一个有真实堆栈、且堆栈里含可断言指纹的 Error。 */
function thrownFromNamedFrame(): Error {
  function orphanedHarvestStep(): never { throw new Error('worker spawn failed') }
  try { orphanedHarvestStep() } catch (e) { return e as Error }
  throw new Error('unreachable')
}

describe('installProcessGuards', () => {
  it('unhandledRejection：完整堆栈进 error 日志 + 发一条 error 级事件，进程不退', () => {
    const h = harness()
    const err = thrownFromNamedFrame()
    h.target.emit('unhandledRejection', err, Promise.resolve())

    // 1. 日志：不是 String(err) 的一行摘要，得有调用帧。
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toContain('unhandledRejection')
    expect(h.logs[0]).toContain('worker spawn failed')
    expect(h.logs[0]).toContain('orphanedHarvestStep')
    expect(h.logs[0]!.split('\n').length).toBeGreaterThan(1)

    // 2. 事件：真发出去了，error 级，堆栈带在 detail 里（复制出去贴给 AI 的那一份）。
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({ type: 'process.unhandled-rejection', severity: 'error' })
    expect(h.events[0]!.detail).toContain('kind=unhandledRejection')
    expect(h.events[0]!.detail).toContain('orphanedHarvestStep')

    // 3. 不退出——这道网的存在理由。
    expect(h.exit).not.toHaveBeenCalled()
    h.off()
  })

  it('非 Error 的拒绝值也看得清是什么，并如实说没有堆栈', () => {
    const h = harness()
    h.target.emit('unhandledRejection', { code: 'ENOENT', path: '/no/such' }, Promise.resolve())
    expect(h.logs[0]).toContain('ENOENT')
    expect(h.logs[0]).toContain('/no/such')
    expect(h.logs[0]).toContain('没有堆栈')
    expect(h.events[0]!.detail).toContain('ENOENT')
    h.off()
  })

  it('uncaughtException：同样吵，但记录 + 通知之后仍然退出(1)', () => {
    const h = harness()
    h.target.emit('uncaughtException', thrownFromNamedFrame())

    expect(h.logs[0]).toContain('uncaughtException')
    expect(h.logs[0]).toContain('orphanedHarvestStep')
    expect(h.events[0]).toMatchObject({ type: 'process.uncaught-exception', severity: 'error' })
    expect(h.events[0]!.detail).toContain('orphanedHarvestStep')
    // 事件先落盘（EventStore 是 writeFileSync）再退出，顺序反了用户就看不到"上次怎么没的"。
    expect(h.exit).toHaveBeenCalledWith(1)
    h.off()
  })

  it('通知本身抛错不许再掀翻一次：日志照留，unhandledRejection 仍不退出、uncaught 仍退出', () => {
    const target = new EventEmitter() as unknown as Pick<NodeJS.Process, 'on' | 'off'>
    const logs: string[] = []
    const exit = vi.fn()
    const off = installProcessGuards({
      target,
      logError: (m) => logs.push(m),
      notify: () => { throw new Error('events store is down') },
      exit,
    })
    const em = target as unknown as EventEmitter
    expect(() => em.emit('unhandledRejection', new Error('x'), Promise.resolve())).not.toThrow()
    expect(exit).not.toHaveBeenCalled()
    expect(() => em.emit('uncaughtException', new Error('y'))).not.toThrow()
    expect(exit).toHaveBeenCalledWith(1)
    expect(logs).toHaveLength(2)
    off()
  })

  it('没有分类忽略这回事：同一逃逸口的第二次仍然照发（dedupe 交给事件层，不在这里过滤）', () => {
    const h = harness()
    const err = thrownFromNamedFrame()
    h.target.emit('unhandledRejection', err, Promise.resolve())
    h.target.emit('unhandledRejection', err, Promise.resolve())
    expect(h.events).toHaveLength(2)
    expect(h.logs).toHaveLength(2)
    // dedupeKey 按堆栈首行分组：同一个口合并，不同的口各报各的。
    expect(h.events[0]!.dedupeKey).toBe(h.events[1]!.dedupeKey)
    const other = h.events[0]!.dedupeKey
    h.target.emit('unhandledRejection', new Error('别处的口'), Promise.resolve())
    expect(h.events[2]!.dedupeKey).not.toBe(other)
    h.off()
  })

  it('off() 摘干净：撤销之后钩子不再响应', () => {
    const h = harness()
    h.off()
    h.target.emit('unhandledRejection', new Error('x'), Promise.resolve())
    expect(h.logs).toHaveLength(0)
    expect(h.events).toHaveLength(0)
  })

  it('describeThrown 展开 cause，不把真因吃掉', () => {
    const text = describeThrown(new Error('fetch failed', { cause: new Error('ECONNREFUSED 127.0.0.1:8901') }))
    expect(text).toContain('fetch failed')
    expect(text).toContain('ECONNREFUSED')
  })
})
