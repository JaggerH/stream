// src/jobs/store.ts
//
// 能力型 Job 账本(sqlite):转写/声纹这类"长活切片跑"的排队/续跑/回收底座。
// 形态照抄 src/agent/search/run-store.ts(better-sqlite3、WAL、prepare、JSON 列)。
//
// 目录约定:sqlite 文件与 jobs 目录是同级兄弟——jobs 根目录 = dirname(dbPath) + '/jobs'。
// 例如 dbPath = 'data/jobs.db'（bootstrap 实际接线的路径）→ 每个 job 的中间产物目录是
// 'data/jobs/<jobId>/',与 spec 里 `data/jobs/<id>/window-3.json` 的指针写法对齐。
// complete()/sweep() 删的正是这个目录。
import Database from 'better-sqlite3'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface CapabilityJob {
  jobId: string
  kind: string // 'stt' | 'identify' | 后续能力自定
  input: Record<string, unknown> // 重跑所需全部参数(记意图不记结果)
  status: 'queued' | 'running' | 'error'
  chunksDone: string[] // 已完成片的指针(如 'data/jobs/<id>/window-3.json')
  error?: string
  createdAt: string
  updatedAt: string
}

const ORPHAN_STALE_MS = 24 * 60 * 60 * 1000 // 孤儿:启动恢复时超过这个 age 的 queued/running 直接标 error
const ERROR_TTL_MS = 7 * 24 * 60 * 60 * 1000 // error 行留存 7 天供排障
const MAX_ROWS = 1000 // 总行数硬顶,超限先删最老的 error 行
// enqueue 只产 randomUUID(标准带连字符的 36 位十六进制串)——jobDir 用它守门,拒掉任何非
// 这个形态的 jobId,防 '../../etc' 这类穿越串靠 join 拼出根目录外的路径被 rmSync(recursive) 强删。
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** true 当且仅当 value 是字面量对象(`{}`/`Object.create(null)`),不含 Date/RegExp/Map 等内建类型。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * 稳定序列化:对象键排序后再 JSON.stringify,使 enqueue 的 kind+input 判等与键写入顺序无关。
 * 只对**字面量对象**递归展开自定义键序;非字面量对象(Date、RegExp、Map…)一律交给原生
 * JSON.stringify——`Object.keys(new Date())` 恒为空数组,两个不同的 Date 若被当成字面量对象
 * 递归会一起坍缩成 `'{}'`,导致不同 input 的 job 被误判同键、静默合并。
 * 值为 `undefined` 的字段直接跳过(与该键完全省略时同键),对齐 JSON.stringify 丢弃 undefined 字段的语义。
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(',')}]`
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
    const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    return `{${body.join(',')}}`
  }
  return JSON.stringify(value)
}

export class CapabilityJobStore {
  private db: Database.Database
  private jobsRoot: string

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capability_jobs (
        job_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        input TEXT NOT NULL,
        input_key TEXT NOT NULL,
        status TEXT NOT NULL,
        chunks_done TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    // jobs 根目录与 db 文件同级;:memory: 没有落盘目录,退化到 cwd 下的 data/jobs(测试从不会
    // 真的对 :memory: 调 complete/sweep 的目录删除路径,但目录必须存在这个约定才不至于抛异常)。
    this.jobsRoot = dbPath === ':memory:' ? join(process.cwd(), 'data', 'jobs') : join(dirname(dbPath), 'jobs')
  }

  private jobDir(jobId: string): string {
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error(`invalid jobId: ${jobId}`)
    return join(this.jobsRoot, jobId)
  }

  /** 该 job 的中间产物目录（`<dirname(dbPath)>/jobs/<jobId>`）——只读暴露给调用方
   *  （service 往里落 window-<n>.json），推导与校验都复用 jobDir，别在外面重复拼路径。
   *  目录不保证存在（写入方自己 mkdir）；complete()/sweep() 清行时连它一起删。 */
  jobDirOf(jobId: string): string {
    return this.jobDir(jobId)
  }

  private rowToJob(row: Record<string, unknown> | undefined): CapabilityJob | null {
    if (!row) return null
    return {
      jobId: row.job_id as string,
      kind: row.kind as string,
      input: JSON.parse(row.input as string) as Record<string, unknown>,
      status: row.status as CapabilityJob['status'],
      chunksDone: JSON.parse(row.chunks_done as string) as string[],
      error: (row.error as string) ?? undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }
  }

  /** 同 kind+input 已有非 error 行 → 复用其 jobId;已有 error 行 → 复用并重排回 queued;否则新建。 */
  enqueue(kind: string, input: Record<string, unknown>): string {
    const inputKey = stableStringify(input)
    const existing = this.db
      .prepare('SELECT * FROM capability_jobs WHERE kind = ? AND input_key = ? ORDER BY created_at ASC, rowid ASC LIMIT 1')
      .get(kind, inputKey) as Record<string, unknown> | undefined
    const now = new Date().toISOString()
    if (existing) {
      if (existing.status !== 'error') return existing.job_id as string
      // error 行复用:原地更新回 queued,清掉 error,chunks_done 保留(断点续跑从已完成片继续)。
      this.db
        .prepare(
          `UPDATE capability_jobs SET status = 'queued', error = NULL, updated_at = ? WHERE job_id = ?`
        )
        .run(now, existing.job_id as string)
      return existing.job_id as string
    }
    const jobId = randomUUID()
    this.db
      .prepare(
        `INSERT INTO capability_jobs
           (job_id, kind, input, input_key, status, chunks_done, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', '[]', NULL, ?, ?)`
      )
      .run(jobId, kind, JSON.stringify(input), inputKey, now, now)
    return jobId
  }

  markRunning(jobId: string): void {
    this.db
      .prepare(`UPDATE capability_jobs SET status = 'running', updated_at = ? WHERE job_id = ?`)
      .run(new Date().toISOString(), jobId)
  }

  /** 推进 chunksDone + updatedAt。 */
  appendChunk(jobId: string, pointer: string): void {
    const job = this.get(jobId)
    if (!job) return
    const next = [...job.chunksDone, pointer]
    this.db
      .prepare(`UPDATE capability_jobs SET chunks_done = ?, updated_at = ? WHERE job_id = ?`)
      .run(JSON.stringify(next), new Date().toISOString(), jobId)
  }

  /** 装配完成:删 data/jobs/<jobId>/ 目录 + DELETE 行。做完不留痕——做过什么去业务库/日志找。
   *  顺序故意是先删目录后删行(不是反过来):中途崩了目录还在、行也还在,下次 sweep/recover
   *  还能看见这行、要么续跑要么按 stale 清账,目录不会变孤儿;若先删行后删目录,DELETE 与
   *  rmSync 之间崩溃会让目录失去唯一指向它的账本行,永远没人再删它——sweep 只按行走,行没了
   *  它就看不见这个目录。 */
  complete(jobId: string): void {
    const dir = this.jobDir(jobId) // 校验放最前:非法 jobId 直接 throw,连 DB 行都不碰
    rmSync(dir, { recursive: true, force: true })
    this.db.prepare('DELETE FROM capability_jobs WHERE job_id = ?').run(jobId)
  }

  fail(jobId: string, error: string): void {
    this.db
      .prepare(`UPDATE capability_jobs SET status = 'error', error = ?, updated_at = ? WHERE job_id = ?`)
      .run(error, new Date().toISOString(), jobId)
  }

  get(jobId: string): CapabilityJob | null {
    return this.rowToJob(
      this.db.prepare('SELECT * FROM capability_jobs WHERE job_id = ?').get(jobId) as
        | Record<string, unknown>
        | undefined
    )
  }

  /**
   * 启动恢复:返回可续跑的 queued/running 行;updated_at 超过 24h 的孤儿就地标 error
   * ('stale, superseded on restart')且不出现在返回列表里——防一个永远失败的 job 每次重启都复活空转。
   */
  recover(now: () => number = Date.now): CapabilityJob[] {
    const nowMs = now()
    const rows = this.db
      .prepare(`SELECT * FROM capability_jobs WHERE status IN ('queued', 'running')`)
      .all() as Record<string, unknown>[]
    const survivors: CapabilityJob[] = []
    for (const row of rows) {
      const job = this.rowToJob(row)!
      const ageMs = nowMs - Date.parse(job.updatedAt)
      if (ageMs > ORPHAN_STALE_MS) {
        this.fail(job.jobId, 'stale, superseded on restart')
        continue
      }
      survivors.push(job)
    }
    return survivors
  }

  /** reaper 一步:error 行超 7 天删除(连目录);总行数超 1000 先删最老的 error 行。 */
  sweep(now: () => number = Date.now): { removed: number } {
    const nowMs = now()
    let removed = 0

    // rowid 兜底:同一毫秒内批量 fail() 的行 updated_at 会打平,靠插入顺序(rowid)稳定判定"最老"。
    const errorRows = this.db
      .prepare(`SELECT job_id, updated_at FROM capability_jobs WHERE status = 'error' ORDER BY updated_at ASC, rowid ASC`)
      .all() as { job_id: string; updated_at: string }[]

    const remainingErrorRows: string[] = []
    for (const row of errorRows) {
      if (nowMs - Date.parse(row.updated_at) > ERROR_TTL_MS) {
        rmSync(this.jobDir(row.job_id), { recursive: true, force: true })
        this.db.prepare('DELETE FROM capability_jobs WHERE job_id = ?').run(row.job_id)
        removed += 1
      } else {
        remainingErrorRows.push(row.job_id)
      }
    }

    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM capability_jobs').get() as { n: number }).n
    if (total > MAX_ROWS) {
      // 容量顶只吃 error 行(queued/running 是活跃工作,不因为容量而被丢弃)——remainingErrorRows
      // 已按 updated_at 升序,最老的排在最前面。
      let over = total - MAX_ROWS
      for (const jobId of remainingErrorRows) {
        if (over <= 0) break
        rmSync(this.jobDir(jobId), { recursive: true, force: true })
        this.db.prepare('DELETE FROM capability_jobs WHERE job_id = ?').run(jobId)
        removed += 1
        over -= 1
      }
    }

    return { removed }
  }

  close(): void {
    this.db.close()
  }
}
