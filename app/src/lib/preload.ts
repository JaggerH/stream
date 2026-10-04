/** Preload middle layer — sits between the RSSHub index (thin items) and the display.
 *
 *  RSSHub only gives an index (title + link + counts). This layer continuously warms
 *  the *full* info per item — extracted article, comments, comment count — ahead of
 *  the viewport, so the list and the detail modal always render complete data and an
 *  open is instant. It's source-blind: every source routes through enrichParamsFor
 *  (in enrich.ts) and api.enrich; this module owns the caching + scroll scheduling.
 *
 *  One bounded-LRU cache keyed per item (channels share it harmlessly — keys differ),
 *  warmed by a per-row IntersectionObserver, read back by the card + modal. The only
 *  knobs you normally touch are the tunables just below. */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Connection, type EnrichParams } from './api.ts'
import { allowsAutomaticEnrichment, enrichParamsFor } from './enrich.ts'
import type { Article, Comment, Enrichment, Item } from './types.ts'
import { useWs } from '../hooks/useWs.ts'

// —— tunables ——
const CACHE_TTL_MS = 5 * 60 * 1000 // a warm entry older than this is re-fetched
// bounded LRU: keep the most-recent N item enrichments.
// 60 是按单列列表定的：一屏 ~4 行 → 约 15 屏的余量。瀑布流一屏能放 20–30 张卡（6 列时），
// 同样这 60 条只够 2–3 屏，往下滚三屏再滚回来第一屏就已经被挤掉了。240 给瀑布流留 ~8–10 屏，
// 和列表同量级。不直接按 15 屏配到 375+：每条缓存都带着整篇文章 + 评论，而 persistCache 会在
// 每次 touch/store 时把**整个 cache** 序列化进 sessionStorage，条数直接进这条成本，且 5MB 配额
// 是硬顶。剩下的缺口由下面 usePrefetchOnApproach 不再永久 disconnect 补上——被挤掉的卡再次
// 进入视口会重新 warm，LRU 不必覆盖整场会话。
const PRELOAD_MAX = 240
const PRELOAD_LOOKAHEAD_PX = 800 // warm a row when it's within ~1 screen below the viewport
const MAX_PREFETCH = 3 // concurrent prefetches（包 enricher 那类现取本来就不进预取，见 allowsAutomaticEnrichment）
const STORAGE_KEY = 'stream.preload-cache.v1'

type CacheEntry = { at: number; promise: Promise<Enrichment>; value?: Enrichment }
type PersistedEntry = { key: string; at: number; value: Enrichment }
const cache = new Map<string, CacheEntry>()
const fresh = (e?: CacheEntry): e is CacheEntry => !!e && Date.now() - e.at < CACHE_TTL_MS

function readPersisted(): PersistedEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as PersistedEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry) => entry && typeof entry.key === 'string' && typeof entry.at === 'number' && entry.value)
  } catch {
    return []
  }
}

function persistCache(): void {
  if (typeof window === 'undefined') return
  try {
    const entries: PersistedEntry[] = []
    for (const [key, entry] of cache.entries()) {
      if (!entry.value || !fresh(entry)) continue
      entries.push({ key, at: entry.at, value: entry.value })
    }
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    /* ignore persistence failures */
  }
}

function hydrateCache(): void {
  if (cache.size > 0) return
  for (const entry of readPersisted()) {
    if (Date.now() - entry.at >= CACHE_TTL_MS) continue
    const promise = Promise.resolve(entry.value)
    cache.set(entry.key, { at: entry.at, value: entry.value, promise })
  }
}

hydrateCache()

// LRU over a Map (insertion-ordered): touch = move to newest, store = insert + evict oldest.
function touch(key: string, entry: CacheEntry): void {
  cache.delete(key)
  cache.set(key, entry)
  persistCache()
}
function store(key: string, entry: CacheEntry): void {
  cache.set(key, entry)
  while (cache.size > PRELOAD_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  persistCache()
}

// subscribers so the card upgrades (excerpt / lead image / comment count) the moment a
// prefetch lands, without itself triggering a fetch.
const listeners = new Map<string, Set<() => void>>()
const notify = (key: string) => listeners.get(key)?.forEach((l) => l())

// Concurrency gate for *prefetch* only — a fast scroll must not fan out dozens of
// fetches. On-demand opens bypass it so a click never waits behind speculative work.
let active = 0
const waiting: (() => void)[] = []
function acquire(): Promise<void> {
  if (active < MAX_PREFETCH) {
    active++
    return Promise.resolve()
  }
  return new Promise<void>((res) => waiting.push(res)).then(() => void active++)
}
function release(): void {
  active--
  waiting.shift()?.()
}

function fetchEnrichment(conn: Connection, params: EnrichParams, queued: boolean): Promise<Enrichment> {
  const key = JSON.stringify(params)
  const hit = cache.get(key)
  if (fresh(hit)) {
    touch(key, hit)
    return hit.promise
  }
  const run = async () => {
    if (queued) await acquire()
    try {
      return await api.enrich(conn, params)
    } finally {
      if (queued) release()
    }
  }
  const promise = run()
  const entry: CacheEntry = { at: Date.now(), promise }
  store(key, entry)
  promise
    .then((v) => {
      entry.value = v
      persistCache()
      notify(key)
    })
    // drop a failed entry so a later open / prefetch can retry instead of caching the error
    .catch(() => {
      if (cache.get(key) === entry) {
        cache.delete(key)
        persistCache()
      }
      notify(key)
    })
  return promise
}

/** Read an item's warmed enrichment from the cache, re-rendering when a prefetch lands.
 *  Read-only — never triggers a fetch (that's prefetch's / useEnrichment's job). The
 *  card uses it to show the real excerpt, lead image, and comment count once warm. */
export function useEnrichmentValue(item: Item | null): Enrichment | null {
  const params = item ? enrichParamsFor(item) : null
  const key = params ? JSON.stringify(params) : ''
  const [, bump] = useState(0)
  useEffect(() => {
    if (!key) return
    const l = () => bump((n) => n + 1)
    let set = listeners.get(key)
    if (!set) listeners.set(key, (set = new Set()))
    set.add(l)
    return () => {
      set!.delete(l)
      if (!set!.size) listeners.delete(key)
    }
  }, [key])
  const e = key ? cache.get(key) : undefined
  if (e) touch(key, e)
  return e?.value ?? null
}

/** Warm the cache for an item ahead of the viewport (concurrency-capped). No-op when
 *  the item isn't enrichable or is already cached/in-flight. */
export function prefetchEnrichment(item: Item, conn: Connection): void {
  if (!allowsAutomaticEnrichment(item)) return
  const params = enrichParamsFor(item)
  if (!params) return
  if (fresh(cache.get(JSON.stringify(params)))) return
  void fetchEnrichment(conn, params, true).catch(() => {})
}

/** Prefetch an item's enrichment when its row approaches the viewport. Returns a ref
 *  to attach to the row element. */
export function usePrefetchOnApproach<T extends HTMLElement>(item: Item, conn: Connection) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !allowsAutomaticEnrichment(item) || !enrichParamsFor(item)) return
    const root =
      (el.closest('[data-radix-scroll-area-viewport]') as Element | null) ??
      (el.closest('[data-slot="shell-content"]') as Element | null)
    const io = new IntersectionObserver(
      (entries) => {
        // 每次进入视口都问一次，**不再 disconnect**。原来的理由是"一次就够——结果已经缓存了"，
        // 这句话只在缓存必然还在时成立：单列列表下 60 条 ≈ 15 屏，滚回去时条目八成还在缓存里。
        // 瀑布流一屏 20–30 张卡，被挤出 LRU 是常态；observer 一旦断开，那些卡就**永久**退回
        // body_text + 可能不同/缺失的首图，再也没有机会回暖——一次降级变成不可逆的降级。
        // 重复触发不贵：prefetchEnrichment 命中新鲜缓存时直接返回，真发请求只在缓存已经没了时。
        if (entries[0].isIntersecting) prefetchEnrichment(item, conn)
      },
      { root, rootMargin: `0px 0px ${PRELOAD_LOOKAHEAD_PX}px 0px` }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [item, conn])
  return ref
}

export interface EnrichmentState {
  article: Article | null
  comments: Comment[]
  total: number
  loading: boolean
  err: boolean
  hasMore: boolean
  loadMore: () => void
}

/** Enrich an item (article + normalized comments), source-blind, reading the shared
 *  preload cache. Used by the list peek and the detail modal — a warmed item resolves
 *  instantly. `loadMore` 翻 `*-comments` 那类源的页; other sources return all at once. */
export function useEnrichment(
  item: Item | null,
  conn: Connection,
  enabled: boolean,
): EnrichmentState {
  const params = item ? enrichParamsFor(item) : null
  const key = params ? JSON.stringify(params) : ''
  const [article, setArticle] = useState<Article | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [total, setTotal] = useState(0)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(enabled && !!params)
  const [err, setErr] = useState(false)
  const busy = useRef(false)
  const correlation = useRef<string | null>(null)
  // 包声明的现取（`content.enrich` → 通用变体）走 WS：那类 enricher 多半骑着采集会话开标签页，
  // 一次一条、新点击顶掉旧的，结果分片推回——HTTP 一问一答装不下这个形状。宿主自己那几条、以及包
  // 自报 `prefetch` 的便宜现取走 HTTP：它们和滚动预取共用同一份缓存，点开时直接命中暖好的结果。
  const viaWs = !!params && 'params' in params && !params.prefetch
  const sendOpen = useWs(
    api.wsUrl(conn),
    useCallback((message) => {
      if (!('correlationId' in message) || message.correlationId !== correlation.current) return
      if (message.type === 'enrich.article') setArticle(message.article)
      else if (message.type === 'enrich.comments') {
        setComments(message.comments)
        setTotal(message.total)
      } else if (message.type === 'enrich.completed') {
        setLoading(false)
      } else if (message.type === 'enrich.failed' || message.type === 'enrich.blocked') {
        setErr(true)
        setLoading(false)
      }
    }, []),
    enabled && viaWs,
  )

  useEffect(() => {
    if (!enabled || !params) {
      setLoading(false)
      return
    }
    setArticle(null)
    setComments([])
    setTotal(0)
    setCursor(null)
    setErr(false)
    setLoading(true)
    if (viaWs && 'params' in params) {
      const correlationId = globalThis.crypto?.randomUUID?.() ?? `enrich-${Date.now()}-${Math.random()}`
      correlation.current = correlationId
      sendOpen({ type: 'enrich.open', correlationId, source: params.source, params: params.params })
      return () => {
        if (correlation.current === correlationId) correlation.current = null
      }
    }
    let live = true
    // shared cache: reuse a warmed / in-flight result; on-demand bypasses the prefetch
    // gate so an open never waits behind speculative prefetches.
    fetchEnrichment(conn, params, false)
      .then((e) => {
        if (!live) return
        setArticle(e.article ?? null)
        setComments(e.comments ?? [])
        setTotal(e.total ?? e.comments?.length ?? 0)
        setCursor(e.cursor ?? null)
        setLoading(false)
      })
      .catch(() => live && (setErr(true), setLoading(false)))
    return () => {
      live = false
    }
    // key captures the full param set; conn is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled])

  const loadMore = useCallback(() => {
    if (busy.current || !cursor || !params || !('vid' in params) || !params.source.endsWith('-comments')) return
    busy.current = true
    api
      .enrich(conn, { ...params, page: Number(cursor) })
      .then((e) => {
        setComments((prev) => {
          const seen = new Set(prev.map((c) => c.id))
          return [...prev, ...(e.comments ?? []).filter((c) => !seen.has(c.id))]
        })
        setCursor(e.cursor ?? null)
      })
      .catch(() => setCursor(null))
      .finally(() => {
        busy.current = false
      })
  }, [cursor, key, conn]) // eslint-disable-line react-hooks/exhaustive-deps

  return { article, comments, total, loading, err, hasMore: !!cursor, loadMore }
}
