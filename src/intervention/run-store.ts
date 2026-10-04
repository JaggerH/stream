import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AgentSession, AnswerRow, AnswerStatus,
  Proposal, ProposalKind, ProposalStatus, RunErrorCode, RunEvent, RunEventKind, RunKind, RunRecord, RunStatus, Stopped, Usage,
} from './types.ts'
import { TERMINAL_RUN_STATUSES } from './types.ts'

/** 答案缓存的行数上限：它是省钱用的旁路，不是账本——留住最近的就够，旧的丢了只是多问一次。 */
export const ANSWER_CAP = 2000

/** 落库的截图上限（base64 字符数，约 300KB 原图）。一条提议整张塞进 `proposals.body`，
 *  一张全屏 PNG 就能顶掉几百条 run 的体量，而库没有任何上限时它只会一直涨。 */
export const SHOT_CAP = 400_000

/** run 的保留窗口：条数与天数**取先到的**。介入 run 是可复盘的轨迹，不是账本。 */
export const RUN_KEEP = { maxRuns: 500, maxAgeDays: 30 }

/**
 * 太大的截图换成一格「抓到了但没存」。**不是删掉 `shot`**：人审时要能分清「引擎没抓到」
 * 和「抓到了但太大没存」——前者要去查采集链路，后者不用。
 */
function cappedShot<T extends { scene?: Proposal['scene'] }>(p: T): T {
  const shot = p.scene?.shot
  if (!shot || shot.base64.length <= SHOT_CAP) return p
  return { ...p, scene: { ...p.scene!, shot: { mime: shot.mime, base64: '', truncated: true } } }
}

/** 这条 run 的用量还是建行时那份空账（一笔都没记过）。 */
function isPristine(u: Usage): boolean {
  return u.turns === 0 && u.promptTokens === 0 && u.completionTokens === 0 && u.wallMs === 0
}

/**
 * `Stopped.reason` → `RunStatus` 的终态映射（review finding：旧实现无条件写 `done`，
 * 与 `reason` 脱钩，导致 `RunStatus` 里 `stopped`/`cancelled` 两个平级终态永远写不出来）。
 *
 * `error` 抛错而不是映射成某个 `RunStatus`：出错收尾走 `fail()`，那里才有错误码可填；
 * `finish()` 只应该处理「正常收场」的四类原因。
 */
export function statusForStop(stopped: Stopped): RunStatus {
  switch (stopped.reason) {
    case 'end_turn':
    case 'frontier-exhausted':
      return 'done'
    case 'cancelled':
      return 'cancelled'
    case 'gate:turns':
    case 'gate:tokens':
    case 'gate:wall':
    case 'stuck':
      return 'stopped'
    case 'error':
      throw new Error(`finish() 不接 reason:'error'——出错收尾走 fail()，那里才有错误码可填：${JSON.stringify(stopped)}`)
    default:
      return stopped.reason satisfies never
  }
}

/**
 * 介入 run 的持久层（spec §6）。三表：runs / run_events / proposals。
 *
 * 和 `SearchRunStore` 同一个形状（run 是可寻址资源、历史只追加、权威状态独立存），但**不共表**：
 * 那张表的 `stopped` 是 `StopReason` 一格字符串、语义相反（见 types.ts），塞进去只会让读的人
 * 拿着一份枚举去读另一份。
 *
 * 事件 `seq` 按 run 单调：`appendEvent` 在一个事务里 `MAX(seq)+1` 并回写 `runs.last_seq`。
 */
export class InterventionRunStore {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        question TEXT,
        status TEXT NOT NULL,
        stopped TEXT,
        error TEXT,
        usage TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        at TEXT NOT NULL,
        title TEXT NOT NULL,
        data TEXT,
        call_id TEXT,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS proposals_by_run ON proposals(run_id);
      CREATE INDEX IF NOT EXISTS proposals_by_status ON proposals(status);
      CREATE TABLE IF NOT EXISTS answers (
        key TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        proposal_id TEXT,
        answer TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS answers_by_proposal ON answers(proposal_id);
      CREATE INDEX IF NOT EXISTS answers_by_updated ON answers(updated_at);
    `)
    const cols = (this.db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name)
    if (!cols.includes('agent_session')) this.db.exec('ALTER TABLE runs ADD COLUMN agent_session TEXT')
  }

  private now(): string { return new Date().toISOString() }

  private rowToRun(row: Record<string, unknown> | undefined): RunRecord | null {
    if (!row) return null
    return {
      id: row.id as string,
      kind: row.kind as RunKind,
      sourceId: row.source_id as string,
      ...(row.question ? { question: row.question as ProposalKind } : {}),
      status: row.status as RunStatus,
      ...(row.stopped ? { stopped: JSON.parse(row.stopped as string) as Stopped } : {}),
      ...(row.error ? { error: JSON.parse(row.error as string) as RunRecord['error'] } : {}),
      usage: JSON.parse(row.usage as string) as Usage,
      startedAt: row.started_at as string,
      updatedAt: row.updated_at as string,
      lastSeq: row.last_seq as number,
      ...(row.agent_session ? { agentSession: JSON.parse(row.agent_session as string) as AgentSession } : {}),
    }
  }

  create(input: { kind: RunKind; sourceId: string; question?: ProposalKind }): RunRecord {
    const id = randomUUID()
    const t = this.now()
    const usage: Usage = { promptTokens: 0, completionTokens: 0, turns: 0, wallMs: 0, reported: false }
    this.db.prepare(
      `INSERT INTO runs (id, kind, source_id, question, status, usage, started_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).run(id, input.kind, input.sourceId, input.question ?? null, JSON.stringify(usage), t, t)
    // 每建一条顺手裁一次。表很小（上限 500 条 run），两条索引扫下来的代价可以忽略，
    // 而**挂在别处**（定时任务 / 启动时）的裁剪总会有人忘了接线——那时库只会一直涨到没人发现。
    // 裁剪失败（库锁住 / 磁盘满）不该连累这次新建：run 已经写进去了，裁剪只是省空间的旁路，
    // 下次 create 还会再试一次，不必这次就抛。
    try { this.prune() } catch (e) { console.error(`[intervention] prune 失败，本次跳过：${e instanceof Error ? e.message : String(e)}`) }
    return this.get(id)!
  }

  /**
   * 裁掉旧 run（连同它的事件与提议）。条数与天数**取先到的**：一天问上千次时按条数收，
   * 长期低频时按天数收。删 run 不删 `answers`——那张表有自己的上限，而且它的价值恰恰在于活得久。
   *
   * **只裁终态的**（`TERMINAL_RUN_STATUSES`）。一条 `paused` 等人点头的修复会话可以在库里躺 30 天，
   * 也可能在期间被 500 条新 run 挤出窗口——把它的行抽走，那个会话实例、它的 ACP 连接、看门狗
   * 和 **agent 子进程**就一起成了孤儿：登记表下一次对账会把它当终态摘掉（行都没了），
   * 而 `RepairSession.status` 读不到行只会回 `'error'`，看门狗每次醒来都早退。没有一处会喊。
   * 库是权威——但权威不该从一条**还活着**的 run 底下被抽走。
   *
   * 返回删掉几条 run（0 也是一个正常答案，不是"没生效"）。
   */
  prune(opts: { maxRuns?: number; maxAgeDays?: number } = {}): number {
    const maxRuns = opts.maxRuns ?? RUN_KEEP.maxRuns
    const maxAgeDays = opts.maxAgeDays ?? RUN_KEEP.maxAgeDays
    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString()
    const terminal = `status IN (${TERMINAL_RUN_STATUSES.map(() => '?').join(',')})`
    const tx = this.db.transaction((): number => {
      const old = this.db.prepare(`SELECT id FROM runs WHERE started_at < ? AND ${terminal}`)
        .all(cutoff, ...TERMINAL_RUN_STATUSES) as { id: string }[]
      // 超额那一档也只挑终态的：还活着的 run 照常占着保留窗口的名额（它本来就该留着），
      // 多留几条的代价远小于裁掉一条正在跑的。
      const over = this.db.prepare(
        `SELECT id FROM runs ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?`,
      ).all(maxRuns) as { id: string }[]
      const alive = new Set(
        (this.db.prepare(`SELECT id FROM runs WHERE NOT ${terminal}`).all(...TERMINAL_RUN_STATUSES) as { id: string }[]).map((r) => r.id),
      )
      const doomed = [...new Set([...old, ...over].map((r) => r.id))].filter((id) => !alive.has(id))
      const delRun = this.db.prepare('DELETE FROM runs WHERE id = ?')
      const delEvents = this.db.prepare('DELETE FROM run_events WHERE run_id = ?')
      const delProposals = this.db.prepare('DELETE FROM proposals WHERE run_id = ?')
      for (const id of doomed) { delEvents.run(id); delProposals.run(id); delRun.run(id) }
      return doomed.length
    })
    return tx()
  }

  get(id: string): RunRecord | null {
    return this.rowToRun(this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined)
  }

  list(filter?: { sourceId?: string; status?: RunStatus[]; limit?: number }): RunRecord[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter?.sourceId) { where.push('source_id = ?'); args.push(filter.sourceId) }
    if (filter?.status?.length) { where.push(`status IN (${filter.status.map(() => '?').join(',')})`); args.push(...filter.status) }
    const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, rowid DESC LIMIT ?`
    args.push(filter?.limit ?? 100)
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => this.rowToRun(r)!)
  }

  setStatus(id: string, status: RunStatus): void {
    this.db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?').run(status, this.now(), id)
  }

  setAgentSession(id: string, s: AgentSession): void {
    this.db.prepare('UPDATE runs SET agent_session = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(s), this.now(), id)
  }

  /**
   * 进程活着才有意义的状态：重启后它们都是孤儿。**这一口只回「谁是孤儿」，不判「谁续得上」**——
   * 后者要认识 `kind` 与 `agentSession` 的语义，那是 `RepairManager.markInterruptedAtBoot` 的事
   * （它把续得上的收成 paused、续不上的收成终态 error）。
   */
  inFlight(): RunRecord[] {
    return this.list({ status: ['queued', 'running', 'awaiting_input', 'awaiting_confirmation', 'rate_limited'], limit: 1000 })
  }

  markInterrupted(id: string, why: string): void {
    this.setStatus(id, 'paused')
    this.appendEvent(id, { kind: 'status_changed', title: `暂停：${why}`, data: { status: 'paused', why } })
  }

  /**
   * 正常收尾：状态按 `stopped.reason` 映射（见 `statusForStop`），两格停止原因如实写。
   *
   * 为什么 `finish` 不接 `reason: 'error'`：`RunStatus` 里 `error` 携带的是 `{code, message}`
   * 细分错误码（见 `fail`），而 `finish` 的调用点手里只有 `Stopped`，没有错误码可填。
   * 把两条路合成一条会让「为什么错」在落库那一刻丢失——`fail()` 才是出错收尾的唯一入口，
   * `statusForStop` 对 `error` 抛错是故意的，逼调用方走对函数，而不是拿 `finish` 顶替。
   */
  finish(id: string, stopped: Stopped): void {
    const status = statusForStop(stopped)
    this.db.prepare('UPDATE runs SET status = ?, stopped = ?, updated_at = ? WHERE id = ?')
      .run(status, JSON.stringify(stopped), this.now(), id)
  }

  /** 出错收尾：状态 error，`stopped` 固定为 nothing/error——错误码在 `error` 里细分。 */
  fail(id: string, error: { code: RunErrorCode; message: string }): void {
    const stopped: Stopped = { produced: 'nothing', reason: 'error' }
    this.db.prepare('UPDATE runs SET status = ?, stopped = ?, error = ?, updated_at = ? WHERE id = ?')
      .run('error', JSON.stringify(stopped), JSON.stringify(error), this.now(), id)
  }

  appendEvent(runId: string, e: { kind: RunEventKind; title: string; data?: unknown; callId?: string }): RunEvent {
    const tx = this.db.transaction((): RunEvent => {
      const row = this.db.prepare('SELECT last_seq FROM runs WHERE id = ?').get(runId) as { last_seq: number } | undefined
      if (!row) throw new Error(`run 不存在：${runId}`)
      const seq = row.last_seq + 1
      const at = this.now()
      this.db.prepare(
        'INSERT INTO run_events (run_id, seq, kind, at, title, data, call_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(runId, seq, e.kind, at, e.title, e.data === undefined ? null : JSON.stringify(e.data), e.callId ?? null)
      this.db.prepare('UPDATE runs SET last_seq = ?, updated_at = ? WHERE id = ?').run(seq, at, runId)
      return { seq, runId, kind: e.kind, at, title: e.title, ...(e.data !== undefined ? { data: e.data } : {}), ...(e.callId ? { callId: e.callId } : {}) }
    })
    return tx()
  }

  events(runId: string, opts?: { since?: number; limit?: number }): RunEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
    ).all(runId, opts?.since ?? 0, opts?.limit ?? 500) as Record<string, unknown>[]
    return rows.map((r) => ({
      seq: r.seq as number,
      runId: r.run_id as string,
      kind: r.kind as RunEventKind,
      at: r.at as string,
      title: r.title as string,
      ...(r.data ? { data: JSON.parse(r.data as string) as unknown } : {}),
      ...(r.call_id ? { callId: r.call_id as string } : {}),
    }))
  }

  /**
   * 累加一轮用量。`reported:false` 的一轮把整条 run 的 `reported` 拉成 false——「有一轮没报」就是「不完整」。
   *
   * `countTurn:false` 给的是**不是一轮对话的那些开销**（探索的拉黑闸一屏问一次运行时模型）：token 要
   * 记进账，但 `turns` 不能跟着涨——`turns` 是闸的刻度也是人读的「聊了几轮」，把问闸次数混进去，
   * 一条探索会凭空多出几十「轮」，闸提前撞满而事件流里根本没有那些轮。
   */
  addUsage(
    runId: string,
    u: { promptTokens: number; completionTokens: number; reported: boolean; wallMs: number },
    opts?: { countTurn?: boolean },
  ): void {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare('SELECT usage FROM runs WHERE id = ?').get(runId) as { usage: string } | undefined
      if (!row) throw new Error(`run 不存在：${runId}`)
      const cur = JSON.parse(row.usage) as Usage
      const countTurn = opts?.countTurn ?? true
      const next: Usage = {
        promptTokens: cur.promptTokens + u.promptTokens,
        completionTokens: cur.completionTokens + u.completionTokens,
        turns: cur.turns + (countTurn ? 1 : 0),
        wallMs: cur.wallMs + u.wallMs,
        // 建行时的 `reported:false` 是「还没记过任何一笔」，不是「有一笔没报」——第一笔要跨过它。
        // **判据不能是 `turns === 0`**：`countTurn:false` 的那些笔不涨 turns，于是它们报的
        // `reported:false` 会被下一笔真轮次当成「还没记过」而抹掉，而那正是这一格要说的事。
        reported: (isPristine(cur) ? true : cur.reported) && u.reported,
      }
      this.db.prepare('UPDATE runs SET usage = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), this.now(), runId)
    })
    tx()
  }

  addProposal(p: Omit<Proposal, 'id' | 'createdAt'>): Proposal {
    const id = randomUUID()
    const createdAt = this.now()
    const full: Proposal = { ...cappedShot(p), id, createdAt }
    this.db.prepare(
      'INSERT INTO proposals (id, run_id, source_id, kind, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, p.runId, p.sourceId, p.kind, JSON.stringify(full), p.status, createdAt)
    return full
  }

  getProposal(id: string): Proposal | null {
    const row = this.db.prepare('SELECT body FROM proposals WHERE id = ?').get(id) as { body: string } | undefined
    return row ? (JSON.parse(row.body) as Proposal) : null
  }

  proposals(filter?: { runId?: string; sourceId?: string; status?: ProposalStatus }): Proposal[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter?.runId) { where.push('run_id = ?'); args.push(filter.runId) }
    if (filter?.sourceId) { where.push('source_id = ?'); args.push(filter.sourceId) }
    if (filter?.status) { where.push('status = ?'); args.push(filter.status) }
    const sql = `SELECT body FROM proposals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC`
    return (this.db.prepare(sql).all(...args) as { body: string }[]).map((r) => JSON.parse(r.body) as Proposal)
  }

  setProposalStatus(id: string, status: ProposalStatus): void {
    const p = this.getProposal(id)
    if (!p) throw new Error(`提议不存在：${id}`)
    const next = { ...p, status }
    this.db.prepare('UPDATE proposals SET status = ?, body = ? WHERE id = ?').run(status, JSON.stringify(next), id)
  }

  /**
   * 答案缓存（spec §4.3）。**落库不放进程内的 Map**：后端重载 / 换个进程之后，同一个界面
   * 第二次落空又会重新问一次模型——一次白烧的 token 加一次白等，而两边都不报错。
   */
  getAnswer(key: string): AnswerRow | null {
    const row = this.db.prepare('SELECT * FROM answers WHERE key = ?').get(key) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      key: row.key as string,
      sourceId: row.source_id as string,
      kind: row.kind as ProposalKind,
      fingerprint: row.fingerprint as string,
      status: row.status as AnswerStatus,
      ...(row.proposal_id ? { proposalId: row.proposal_id as string } : {}),
      answer: JSON.parse(row.answer as string) as unknown,
      updatedAt: row.updated_at as string,
    }
  }

  /** 表的上限：超过 `ANSWER_CAP` 就按 `updated_at` 删最旧的。缓存丢了只是多问一次，不是错。 */
  putAnswer(row: Omit<AnswerRow, 'updatedAt'>): void {
    const t = this.now()
    this.db.prepare(
      `INSERT INTO answers (key, source_id, kind, fingerprint, status, proposal_id, answer, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET status = excluded.status, proposal_id = excluded.proposal_id,
         answer = excluded.answer, updated_at = excluded.updated_at`,
    ).run(row.key, row.sourceId, row.kind, row.fingerprint, row.status, row.proposalId ?? null, JSON.stringify(row.answer), t)
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM answers').get() as { n: number }).n
    if (n > ANSWER_CAP) {
      this.db.prepare(
        'DELETE FROM answers WHERE key IN (SELECT key FROM answers ORDER BY updated_at ASC, rowid ASC LIMIT ?)',
      ).run(n - ANSWER_CAP)
    }
  }

  /**
   * 人拒了一条提议 → 它背后那条缓存答案也得跟着变。不跟的话，同指纹再落空时缓存照旧命中，
   * 报的还是「有一条待审提议」——人刚拒掉的那一条。
   */
  setAnswerStatusByProposal(proposalId: string, status: AnswerStatus): void {
    this.db.prepare('UPDATE answers SET status = ?, updated_at = ? WHERE proposal_id = ?').run(status, this.now(), proposalId)
  }

  close(): void { this.db.close() }
}
