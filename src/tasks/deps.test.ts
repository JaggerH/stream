import { describe, it, expect, beforeEach } from 'vitest'
import { TaskCenter } from './center.ts'
import { registerTasks } from './registry.ts'
import type { ScheduledTask } from './types.ts'

describe('task deps registry', () => {
  let c = new TaskCenter()
  beforeEach(() => { c = new TaskCenter() })

  it('getTaskDeps throws before setTaskDeps (防静默空跑)', () => {
    expect(() => c.getDeps()).toThrow(/task deps not initialized/)
  })

  it('returns what was set', () => {
    const deps = { log: () => {} }
    c.setDeps(deps as never)
    expect(c.getDeps()).toBe(deps)
  })

  it('registerTasks indexes by id and rejects duplicates', () => {
    const t = (id: string): ScheduledTask => ({
      id, label: id, schedule: '0 * * * * *', serial: false, maxAttempts: 1,
      run: async () => ({ summary: 'ok' }),
    })
    registerTasks(c.registry, [t('a'), t('b')])
    expect([...c.registry.keys()]).toEqual(['a', 'b'])
    expect(() => registerTasks(c.registry, [t('a')])).toThrow(/duplicate task id/)
  })
})
