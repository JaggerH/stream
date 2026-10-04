import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountTaskRoutes } from './task-routes.ts'
import { TaskStore } from '../tasks/task-store.ts'
import { RunLedger } from '../tasks/run-history.ts'
import { compileUserTask } from '../tasks/user-tasks.ts'

/** 真 store + 真 ledger（空账本）+ 真路由：验的是这几块拼起来不炸，不是各自的逻辑。 */
describe('任务面端到端', () => {
  it('建一条 → 清单里有它 → 历次执行为空 → 删掉', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-tasks-'))
    const store = new TaskStore(join(dir, 'stream.db'))
    const ledger = new RunLedger(join(dir, 'sidequest.sqlite'))
    const app = new Hono()
    const applied: string[] = []
    mountTaskRoutes(app, {
      store, ledger,
      builtins: () => [],
      actions: () => [],
      apply: async (row) => { compileUserTask(row); applied.push(row.id) },
      unapply: async () => {},
      runNow: async () => true,
    })

    const created = await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'echo-task', label: '回声', schedule: '0 0 3 * * *',
        command: '/bin/echo', args: ['hi'], serial: true, maxAttempts: 1,
        effect: 'read-only', enabled: true,
      }),
    })
    expect(created.status).toBe(200)
    expect(applied).toEqual(['echo-task'])

    const list = await (await app.request('/api/tasks')).json()
    expect(list.tasks.map((t: { id: string }) => t.id)).toEqual(['echo-task'])
    expect(list.tasks[0].lastRun).toBeNull()

    const runs = await (await app.request('/api/tasks/echo-task/runs')).json()
    expect(runs.runs).toEqual([])

    expect((await app.request('/api/tasks/echo-task', { method: 'DELETE' })).status).toBe(200)
    expect(store.list()).toEqual([])
  })
})
