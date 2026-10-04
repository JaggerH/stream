// src/agent/search/run-store.ts
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Hub, RunRecord, RunStatus, TrajectoryStep } from './types.ts'

/**
 * 一条 run 的 `result` 落库时的**上限**（JSON 文本字节）。
 *
 * 账本记的是「发生过什么」，不是产物仓库。超过这个数的结果几乎一定是把一个文件（导出的图、
 * 抓下来的整页）编成文本塞了进来——活体上 `action:photopea-run` 一行 74MB 的 base64 就是这么来的，
 * 456 行攒到 2.07GB，开机扫一遍直接 OOM（见 `failOrphanedRuns` 头注）。文件走 `output.files`
 * 落盘（`src/mcp/action-artifacts.ts`），账本只存路径。
 *
 * **超了就 throw，不截断**：截断是静默失真（调用方拿到一个看起来完整、其实少了一截的 JSON）；
 * throw 会让这条 run 落成 `error` 并把这句话原样带回，第一次就响。
 */
export const RESULT_MAX_BYTES = 1024 * 1024

/** 每个域的行保留多久（`prune` 的缺省）。动作类回执拿走就没用了；发现 / 购买类的轨迹是复盘材料，留久些。 */
export const RUN_RETENTION_MS: Record<string, number> = {
  action: 30 * 24 * 60 * 60_000,
  default: 90 * 24 * 60 * 60_000,
}

/**
 * Per-run persistent record for the Search Agent (sqlite, mirroring ConversionStore). One row per
 * runId, carrying status + the full trajectory (JSON) + the final targets (JSON). The trajectory
 * IS the replay substrate (spec §7.5): appendStep grows it; put updates status/targets WITHOUT
 * touching it (trajectory is only ever appended, never rewritten by a status update).
 */
export class SearchRunStore {
  private db: Database.Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        run_id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        trajectory TEXT NOT NULL,
        targets TEXT,
        onboardable TEXT,
        error TEXT,
        updated_at TEXT NOT NULL
      );
    `)
    // Migrate DBs created before `hubs` shipped: CREATE TABLE IF NOT EXISTS won't add a column to an
    // existing table, so a pre-existing db would lack it and put() would throw.
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(agent_runs)').all() as { name: string }[]).map((c) => c.name)
    )
    if (!cols.has('hubs')) this.db.exec('ALTER TABLE agent_runs ADD COLUMN hubs TEXT')
    // 同一条迁移路子：`domain`（这条 run 跑的哪个发现域）和 `stopped`（停在哪）都是后加的。
    if (!cols.has('domain')) this.db.exec('ALTER TABLE agent_runs ADD COLUMN domain TEXT')
    if (!cols.has('stopped')) this.db.exec('ALTER TABLE agent_runs ADD COLUMN stopped TEXT')
    // `result`：非发现类 job（购买决策）的最终产物；发现类用 targets/hubs，这一列空着。
    if (!cols.has('result')) this.db.exec('ALTER TABLE agent_runs ADD COLUMN result TEXT')
  }

  private rowToRecord(row: Record<string, unknown> | undefined): RunRecord | null {
    if (!row) return null
    return {
      runId: row.run_id as string,
      goal: row.goal as string,
      // 存量记录（这一列之前建的）全是网盘档——缺省按 netdisk 读，别让它们读出个 undefined
      // 再顺着流到回执里：那会让"没记"和"不是网盘档"长得一样。
      domain: (row.domain as string) || 'netdisk',
      status: row.status as RunStatus,
      trajectory: JSON.parse((row.trajectory as string) || '[]') as TrajectoryStep[],
      targets: row.targets ? (JSON.parse(row.targets as string) as RunRecord['targets']) : undefined,
      hubs: row.hubs ? (JSON.parse(row.hubs as string) as Hub[]) : undefined,
      onboardable: row.onboardable ? (JSON.parse(row.onboardable as string) as string[]) : undefined,
      stopped: (row.stopped as RunRecord['stopped']) ?? undefined,
      error: (row.error as string) ?? undefined,
      result: row.result ? (JSON.parse(row.result as string) as unknown) : undefined,
      updatedAt: row.updated_at as string,
    }
  }

  create(goal: string, domain = 'netdisk'): RunRecord {
    const runId = randomUUID()
    this.db
      .prepare(
        `INSERT INTO agent_runs (run_id, goal, status, trajectory, domain, updated_at)
         VALUES (?, ?, 'queued', '[]', ?, ?)`
      )
      .run(runId, goal, domain, new Date().toISOString())
    return this.get(runId)!
  }

  get(runId: string): RunRecord | null {
    return this.rowToRecord(
      this.db.prepare('SELECT * FROM agent_runs WHERE run_id = ?').get(runId) as
        | Record<string, unknown>
        | undefined
    )
  }

  /**
   * 进程重启后把上一条命留下的 `running` / `queued` 行判死（它们永远不可能自己接着跑）。
   *
   * **一条 UPDATE，不读、不解析任何一行。** 这里以前是 `list()` 全表拉回来再逐行看 `status`，
   * 而 `list()` 会把每一行的 `trajectory` / `targets` / `result` 全部 `JSON.parse` —— 那是一次
   * 启动期的定时炸弹：`result` 这一列**光文本就 2.07 GB**（456 行里 56 行超过 10MB，全是
   * `action:photopea-run`，最大单行 74 MB，装的是整份导出文件的 base64）。2026-09-22 真炸了：
   * `FATAL ERROR: Reached heap limit` on `--max-old-space-size=3072`，systemd 连拉 14 次全崩在
   * 同一处，后端整个起不来，而日志里只有一行 V8 的 `JsonParse` native stack。
   *
   * 这一格要的只有 `status`，**一个字节的 JSON 都不用读**。别改回 `list()`。
   */
  failOrphanedRuns(error = '中断（服务重启）'): number {
    const r = this.db
      .prepare(
        `UPDATE agent_runs SET status = 'error', error = ?, updated_at = ?
         WHERE status IN ('running', 'queued')`,
      )
      .run(error, new Date().toISOString())
    return r.changes
  }

  /** Update status/targets/onboardable/error. Never touches the trajectory. */
  put(
    runId: string,
    patch: Partial<Omit<RunRecord, 'runId' | 'updatedAt' | 'trajectory'>> & { status: RunStatus }
  ): void {
    const result = patch.result !== undefined ? JSON.stringify(patch.result) : null
    if (result && Buffer.byteLength(result) > RESULT_MAX_BYTES) {
      throw new Error(
        `[agent-runs] run ${runId} 的 result 有 ${(Buffer.byteLength(result) / 1048576).toFixed(1)}MB，` +
          `账本只收 ${RESULT_MAX_BYTES / 1048576}MB 以内的——文件类产物要在 recipe 的 output.files 里声明、落盘存路径，别编成文本塞进结果`,
      )
    }
    this.db
      .prepare(
        `UPDATE agent_runs SET
           status = @status,
           targets = COALESCE(@targets, targets),
           hubs = COALESCE(@hubs, hubs),
           onboardable = COALESCE(@onboardable, onboardable),
           stopped = COALESCE(@stopped, stopped),
           error = COALESCE(@error, error),
           result = COALESCE(@result, result),
           updated_at = @updated_at
         WHERE run_id = @run_id`
      )
      .run({
        run_id: runId,
        status: patch.status,
        targets: patch.targets ? JSON.stringify(patch.targets) : null,
        hubs: patch.hubs ? JSON.stringify(patch.hubs) : null,
        onboardable: patch.onboardable ? JSON.stringify(patch.onboardable) : null,
        stopped: patch.stopped ?? null,
        error: patch.error ?? null,
        result,
        updated_at: new Date().toISOString(),
      })
  }

  /**
   * 保留期清理：按域删掉 `updated_at` 早于保留期的**已落定**行（`running` / `queued` 不动——
   * 它们要么在飞，要么等下次开机 `failOrphanedRuns` 判死）。
   *
   * **删行不还磁盘**：SQLite 只把页标成空闲。活体那本账 1.65GB 里清完还是 1.65GB，所以空闲页
   * 超过四分之一就 `VACUUM` 一次——它要重写整个文件，但清完之后文件本来就该只剩几十 MB，
   * 一次的代价可以接受；不设阈值天天 VACUUM 才是白写盘。
   */
  prune(opts: { now?: number; retentionMs?: Record<string, number> } = {}): { removed: number; stripped: number; vacuumed: boolean } {
    const now = opts.now ?? Date.now()
    const retention = opts.retentionMs ?? RUN_RETENTION_MS
    const domains = (this.db.prepare('SELECT DISTINCT domain FROM agent_runs').all() as { domain: string | null }[]).map(
      (r) => r.domain,
    )
    let removed = 0
    const del = this.db.prepare(
      `DELETE FROM agent_runs WHERE status NOT IN ('running', 'queued') AND updated_at < ?
         AND ((domain IS NULL AND ? IS NULL) OR domain = ?)`,
    )
    for (const d of domains) {
      // 存量行 domain 为 NULL 的按 netdisk 读（见 rowToRecord），保留期也照 netdisk 那档算。
      const keepMs = retention[d ?? 'netdisk'] ?? retention.default ?? RUN_RETENTION_MS.default
      const cutoff = new Date(now - keepMs).toISOString()
      removed += del.run(cutoff, d, d).changes
    }
    // 存量里违反 `RESULT_MAX_BYTES` 的行（护栏立起来之前塞进去的 base64 文件）：**不等保留期**，
    // 当场把 result 抹掉、行留着并写明缘由。等它们自然过期要一个月，而那一个月里这 2.7GB 每次
    // 开机都躺在那儿；内容本身也早取不出来了（`items[0].data` 那份契约已经没了）。
    const stripped = this.db
      .prepare(
        `UPDATE agent_runs SET result = NULL, error = COALESCE(error, ?), updated_at = ?
         WHERE length(result) > ?`,
      )
      .run(`result 超过账本上限 ${RESULT_MAX_BYTES / 1048576}MB，已清除（旧格式：文件编成 base64 塞在结果里）`, new Date(now).toISOString(), RESULT_MAX_BYTES).changes
    const pageCount = this.db.pragma('page_count', { simple: true }) as number
    const freelist = this.db.pragma('freelist_count', { simple: true }) as number
    const vacuumed = pageCount > 0 && freelist / pageCount > 0.25
    if (vacuumed) this.db.exec('VACUUM')
    return { removed, stripped, vacuumed }
  }

  /** Append one trajectory step; assigns seq (current length) + an ISO timestamp. */
  appendStep(runId: string, step: Omit<TrajectoryStep, 'seq' | 'at'>): void {
    const rec = this.get(runId)
    if (!rec) return
    const full: TrajectoryStep = { ...step, seq: rec.trajectory.length, at: new Date().toISOString() }
    const next = [...rec.trajectory, full]
    this.db
      .prepare('UPDATE agent_runs SET trajectory = ?, updated_at = ? WHERE run_id = ?')
      .run(JSON.stringify(next), new Date().toISOString(), runId)
  }

  close(): void {
    this.db.close()
  }
}
