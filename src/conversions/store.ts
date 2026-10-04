// src/conversions/store.ts
//
// Conversions —— 「把一个 item 派生出一份新产物」这件事的单一存储。转成文字(extract)、
// 补说话人(identify)、抽帧取画面文字(frames)、摘要(summary) 是它的四个 kind，共用一张表、
// 一套生命周期、一套计时。
// extract 内部再分转写/OCR/网页正文三条分支——但那是它的实现，对外只有一个 kind。
// 设计见 docs/superpowers/specs/2026-07-25-conversions-unified-api-design.md。
//
// 形态照抄 src/jobs/store.ts / src/agent/search/run-store.ts（better-sqlite3、WAL、JSON 列）。
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LadderTrace } from '../providers/ladder-trace.ts'

export type ConversionKind = 'extract' | 'identify' | 'frames' | 'summary' | 'audio-fp'
export type ConversionStatus = 'queued' | 'running' | 'done' | 'error'

/** 源 item 的去规范化快照：存下来，历史才自包含——即使源 feed 早已不再持有这个 item
 *  （Discovery 的瞬时卡片尤其如此），转换记录仍然找得到、显示得出。 */
export interface ConversionSnapshot {
  title?: string
  /** 简短来源标签，如 "<facility>" / "discovery·douyin" */
  source?: string
  poster?: string
  url?: string
}

/** 一个阶段的墙钟。阶段名由 kind 声明（stt: media|asr|diarize，parse: fetch|ocr …）。
 *  **未发生的阶段不出现在数组里**，不是 ms:0——「没跑」和「跑了 0ms」必须可区分。 */
export interface ConversionStage {
  name: string
  ms: number
}

export interface ConversionTiming {
  totalMs: number
  stages: ConversionStage[]
}

/** 与全局 errorBody 同形，便于对接方只写一套解析。 */
export interface ConversionError {
  code: string
  message: string
}

export interface ConversionRecord {
  id: string
  kind: ConversionKind
  itemId: string
  status: ConversionStatus
  /** 仅 kind:'summary'——它的输入是另一条 conversion（转写结果），不是原始媒体。 */
  inputId?: string
  snapshot?: ConversionSnapshot
  timing?: ConversionTiming
  error?: ConversionError
  /** 按 kind 判别的产物；列表默认不带（见 list 的 expandResult）。 */
  result?: unknown
  /** 这一次是 Provider 梯子上的谁干的（`via`），以及每一档各花多久、没成的为什么（`rungs`）。
   *  与 `timing` 同性质的**信封字段**：列表里也带（它正是「这条结果信不信得过」的依据，
   *  不该藏在详情里）。走梯子的 kind 才有——identify 直连声纹后端，没有梯子可走。
   *  老记录没有这个字段，前端据此不渲染，**不补空对象**：那等于声称"梯子上没人跑过"。 */
  ladder?: LadderTrace
  createdAt: string
  startedAt?: string
  finishedAt?: string
  updatedAt: string
}

export interface CreateConversionInput {
  kind: ConversionKind
  itemId: string
  inputId?: string
  snapshot?: ConversionSnapshot
}

export type ConversionPatch = Partial<
  Pick<ConversionRecord, 'status' | 'result' | 'error' | 'timing' | 'ladder' | 'startedAt' | 'finishedAt' | 'snapshot'>
>

export interface ListConversionsQuery {
  item?: string
  kind?: ConversionKind
  status?: ConversionStatus
  limit?: number
  /** 上一页最后一条的 id；下一页取严格小于它的（id 单调，见 newConversionId）。 */
  cursor?: string
  /** 列表默认不驮正文（一集播客的 segments 是数千条对象）。 */
  expandResult?: boolean
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

// id 必须**按创建顺序字典序单调**：游标分页直接拿它当锚点，不能用 updated_at 这类会变的键
// （老行被 touch 一下就会跳进调用方已经读过的页里，漏条目）。所以 = 毫秒时间戳 + 同毫秒内计数器
// + 随机尾，三段都定长 base36，拼起来比较大小即等价于比较创建先后。
let lastMs = 0
let seq = 0
function newConversionId(): string {
  const now = Date.now()
  if (now === lastMs) {
    seq += 1
  } else {
    lastMs = now
    seq = 0
  }
  const ts = now.toString(36).padStart(9, '0')
  const ctr = seq.toString(36).padStart(4, '0')
  const rnd = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0')
  return `cv_${ts}${ctr}${rnd}`
}

function parseJson<T>(raw: unknown): T | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

export class ConversionStore {
  private db: Database.Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversions (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        item_id      TEXT NOT NULL,
        status       TEXT NOT NULL,
        input_id     TEXT,
        result       TEXT,
        error        TEXT,
        snapshot     TEXT,
        timing       TEXT,
        ladder       TEXT,
        created_at   TEXT NOT NULL,
        started_at   TEXT,
        finished_at  TEXT,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversions_item_kind ON conversions (item_id, kind);
      CREATE INDEX IF NOT EXISTS conversions_kind      ON conversions (kind);
      CREATE INDEX IF NOT EXISTS conversions_status    ON conversions (status);
    `)
    // 存量库补列：上面是 CREATE TABLE IF NOT EXISTS，已存在的表不会跟着长出新列。
    // 老行的 ladder 保持 NULL——那些转换跑的时候确实没记，读出来就是 undefined。
    const cols = new Set((this.db.prepare('PRAGMA table_info(conversions)').all() as Array<{ name: string }>).map((c) => c.name))
    if (!cols.has('ladder')) this.db.exec('ALTER TABLE conversions ADD COLUMN ladder TEXT')
  }

  /** 同一个库句柄——旧表迁移（migrate.ts）要在这张库里读 transcripts/parses 再 drop 掉，
   *  必须和这里用同一个连接，不能另开一个（WAL 下两个句柄看到的会是两个快照）。 */
  get database(): Database.Database {
    return this.db
  }

  private rowToRecord(row: Record<string, unknown> | undefined, opts?: { withResult?: boolean }): ConversionRecord | null {
    if (!row) return null
    const rec: ConversionRecord = {
      id: row.id as string,
      kind: row.kind as ConversionKind,
      itemId: row.item_id as string,
      status: row.status as ConversionStatus,
      inputId: (row.input_id as string) ?? undefined,
      snapshot: parseJson<ConversionSnapshot>(row.snapshot),
      timing: parseJson<ConversionTiming>(row.timing),
      ladder: parseJson<LadderTrace>(row.ladder),
      error: parseJson<ConversionError>(row.error),
      createdAt: row.created_at as string,
      startedAt: (row.started_at as string) ?? undefined,
      finishedAt: (row.finished_at as string) ?? undefined,
      updatedAt: row.updated_at as string,
    }
    if (opts?.withResult !== false) {
      const result = parseJson<unknown>(row.result)
      if (result !== undefined) rec.result = result
    }
    return rec
  }

  create(input: CreateConversionInput): ConversionRecord {
    const now = new Date().toISOString()
    const id = newConversionId()
    this.db
      .prepare(
        `INSERT INTO conversions (id, kind, item_id, status, input_id, snapshot, created_at, updated_at)
         VALUES (@id, @kind, @item_id, 'queued', @input_id, @snapshot, @now, @now)`
      )
      .run({
        id,
        kind: input.kind,
        item_id: input.itemId,
        input_id: input.inputId ?? null,
        snapshot: input.snapshot ? JSON.stringify(input.snapshot) : null,
        now,
      })
    return this.get(id)!
  }

  get(id: string): ConversionRecord | null {
    return this.rowToRecord(
      this.db.prepare('SELECT * FROM conversions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    )
  }

  /** 该 (item, kind) 最新的一条——去重（「已经转过就别重复计费」）读的就是它。 */
  latestFor(itemId: string, kind: ConversionKind): ConversionRecord | null {
    return this.rowToRecord(
      this.db
        .prepare('SELECT * FROM conversions WHERE item_id = ? AND kind = ? ORDER BY id DESC LIMIT 1')
        .get(itemId, kind) as Record<string, unknown> | undefined
    )
  }

  /** 局部更新：patch 没提到的列一律不动（快照尤其——它只在 create 时写一次）。 */
  update(id: string, patch: ConversionPatch): ConversionRecord | null {
    const existing = this.db.prepare('SELECT id FROM conversions WHERE id = ?').get(id)
    if (!existing) return null
    const sets: string[] = []
    const params: Record<string, unknown> = { id, updated_at: new Date().toISOString() }
    const put = (col: string, key: string, value: unknown) => {
      sets.push(`${col} = @${key}`)
      params[key] = value
    }
    if (patch.status !== undefined) put('status', 'status', patch.status)
    if (patch.startedAt !== undefined) put('started_at', 'started_at', patch.startedAt)
    if (patch.finishedAt !== undefined) put('finished_at', 'finished_at', patch.finishedAt)
    if (patch.result !== undefined) put('result', 'result', JSON.stringify(patch.result))
    if (patch.error !== undefined) put('error', 'error', patch.error === null ? null : JSON.stringify(patch.error))
    if (patch.timing !== undefined) put('timing', 'timing', JSON.stringify(patch.timing))
    if (patch.ladder !== undefined) put('ladder', 'ladder', JSON.stringify(patch.ladder))
    if (patch.snapshot !== undefined) put('snapshot', 'snapshot', JSON.stringify(patch.snapshot))
    sets.push('updated_at = @updated_at')
    this.db.prepare(`UPDATE conversions SET ${sets.join(', ')} WHERE id = @id`).run(params)
    return this.get(id)
  }

  /** 最新在前（按 id，等价于创建序）。游标锚在 id 上，老行被更新也不会搅乱已读过的页。 */
  list(query: ListConversionsQuery): { items: ConversionRecord[]; nextCursor?: string } {
    const where: string[] = []
    const params: Record<string, unknown> = {}
    if (query.item) {
      where.push('item_id = @item')
      params.item = query.item
    }
    if (query.kind) {
      where.push('kind = @kind')
      params.kind = query.kind
    }
    if (query.status) {
      where.push('status = @status')
      params.status = query.status
    }
    if (query.cursor) {
      where.push('id < @cursor')
      params.cursor = query.cursor
    }
    const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT)
    params.limit = limit + 1 // 多取一条判断还有没有下一页
    const rows = this.db
      .prepare(
        `SELECT * FROM conversions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY id DESC LIMIT @limit`
      )
      .all(params) as Record<string, unknown>[]
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const items = page.map((r) => this.rowToRecord(r, { withResult: !!query.expandResult })!)
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : undefined }
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM conversions WHERE id = ?').run(id)
  }

  close(): void {
    this.db.close()
  }
}
