import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunLedger } from './run-history.ts'

/** 照实测 schema 建一张最小可用的 sidequest_jobs。 */
function seed(rows: Array<Partial<{ args: string; state: string; result: string | null; errors: string | null; inserted_at: number; attempted_at: number | null; completed_at: number | null; attempt: number }>>): string {
  const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'sq.sqlite')
  const db = new Database(path)
  db.exec(`CREATE TABLE sidequest_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, queue TEXT NOT NULL DEFAULT 'default',
    class TEXT NOT NULL DEFAULT 'StreamTaskJob', script TEXT NOT NULL DEFAULT '',
    args TEXT NOT NULL, constructor_args TEXT NOT NULL DEFAULT '[]',
    result TEXT, errors TEXT, state TEXT NOT NULL,
    available_at INTEGER, inserted_at INTEGER NOT NULL, attempted_at INTEGER,
    completed_at INTEGER, failed_at INTEGER, canceled_at INTEGER, claimed_at INTEGER,
    claimed_by TEXT, attempt INTEGER NOT NULL DEFAULT 1, max_attempts INTEGER NOT NULL DEFAULT 1)`)
  const ins = db.prepare(`INSERT INTO sidequest_jobs (args, state, result, errors, inserted_at, attempted_at, completed_at, attempt)
    VALUES (@args, @state, @result, @errors, @inserted_at, @attempted_at, @completed_at, @attempt)`)
  for (const r of rows) ins.run({
    args: r.args ?? '["t1"]', state: r.state ?? 'completed',
    result: r.result ?? null, errors: r.errors ?? null,
    inserted_at: r.inserted_at ?? 1000, attempted_at: r.attempted_at === undefined ? 1000 : r.attempted_at,
    completed_at: r.completed_at === undefined ? 1500 : r.completed_at, attempt: r.attempt ?? 1,
  })
  db.close()
  return path
}

describe('RunLedger', () => {
  it('按 taskId 取历次执行，倒序，带 summary/detail/耗时', () => {
    const p = seed([
      { inserted_at: 1000, attempted_at: 1000, completed_at: 1200, result: '{"summary":"第一次","detail":{"n":1}}' },
      { inserted_at: 2000, attempted_at: 2000, completed_at: 2500, result: '{"summary":"第二次"}' },
    ])
    const runs = new RunLedger(p).runs('t1')
    expect(runs.map((r) => r.summary)).toEqual(['第二次', '第一次'])
    expect(runs[1].detail).toEqual({ n: 1 })
    expect(runs[0].durationMs).toBe(500)
  })

  it('只认自己那个 taskId，不串台', () => {
    const p = seed([{ args: '["t1"]' }, { args: '["t2"]' }, { args: '["t1"]' }])
    expect(new RunLedger(p).runs('t1')).toHaveLength(2)
  })

  it('limit 生效', () => {
    const p = seed([{ inserted_at: 1 }, { inserted_at: 2 }, { inserted_at: 3 }])
    expect(new RunLedger(p).runs('t1', 2)).toHaveLength(2)
  })

  it('失败行带 errors，没跑完的 durationMs 是 null', () => {
    const p = seed([{ state: 'failed', errors: '{"message":"boom"}', completed_at: null }])
    const r = new RunLedger(p).runs('t1')[0]
    expect(r.state).toBe('failed')
    expect(r.errors).toEqual({ message: 'boom' })
    expect(r.durationMs).toBeNull()
  })

  it('lastRun 给最近一条', () => {
    const p = seed([{ inserted_at: 1, result: '{"summary":"老"}' }, { inserted_at: 9, result: '{"summary":"新"}' }])
    expect(new RunLedger(p).lastRun('t1')?.summary).toBe('新')
  })

  it('账本里没有这个任务 ⇒ 空数组 / undefined，不抛', () => {
    const p = seed([{ args: '["other"]' }])
    expect(new RunLedger(p).runs('t1')).toEqual([])
    expect(new RunLedger(p).lastRun('t1')).toBeUndefined()
  })

  it('prune 按「每任务保留 N 条」和「保留多久」取宽的那个，删的是两条都不满足的', () => {
    const now = 10_000_000
    const p = seed([
      { args: '["t1"]', inserted_at: now - 1000 },      // 新，条数内 → 留
      { args: '["t1"]', inserted_at: now - 2000 },      // 次新，条数内 → 留
      { args: '["t1"]', inserted_at: now - 3000 },      // 新但超出 keepPerTask=2 → 靠「保留多久」救回来 → 留
      { args: '["t1"]', inserted_at: now - 9_000_000 }, // 又老又超出条数，两个条件都不满足 → 删
      { args: '["t2"]', inserted_at: now - 9_000_000 }, // t2 只有这一条，虽然老但条数内 → 靠「每任务 N 条」救回来 → 留
    ])
    // 注入合成时钟，让 cutoff 落在 fixture 的时间轴内——不注入的话默认时钟是真实的 2026
    // epoch（~1.77e12ms），而这里所有行的 inserted_at 都在 1970 附近，年龄条件会恒真，
    // 测试就测不出"忽略 keepMs、纯按条数删"这种错误实现。
    const led = new RunLedger(p, () => now)
    expect(led.prune({ keepPerTask: 2, keepMs: 60_000 })).toBe(1)
    // t1 留 3 条：条数内的 2 条 + 被「保留多久」救回来的那条超额新行
    expect(led.runs('t1')).toHaveLength(3)
    // t2 留 1 条：虽然超出 keepMs，但没超出 keepPerTask
    expect(led.runs('t2')).toHaveLength(1)
  })

  it('result 是坏 JSON ⇒ summary 退化成原文，不抛', () => {
    const p = seed([{ result: '{坏的' }])
    expect(new RunLedger(p).runs('t1')[0].summary).toContain('{坏的')
  })

  it('账本文件还不存在 ⇒ runs 返回空，不抛（首次启动、任务一次都没跑过）', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'nope.sqlite')
    expect(new RunLedger(missing).runs('t1')).toEqual([])
  })
})
