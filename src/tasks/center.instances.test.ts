import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskCenter, instanceKeyOf, type TaskCenterStartOptions } from './center.ts'
import { StreamTaskJob } from './stream-task-job.ts'
import type { ScheduledTask } from './types.ts'

/**
 * 同一进程两个调度中心，**真 sidequest**（design D5-B）：各自一个账本，同名任务互不去重、互不路由，
 * 关掉一个另一个的 cron 照常触发。假门面测不到这些——它们全是 sidequest 静态单例会出错的地方。
 */
/**
 * jobs 清单：生产里 sidequest 原生 import `sidequest.jobs.js`（tsx 的 loader 让它拿到正在跑的那份模块）。vitest 里
 * 原生 import 读不了 .ts，所以这里递一份 .mjs，从全局取**本测试模块图里**那个 job 类——路由表也就是同一张。
 */
const JOB_KEY = Symbol.for('stream.test.StreamTaskJob')
;(globalThis as Record<symbol, unknown>)[JOB_KEY] = StreamTaskJob
const jobsDir = mkdtempSync(join(tmpdir(), 'center-jobs-'))
const jobsFile = join(jobsDir, 'sidequest.jobs.mjs')
writeFileSync(jobsFile, `export const StreamTaskJob = globalThis[Symbol.for('stream.test.StreamTaskJob')]\n`)
const base = (dbPath: string, log: (m: string) => void = () => {}): TaskCenterStartOptions => ({ dbPath, log, watchdog: false, jobsFile })

const dirs: string[] = []
const centers: TaskCenter[] = []
afterEach(async () => {
  for (const c of centers.splice(0)) await c.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('等不到条件成立')
    await sleep(50)
  }
}

function ledger(): string {
  const d = mkdtempSync(join(tmpdir(), 'center-inst-'))
  dirs.push(d)
  return join(d, 'sidequest.sqlite')
}

/** 每秒一班的 serial 任务；跑一次给计数器 +1。两个实例用**同一个 id**。 */
const everySecond = (hits: { n: number }): ScheduledTask => ({
  id: 'same', label: 'same', schedule: '* * * * * *', serial: true, maxAttempts: 1,
  run: async () => { hits.n += 1; return { summary: 'ok' } },
})

async function up(dbPath: string, hits: { n: number }): Promise<TaskCenter> {
  const c = new TaskCenter()
  centers.push(c)
  c.setDeps({ log: () => {} })
  const r = await c.start([everySecond(hits)], base(dbPath))
  expect(r.ok).toBe(true)
  return c
}

describe('两个调度中心同进程（真 sidequest）', () => {
  it('各跑各的；关掉 A 之后 B 的 cron 照常触发', async () => {
    const a = { n: 0 }, b = { n: 0 }
    const pa = ledger(), pb = ledger()
    const ca = await up(pa, a)
    await up(pb, b)
    await until(() => a.n > 0 && b.n > 0)
    await ca.stop()
    const aAfter = a.n, bAfter = b.n
    await until(() => b.n >= bAfter + 2)
    // A 停了就不再跑（cron 摘干净、派发器停了）；B 的派发与 cron 没被 A 的关停带走。
    expect(a.n).toBe(aAfter)
    // 账本各自落各自的：B 的行全在 B 的文件里，带的是 B 的实例键。
    const db = new Database(pb, { readonly: true })
    const ctors = db.prepare('SELECT DISTINCT constructor_args AS c FROM sidequest_jobs').all() as { c: string }[]
    db.close()
    expect(ctors.map((r) => r.c)).toEqual([JSON.stringify([instanceKeyOf(pb)])])
  })

  it('同名 serial 任务在两个账本里互不去重：两边同时都有一条活着的', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const running = { a: 0, b: 0 }
    const blocking = (k: 'a' | 'b'): ScheduledTask => ({
      id: 'same', label: 'same', schedule: '0 0 0 1 1 *', serial: true, maxAttempts: 1,
      run: async () => { running[k] += 1; await gate; return { summary: 'ok' } },
    })
    const mk = async (k: 'a' | 'b') => {
      const c = new TaskCenter(); centers.push(c)
      c.setDeps({ log: () => {} })
      await c.start([blocking(k)], base(ledger()))
      return c
    }
    const ca = await mk('a'), cb = await mk('b')
    expect(await ca.runTaskNow('same')).toBe(true)
    // A 那条还活着（卡在 gate 上）——同一个 digest 若共用一个账本，B 这次入队会被判 duplicated 抛出来。
    expect(await cb.runTaskNow('same')).toBe(true)
    await until(() => running.a === 1 && running.b === 1)
    expect((await ca.runningTasks()).map((t) => t.id)).toEqual(['same'])
    expect((await cb.runningTasks()).map((t) => t.id)).toEqual(['same'])
    release()
  })

  it('旧账本里没有实例键的排队行：认领到本实例并照常跑完', async () => {
    const hits = { n: 0 }
    const path = ledger()
    const c = new TaskCenter(); centers.push(c)
    c.setDeps({ log: () => {} })
    const once: ScheduledTask = { ...everySecond(hits), schedule: '0 0 0 1 1 *' }
    await c.start([once], base(path))
    await c.runTaskNow('same')
    await until(() => hits.n === 1)
    await c.stop()
    // 造一条「旧版本留下的」排队行：constructor_args 为空、digest 按空构造参数算的（随便一个非空值即可）。
    const db = new Database(path)
    db.prepare(`INSERT INTO sidequest_jobs (queue, script, class, args, constructor_args, state, attempt, max_attempts,
      inserted_at, available_at, timeout, uniqueness_config, unique_digest, retry_delay, backoff_strategy)
      SELECT queue, script, class, args, '[]', 'waiting', 0, max_attempts, inserted_at, available_at, timeout,
      uniqueness_config, 'legacy-digest', retry_delay, backoff_strategy FROM sidequest_jobs LIMIT 1`).run()
    db.close()
    const logs: string[] = []
    await c.start([once], base(path, (m) => logs.push(m)))
    expect(logs).toContainEqual(expect.stringContaining('1 条排队中的执行认领到本实例'))
    await until(() => hits.n === 2)
    const after = new Database(path, { readonly: true })
    const legacy = after.prepare("SELECT constructor_args AS c FROM sidequest_jobs WHERE constructor_args = '[]'").all()
    after.close()
    expect(legacy).toEqual([])
  })
})
