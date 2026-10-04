import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FailureCategory, FailureRecord } from './failure.ts'

export type HealthState = 'healthy' | 'degraded' | 'dead'

/** The outcome of one REAL upstream fetch (cache hits are never recorded). */
export type Outcome =
  | { kind: 'ok'; itemCount: number }
  | { kind: 'empty' }
  | { kind: 'error'; message: string; category?: FailureCategory; stack?: string }

const FAILURE_HISTORY = 5 // rolling per-source failure track, newest first

export interface SourceHealth {
  state: HealthState
  lifetimeItemCount: number
  consecutiveEmpty: number
  consecutiveError: number
  lastOutcome: 'ok' | 'empty' | 'error'
  lastAt: string
  lastError?: string
  /** category of the most recent error (drift/auth/timeout/…) */
  lastErrorCategory?: FailureCategory
  /** full stack of the most recent error, for debugging */
  lastErrorStack?: string
  /** rolling history of recent failures (message + category + stack), newest first */
  recentFailures?: FailureRecord[]
}

const DEFAULT_K = 4 // consecutive empties (on a productive source) → degraded
const DEFAULT_ERR_K = 2 // consecutive hard errors → dead (1 → degraded)

function fresh(): SourceHealth {
  return {
    state: 'healthy',
    lifetimeItemCount: 0,
    consecutiveEmpty: 0,
    consecutiveError: 0,
    lastOutcome: 'ok',
    lastAt: new Date().toISOString(),
  }
}

/**
 * Per-source health ledger, keyed by `source_id` (health is a property of the upstream
 * backend, shared across every stream that uses it — see design D1/D2). Persisted as JSON
 * so `doctor` survives restarts and the re-probe cadence spans process lifetimes.
 *
 * It is the single source of truth for BOTH failover selection and the doctor report.
 */
export class SourceHealthStore {
  private readonly map: Record<string, SourceHealth>
  private readonly K: number
  private readonly errK: number

  constructor(private readonly path: string, opts?: { K?: number; errK?: number }) {
    this.K = opts?.K ?? DEFAULT_K
    this.errK = opts?.errK ?? DEFAULT_ERR_K
    this.map = this.load()
  }

  private load(): Record<string, SourceHealth> {
    if (!existsSync(this.path)) return {}
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, SourceHealth>
    } catch {
      return {} // corrupt ledger → cold start (all healthy)
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = join(dirname(this.path), `.${'source-health'}.${process.pid}.tmp`)
    writeFileSync(tmp, JSON.stringify(this.map, null, 2))
    renameSync(tmp, this.path) // atomic swap
  }

  /** Apply one fetch outcome and persist. Returns the updated record. */
  record(sourceId: string, o: Outcome): SourceHealth {
    const h = this.map[sourceId] ?? fresh()
    h.lastAt = new Date().toISOString()

    if (o.kind === 'ok') {
      h.lifetimeItemCount += o.itemCount
      h.consecutiveEmpty = 0
      h.consecutiveError = 0
      h.state = 'healthy'
      h.lastOutcome = 'ok'
      this.clearLastError(h) // recentFailures history is preserved
    } else if (o.kind === 'empty') {
      h.consecutiveError = 0
      h.consecutiveEmpty += 1
      h.lastOutcome = 'empty'
      this.clearLastError(h)
      // A genuinely-quiet / never-productive source stays healthy; only a normally-
      // productive source gone silent for K ticks is suspected dead.
      if (h.state !== 'dead' && h.lifetimeItemCount > 0 && h.consecutiveEmpty >= this.K) {
        h.state = 'degraded'
      }
    } else {
      h.consecutiveError += 1
      h.lastOutcome = 'error'
      h.lastError = o.message
      h.lastErrorCategory = o.category ?? 'unknown'
      h.lastErrorStack = o.stack
      const rec: FailureRecord = { at: h.lastAt, category: h.lastErrorCategory, message: o.message, stack: o.stack }
      h.recentFailures = [rec, ...(h.recentFailures ?? [])].slice(0, FAILURE_HISTORY)
      // Hard failure bypasses the soft baseline: 1 error degrades, errK strikes it dead.
      h.state = h.consecutiveError >= this.errK ? 'dead' : 'degraded'
    }

    this.map[sourceId] = h
    this.persist()
    return h
  }

  /** Clear the CURRENT error fields (message/category/stack); keeps recentFailures history. */
  private clearLastError(h: SourceHealth): void {
    delete h.lastError
    delete h.lastErrorCategory
    delete h.lastErrorStack
  }

  /**
   * A real success disproved "needs re-login" — release **only that one assertion**, leaving every
   * other health statistic alone. Returns whether anything was actually cleared, so the caller can
   * decide whether to broadcast.
   *
   * Why this exists: `readSource`'s failure path makes an exception for `auth` so that even an
   * ad-hoc read records it — that is what lets a search-only facility's login wall surface at all
   * (it is never scheduled, so nothing else would ever report it). An exception opened on one side
   * only is a one-way valve: the wall lights up and can never go out. Live 2026-07-28 — the user
   * logged back in, harvests were succeeding, and the "登录已失效" banner stayed up forever.
   *
   * Why so narrow: widening it to "any success clears any failure" would turn preview into a
   * whitewash tool — one manual preview and a genuinely broken source reads as healthy. `auth` is
   * the only category an ad-hoc read is allowed to raise, so it is the only one it may clear.
   * The `recentFailures` ledger is untouched: releasing the current assertion is not forgetting
   * that it happened.
   */
  clearAuthFailure(sourceId: string): boolean {
    const h = this.map[sourceId]
    if (!h || h.lastOutcome !== 'error' || h.lastErrorCategory !== 'auth') return false
    h.lastOutcome = 'ok'
    h.consecutiveError = 0
    h.state = 'healthy'
    h.lastAt = new Date().toISOString()
    this.clearLastError(h)
    this.map[sourceId] = h
    this.persist()
    return true
  }

  /** Force a source back to healthy (re-probe success / manual reprobe). */
  markHealthy(sourceId: string): void {
    const h = this.map[sourceId] ?? fresh()
    h.state = 'healthy'
    h.consecutiveEmpty = 0
    h.consecutiveError = 0
    h.lastAt = new Date().toISOString()
    this.clearLastError(h)
    this.map[sourceId] = h
    this.persist()
  }

  get(sourceId: string): SourceHealth | undefined {
    return this.map[sourceId]
  }

  /** Unknown sources are healthy (cold start). */
  stateOf(sourceId: string): HealthState {
    return this.map[sourceId]?.state ?? 'healthy'
  }

  snapshot(): Record<string, SourceHealth> {
    return { ...this.map }
  }
}

/**
 * Read-only ledger for contexts that must never touch disk (e.g. the disk-only stdio MCP —
 * D4/D6 forbid it from writing the data dir, even on an auth-classified fetch failure recorded
 * off a read path — see `Scheduler.fetchSource`'s auth branch). `record`/`markHealthy` are
 * total no-ops: they neither mutate in-memory state nor call the private `persist()` that would
 * hit the filesystem. Reads (`get`/`stateOf`/`snapshot`) fall through to the empty base map —
 * a disk-mode read never needs real health state, since `stateOf` only feeds `exclusive`-strategy
 * selection inside `tick()`, which disk mode never calls.
 */
export class NoopSourceHealthStore extends SourceHealthStore {
  constructor() {
    super(':noop:') // never read or written — load() sees a nonexistent path, persist() is never called
  }

  override record(_sourceId: string, _o: Outcome): SourceHealth {
    return {
      state: 'healthy',
      lifetimeItemCount: 0,
      consecutiveEmpty: 0,
      consecutiveError: 0,
      lastOutcome: 'ok',
      lastAt: new Date().toISOString(),
    }
  }

  override markHealthy(_sourceId: string): void {
    // no-op — never persists
  }
}
