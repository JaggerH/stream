import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StreamTaskJob } from './stream-task-job.ts'
import { bindTaskRoute } from './task-routes.ts'
import type { ScheduledTask, TaskDeps } from './types.ts'
import { DeviceLost, DeviceOffline } from '../devices/errors.ts'
import { HostAbortedByUser } from '../http/host-relay.ts'

const mkTask = (over: Partial<ScheduledTask>): ScheduledTask => ({
  id: 't1', label: 'T1', schedule: '0 * * * * *', serial: false, maxAttempts: 2,
  run: async () => ({ summary: 'ok' }), ...over,
})

/** job 经路由表找实例（task-routes.ts）：这里直接登记一条，注册表与 deps 由用例自己摆。 */
const taskRegistry = new Map<string, ScheduledTask>()
let deps: TaskDeps | undefined
const setTaskDeps = (d: TaskDeps) => { deps = d }

describe('StreamTaskJob', () => {
  let unbind = () => {}
  beforeEach(() => {
    deps = undefined; taskRegistry.clear()
    unbind = bindTaskRoute('k', {
      task: (id) => taskRegistry.get(id),
      deps: () => { if (!deps) throw new Error('task deps not initialized'); return deps },
    })
  })
  afterEach(() => unbind())

  it('runs the registered task with injected deps and returns its outcome', async () => {
    const run = vi.fn(async (d: TaskDeps) => {
      // @ts-expect-error: TS flags function property as always truthy (correct but strict)
      return { summary: `saw ${d.log ? 'deps' : '??'}` }
    })
    taskRegistry.set('t1', mkTask({ run }))
    setTaskDeps({ log: () => {} })
    const out = await new StreamTaskJob('k').run('t1')
    expect(out).toEqual({ summary: 'saw deps' })
  })

  it('throws on unknown task id (记 failed 而非静默)', async () => {
    setTaskDeps({ log: () => {} })
    await expect(new StreamTaskJob('k').run('nope')).rejects.toThrow(/unknown task/)
  })

  it('failure emits event with dedupeKey then rethrows (引擎重试计数不被吞)', async () => {
    const append = vi.fn()
    taskRegistry.set('t1', mkTask({ run: async () => { throw new Error('boom') } }))
    setTaskDeps({ log: () => {}, events: { append } })
    await expect(new StreamTaskJob('k').run('t1')).rejects.toThrow('boom')
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task.failed', severity: 'error', dedupeKey: 'task-failed:t1',
      title: expect.stringContaining('T1'),
    }))
  })

  it('deps 未初始化 → 拒跑抛错', async () => {
    taskRegistry.set('t1', mkTask({}))
    await expect(new StreamTaskJob('k').run('t1')).rejects.toThrow(/not initialized/)
  })

  it.each([
    ['DeviceLost', () => new DeviceLost('linux:nas')],
    ['HostAbortedByUser', () => new HostAbortedByUser('hotkey')],
  ])('%s from task.run → failed transition, event still emitted, no rethrow (不重试)', async (_name, mk) => {
    const append = vi.fn()
    const err = mk()
    taskRegistry.set('t1', mkTask({ run: async () => { throw err } }))
    setTaskDeps({ log: () => {}, events: { append } })
    const out = await new StreamTaskJob('k').run('t1')
    expect(out).toMatchObject({
      __is_job_transition__: true, type: 'failed',
      error: expect.objectContaining({ message: err.message }),
    })
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task.failed', dedupeKey: 'task-failed:t1',
    }))
  })

  it.each([
    ['DeviceOffline', () => new DeviceOffline('linux:nas')],
    ['plain Error', () => new Error('boom')],
  ])('%s from task.run → still rethrows so the engine retries', async (_name, mk) => {
    const err = mk()
    taskRegistry.set('t1', mkTask({ run: async () => { throw err } }))
    setTaskDeps({ log: () => {}, events: { append: vi.fn() } })
    await expect(new StreamTaskJob('k').run('t1')).rejects.toBe(err)
  })
})

describe('StreamTaskJob 的实例路由', () => {
  const t = (summary: string) => new Map([['t1', mkTask({ run: async () => ({ summary }) })]])
  const route = (reg: Map<string, ScheduledTask>) => ({ task: (id: string) => reg.get(id), deps: () => ({ log: () => {} }) })

  it('按构造参数里的实例键找到那个实例的注册表：两个实例同名任务各跑各的', async () => {
    const offA = bindTaskRoute('a', route(t('A')))
    const offB = bindTaskRoute('b', route(t('B')))
    try {
      expect(await new StreamTaskJob('a').run('t1')).toEqual({ summary: 'A' })
      expect(await new StreamTaskJob('b').run('t1')).toEqual({ summary: 'B' })
      // 旧账本的行没有键：两个实例时认不出是谁的，抛（记 failed），不猜
      await expect(new StreamTaskJob().run('t1')).rejects.toThrow(/no task center/)
    } finally { offA(); offB() }
  })

  it('旧账本的行（没有键）在只有一个实例时归它——单实例与改造前等价', async () => {
    const off = bindTaskRoute('only', route(t('only')))
    try {
      expect(await new StreamTaskJob().run('t1')).toEqual({ summary: 'only' })
    } finally { off() }
  })

  it('同一个键不许登记两次（两个中心共用一个账本）', () => {
    const off = bindTaskRoute('dup', route(t('x')))
    try {
      expect(() => bindTaskRoute('dup', route(t('y')))).toThrow(/已被本进程里的另一个调度中心占用/)
    } finally { off() }
  })
})
