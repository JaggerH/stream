import { describe, it, expect, beforeEach } from 'vitest'
import { setTaskDeps, getTaskDeps, resetTaskDeps } from './deps.ts'
import { taskRegistry, registerTasks } from './registry.ts'
import type { ScheduledTask } from './types.ts'

describe('task deps registry', () => {
  beforeEach(() => { resetTaskDeps(); taskRegistry.clear() })

  it('getTaskDeps throws before setTaskDeps (防静默空跑)', () => {
    expect(() => getTaskDeps()).toThrow(/task deps not initialized/)
  })

  it('returns what was set', () => {
    const deps = { log: () => {} }
    setTaskDeps(deps as never)
    expect(getTaskDeps()).toBe(deps)
  })

  it('registerTasks indexes by id and rejects duplicates', () => {
    const t = (id: string): ScheduledTask => ({
      id, label: id, schedule: '0 * * * * *', serial: false, maxAttempts: 1,
      run: async () => ({ summary: 'ok' }),
    })
    registerTasks([t('a'), t('b')])
    expect([...taskRegistry.keys()]).toEqual(['a', 'b'])
    expect(() => registerTasks([t('a')])).toThrow(/duplicate task id/)
  })
})
