import { describe, it, expect, afterEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskCenter, type TaskCenterStartOptions } from './center.ts'
import { StreamTaskJob } from './stream-task-job.ts'
import type { ScheduledTask, TaskSettledEvent } from './types.ts'

/**
 * 任务结束的实例级回调（`onTaskSettled`，openspec `embeddable-engine` 的宿主钩子）：
 * 用**真 sidequest** 走完整的 job 管道——落账、路由表、job 类——因为回调恰恰挂在
 * `StreamTaskJob.run` 的成功/失败出口上，假门面够不着那里。
 */
const JOB_KEY = Symbol.for('stream.test.StreamTaskJob')
;(globalThis as Record<symbol, unknown>)[JOB_KEY] = StreamTaskJob
const jobsDir = mkdtempSync(join(tmpdir(), 'center-settled-jobs-'))
const jobsFile = join(jobsDir, 'sidequest.jobs.mjs')
writeFileSync(jobsFile, `export const StreamTaskJob = globalThis[Symbol.for('stream.test.StreamTaskJob')]\n`)
const base = (dbPath: string, log: (m: string) => void = () => {}): TaskCenterStartOptions => ({ dbPath, log, watchdog: false, jobsFile })

const dirs: string[] = []
const centers: TaskCenter[] = []
afterEach(async () => {
  for (const c of centers.splice(0)) await c.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
afterAll(() => rmSync(jobsDir, { recursive: true, force: true }))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('等不到条件成立')
    await sleep(50)
  }
}

function ledger(): string {
  const d = mkdtempSync(join(tmpdir(), 'center-settled-'))
  dirs.push(d)
  return join(d, 'sidequest.sqlite')
}

/** 每秒一班的任务，跑一次计数 +1（成功档）。 */
const okTask = (id: string, h: { n: number }): ScheduledTask => ({
  id, label: `任务 ${id}`, schedule: '* * * * * *', serial: true, maxAttempts: 1,
  run: async () => { h.n += 1; return { summary: 'ok' } },
})

describe('onTaskSettled：任务结束的实例级回调', () => {
  it('成功结束 → done（带名字与时刻）', async () => {
    const events: TaskSettledEvent[] = []
    const h = { n: 0 }
    const c = new TaskCenter(); centers.push(c)
    c.setDeps({ log: () => {} })
    c.onTaskSettled = (e) => events.push(e)
    await c.start([okTask('every', h)], base(ledger()))
    await until(() => events.length > 0 && h.n > 0)
    expect(events[0]).toMatchObject({ taskId: 'every', name: '任务 every', status: 'done' })
    expect(events[0].at).toBeGreaterThan(0)
    expect(events[0].error).toBeUndefined()
  })

  it('失败结束 → failed（带错误信息）', async () => {
    const events: TaskSettledEvent[] = []
    const c = new TaskCenter(); centers.push(c)
    c.setDeps({ log: () => {} })
    c.onTaskSettled = (e) => events.push(e)
    const boom: ScheduledTask = {
      id: 'boom', label: '会炸的', schedule: '0 0 0 1 1 *', serial: true, maxAttempts: 1,
      run: async () => { throw new Error('炸了') },
    }
    await c.start([boom], base(ledger()))
    expect(await c.runTaskNow('boom')).toBe(true)
    await until(() => events.length > 0)
    expect(events[0]).toMatchObject({ taskId: 'boom', name: '会炸的', status: 'failed', error: '炸了' })
  })

  it('回调抛错只记日志，任务照常落账', async () => {
    const logs: string[] = []
    const h = { n: 0 }
    const c = new TaskCenter(); centers.push(c)
    c.setDeps({ log: () => {} })
    c.onTaskSettled = () => { throw new Error('回调坏了') }
    const path = ledger()
    await c.start([okTask('steady', h)], base(path, (m) => logs.push(m)))
    expect(await c.runTaskNow('steady')).toBe(true)
    await until(() => h.n === 1)
    expect(logs).toContainEqual(expect.stringContaining('回调坏了'))
    // 落账没被回调带走：这一班记 completed。
    const db = new Database(path, { readonly: true })
    const states = db.prepare('SELECT DISTINCT state FROM sidequest_jobs').all() as { state: string }[]
    db.close()
    expect(states.map((r) => r.state)).toContain('completed')
  })

  it('两个实例各自只收到自己的', async () => {
    const ea: TaskSettledEvent[] = [], eb: TaskSettledEvent[] = []
    const ha = { n: 0 }, hb = { n: 0 }
    const mk = async (id: string, h: { n: number }, ev: TaskSettledEvent[]): Promise<TaskCenter> => {
      const c = new TaskCenter(); centers.push(c)
      c.setDeps({ log: () => {} })
      c.onTaskSettled = (e) => ev.push(e)
      await c.start([okTask(id, h)], base(ledger()))
      return c
    }
    await mk('task-a', ha, ea)
    await mk('task-b', hb, eb)
    await until(() => ea.length > 0 && eb.length > 0)
    expect(ea.every((e) => e.taskId === 'task-a')).toBe(true)
    expect(eb.every((e) => e.taskId === 'task-b')).toBe(true)
  })
})
