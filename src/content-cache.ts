/** ContentCache — the one pattern for per-item expensive enrichment caching (tryGet style).
 *
 *  Scope: "given a key, fetch once at real cost, treat the value as fact for a while" —
 *  article extraction, favicons, future per-item enrich. NOT in scope, on purpose:
 *  T3 ledgers (transcripts/parses are artifacts, not caches), DiscoverCache (its SWR +
 *  never-throw contract is product semantics), AList link caches (their TTL is the
 *  upstream signature's lifetime, not ours), and the route-level harvest CacheLayer.
 *
 *  RED LINE: cache stable FACTS only — metadata, extracted text, icon bytes. Never cache
 *  signed / expiring CDN URLs (play/download links): that is exactly why the embedded
 *  RSSHub's 1h content cache is disabled (CACHE_TYPE=''). Volatile URLs are resolved live.
 *
 *  Invalidation is entirely mechanical — no module ever "remembers to clear" anything:
 *   1. TTL expiry (per namespace; negative entries may have their own, shorter TTL)
 *   2. version mismatch — bump the namespace's `version` when the cached shape changes;
 *      old rows become misses, no migration script ever
 *   3. the caller's explicit user action (`fresh: true`, e.g. a force-refresh button)
 */

import Database from 'better-sqlite3'

export interface NamespaceSpec {
  /** freshness window for cached values */
  ttlMs: number
  /** bump when the cached value's projection/shape changes (default 1) */
  version?: number
  /** when set, null fetch results are cached too (negative cache) with this TTL */
  negativeTtlMs?: number
  /** when the fetch throws and an expired same-version row exists, serve it instead of throwing */
  staleFallback?: boolean
}

interface Row {
  value: string
  version: number
  expires_at: number
}

export class ContentCache {
  private readonly db: Database.Database
  private readonly specs = new Map<string, Required<Pick<NamespaceSpec, 'ttlMs' | 'version'>> & NamespaceSpec>()
  private readonly inflight = new Map<string, Promise<unknown>>()
  private readonly now: () => number

  constructor(dbPath: string, opts?: { now?: () => number }) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_cache (
        ns TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        version INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (ns, key)
      );
      CREATE INDEX IF NOT EXISTS content_cache_expiry ON content_cache(expires_at);
    `)
    this.now = opts?.now ?? (() => Date.now())
    this.prune()
  }

  /** Declare a namespace. Each consumer module registers its own — the spec (TTL, version,
   *  negative policy) lives next to the projection code it describes. Re-registering
   *  overwrites (bootstrap wiring may run more than once in tests). */
  register(ns: string, spec: NamespaceSpec): void {
    this.specs.set(ns, { version: 1, ...spec })
  }

  /**
   * Return the cached value for (ns, key) or run `fn` once to produce it. Concurrent
   * calls for the same (ns, key) single-flight onto one fn run; if that run fails,
   * waiters retry with their own fn (same contract as the harvest CacheLayer).
   * `fresh: true` skips the cache-hit check (explicit user refresh) but still joins
   * in-flight work and still writes the result back for later cached readers.
   */
  async tryGet<T>(ns: string, key: string, fn: () => Promise<T | null>, opts?: { fresh?: boolean }): Promise<T | null> {
    const spec = this.specs.get(ns)
    if (!spec) throw new Error(`[content-cache] namespace "${ns}" is not registered`)

    if (!opts?.fresh) {
      const row = this.read(ns, key)
      if (row && row.version === spec.version && row.expires_at > this.now()) {
        return JSON.parse(row.value) as T | null
      }
    }

    const flightKey = `${ns}\0${key}`
    const existing = this.inflight.get(flightKey)
    if (existing) {
      try {
        return (await existing) as T | null
      } catch {
        return this.tryGet(ns, key, fn, opts)
      }
    }

    const run = (async (): Promise<T | null> => {
      try {
        const value = await fn()
        if (value == null) {
          if (spec.negativeTtlMs != null) this.write(ns, key, 'null', spec.version, spec.negativeTtlMs)
          return null
        }
        this.write(ns, key, JSON.stringify(value), spec.version, spec.ttlMs)
        return value
      } catch (e) {
        if (spec.staleFallback) {
          const stale = this.read(ns, key)
          if (stale && stale.version === spec.version) return JSON.parse(stale.value) as T | null
        }
        throw e
      } finally {
        this.inflight.delete(flightKey)
      }
    })()
    this.inflight.set(flightKey, run)
    return run
  }

  delete(ns: string, key: string): void {
    this.db.prepare('DELETE FROM content_cache WHERE ns = ? AND key = ?').run(ns, key)
  }

  /** Drop expired rows. Runs at construction (boot), so between boots expired rows linger
   *  and can serve the staleFallback path — a deliberate cap: "last known good" survives
   *  at most until the next boot, never indefinitely. */
  prune(): number {
    return this.db.prepare('DELETE FROM content_cache WHERE expires_at <= ?').run(this.now()).changes
  }

  close(): void {
    this.db.close()
  }

  private read(ns: string, key: string): Row | undefined {
    return this.db.prepare('SELECT value, version, expires_at FROM content_cache WHERE ns = ? AND key = ?')
      .get(ns, key) as Row | undefined
  }

  private write(ns: string, key: string, value: string, version: number, ttlMs: number): void {
    const now = this.now()
    this.db.prepare(`
      INSERT INTO content_cache (ns, key, value, version, fetched_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(ns, key) DO UPDATE SET
        value = excluded.value, version = excluded.version,
        fetched_at = excluded.fetched_at, expires_at = excluded.expires_at
    `).run(ns, key, value, version, now, now + ttlMs)
  }
}
