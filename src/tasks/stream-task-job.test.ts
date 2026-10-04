import { describe, it, expect, beforeEach, vi } from 'vitest'
import { StreamTaskJob } from './stream-task-job.ts'
import { taskRegistry } from './registry.ts'
import { setTaskDeps, resetTaskDeps } from './deps.ts'
import type { ScheduledTask, TaskDeps } from './types.ts'

const mkTask = (over: Partial<ScheduledTask>): ScheduledTask => ({
  id: 't1', label: 'T1', schedule: '0 * * * * *', serial: false, maxAttempts: 2,
  run: async () => ({ summary: 'ok' }), ...over,
})

describe('StreamTaskJob', () => {
  beforeEach(() => { resetTaskDeps(); taskRegistry.clear() })

  it('runs the registered task with injected deps and returns its outcome', async () => {
    const run = vi.fn(async (d: TaskDeps) => {
      // @ts-expect-error: TS flags function property as always truthy (correct but strict)
      return { summary: `saw ${d.log ? 'deps' : '??'}` }
    })
    taskRegistry.set('t1', mkTask({ run }))
    setTaskDeps({ log: () => {} })
    const out = await new StreamTaskJob().run('t1')
    expect(out).toEqual({ summary: 'saw deps' })
  })

  it('throws on unknown task id (记 failed 而非静默)', async () => {
    setTaskDeps({ log: () => {} })
    await expect(new StreamTaskJob().run('nope')).rejects.toThrow(/unknown task/)
  })

  it('failure emits event with dedupeKey then rethrows (引擎重试计数不被吞)', async () => {
    const append = vi.fn()
    taskRegistry.set('t1', mkTask({ run: async () => { throw new Error('boom') } }))
    setTaskDeps({ log: () => {}, events: { append } })
    await expect(new StreamTaskJob().run('t1')).rejects.toThrow('boom')
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task.failed', severity: 'error', dedupeKey: 'task-failed:t1',
      title: expect.stringContaining('T1'),
    }))
  })

  it('deps 未初始化 → 拒跑抛错', async () => {
    taskRegistry.set('t1', mkTask({}))
    await expect(new StreamTaskJob().run('t1')).rejects.toThrow(/not initialized/)
  })
})
