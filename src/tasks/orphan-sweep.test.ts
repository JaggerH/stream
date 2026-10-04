import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLedgerIndexes, interruptOrphanRuns, LEDGER_QUERIES, releaseStaleDigests, INTERRUPTED_BY_RESTART } from './orphan-sweep.ts'
import { RunLedger, RUNS_SQL } from './run-history.ts'

/** 每行：状态 + 可选的 unique_digest（sidequest 的 serial 去重靠它，活着的行才该有）。 */
type SeedRow = string | { state: string; digest: string }

/**
 * 夹具照抄 sidequest sqlite-backend 的表形状，**连那条局部唯一索引一起建**——
 * `sidequest_jobs_unique_digest_active_idx` 就是让"终态行带着 digest"变成再也排不上的元凶，
 * 不建它，"收完能再排上"这条用例验的就是个寂寞。
 */
function seed(rows: SeedRow[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'orphan-')), 'sq.sqlite')
  const db = new Database(path)
  db.exec(`CREATE TABLE sidequest_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, queue TEXT NOT NULL DEFAULT 'default',
    class TEXT NOT NULL DEFAULT 'StreamTaskJob', script TEXT NOT NULL DEFAULT '',
    args TEXT NOT NULL, constructor_args TEXT NOT NULL DEFAULT '[]',
    result TEXT, errors TEXT, state TEXT NOT NULL,
    available_at INTEGER, inserted_at INTEGER NOT NULL, attempted_at INTEGER,
    completed_at INTEGER, failed_at INTEGER, canceled_at INTEGER, claimed_at INTEGER,
    claimed_by TEXT, attempt INTEGER NOT NULL DEFAULT 1, max_attempts INTEGER NOT NULL DEFAULT 1,
    unique_digest TEXT, uniqueness_config TEXT);
    CREATE UNIQUE INDEX sidequest_jobs_unique_digest_active_idx ON sidequest_jobs(unique_digest) WHERE unique_digest IS NOT NULL`)
  const ins = db.prepare('INSERT INTO sidequest_jobs (args, state, inserted_at, attempted_at, unique_digest, uniqueness_config) VALUES (?, ?, 1000, 1000, ?, ?)')
  // 一个事务包住：逐条自动提交 = 每条一次刷盘，500 行在忙的机器上要十几秒（撞过 15s 超时）。
  db.transaction(() => {
    for (const r of rows) {
      if (typeof r === 'string') ins.run('["t1"]', r, null, null)
      else ins.run('["t1"]', r.state, r.digest, '{"type":"alive-job","withArgs":true}')
    }
  })()
  db.close()
  return path
}

/** 模拟 sidequest `createNewJob`：同 digest 的活行再插一条——撞索引就是 DuplicatedJobError。 */
function enqueueSame(path: string, digest: string): void {
  const db = new Database(path)
  try {
    db.prepare("INSERT INTO sidequest_jobs (args, state, inserted_at, unique_digest) VALUES ('[\"t1\"]', 'waiting', 2000, ?)").run(digest)
  } finally {
    db.close()
  }
}

function digestRows(path: string): Array<{ id: number; state: string; unique_digest: string | null; uniqueness_config: string | null }> {
  const db = new Database(path, { readonly: true })
  try {
    return db.prepare('SELECT id, state, unique_digest, uniqueness_config FROM sidequest_jobs ORDER BY id').all() as ReturnType<typeof digestRows>
  } finally {
    db.close()
  }
}

describe('interruptOrphanRuns', () => {
  it('claimed / running 的行记成 failed、写上人话；其余状态不动', async () => {
    const path = seed(['running', 'claimed', 'completed', 'failed', 'waiting'])
    expect(await interruptOrphanRuns(path, 5000)).toBe(2)
    const db = new Database(path, { readonly: true })
    const rows = db.prepare('SELECT state, failed_at, errors FROM sidequest_jobs ORDER BY id').all() as Array<{ state: string; failed_at: number | null; errors: string | null }>
    db.close()
    expect(rows.map((r) => r.state)).toEqual(['failed', 'failed', 'completed', 'failed', 'waiting'])
    expect(rows[0]!.failed_at).toBe(5000)
    expect(JSON.parse(rows[0]!.errors!)[0].message).toBe(INTERRUPTED_BY_RESTART)
    // 原本就 failed 的那行不该被盖上这句话
    expect(rows[3]!.errors).toBeNull()
  })

  it('收完的行经 RunLedger 读出来 failure 就是那句人话', async () => {
    const path = seed(['running'])
    await interruptOrphanRuns(path, 5000)
    const run = new RunLedger(path).lastRun('t1')!
    expect(run.state).toBe('failed')
    expect(run.failure).toBe(INTERRUPTED_BY_RESTART)
  })

  it('引擎自己收的尸（Stale job released for retry）读出来也是人话；别的错误原样', () => {
    const path = seed(['failed', 'failed', 'completed'])
    const db = new Database(path)
    db.prepare('UPDATE sidequest_jobs SET errors = ? WHERE id = 1').run(JSON.stringify([{ message: 'Stale job released for retry', attempt: 1 }]))
    db.prepare('UPDATE sidequest_jobs SET errors = ? WHERE id = 2').run(JSON.stringify([{ message: 'exit 2：boom', attempt: 1 }]))
    db.close()
    const runs = new RunLedger(path).runs('t1')
    const byId = new Map(runs.map((r) => [r.id, r]))
    expect(byId.get(1)!.failure).toBe('后端重启时这一轮还在跑，被中断（引擎稍后巡检才发现）')
    expect(byId.get(2)!.failure).toBe('exit 2：boom')
    expect(byId.get(3)!.failure).toBeNull()
  })

  it('账本文件不存在 ⇒ 0，不抛', async () => {
    expect(await interruptOrphanRuns(join(tmpdir(), 'nope-' + Date.now(), 'x.sqlite'))).toBe(0)
  })

  it('收尸同时清掉 unique_digest：同一条任务重启后能再排上；uniqueness_config 不动', async () => {
    const D = 'sha256-of-t1'
    const path = seed([{ state: 'running', digest: D }])
    // 先证明夹具是真的：不收尸，同 digest 再排就撞索引（活体上就是这个 DuplicatedJobError）
    expect(() => enqueueSame(path, D)).toThrow(/UNIQUE constraint failed/)
    expect(await interruptOrphanRuns(path, 5000)).toBe(1)
    const [row] = digestRows(path)
    expect(row!.state).toBe('failed')
    expect(row!.unique_digest).toBeNull()
    expect(row!.uniqueness_config).toBe('{"type":"alive-job","withArgs":true}')
    // 收完再排同一条：能进
    expect(() => enqueueSame(path, D)).not.toThrow()
    expect(digestRows(path).map((r) => [r.state, r.unique_digest])).toEqual([['failed', null], ['waiting', D]])
  })
})

describe('releaseStaleDigests', () => {
  it('终态行（completed / failed / canceled）带着 digest 就清掉并计数；活行不动', async () => {
    const path = seed([
      { state: 'completed', digest: 'a' },
      { state: 'failed', digest: 'b' },
      { state: 'canceled', digest: 'c' },
      { state: 'waiting', digest: 'd' },
      { state: 'running', digest: 'e' },
      'failed',
    ])
    expect(await releaseStaleDigests(path)).toBe(3)
    expect(digestRows(path).map((r) => r.unique_digest)).toEqual([null, null, null, 'd', 'e', null])
    // 清完，之前被终态行卡住的那条任务能再排上
    expect(() => enqueueSame(path, 'a')).not.toThrow()
    // 幂等：第二遍没东西可清
    expect(await releaseStaleDigests(path)).toBe(0)
  })

  it('账本文件不存在 / 表不存在 ⇒ 0，不抛', async () => {
    expect(await releaseStaleDigests(join(tmpdir(), 'nope-' + Date.now(), 'x.sqlite'))).toBe(0)
    const path = join(mkdtempSync(join(tmpdir(), 'orphan-')), 'empty.sqlite')
    new Database(path).close()
    expect(await releaseStaleDigests(path)).toBe(0)
  })
})

describe('ensureLedgerIndexes', () => {
  /** 每条查询 + 它的参数。sidequest 那几条是从 @sidequest/{backend,sqlite-backend}@1.16.2 抄来的
   *  形状（它们由 knex 生成，拿不到字符串）——dispatcher 每 100ms 跑一遍的就是它们。 */
  const QUERIES: Array<[string, string, unknown[]]> = [
    ['sidequest getQueuesFromJobs', 'select distinct `queue` from `sidequest_jobs`', []],
    ['sidequest claimPendingJob', "select `id` from `sidequest_jobs` where `state` = 'waiting' and `queue` = ? and `available_at` <= ? order by `inserted_at` asc limit ?", ['default', 5000, 4]],
    ['sidequest staleJobs', "select * from `sidequest_jobs` where `state` = 'running'", []],
    ['RunLedger.runs', RUNS_SQL, ['["t1"]', 1]],
    ...Object.entries(LEDGER_QUERIES).map(([k, sql]): [string, string, unknown[]] =>
      [k, sql, (sql.match(/\?/g) ?? []).map(() => (k.endsWith('Queue') ? 'default' : '["t1"]'))]),
  ]

  /** EXPLAIN QUERY PLAN 里「无索引全表扫」那一行。`SCAN ... USING COVERING INDEX` 不算：
   *  DISTINCT queue 走覆盖索引扫的是小得多的索引 b-tree（实测 27ms → 6ms）。 */
  function fullScans(path: string): string[] {
    const db = new Database(path, { readonly: true })
    try {
      return QUERIES.flatMap(([name, sql, params]) =>
        (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
          .filter((r) => /^SCAN sidequest_jobs$/.test(r.detail) || /TEMP B-TREE FOR ORDER BY/.test(r.detail))
          .map((r) => `${name}: ${r.detail}`))
    } finally {
      db.close()
    }
  }

  it('建完之后 dispatcher 的轮询与我们自己的读没有一条全表扫（没建时有——守卫有牙）', async () => {
    const path = seed(Array.from({ length: 500 }, (_, i) => (i % 50 === 0 ? 'waiting' : 'completed')))
    expect(fullScans(path).length).toBeGreaterThan(0)
    expect(await ensureLedgerIndexes(path)).toBe(true)
    expect(fullScans(path)).toEqual([])
  })

  it('watchdog 的「还活着吗」走 state 索引，不走 args（分钟级任务的 args 有 4 万行）', async () => {
    const path = seed(['completed'])
    await ensureLedgerIndexes(path)
    const db = new Database(path, { readonly: true })
    try {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${LEDGER_QUERIES.aliveByTask}`).all('["t1"]') as { detail: string }[])
        .map((r) => r.detail).join(' | ')
      expect(plan).toContain('stream_sq_jobs_state')
    } finally {
      db.close()
    }
  })

  it('幂等；账本 / 表不存在 ⇒ false，不抛', async () => {
    const path = seed(['completed'])
    expect(await ensureLedgerIndexes(path)).toBe(true)
    expect(await ensureLedgerIndexes(path)).toBe(true)
    expect(await ensureLedgerIndexes(join(tmpdir(), 'nope-' + Date.now(), 'x.sqlite'))).toBe(false)
    const empty = join(mkdtempSync(join(tmpdir(), 'orphan-')), 'empty.sqlite')
    new Database(empty).close()
    expect(await ensureLedgerIndexes(empty)).toBe(false)
  })
})
