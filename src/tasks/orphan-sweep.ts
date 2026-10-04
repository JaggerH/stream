/**
 * 启动时给上一个进程留下的"还在跑"的账目收尸。
 *
 * 引擎是 `runner: 'inline'` + `fork: false`：任务在后端进程里跑，子进程随后端一起死。所以
 * **启动那一刻账本里任何 claimed / running 的行都必然是死的**——它的进程已经不在了。
 *
 * 不收会怎样（活体 2026-09-05/06）：
 * - Sidequest 自己的 stale 巡检**一小时一轮**、且只认「running 超过 10 分钟」，在它发现之前那行
 *   一直"活着"。serial 任务用 alive-job 去重（`configure` 里 `unique({withArgs:true})`），这一行
 *   活着 = 这条任务接下来一小时内每一次触发都被判"已经排着了"而静默跳过。`cookie-refresh`
 *   五分钟一班，一次重启就丢十几班。
 * - 巡检收尸时写的是它自己的话 `Stale job released for retry`，落到「上次」那一格是一句谁也
 *   看不懂的英文，看起来像任务本身坏了（A 股基本面那条就是这样被当成"任务报错"的——
 *   实际是 03:37 后端重启把跑了 35 分钟的 python 一起带走了）。
 *
 * 这里在引擎起来之前直接把它们记成 failed，理由写人话；`RunLedger` 照常读出来。
 * 账本文件还不存在（首启）就什么都不做。
 *
 * **不变量：终态 job 不带 `unique_digest`。** serial 去重（`unique({withArgs:true})`）靠
 * `sidequest_jobs_unique_digest_active_idx`——一条 `WHERE unique_digest IS NOT NULL` 的局部唯一
 * 索引；sidequest 自己每次改状态都按 `AliveJobUniqueness.digest()` 重算，行一进终态 digest 就
 * 归 NULL。我们这条 UPDATE 绕过了它，所以必须自己把 digest 一起置空（`uniqueness_config`
 * 是配置，不动）。漏了的后果（活体 2026-09-14）：那条任务此后每一班 cron 的 `createNewJob`
 * 都撞 `DuplicatedJobError`，watchdog 以为"已经排着队了"，`cn.options` 静默停了六天。
 * `releaseStaleDigests` 是同一不变量的兜底巡检：不管谁留下的终态带 digest 行，启动时一律清。
 */
import { existsSync } from 'node:fs'
import type Database from 'better-sqlite3'

/** 写进 errors 里的那句话——`run-history.ts` 把它原样当 failure 讲给前端。 */
export const INTERRUPTED_BY_RESTART = '后端重启，这一轮被中断'

/** 账本文件或 `sidequest_jobs` 表还不存在 ⇒ `undefined`；否则回调拿到打开的库，用完自动关。 */
async function withJobsTable<T>(dbPath: string, fn: (db: Database.Database) => T): Promise<T | undefined> {
  if (!existsSync(dbPath)) return undefined
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(dbPath)
  try {
    // 表都还没有（引擎从没起过）也算"没什么可收的"。
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sidequest_jobs'").get()
    if (has === undefined) return undefined
    return fn(db)
  } finally {
    db.close()
  }
}

export async function interruptOrphanRuns(dbPath: string, now: number = Date.now()): Promise<number> {
  const errors = JSON.stringify([{ message: INTERRUPTED_BY_RESTART, at: new Date(now).toISOString() }])
  const n = await withJobsTable(dbPath, (db) =>
    db.prepare(
      "UPDATE sidequest_jobs SET state = 'failed', failed_at = @now, errors = @errors, unique_digest = NULL WHERE state IN ('claimed', 'running')",
    ).run({ now, errors }).changes,
  )
  return n ?? 0
}

/**
 * 账本的查询索引。sidequest 的迁移只建了一条 `unique_digest` 局部索引，而它自己的轮询和我们的
 * 读都按 `queue` / `state` / `args` 过滤——没有索引就是每条查询全表扫。账本按设计要留 30 天
 * （`ledger-prune`），分钟级任务就攒到 ~19 万行，一次全表扫 ~23ms，而且是**同步**的（better-sqlite3）：
 *
 * - 引擎的 dispatcher 每 100ms 一轮：`SELECT DISTINCT queue` + 每条队列一次 `claimPendingJob`
 *   （7 条队列）→ 一轮 ~190ms 的同步查询，活体 CPU profile 里后端 60% 的时间耗在这儿，
 *   事件循环每 1–2 秒报一次 250–480ms 的卡顿（`[loop-lag]`）。
 * - watchdog 每分钟对每条任务查两次（~40 条任务 × 2 × 23ms）→ 每分钟整点后一秒卡 1.3–1.8s。
 * - `/api/tasks` 每条任务一次 `lastRun` → 一次请求卡 ~0.8s。
 *
 * 建了之后这些查询都是 <0.1ms 的索引查找（`DISTINCT queue` 走覆盖索引 ~6ms）。
 * 索引名带 `stream_` 前缀，免得与 sidequest 日后自己的迁移撞名；`IF NOT EXISTS` 让它每次启动都能跑。
 * 这是往上游的表上加索引，不改上游代码：只影响查询计划，不改任何行的语义。
 */
export const LEDGER_INDEXES: readonly string[] = [
  // dispatcher: DISTINCT queue（覆盖索引）/ claimPendingJob（queue=? AND state='waiting' ORDER BY inserted_at）；
  // center.ts 的互斥组忙闲（queue=? AND state IN (...)）
  'CREATE INDEX IF NOT EXISTS stream_sq_jobs_queue_state ON sidequest_jobs (queue, state, inserted_at)',
  // sidequest 的 staleJobs、`runningTasks`（state='running'）、watchdog 的"还活着吗"
  'CREATE INDEX IF NOT EXISTS stream_sq_jobs_state ON sidequest_jobs (state)',
  // watchdog 的"上一班什么时候"、RunLedger.runs/lastRun（args=? ORDER BY inserted_at DESC, id DESC）、prune
  'CREATE INDEX IF NOT EXISTS stream_sq_jobs_args ON sidequest_jobs (args, inserted_at)',
]

/** 我们自己对账本的读。和上面的索引放在一起，因为它们是一对：索引就是为这些查询（和 sidequest
 *  自己的轮询）建的，改了查询形状要回头看索引还接不接得住——`orphan-sweep.test.ts` 用
 *  EXPLAIN QUERY PLAN 钉着「没有一条是全表扫」。 */
export const LEDGER_QUERIES = {
  /** 互斥组忙不忙（center.ts `queueAlive`） */
  aliveByQueue: "SELECT COUNT(*) AS n FROM sidequest_jobs WHERE queue = ? AND state IN ('waiting','claimed','running')",
  /** watchdog：这条任务上一班什么时候排的 */
  lastInsertedByTask: 'SELECT MAX(CAST(inserted_at AS INTEGER)) AS last FROM sidequest_jobs WHERE args = ?',
  /** watchdog：这条任务还有活着的 job 吗。`+args` 禁止走 args 索引——活着的行永远只有个位数，
   *  走 state 索引是常数；按 args 走，分钟级任务要把 30 天攒下的 4 万行逐行看 state（实测 13ms/次）。 */
  aliveByTask: "SELECT COUNT(*) AS n FROM sidequest_jobs WHERE +args = ? AND state IN ('waiting','claimed','running')",
  /** `runningTasks`（重启闸门） */
  runningArgs: "SELECT args FROM sidequest_jobs WHERE state = 'running'",
} as const

/** 给账本补上 `LEDGER_INDEXES`。账本/表还不存在 ⇒ false（引擎起来建表之后再调一次即可）。 */
export async function ensureLedgerIndexes(dbPath: string): Promise<boolean> {
  const done = await withJobsTable(dbPath, (db) => {
    for (const sql of LEDGER_INDEXES) db.exec(sql)
    return true
  })
  return done ?? false
}

/**
 * 兜底巡检：终态行（completed / failed / canceled）还带着 `unique_digest` 的一律清掉，返回清了几条。
 * 正常情况下永远是 0；非零说明有谁绕过 sidequest 改了状态（历史版本的本文件就是一例）。
 */
export async function releaseStaleDigests(dbPath: string): Promise<number> {
  const n = await withJobsTable(dbPath, (db) =>
    db.prepare(
      "UPDATE sidequest_jobs SET unique_digest = NULL WHERE unique_digest IS NOT NULL AND state IN ('completed', 'failed', 'canceled')",
    ).run().changes,
  )
  return n ?? 0
}
