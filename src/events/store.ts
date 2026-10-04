import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type EventSeverity = 'info' | 'warn' | 'error'

/** One "something happened" record. Domain stores stay the source of truth for the thing
 *  itself; an event only points back at it via `ref`. See the 2026-07-23 design spec. */
export interface StreamEvent {
  id: number // monotonic — doubles as the `since` poll cursor
  type: string // 'auth.needed' | 'transcribe.done' | 'transcribe.error' | 'harvest.error' | ...
  at: number // epoch ms
  title: string
  body?: string
  /**
   * 诊断现场，给**复制出去贴给 AI** 用的那一份 —— 多行纯文本，`标签=值` 一行一条。
   *
   * **不在 UI 上显示**：`title`/`body` 是写给只做架构把关的人的白话，把 reason 枚举名、容器 id、
   * 分跳时间戳堆进去只会把那句话毁掉；可是白话对排查没用，用户复制这条正是为了让 AI 读。
   * 两个读者，两份文本，同一条事件。
   *
   * 可选：老事件、以及压根没有技术现场的事件（登录失效之类）不带这一格，读旧文件也不受影响。
   * 值取不到时**如实写 `unknown` / `未接线`，绝不用 0 或 null 顶替** —— 「没量到」和「量到是 0」
   * 是两个结论，抹平它等于把排查往沟里带。
   */
  detail?: string
  severity: EventSeverity
  ref?: { kind: 'item' | 'facility' | 'stream'; id: string }
  dedupeKey?: string
  readAt?: number
}

export type EventInput = Omit<StreamEvent, 'id' | 'at' | 'readAt'> & { at?: number }

const MAX_EVENTS = 500
const MAX_AGE_MS = 10 * 24 * 3600_000 // 10 天 TTL（用户拍板，原设计 30 天）

interface FileShape { nextId: number; events: StreamEvent[] }

/** Append-only persisted event log with an unread bit. JSON file (small, capped), loaded
 *  whole at construct, rewritten on every mutation — trivial and fine at ≤500 entries. */
export class EventStore {
  private nextId = 1
  private events: StreamEvent[] = [] // oldest → newest

  constructor(private readonly path: string, private readonly now: () => number = Date.now) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as FileShape
      if (typeof raw.nextId === 'number') this.nextId = raw.nextId
      if (Array.isArray(raw.events)) this.events = raw.events
    } catch { /* first run / unreadable → start empty */ }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify({ nextId: this.nextId, events: this.events } satisfies FileShape))
  }

  append(input: EventInput): StreamEvent {
    const e: StreamEvent = { ...input, id: this.nextId++, at: input.at ?? this.now() }
    this.events.push(e)
    const cutoff = this.now() - MAX_AGE_MS
    this.events = this.events.filter((x) => x.at >= cutoff).slice(-MAX_EVENTS)
    this.save()
    return e
  }

  findUnreadByDedupeKey(key: string): StreamEvent | undefined {
    return this.events.find((e) => e.dedupeKey === key && e.readAt === undefined)
  }

  /** Refresh an existing event's timestamp (the dedupe path) — no new entry, no re-count. */
  touch(id: number, at?: number): StreamEvent | undefined {
    const e = this.events.find((x) => x.id === id)
    if (!e) return undefined
    e.at = at ?? this.now()
    this.save()
    return e
  }

  /** Newest first. `since` is an id cursor (strictly greater-than). */
  list(opts: { since?: number; types?: string[] } = {}): StreamEvent[] {
    let out = this.events
    if (opts.since !== undefined) out = out.filter((e) => e.id > opts.since!)
    if (opts.types?.length) out = out.filter((e) => opts.types!.includes(e.type))
    return [...out].reverse()
  }

  unreadCount(): number {
    return this.events.filter((e) => e.readAt === undefined).length
  }

  markRead(sel: { ids?: number[]; all?: boolean }): void {
    const t = this.now()
    for (const e of this.events) {
      if (e.readAt === undefined && (sel.all || sel.ids?.includes(e.id))) e.readAt = t
    }
    this.save()
  }
}
