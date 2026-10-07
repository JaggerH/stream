import { join } from 'path'
import type { Registry } from './registry/registry.ts'
import type { Stream, StreamMember } from './streams/types.ts'
import type { Adapter } from './adapters/types.ts'
import type { AuthSpec, SourceManifest, SourceType } from './manifest/types.ts'
import type { DedupStore } from './dedup-store.ts'
import type { ItemStore, StoredItem } from './item-store.ts'
import type { AdRules } from './content/ad-filter.ts'
import type { StreamItem } from './types.ts'
import type { SourceHealthStore } from './source-health-store.ts'
import { classifyError, isEnvironmentUnavailable, type FailureCategory } from './failure.ts'
import { persistItems, makeStreamItem } from './stream-pipeline.ts'
import { normalize, type RawItem } from './content/normalize.ts'
import { videoItemReference } from './video/item-identity.ts'
import { parseSourceId, canonicalSourceId } from './streams/store.ts'
import { mergeAdRules } from './content/ad-rules.default.ts'
import { inferFeedTitle } from './store/auto-name.ts'
import {
  decideCollectionReplace, MemoryCollectionGuard,
  type CollectionGuardStore, type ReplaceHoldReason,
} from './collection-replace-guard.ts'

export type CredentialResolveFn = (auth: AuthSpec) => Promise<Record<string, string>>

/** Anti-herd jitter ceiling for a startup catch-up fire (data-scheduling: overdue streams
 *  harvest "promptly", not synchronized). Kept small so an overdue stream fires within a few
 *  seconds of start(), unlike the [0.5,1)×cadence steady-state first fire. */
export const CATCHUP_MAX_JITTER_MS = 5_000

/** Pure first-fire decision for start(): overdue (backend was down past a cadence) → prompt
 *  fire with a small jitter; not overdue or no recorded lastHarvestAt (upgrade case) → the
 *  existing [0.5,1)×cadence jittered delay. Missing lastHarvest is deliberately NOT overdue,
 *  so an upgrade never bursts an all-streams catch-up. */
export function computeFirstFire(args: {
  nowMs: number; lastHarvestMs: number | undefined; cadenceMs: number; rng: () => number
}): { overdue: boolean; delayMs: number } {
  const { nowMs, lastHarvestMs, cadenceMs, rng } = args
  if (lastHarvestMs !== undefined && nowMs - lastHarvestMs >= cadenceMs) {
    return { overdue: true, delayMs: rng() * CATCHUP_MAX_JITTER_MS }
  }
  return { overdue: false, delayMs: cadenceMs * (0.5 + rng() / 2) }
}

export interface SchedulerOpts {
  registry: Registry
  streams: Stream[]
  adapters: Map<string, Adapter>
  resolveCreds: CredentialResolveFn
  /** Resolve a manifest's private runtime configuration immediately before adapter execution. */
  /** 每轮 `tick()` 动手之前跑一次的钩子（登录态预取挂在这儿）。**必须自己吞掉失败**——
   *  它是准备动作，没有资格让一轮采集失败。 */
  beforeTick?: () => Promise<void>
  runtimeConfigFor?: (manifest: SourceManifest) => Record<string, unknown>
  vaultRoot: string
  /** when false, new items are stored/emitted but markdown vault files are skipped */
  vaultEnabled?: boolean
  dedup: DedupStore
  /** optional read-model store; each newly-persisted item is added here */
  itemStore?: ItemStore
  /** optional hook fired for each newly-persisted (non-deduped) item */
  onItem?: (item: StreamItem, type: SourceType) => void
  /**
   * 同质内容归堆（`src/story-fold/`）：刚入库的这批和近期的邻居比一比，跨平台搬运的
   * 收成一堆。**它只写自己那两张表，碰不到 item**——归堆是呈现层的事，永不阻止入库
   * （不变量见 `docs/ARCHITECTURE.md`）。约定它**自己吞掉一切异常**，这里不给它兜底：
   * 一个附加的呈现能力没有资格让一轮采集失败。
   */
  storyFold?: { record: (items: StreamItem[]) => void }
  /** notification after an item enters the read model. Consumers must be best-effort: this
   * scheduler layer cannot let enrichment work delay or fail an ingest tick. */
  onItemPersisted?: (item: StreamItem) => void | Promise<void>
  /** optional ad-filter rules; matched items are muted (folded, not dropped) */
  adRules?: AdRules
  /** optional request cache (wraps adapter.fetch) */
  cacheLayer?: CacheLayer
  /** optional per-source health ledger; when present, scheduled harvests record real
   *  fetch outcomes and `strategy: exclusive` streams use it to pick the active source. */
  health?: SourceHealthStore
  /** exclusive-ladder re-probe cadence: every N ticks, re-attempt the top non-healthy source
   *  to allow a recovered backend to be promoted back to healthy. Default 6. */
  reprobeCadence?: number
  /** randomness source for the first-fire jitter (injectable for tests; default Math.random) */
  rng?: () => number
  /** fired after a REAL harvest records a source's health outcome (same cache-miss path as
   *  `health.record`) — lets the facility auth-health projection push a WS update on the edge. */
  onOutcome?: (sourceId: string) => void
  /** fired after a collection-mode shard was ACTUALLY replaced (`replaceStream`), with the
   *  harvested items — used to auto-enqueue downloads for playlists with sync enabled.
   *  A held replace (see collection-replace-guard) does NOT fire it: handing `syncPlaylist` an
   *  empty playlist would undo downloads on exactly the snapshot we just refused to trust. */
  onAudioHarvest?(streamId: string, items: StreamItem[]): void
  /** fired after a successful fanout harvest with the adapter-reported feed title (if any) —
   *  used to auto-name a freshly-subscribed Stream on its first harvest. Store mutation lives
   *  in the wiring (serve.ts), keeping the scheduler store-agnostic. */
  onFeedTitle?(streamId: string, title: string): void
  /** 定时采集失败（非 auth 类）→ 事件层接入点。auth 失败刻意排除——它经 facility auth
   *  健康链路变成 auth.needed 事件，这里再报就是双份。 */
  onHarvestError?: (sourceId: string, failure: { category: FailureCategory; message: string }) => void
  /**
   * 本轮**没跑**（环境没就绪，如用户的 Chrome 没连）。和 onHarvestError 是两回事：那个说"源坏了"，
   * 这个说"我们没去采"。
   *
   * **它必须存在，否则这个修法的失败模式是"静默"**：只跳过不出声，用户看到的就是一直没有新内容、
   * 而且永远没有解释。静默的跳过和静默的失败，用户体验上是同一个东西。
   */
  onHarvestSkipped?: (sourceId: string, reason: string) => void
  /** collection 分片替换的"近乎全空"防线状态（armed 位，per stream+source）。生产注入 stream.db
   *  的实现；缺省 = 进程内，重启即忘（单测 / disk 档）。见 collection-replace-guard.ts。 */
  collectionGuard?: CollectionGuardStore
  /**
   * collection 分片这一轮**没被替换**，旧存量保住了。两种理由：
   *  - `not-authoritative`：采集侧自己说本轮没采到（成功指针为假）
   *  - `near-empty`：采集自称成功但新快照近乎全空，等第二轮确认
   *
   * 和 onHarvestError/onHarvestSkipped 一样必须出声：**静默地保住**和静默地丢失一样糟——用户
   * 会看到内容停更却没有任何解释。
   */
  onCollectionReplaceHeld?: (info: {
    streamId: string; sourceId: string; reason: ReplaceHoldReason; kept: number
  }) => void
  /** wall clock, injectable for tests; default Date.now. Used for catch-up overdue math. */
  now?: () => number
  /** read a stream's persisted last successful harvest (epoch ms); undefined = never harvested. */
  loadLastHarvest?: (streamId: string) => number | undefined
  /** persist a stream's last successful harvest (epoch ms) after a non-throwing tick. */
  saveLastHarvest?: (streamId: string, atMs: number) => void
  /** Live audio-membership predicate: true when the stream currently belongs to an audio-present
   *  Channel. `modeOf` consults it so a 歌单 subscribed into an audio Channel harvests as a
   *  `collection` (order-preserving `replaceStream`) IMMEDIATELY. **Nothing writes the derived
   *  mode back to the store** — audio-ness is re-derived on every call, so moving a stream in or
   *  out of an audio Channel takes effect at once. Injected (not a store dep) to keep the
   *  scheduler store-agnostic; absent in tests → the audio rule is simply skipped. */
  isAudioStream?: (streamId: string) => boolean
  /** Task-boundary attribution (op-track): wraps each tick as `harvest:<streamId>` so loop-lag
   *  stall reports can name the harvest overlapping the stall window. Absent (tests) → no-op. */
  track?: <T>(name: string, fn: () => Promise<T>) => Promise<T>
  /** Sync twin of `track`, for the sub-second synchronous phases inside a harvest
   *  (`normalize:<sourceId>` / `store:<sourceId>`). These are the spans short enough to land
   *  fully inside a stall window — i.e. the ones loop-lag can actually convict; wrapping them
   *  in the async `track` would close the span a microtask late and bill the NEXT sync op to
   *  the wrong name. Absent (tests) → no-op. */
  trackSync?: <T>(name: string, fn: () => T) => T
  /** Harvest phase ledger — the ordinary-harvest counterpart of RecipeRunner's probe wiring
   *  (recipes already report per-phase timing on the `recipe` debug channel; this gives every
   *  other source the same treatment). `newProbe` mints a per-(stream,source) phase recorder
   *  for one harvest, `onTiming` receives the finished breakdown. Only successful harvests
   *  report — failures already land in the source-health ledger with category + stack. */
  harvestTiming?: {
    newProbe: (sourceId: string) => HarvestProbe
    onTiming: (report: HarvestTimingReport) => void
  }
}

/** Structural slice of RunProbe (src/replay/recipe-probe.ts) — injected, not imported, so the
 *  scheduler stays as decoupled from the replay layer as it is from op-track. */
export interface HarvestProbe {
  /** Close the phase since the previous mark. */
  mark(phase: string): void
  timings(): Array<{ phase: string; ms: number }>
}

export interface HarvestTimingReport {
  streamId: string
  sourceId: string
  /** cadence-timer tick (true) vs manual refresh (false) */
  scheduled: boolean
  /** items came from the request cache — no upstream fetch ran, so a ~0ms `fetch` is real */
  cacheHit: boolean
  /** policy-injected target depth for this tick (undefined = stream has no harvest policy) */
  limit?: number
  fetched: number
  written: number
  timing: Array<{ phase: string; ms: number }>
}

export interface TickResult {
  fetched: number
  written: number
}

/** Verbatim composite key. Hashing (djb2, historically) bought nothing for an in-process
 *  Map but made silent cross-source collisions possible — a collision hands stream A
 *  another source's items. */
export function buildCacheKey(adapterId: string, sourceId: string, params: Record<string, unknown>): string {
  const canonical = JSON.stringify(params, Object.keys(params).sort())
  return `${adapterId}:${sourceId}:${canonical}`
}

interface CacheEntry {
  items: unknown[]
  at: number
  ttlMs: number
}

export const DEFAULT_CACHE_TTL_MS = 300_000   // 5 min floor
const MAX_CACHE_TTL_MS = 86_400_000    // 24h ceiling
const LOCK_TIMEOUT_MS = 60_000

/** Sentinel for "the in-flight fetch we were waiting on hung" — rethrown as-is, while a
 *  real fetch failure makes the waiter retry with its own fetch instead. */
class CacheLockTimeoutError extends Error {}

export class CacheLayer {
  private readonly store = new Map<string, CacheEntry>()
  private readonly locks = new Map<string, Promise<unknown[]>>()
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly maxEntries: number
  private readonly lockTimeoutMs: number

  constructor(opts?: { ttlMs?: number; now?: () => number; maxEntries?: number; lockTimeoutMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_CACHE_TTL_MS
    this.now = opts?.now ?? (() => Date.now())
    this.maxEntries = opts?.maxEntries ?? 1000
    this.lockTimeoutMs = opts?.lockTimeoutMs ?? LOCK_TIMEOUT_MS
  }

  /** Resolve TTL from manifest cadence, clamped to [300s, 24h]. */
  static ttlFromCadence(cadenceHintSeconds?: number): number {
    if (!cadenceHintSeconds || cadenceHintSeconds <= 0) return DEFAULT_CACHE_TTL_MS
    const ms = cadenceHintSeconds * 1000
    return Math.min(Math.max(ms, DEFAULT_CACHE_TTL_MS), MAX_CACHE_TTL_MS)
  }

  get(key: string): unknown[] | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (this.now() - entry.at >= entry.ttlMs) {
      this.store.delete(key)
      return null
    }
    // LRU touch: re-insert so eviction (first key in insertion order) drops the
    // least-recently-USED entry, not merely the earliest-inserted one.
    this.store.delete(key)
    this.store.set(key, entry)
    return entry.items
  }

  set(key: string, items: unknown[], ttlMs?: number): void {
    if (this.store.size >= this.maxEntries) {
      const lru = this.store.keys().next().value
      if (lru) this.store.delete(lru)
    }
    this.store.set(key, { items, at: this.now(), ttlMs: ttlMs ?? this.ttlMs })
  }

  /**
   * Fetch-through with in-flight dedup: if another caller is already fetching the same key,
   * await THAT promise directly (no polling). If the in-flight fetch fails, the waiter falls
   * back to its own fetch attempt (joining a restarted one if a sibling got there first).
   * `fresh: true` skips the cache-hit check — an explicit preview wants what the source says
   * NOW — but still joins/records the in-flight lock and refills the cache for later readers.
   *
   * `cacheable` (consulted AFTER fetchFn resolves) can veto storing this result. The one caller
   * that says no is a **non-authoritative** harvest ("本轮没采"): caching it would serve that
   * fake empty for the whole TTL, and every tick in the window would look like a legitimate
   * cache hit — which is exactly what the collection-replace guard must not be fed.
   */
  async fetchOrWait(key: string, ttlMs: number, fetchFn: () => Promise<unknown[]>, opts?: { fresh?: boolean; cacheable?: () => boolean }): Promise<unknown[]> {
    if (!opts?.fresh) {
      const hit = this.get(key)
      if (hit) return hit
    }

    const existing = this.locks.get(key)
    if (existing) {
      try {
        return await this.withLockTimeout(existing, key)
      } catch (e) {
        if (e instanceof CacheLockTimeoutError) throw e
        return this.fetchOrWait(key, ttlMs, fetchFn, opts)
      }
    }

    const promise = fetchFn().then(items => {
      if (opts?.cacheable?.() !== false) this.set(key, items, ttlMs)
      this.locks.delete(key)
      return items
    }).catch(err => {
      this.locks.delete(key)
      throw err
    })
    this.locks.set(key, promise)
    return promise
  }

  /** Bound a waiter by lockTimeoutMs so a hung upstream can't strand every joiner forever. */
  private withLockTimeout(p: Promise<unknown[]>, key: string): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new CacheLockTimeoutError(`[cache] lock timeout for key ${key}`)), this.lockTimeoutMs)
      t.unref?.()
      p.then(
        (v) => { clearTimeout(t); resolve(v) },
        (e) => { clearTimeout(t); reject(e) },
      )
    })
  }
}

/**
 * Drives named streams through the existing pipeline. Fan-out persists each
 * source separately but against the SHARED dedup store, so an item surfaced by
 * two sources (same dedup key) is written exactly once.
 */
/** One source's failure inside a live preview — shown in the preview modal, never written
 *  to the health ledger (a throwaway preview must not mark a source dead). */
export interface PreviewError {
  source: string
  category: FailureCategory
  reason: string
}
export interface PreviewResult {
  items: StoredItem[]
  errors: PreviewError[]
}

/** Newest-first sort key, mirroring the inbox's COALESCE(timestamp, created_at). */
function recencyKey(it: StoredItem): string {
  return it.timestamp || it.fetched_at || ''
}

/** Backoff skip cap: a persistently-failing fanout member is still re-attempted at least
 *  every 7th scheduled tick (skip ≤ 6), mirroring the exclusive ladder's re-probe spirit. */
const MAX_BACKOFF_SKIP_TICKS = 6

export class Scheduler {
  private readonly streams = new Map<string, Stream>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private started = false
  private readonly lastTick = new Map<string, string>()
  private readonly cache: CacheLayer
  /** per-stream tick counter, used to fire the exclusive-ladder re-probe every N ticks */
  private readonly tickCount = new Map<string, number>()
  private readonly reprobeCadence: number
  private readonly rng: () => number
  /** per stream+member consecutive-failure ledger driving the scheduled-tick backoff */
  private readonly backoff = new Map<string, { fails: number; skip: number }>()
  private readonly now: () => number
  /** collection 替换防线的 armed 位（注入的持久实现，或进程内缺省） */
  private readonly collectionGuard: CollectionGuardStore

  constructor(private readonly opts: SchedulerOpts) {
    for (const s of opts.streams) this.streams.set(s.id, s)
    this.cache = opts.cacheLayer ?? new CacheLayer()
    this.reprobeCadence = opts.reprobeCadence ?? 6
    this.rng = opts.rng ?? Math.random
    this.now = opts.now ?? (() => Date.now())
    this.collectionGuard = opts.collectionGuard ?? new MemoryCollectionGuard()
  }

  list(): Stream[] {
    return [...this.streams.values()]
  }

  /** A stream's storage/limit mode: the stream's own `mode` wins; else 'collection' if the stream
   *  belongs to an audio Channel (a 歌单 is a curated ordered list, rebuilt each harvest) or any
   *  member source's manifest is `mode:'collection'` (a collection/channel rebuilt each harvest —
   *  kept out of the all-latest timeline), else 'feed'. The audio rule is derived LIVE (not from
   *  stored mode) so a freshly-subscribed audio stream harvests order-preserving on its very first
   *  tick.
   *
   *  **A stored `mode` SHADOWS both rules** (first line) and nothing ever writes one for you — in
   *  practice almost every stream leaves it unset and is classified live. Stamping one pins the
   *  stream: it then stays `feed` even after joining an audio Channel. Only stamp when the upstream
   *  shape genuinely differs from what membership implies. */
  modeOf(streamId: string): 'feed' | 'collection' {
    const s = this.streams.get(streamId)
    if (!s) return 'feed'
    if (s.mode) return s.mode
    if (this.opts.isAudioStream?.(streamId)) return 'collection'
    return s.sources.some((src) => this.opts.registry.get(this.getSourceId(src))?.mode === 'collection')
      ? 'collection'
      : 'feed'
  }

  private getSourceId(src: StreamMember): string {
    return (src.plugin_id && src.source_template_id)
      ? canonicalSourceId(src.plugin_id, src.source_template_id)
      : src.source_id!;
  }

  /** Effective ad rules for one stream: the scheduler-wide baseline (built-in defaults ⊕
   *  config.yaml, computed once at bootstrap and passed in as opts.adRules) merged with
   *  this stream's own optional override. Union semantics — a stream can only add rules,
   *  never suppress a baseline one. */
  private effectiveAdRules(stream: Stream): AdRules | undefined {
    if (!stream.ad_filter) return this.opts.adRules
    return mergeAdRules(this.opts.adRules ?? {}, stream.ad_filter)
  }

  lastTickAt(id: string): string | undefined {
    return this.lastTick.get(id)
  }

  /** Registration only installs the cadence timer. StreamService owns the explicit first tick
   * for a user-created service; boot restoration never triggers an acquisition.
   *
   * **按 id 幂等 —— 同一条流 add 两次得到一份注册、一条定时器链**：`streams`/`timers` 都是以
   * stream id 为键的 Map，`schedule()` 先 clear 掉旧定时器再 arm 新的，所以第二次 add 不会留下
   * 一条还在自我续期的孤儿链。第二次 add 的语义是 **upsert（用新定义替换旧的）**，不是报错也不是
   * 空操作——`rescheduleResourceStream`(remove+add) 与 `StreamService.subscribe` 的重复订阅都
   * 依赖这个语义刷新流定义，把它改成"拒绝"会让定义更新被静默丢弃。
   * 重复注册真正的代价在调用方那句「立刻抓一次」上，判据见 `scheduleResourceStream`。 */
  add(stream: Stream): void {
    this.streams.set(stream.id, stream)
    if (this.started) this.schedule(stream)
  }

  /** Replace a scheduled stream's definition in place — no timer churn, no immediate tick.
   *  For metadata-only edits (label, ad_filter, vault_subdir…) where cadence/members are
   *  unchanged, so the running timer stays valid; only future ticks and list() need the
   *  fresh object. Returns false (no-op) if the stream isn't scheduled — use add() for that. */
  update(stream: Stream): boolean {
    if (!this.streams.has(stream.id)) return false
    this.streams.set(stream.id, stream)
    return true
  }

  /** Deschedule + drop a stream. Returns true if it existed. */
  remove(id: string): boolean {
    const timer = this.timers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
    for (const k of this.backoff.keys()) if (k.startsWith(`${id}\0`)) this.backoff.delete(k)
    return this.streams.delete(id)
  }

  /** Current health state of a source (cold start = healthy when no ledger). */
  private healthState(sourceId: string): 'healthy' | 'degraded' | 'dead' {
    return this.opts.health?.stateOf(sourceId) ?? 'healthy'
  }

  /** Swap the health ledger this scheduler consults/records to. Used by disk-service to install
   *  a `NoopSourceHealthStore`, guaranteeing a disk-mode Scheduler instance can never write
   *  source-health.json — including from the auth branch in `fetchSource`, which records even
   *  on ad-hoc reads (D4/D6: the disk-only stdio process must never write the data dir). */
  setHealthStore(health: SourceHealthStore | undefined): void {
    this.opts.health = health
  }

  /**
   * Resolve manifest+adapter+creds and fetch raw items for one source.
   * When `recordHealth` is set, the REAL fetch (cache-miss path only) records its
   * outcome in the health ledger — cache hits never move health (design D3). Ad-hoc
   * reads (MCP/discover/search) pass it false so they don't contaminate source health.
   */
  private async fetchSource(
    src: StreamMember,
    fetchOpts: { recordHealth?: boolean; ttlCapMs?: number; fresh?: boolean; probe?: HarvestProbe; signal?: AbortSignal; userInitiated?: boolean } = {}
  ): Promise<{ manifest: SourceManifest; route: string; items: unknown[]; title?: string; cacheHit: boolean; authoritative: boolean }> {
    const { recordHealth = false, ttlCapMs, fresh, probe, signal, userInitiated } = fetchOpts
    const sourceId = this.getSourceId(src)
    const manifest = this.opts.registry.get(sourceId)
    if (!manifest) throw new Error(`Unknown source: ${sourceId}`)
    const adapter = this.opts.adapters.get(manifest.adapter)
    if (!adapter) throw new Error(`No adapter registered for "${manifest.adapter}"`)

    const env = await this.opts.resolveCreds(manifest.auth)
    await adapter.init(env)
    if (adapter.sidecar) {
      await adapter.sidecar.start(env)
      if (!(await adapter.sidecar.health())) {
        throw new Error(`[scheduler] sidecar for adapter "${manifest.adapter}" is unhealthy`)
      }
    }
    probe?.mark('creds')
    const cacheKey = buildCacheKey(manifest.adapter, sourceId, src.params)
    // The manifest's cadence_hint sets the source's own freshness window (clamped to the
    // 5min–24h band), but a scheduled stream's cadence CAPS it: a user who set a 60s
    // cadence must get a real fetch every tick, not a cache hit until the 5-min floor.
    const baseTtl = CacheLayer.ttlFromCadence(manifest.cadence_hint_seconds)
    const ttlMs = ttlCapMs != null ? Math.min(baseTtl, ttlCapMs) : baseTtl
    // `title` is captured only on a cache MISS (the callback runs only then). That is the
    // intended path: a cache hit means the stream was already harvested, so its name is set.
    let title: string | undefined
    // The freshness callback runs only on a cache MISS — `ranFetch` is therefore the hit/miss
    // fact for the timing report (a ~0ms `fetch` phase on a hit is real, not a fast source).
    let ranFetch = false
    // 成功指针（AdapterFetchResult.authoritative）。**缓存命中恒为 true** —— 不是猜测：非权威结果
    // 下面明确拒绝入缓存，所以缓存里只可能是权威结果。
    let authoritative = true
    const items = await this.cache.fetchOrWait(cacheKey, ttlMs, async () => {
      try {
        ranFetch = true
        const got = await adapter.fetch(src.params, manifest, {
          runtimeConfig: this.opts.runtimeConfigFor?.(manifest) ?? {},
          signal,
          userInitiated,
        })
        const normalized = Array.isArray(got) ? got : got.items
        if (!Array.isArray(got)) {
          title = got.title
          authoritative = got.authoritative !== false
        }
        // 本轮**没采**（环境缺席 / 主动 decline / 隔离中）→ health 三样都不动，但出声。
        // 和 isEnvironmentUnavailable 那条同一个道理：记失败 = 用户关一晚电脑第二天全红；
        // 记成功（`empty` 也算一种成功记录）= 把"其实没去采"伪装成"上游今天空了"，而这正是
        // collection 流被清空的那条链子的头。
        if (!authoritative) {
          if (recordHealth) this.opts.onHarvestSkipped?.(sourceId, `本轮未采集（${manifest.adapter} declined）`)
          return normalized
        }
        if (recordHealth) {
          this.opts.health?.record(
            sourceId,
            normalized.length ? { kind: 'ok', itemCount: normalized.length } : { kind: 'empty' }
          )
          this.opts.onOutcome?.(sourceId)
        } else if (this.opts.health?.clearAuthFailure(sourceId)) {
          // The other half of the `auth` exception below. An ad-hoc read is allowed to RAISE a
          // login wall (otherwise a search-only facility's would never surface); it must therefore
          // be allowed to CLEAR one, or the flag is a one-way valve — user logs back in, harvests
          // succeed, and "登录已失效" stays up forever (live 2026-07-28).
          //
          // Only the auth assertion is released, and only when there was one — this is not a
          // general "ad-hoc read counts as a health tick". See clearAuthFailure.
          this.opts.onOutcome?.(sourceId)
        }
        return normalized
      } catch (e) {
        // 环境没就绪 → 本轮跳过：**health 三样都不动**（不记失败、不记成功、不动 lastError）。
        // 记成失败 = 用户关一晚电脑，第二天所有 ext-cdp 的源全红；记成成功 = 把真坏掉的源永久掩盖。
        // 正确答案是第三种：什么都不记，但**出声**（onHarvestSkipped）。
        if (isEnvironmentUnavailable(e)) {
          if (recordHealth) this.opts.onHarvestSkipped?.(sourceId, (e as Error).message)
          throw e
        }
        const failure = classifyError(e)
        // An `auth` failure is recorded even from an ad-hoc read. It is not a health verdict on
        // the source (which is what recordHealth gates) — it is a FACT about the facility's login
        // session, and it is the only thing that lights up the re-login panel. A search-only
        // facility (douyin) is never scheduled, so without this its login wall could never
        // surface and the user would have no way to act on "needs re-login".
        if (recordHealth || failure.category === 'auth') {
          this.opts.health?.record(sourceId, { kind: 'error', ...failure })
          this.opts.onOutcome?.(sourceId)
        }
        if (recordHealth && failure.category !== 'auth') {
          this.opts.onHarvestError?.(sourceId, { category: failure.category, message: failure.message })
        }
        throw e
      }
    // `userInitiated` 意味着这次调用本身就是一个动作（点赞/取消赞……），它的价值就在"真的
    // 发生了这一次"——`fresh` 保证不吃上一次动作留下的陈旧结果，`cacheable:false` 保证这次
    // 结果不留给下一次动作去命中。两者缺一都会让第二次点击退化成一句谎话：不吃缓存但留了
    // 缓存，下下次点击照样白发；吃了新鲜但没标记不可缓存，这次自己倒是真做了，代价转嫁给
    // 下一次调用者。顺带把动作闸的裂缝一起补了——闸只在 `adapter.fetch` 真的被调用时才生效
    // （见 ActionRecipeBlockedError 头注），缓存命中会绕开这次调用；不缓存动作结果 = 没有
    // 命中可言，闸永远跑得到。
    }, { fresh: fresh || userInitiated, cacheable: () => authoritative && !userInitiated })
    probe?.mark(ranFetch ? 'fetch' : 'fetch(cache)')
    const route = manifest.route ?? (src.params.route as string | undefined) ?? manifest.id
    return { manifest, route, items, title, cacheHit: !ranFetch, authoritative }
  }

  /** Persist one source's harvest into dedup/vault/item-store. Returns counts.
   *
   *  Phase marks (when `probe` is present) + op-track sync spans: the normalize loop and the
   *  batched sqlite write are the sub-second PURE-CPU sections of a harvest — exactly the spans
   *  short enough to land fully inside a loop-lag stall window and get convicted (`contained`),
   *  where the enclosing `harvest:<streamId>` op always spans the window and stays a weak
   *  suspect. One instrumentation, two consumers: the phase ledger and stall attribution. */
  private async persistHarvest(
    streamId: string,
    stream: Stream,
    src: StreamMember,
    manifest: SourceManifest,
    route: string,
    items: unknown[],
    vaultDir: string | undefined,
    probe?: HarvestProbe,
    /** 采集侧的成功指针；缺省 true（裸数组 / 老调用点） */
    authoritative = true,
  ): Promise<TickResult> {
    const sourceId = this.getSourceId(src)
    const adRules = this.effectiveAdRules(stream)
    // Fanout fetches run concurrently but persists are sequential — the gap between this
    // source's fetch landing and its persist starting is queue wait behind the previous
    // member. Name it, or it silently inflates whichever phase is marked first below.
    probe?.mark('queued')
    const sync = <T,>(name: string, fn: () => T): T => (this.opts.trackSync ? this.opts.trackSync(name, fn) : fn())
    // Collection-mode streams (歌单/收藏/频道 — a source's current full set, not an append
    // feed) rebuild the read-model each harvest via replaceStream. Rebuilding each harvest
    // reflects add/remove, preserves upstream order in `seq`, and (unlike the append path)
    // is NOT gated by the dedup store — so a re-harvest always repopulates instead of being
    // skipped as "seen".
    if (this.modeOf(streamId) === 'collection' && this.opts.itemStore) {
      const ordered = sync(`normalize:${sourceId}`, () => items.map((raw) => {
        const it = makeStreamItem(streamId, route, raw, adRules, sourceId, stream.title_include, src.season)
        it.content = normalize(it.raw as RawItem, manifest)
        if (manifest.categories?.includes('video')) it.videoRef = videoItemReference(it)
        return it
      }))
      probe?.mark('normalize')
      // 替换不是无条件的：空快照有两种，一种是"上游真的空了"(该替换)，一种是"这轮没采到/上游
      // 抽风"(替换就是数据丢失，2026-07-24 怡乐 1015 条)。两层防线见 collection-replace-guard.ts。
      const guard = this.collectionGuard
      const decision = decideCollectionReplace({
        authoritative,
        nextCount: ordered.length,
        prevCount: this.opts.itemStore.countBySource(streamId, sourceId),
        armed: guard.isArmed(streamId, sourceId),
      })
      if (!decision.replace) {
        // near-empty：记下"它说过一次了"，下一轮再说同样的话就认。
        // not-authoritative：**不动 armed** —— 没采到不构成"上游说空"的一轮，不许拿它凑数。
        if (decision.reason === 'near-empty') guard.arm(streamId, sourceId)
        probe?.mark('store(held)')
        this.opts.onCollectionReplaceHeld?.({
          streamId,
          sourceId,
          reason: decision.reason,
          kept: this.opts.itemStore.countBySource(streamId, sourceId),
        })
        // 旧分片原样留着；onAudioHarvest 也不能发 —— 拿一份空歌单去 syncPlaylist 会照着撤下载。
        return { fetched: items.length, written: 0 }
      }
      guard.clear(streamId, sourceId)
      // 按 source 分片替换:多成员 collection 流各成员各自快照,整流替换会互相抹除(见 item-store 注释)
      sync(`store:${sourceId}`, () => this.opts.itemStore!.replaceStream(streamId, ordered, manifest.type, sourceId))
      probe?.mark('store')
      // **collection 流不进归堆**（这里刻意没有 storyFold 那一跳）。
      //
      // 歌单 / 收藏夹是**目录快照**，不是发布事件：一首歌出现在两个歌单里，说的是"这两个
      // 歌单都收了它"，不是"两个源都发布了同一条内容"。跟着来的两个数都是错的——
      // 「同质内容」在它身上没有意义，而「谁先发」算出来的是**用户把歌加进歌单的时间差**。
      // 2026-08-13 活体上这么算过一轮：领先榜煞有介事地报"平均领先 15253 秒"，量的其实是
      // 用户两次收藏之间隔了多久。
      for (const item of ordered) this.notifyPersisted(item)
      this.opts.onAudioHarvest?.(streamId, ordered)
      const res = await persistItems(streamId, route, items, vaultDir, this.opts.dedup, async (it) => {
        this.opts.onItem?.(it, manifest.type) // notify on genuinely-new items only; store handled above
      }, adRules, sourceId)
      probe?.mark('finalize') // dedup filter + vault writes + dedup.addMany + notifications
      return res
    }
    const res = await persistItems(
      streamId, route, items, vaultDir, this.opts.dedup,
      // notify per genuinely-new item, AFTER the batched durable write below
      async (it) => {
        this.notifyPersisted(it)
        this.opts.onItem?.(it, manifest.type)
      },
      adRules, sourceId, stream.title_include,
      // batched item-store write (one transaction): normalize each new item, then add them all at once
      (fresh) => {
        // persistItems runs this AFTER its per-item dedup-filter + vault loop — mark that
        // preceding stretch first or it would be billed to `normalize`.
        probe?.mark('dedup/vault')
        sync(`normalize:${sourceId}`, () => {
          for (const it of fresh) {
            it.content = normalize(it.raw as RawItem, manifest)
            if (manifest.categories?.includes('video')) it.videoRef = videoItemReference(it)
          }
        })
        probe?.mark('normalize')
        sync(`store:${sourceId}`, () => this.opts.itemStore?.addMany(fresh, manifest.type))
        probe?.mark('store')
        // 入库之后才归堆：账本里指向的 item 必须已经在库里。自己有耗时格，慢了看得见。
        if (this.opts.storyFold) {
          this.foldQuietly(fresh)
          probe?.mark('fold')
        }
      },
      src.season,
    )
    probe?.mark('finalize') // dedup.addMany + per-item notifications
    return res
  }

  /**
   * 归堆那一跳。**兜底在这一层，不在实现方**：`StoryFoldRecorder` 自己也吞异常（那是为了
   * 一条失败不拖累同批其它条），但"绝不让呈现层的附加能力弄挂一轮采集"是**调用方的不变量**，
   * 不能寄托在被调方的自觉上——它换个实现、抛在 record 之外，代价就是整轮采集失败。
   */
  private foldQuietly(items: StreamItem[]): void {
    try {
      this.opts.storyFold?.record(items)
    } catch (e) {
      console.error('[scheduler] 归堆失败（不影响入库）:', (e as Error).message)
    }
  }

  private notifyPersisted(item: StreamItem): void {
    void Promise.resolve(this.opts.onItemPersisted?.(item)).catch(() => undefined)
  }

  /** Policy-layer limit for this tick (ARCHITECTURE.md Data Scheduling → parameter
   *  composition): backfill depth while the stream has never persisted an item (durable
   *  dedup count is 0 — a failed first harvest stays 0 and retries the backfill), then the
   *  incremental depth. undefined = no injection (streams without options.harvest, or the
   *  relevant limit unset). Computed once per tick so every member of the same tick sees
   *  the same phase. */
  private harvestLimit(stream: Stream): number | undefined {
    const policy = stream.harvest
    if (!policy) return undefined
    // A collection-mode stream is the source's full current set, and its persist path
    // (replaceStream) is NOT evict-gated — so harvesting only the incremental window would
    // shrink the store to that window. Collection streams therefore always fetch backfill
    // (full) depth.
    if (this.modeOf(stream.id) === 'collection') {
      return policy.backfillLimit ?? policy.incrementalLimit
    }
    return this.itemCount(stream.id) === 0 ? policy.backfillLimit : policy.incrementalLimit
  }

  /** Bind the policy limit below the member's own params — an explicitly bound limit wins. */
  private bindLimit(src: StreamMember, limit: number | undefined): StreamMember {
    return limit == null ? src : { ...src, params: { limit, ...src.params } }
  }

  /** `scheduled: true` marks a cadence-timer tick — only those advance/honor the failure
   *  backoff, so a user's manual refresh always attempts every source immediately. */
  async tick(streamId: string, tickOpts: { scheduled?: boolean } = {}): Promise<TickResult> {
    // 动手之前给登录态一个补新鲜的机会（今天接的是 cookie-puller：快照太旧就去浏览器取一次）。
    // 位置刻意选在这里而不是取 cookie 的地方：这是**每轮采集一次**，而 `cookieString()` 是
    // 每个请求一次。绝不因此挡住采集——它自己吞掉失败，浏览器不在是常态不是故障。
    if (this.opts.beforeTick) await this.opts.beforeTick().catch(() => {})
    const run = () => this.tickInner(streamId, tickOpts)
    return this.opts.track ? this.opts.track(`harvest:${streamId}`, run) : run()
  }

  private async tickInner(streamId: string, tickOpts: { scheduled?: boolean }): Promise<TickResult> {
    const stream = this.streams.get(streamId)
    if (!stream) throw new Error(`Unknown stream: ${streamId}`)

    const vaultDir = this.opts.vaultEnabled === false ? undefined : join(this.opts.vaultRoot, stream.vault_subdir)
    try {
      const result =
        stream.strategy === 'exclusive'
          ? await this.tickExclusive(stream, vaultDir, tickOpts.scheduled === true)
          : await this.tickFanout(stream, vaultDir, tickOpts.scheduled === true)

      // A non-throwing tick confirms the stream is up to date (even written:0) — advance the
      // persisted lastHarvestAt so a subsequent restart does not needlessly re-catch-up.
      // A throwing tick (every member/rung failed) deliberately does NOT advance it, so the
      // restart catch-up still sees a persistently-failing stream as overdue and retries it.
      this.opts.saveLastHarvest?.(streamId, this.now())
      return result
    } finally {
      // "Last attempted" (UI/backoff signal) advances even on an all-failed tick — distinct
      // from lastHarvestAt above, which is "last confirmed up to date".
      this.lastTick.set(streamId, new Date().toISOString())
    }
  }

  private backoffKey(streamId: string, member: StreamMember): string {
    return `${streamId}\0${this.getSourceId(member)}`
  }

  /**
   * Default (fanout) strategy: fetch every source each tick and merge through the shared dedup.
   * Fetches run CONCURRENTLY — facility-bound adapters serialize internally (session-manager's
   * per-lane tail chain), so parallelism only overlaps genuine I/O waits. Persistence stays
   * sequential: the "shared item written exactly once" guarantee relies on each persist seeing
   * the previous one's dedup marks.
   * One failing member no longer aborts the tick; the tick throws only when EVERY attempted
   * member failed (so a single-source manual refresh keeps its visible error path). On
   * scheduled ticks a repeatedly-failing member backs off exponentially (skip 0,1,3,… ticks,
   * capped) instead of being re-hit at full cadence.
   */
  private async tickFanout(stream: Stream, vaultDir: string | undefined, scheduled: boolean): Promise<TickResult> {
    const limit = this.harvestLimit(stream)
    const ttlCapMs = stream.cadence_seconds * 1000

    const due = stream.sources.filter((member) => {
      if (!scheduled) return true
      const bo = this.backoff.get(this.backoffKey(stream.id, member))
      if (bo && bo.skip > 0) {
        bo.skip--
        return false
      }
      return true
    })

    const outcomes = await Promise.all(due.map(async (member) => {
      const src = this.bindLimit(member, limit)
      // One probe per (stream, source) harvest — created at fetch start so `creds`/`fetch` land
      // on it; carried alongside the outcome to the sequential persist below. Failed fetches
      // just drop theirs (failures report through the source-health ledger, not the timing one).
      const probe = this.opts.harvestTiming?.newProbe(this.getSourceId(src))
      try {
        return { member, src, probe, ok: await this.fetchSource(src, { recordHealth: true, ttlCapMs, probe }), error: undefined }
      } catch (e) {
        return { member, src, probe, ok: undefined, error: e as Error }
      }
    }))

    let fetched = 0
    let written = 0
    let firstTitle: string | undefined
    // adapter 没报 title 时的兜底素材（见循环末尾的 inferFeedTitle）。
    const rawForInference: unknown[] = []
    const errors: Error[] = []
    for (const o of outcomes) {
      const key = this.backoffKey(stream.id, o.member)
      if (o.error) {
        errors.push(o.error)
        if (scheduled) {
          const fails = (this.backoff.get(key)?.fails ?? 0) + 1
          this.backoff.set(key, { fails, skip: Math.min(2 ** (fails - 1) - 1, MAX_BACKOFF_SKIP_TICKS) })
        }
        continue
      }
      this.backoff.delete(key)
      const { manifest, route, items, title, cacheHit, authoritative } = o.ok!
      if (firstTitle === undefined && title) firstTitle = title
      else if (firstTitle === undefined) rawForInference.push(...items)
      const res = await this.persistHarvest(stream.id, stream, o.src, manifest, route, items, vaultDir, o.probe, authoritative)
      fetched += res.fetched
      written += res.written
      this.opts.harvestTiming?.onTiming({
        streamId: stream.id,
        sourceId: this.getSourceId(o.src),
        scheduled,
        cacheHit,
        limit,
        fetched: res.fetched,
        written: res.written,
        timing: o.probe?.timings() ?? [],
      })
    }
    if (errors.length > 0 && errors.length === outcomes.length) throw errors[0]
    // 部分失败：整轮不抛，调用方那行 `tick failed` 就不会出现——坏掉的来源在这里各说一句，否则
    // 后端日志里一个字都没有（它只进源健康那本账）。不会刷屏：连续失败的来源已经在按退避跳班。
    for (const o of outcomes) {
      if (o.error) console.error(`[scheduler] ${stream.id} 来源 ${this.getSourceId(o.src)} 失败（其余来源照常入库）:`, o.error.message)
    }
    this.reportFeedTitle(stream.id, firstTitle, rawForInference)
    return { fetched, written }
  }

  /**
   * 「这条流叫什么」上报给自动命名（`backfillLabel`）。adapter 报的 title 优先；它缺席时才从
   * 本轮 raw items 推断——8 个 adapter 里只有 RSSHub 真的报，其余全返回裸数组，不兜底就等于
   * 除 RSSHub 之外的流永远停在 `xhs:xhs-home` 这种占位名上。判据见 `inferFeedTitle`。
   *
   * 两条 tick 路径（fanout / exclusive）都必须走这里：exclusive 以前根本没调过 onFeedTitle，
   * 用阶梯策略的流即使源报了标题也不会被命名。
   */
  private reportFeedTitle(streamId: string, reported: string | undefined, rawItems: unknown[]): void {
    const title = reported ?? inferFeedTitle(rawItems)
    if (title) this.opts.onFeedTitle?.(streamId, title)
  }

  /**
   * Exclusive strategy: treat `sources` as an ordered ladder. Re-probe the top non-healthy
   * source every N ticks (recovers a transiently-dead primary), then harvest from the first
   * healthy source — falling through to the next on a HARD error within the same tick so the
   * worst case still attempts retrieval (the last rung is typically a browser source).
   */
  private async tickExclusive(stream: Stream, vaultDir: string | undefined, scheduled: boolean): Promise<TickResult> {
    const n = (this.tickCount.get(stream.id) ?? 0) + 1
    this.tickCount.set(stream.id, n)
    const limit = this.harvestLimit(stream)
    const ttlCapMs = stream.cadence_seconds * 1000

    // Re-probe: give a recovered backend a chance to be promoted back to healthy.
    if (this.opts.health && n % this.reprobeCadence === 0) {
      const stale = stream.sources.find((s) => this.healthState(this.getSourceId(s)) !== 'healthy')
      if (stale) {
        try {
          const r = await this.fetchSource(this.bindLimit(stale, limit), { recordHealth: true, ttlCapMs })
          const staleSourceId = this.getSourceId(stale)
          if (r.items.length) this.opts.health.markHealthy(staleSourceId)
        } catch {
          // still down — leave its state as-is
        }
      }
    }

    // Selection: first healthy source; if none healthy, the last rung.
    let idx = stream.sources.findIndex((s) => this.healthState(this.getSourceId(s)) === 'healthy')
    if (idx === -1) idx = stream.sources.length - 1

    // Try from the selected rung downward; advance only on a hard error.
    let lastError: Error | undefined
    for (let i = idx; i < stream.sources.length; i++) {
      const src = this.bindLimit(stream.sources[i], limit)
      const probe = this.opts.harvestTiming?.newProbe(this.getSourceId(src))
      try {
        const { manifest, route, items, title, cacheHit, authoritative } = await this.fetchSource(src, { recordHealth: true, ttlCapMs, probe })
        const res = await this.persistHarvest(stream.id, stream, src, manifest, route, items, vaultDir, probe, authoritative)
        this.reportFeedTitle(stream.id, title, items)
        this.opts.harvestTiming?.onTiming({
          streamId: stream.id,
          sourceId: this.getSourceId(src),
          scheduled,
          cacheHit,
          limit,
          fetched: res.fetched,
          written: res.written,
          timing: probe?.timings() ?? [],
        })
        return res
      } catch (e) {
        // hard error already recorded by fetchSource; fall through to the next rung
        // (the failed rung's probe is dropped with it — failures report through health)
        lastError = e as Error
        continue
      }
    }
    // Every attempted rung failed — throw (matching tickFanout's all-failed contract) so
    // tick() does not advance lastHarvestAt and a manual refresh surfaces the error. A
    // silent {0,0} here would be indistinguishable from "up to date, nothing new".
    if (lastError) throw lastError
    return { fetched: 0, written: 0 }
  }

  /**
   * Fetch a single source's items by id without persisting (for MCP read).
   *
   * `signal` = 「调用方还想不想要这次结果」。它一路走到 recipe runner（经
   * `SourceExecutionContext.signal`），所以放弃一次读**真的会把那次运行停掉**，而不只是把答案
   * 丢掉——被放弃的运行仍占着 facility 的那条 lane、仍在花它的访问预算，这两样才是用户体感到的
   * 那个"越点越慢"。**注意它落在缓存共享的外面**：同一把键上已有人在取时，这次调用等的是那一份，
   * 取消自己不会牵连别人，但也停不下别人已经起的那次运行。
   *
   * `userInitiated` 与 `signal` 走同一条线：调用方在这里显式声明"这次是不是用户第一方触发的"，
   * 一路传到 `adapter.fetch` 的 `SourceExecutionContext`——`meta.action:true` 的 recipe 靠它
   * 判断能不能绕开 `ActionRecipeBlockedError`（见该错误类头注）。默认不声明，默认仍是"不是"。
   */
  async readSource(
    sourceId: string,
    params: Record<string, unknown> = {},
    opts: { signal?: AbortSignal; userInitiated?: boolean } = {},
  ): Promise<unknown[]> {
    const parsed = parseSourceId(sourceId)
    return (await this.fetchSource(
      { plugin_id: parsed.plugin_id, source_template_id: parsed.source_template_id, params },
      { signal: opts.signal, userInitiated: opts.userInitiated },
    )).items
  }

  /**
   * Fetch + normalize a source live, WITHOUT persisting/deduping — for ephemeral
   * "discover" views (recommendation feeds that must not accumulate in the inbox).
   */
  async readNormalized(sourceId: string, params: Record<string, unknown> = {}): Promise<StoredItem[]> {
    const parsed = parseSourceId(sourceId)
    const { route, items } = await this.fetchSource({ plugin_id: parsed.plugin_id, source_template_id: parsed.source_template_id, params })
    return items.map((raw) => this.normalizeRaw(sourceId, raw, route))
  }

  /** Normalize ONE raw adapter item as a StoredItem — the per-item half of readNormalized
   *  (makeStreamItem + normalize + manifest.type), so the content-search call site reproduces the
   *  exact ingest normalization instead of duplicating it. Normalization is chosen per-scope at the
   *  CALL SITE (by the item's source manifest), never by "the manifest happens to have a normalizer". */
  normalizeRaw(sourceId: string, raw: unknown, route?: string): StoredItem {
    const manifest = this.opts.registry.get(sourceId)
    if (!manifest) throw new Error(`Unknown source: ${sourceId}`)
    // 第 5 参 = 产源：出线投影按它找归属包（按钮 / 源名 / 站点），缺了就整条静默不投影。
    const it = makeStreamItem(sourceId, route ?? manifest.route ?? manifest.id, raw, undefined, sourceId)
    it.content = normalize(it.raw as RawItem, manifest)
    if (manifest.categories?.includes('video')) it.videoRef = videoItemReference(it)
    return { ...it, type: manifest.type }
  }

  /** Fetch a named stream's merged items without persisting (for MCP read). */
  async readStream(streamId: string): Promise<unknown[]> {
    const stream = this.streams.get(streamId)
    if (!stream) throw new Error(`Unknown stream: ${streamId}`)
    const merged: unknown[] = []
    for (const src of stream.sources) merged.push(...(await this.fetchSource(src)).items)
    return merged
  }

  /**
   * Live preview of a whole Stream: fetch every source, NORMALIZE each item (harvest
   * normalization), merge newest-first, cap. Side-effect-free — no store, no dedup, and
   * (unlike a real tick) no health-ledger write, so previewing never marks a source dead.
   * A failing source contributes a reason, not a thrown error, so one bad source can't
   * blank the rest.
   */
  async readStreamNormalized(streamId: string, opts: { limit?: number } = {}): Promise<PreviewResult> {
    const stream = this.streams.get(streamId)
    if (!stream) throw new Error(`Unknown stream: ${streamId}`)
    const items: StoredItem[] = []
    const errors: PreviewError[] = []
    // fresh: an explicit preview answers "what does this source say NOW" — serving a
    // cadence-cache hit here would make a config test look stale or wrongly healthy.
    for (const src of stream.sources) await this.normalizeInto(this.getSourceId(src), () => this.fetchSource(src, { fresh: true }), items, errors)
    items.sort((a, b) => recencyKey(b).localeCompare(recencyKey(a)))
    return { items: items.slice(0, opts.limit ?? 20), errors }
  }

  /**
   * 一个 Stream 的实时快照，**保持来源自己给的顺序**——不按时间重排、不截断。
   *
   * 与 `readStreamNormalized` 只差这两件事，但差别是本质的：歌单的顺序是**歌单自己的属性**，
   * 既不在时间里也不在入库顺序里。某音乐平台歌单每首歌的 `timestamp` 就是抓取那一秒（全表同值），
   * 按它排等于随机；而入库顺序（`seq`）只有在"整份一次性回填"时才碰巧等于歌单顺序，一旦这份
   * 歌单是靠增量轮次一点点攒起来的（每轮只取最新 N 条），`seq` 和歌单顺序就再无关系。
   * **两个方向都试错过**：先按 `seq` 升序（错），改成降序（对了一份、错了另一份）。
   * 顺序的真相源只有一个——去问歌单本身。
   */
  async readStreamInSourceOrder(streamId: string): Promise<PreviewResult> {
    const stream = this.streams.get(streamId)
    if (!stream) throw new Error(`Unknown stream: ${streamId}`)
    const items: StoredItem[] = []
    const errors: PreviewError[] = []
    for (const src of stream.sources) await this.normalizeInto(this.getSourceId(src), () => this.fetchSource(src, { fresh: true }), items, errors)
    return { items, errors }
  }

  /** Live preview of ONE source (with ad-hoc params, e.g. an unsaved config form) — the
   *  single-source twin of readStreamNormalized; wraps readNormalized's throw as an error. */
  async readSourceNormalized(sourceId: string, params: Record<string, unknown> = {}): Promise<PreviewResult> {
    const parsed = parseSourceId(sourceId)
    const items: StoredItem[] = []
    const errors: PreviewError[] = []
    await this.normalizeInto(
      sourceId,
      () => this.fetchSource({ plugin_id: parsed.plugin_id, source_template_id: parsed.source_template_id, params }, { fresh: true }),
      items,
      errors,
    )
    return { items, errors }
  }

  /** Fetch one source and normalize its items into `items`; on failure push a classified
   *  reason into `errors` (never throws). Shared by both preview entry points. */
  private async normalizeInto(
    sourceId: string,
    fetch: () => Promise<{ route: string; items: unknown[] }>,
    items: StoredItem[],
    errors: PreviewError[],
  ): Promise<void> {
    try {
      const { route, items: raw } = await fetch()
      for (const r of raw) items.push(this.normalizeRaw(sourceId, r, route))
    } catch (e) {
      const { category, message } = classifyError(e)
      errors.push({ source: sourceId, category, reason: message })
    }
  }

  has(streamId: string): boolean {
    return this.streams.has(streamId)
  }

  itemCount(streamId: string): number {
    return this.opts.dedup.countForStream(streamId)
  }

  /** Batch counterpart to `itemCount` — used by StreamService.status() so GET /api/status
   *  doesn't loop synchronously over every scheduled stream (see src/loop-lag.ts). */
  itemCounts(streamIds: string[]): Map<string, number> {
    return this.opts.dedup.countForStreams(streamIds)
  }

  /** First fire lands at a random phase in [0.5, 1) × cadence so streams sharing a cadence
   *  don't volley in sync forever; afterwards each tick re-arms cadence after it FINISHES
   *  (chained setTimeout, not a fixed-period interval timer), so a slow harvest can never overlap the next. */
  private schedule(stream: Stream): void {
    const existing = this.timers.get(stream.id)
    if (existing) clearTimeout(existing)
    this.arm(stream.id, stream.cadence_seconds * 1000 * (0.5 + this.rng() / 2))
  }

  private arm(streamId: string, delayMs: number): void {
    const timer = setTimeout(async () => {
      try {
        await this.tick(streamId, { scheduled: true })
      } catch (e) {
        console.error(`[scheduler] ${streamId} tick failed:`, (e as Error).message)
      }
      // Re-arm only if this chain is still current: remove()/stop()/re-schedule() during the
      // tick clears or replaces the map entry, which retires this chain without a race.
      if (this.started && this.timers.get(streamId) === timer) {
        const s = this.streams.get(streamId)
        if (s) this.arm(streamId, s.cadence_seconds * 1000)
      }
    }, delayMs)
    this.timers.set(streamId, timer)
  }

  start(): void {
    this.started = true
    // Restoring persisted services is not a user registration action. First fire honors the
    // persisted lastHarvestAt: overdue (backend was down past a cadence) → prompt catch-up with
    // small jitter; otherwise the existing [0.5,1)×cadence jittered first fire. Missing
    // lastHarvestAt is treated as not-overdue (no upgrade-time mass catch-up).
    for (const stream of this.streams.values()) {
      const { delayMs } = computeFirstFire({
        nowMs: this.now(),
        lastHarvestMs: this.opts.loadLastHarvest?.(stream.id),
        cadenceMs: stream.cadence_seconds * 1000,
        rng: this.rng,
      })
      const existing = this.timers.get(stream.id)
      if (existing) clearTimeout(existing)
      this.arm(stream.id, delayMs)
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.started = false
  }

  /** Shut down every adapter-owned sidecar (called on teardown). */
  async shutdownAdapters(): Promise<void> {
    for (const adapter of this.opts.adapters.values()) {
      try { await adapter.sidecar?.shutdown() } catch (e) {
        console.error(`[scheduler] sidecar shutdown for "${adapter.id}" failed:`, (e as Error).message)
      }
    }
  }
}
