import type { Context } from 'cordis'
import type { StoredItem } from '../../item-store.ts'
import { renormalizeStoredItems, type RenormalizeFilter } from '../../content/renormalize.ts'
import { sourceOf } from '../../providers/executor.ts'
import { type RawVideoItem } from '../../video/extract.ts'
import { buildResult } from '../../video/aggregate.ts'
import { facetOneSource } from '../../video/facet-source.ts'
import { Deduper } from '../../video/dedupe.ts'
import type { VideoPart, VideoSearchEvent, VideoSearchResult, VideoSourceTiming } from '../../video/types.ts'
import { resourceSearchGroups as planResourceSearchGroups, type SearchGroup } from '../../video/search-groups.ts'
import { videoSearchStream as streamVideoSearch, type SourceOutcome } from '../../video/search-stream.ts'
import { searchMetaBySourceId, missTimings } from '../../search/seeds.ts'

declare module 'cordis' {
  interface Context {
    /** 搜索扇出这一域（`src/kernel/plugins/search-fanout.ts`）——一个聚合对象，不是六个 ctx key。 */
    search: SearchFanoutService
  }
}

/**
 * 搜索扇出面。**字段名与它们在 `Boot` 上的旧名字一字不差**——搬家不改名。
 */
export interface SearchFanoutService {
  /** 把一条搜出来的裸条目按**产它的那个 source** 归一化（复现入库时的那次归一化）。 */
  normalizeSearchItem: (sourceId: string, raw: unknown) => StoredItem
  /** 对已入库的条目重跑归一化（`POST /api/items/renormalize`）。 */
  renormalizeItems: (filter: RenormalizeFilter) => ReturnType<typeof renormalizeStoredItems>
  /** 内容搜索：按 `content-search` 行并发扇出 → 逐条按产源归一化。临时结果，不落库。 */
  contentSearch: (q: string) => Promise<StoredItem[]>
  /** 同上,但把失败成员一并带回(`warnings`,与 HTTP /api/search 的 warnings 同源判据:
   *  'declined (no result)' 是空结果不是故障,不进来)。购买决策 job 找横评靠它诚实报
   *  「社区源没答上来」——只回 items 的那格会把 misses 静默丢掉。 */
  contentSearchDetailed: (q: string) => Promise<{ items: StoredItem[]; warnings: Array<{ member: string; reason: string }> }>
  /** 比价搜索：按 `price-search` 行并发扇出 → 逐条按产源归一化。与 contentSearch 同形，只是行不同
   *  （成员是 provides=search-price 的比价源）。临时结果，不落库。 */
  priceSearch: (q: string) => Promise<StoredItem[]>
  /** 比价 + 没答上来的成员（与 contentSearchDetailed 同形）。购买决策靠它区分「源挂了」和「没人卖」。 */
  priceSearchDetailed: (q: string) => Promise<{ items: StoredItem[]; warnings: Array<{ member: string; reason: string }> }>
  /** 残值搜索：按 `resale-search` 行并发扇出（成员是 provides=search-resale 的二手回收源：转转…）。
   *  与 priceSearch 同形但**独立一格**：比价是新品报价，这一格是「型号二手值多少」；消费端是购买
   *  决策 job 的残值格。临时结果，不落库。 */
  resaleSearch: (q: string) => Promise<StoredItem[]>
  /** 批量 / MCP 的资源搜索（吃 `resource-search` 行的并发扇出结果）。 */
  videoSearch: (q: string, opts?: { nsfw?: boolean }) => Promise<VideoSearchResult>
  /** 流式资源搜索（SSE）：同一行的成员，先到先发。 */
  videoSearchStream: (q: string, opts?: { nsfw?: boolean; providerId?: string }) => AsyncGenerator<VideoSearchEvent>
  /** 把一批带出处的裸条目按源分组 → 抽取 → 合并成一个结果（批量路的 facet）。 */
  facetResources: (
    q: string,
    items: unknown[],
    misses: Array<{ member: string; reason: string }>,
    providerId?: string,
  ) => VideoSearchResult
}

export interface SearchFanoutConfig {
  log: (...args: unknown[]) => void
  /**
   * 两个吃 `Scheduler` 的口。**必须是 thunk，不能是实例**：Scheduler 还没进内核
   *（批次 8 才轮到它），装配期这里根本没有那个对象。传函数 = 调用时才解引用，
   * 装配序天然对（同 harvest 域的 `readSource`）。
   */
  normalizeRaw: (sourceId: string, raw: unknown) => StoredItem
  readSource: (sourceId: string, params: Record<string, unknown>) => Promise<unknown[]>
}

/** 流式路的墙钟默认（源没在自己的 manifest 里申报 `member_timeout_ms` 时用它）。比批量路的
 *  25s（`perMemberTimeoutMs`）紧，是有意的：这条路上有人盯着屏幕在等。 */
const VIDEO_SOURCE_TIMEOUT_MS = 15000

/**
 * 搜索扇出这一域：**「一次查询打给一排源、把回来的东西并成一份结果」**。
 *
 * 两条路，共用同一行 Provider 的成员：
 *  - 批量 / MCP（`contentSearch` / `videoSearch`）—— 执行器并发 invoke，回来一批带出处的
 *    裸条目，在调用点按产源分组再抽取（`facetResources`）。
 *  - 流式（`videoSearchStream`）—— 按 group 扇出，先到先发；慢源不拖累别人。
 *
 * **两条路的合并序不同，是有意的**：批量路按 items 里各源首次出现的顺序（= 成员声明序，
 * 确定性），流式路先到先得。
 *
 * 依赖全部经 inject 从内核取（`ctx.provider` 的执行器 / `ctx.sources` 的目录 /
 * `ctx.stores` 的条目库与频道发现账本）；`Scheduler` 那两口是 config 里的 thunk（见上）。
 * 本域不持任何句柄，所以没有 effect。
 */
export const searchFanoutPlugin = {
  name: 'search-fanout',
  inject: ['stores', 'sources', 'provider'],
  apply(ctx: Context, config: SearchFanoutConfig): void {
    const { log } = config
    const { itemStore, channels, discoveredChannels } = ctx.stores
    const registry = ctx.sources.registry
    /** 执行器**每次现取**：provider 域先挂（inject 保证），但照域插件惯例不把它解构成快照。 */
    const executor = () => ctx.provider.providerExecutor

    // content-search call sites (HTTP GET /api/search?scope=content normalizes inline; the MCP
    // content_search tool uses this wrapper): fan out over the per-source members via the executor
    // (concurrent), then normalize each raw item through ITS producing source (provenance → sourceOf →
    // scheduler.normalizeRaw), reproducing the ingest normalization. Ephemeral, not persisted.
    const normalizeSearchItem = (sourceId: string, raw: unknown): StoredItem => config.normalizeRaw(sourceId, raw)
    const renormalizeItems = (filter: RenormalizeFilter) => renormalizeStoredItems(itemStore, registry, filter)
    const contentSearchDetailed = async (q: string): Promise<{ items: StoredItem[]; warnings: Array<{ member: string; reason: string }> }> => {
      const r = await executor().invoke('content-search', q)
      if (!r || r.strategy !== 'concurrent') return { items: [], warnings: [] }
      const items = r.items.flatMap((raw) => {
        const src = sourceOf(raw)
        return src ? [normalizeSearchItem(src, raw)] : []
      })
      // 'declined (no result)' = 该成员正常跑完但空手,不是故障(与 HTTP /api/search 同判据)。
      const warnings = r.misses
        .filter((m) => m.reason !== 'declined (no result)')
        .map((m) => ({ member: m.member, reason: m.reason }))
      return { items, warnings }
    }
    const contentSearch = async (q: string): Promise<StoredItem[]> => (await contentSearchDetailed(q)).items

    // 比价搜索：与 contentSearch 逐字同形，只换 provider 行（price-search，成员是 provides=search-price
    // 的比价源）。抽不出公共函数是有意的——两条路的 provider id 是各自的语义常量，参数化只会把
    // 「这是内容搜索」和「这是比价搜索」这层意图藏进一个字符串。
    const priceSearchDetailed = async (q: string): Promise<{ items: StoredItem[]; warnings: Array<{ member: string; reason: string }> }> => {
      const r = await executor().invoke('price-search', q)
      if (!r || r.strategy !== 'concurrent') return { items: [], warnings: [] }
      const items = r.items.flatMap((raw) => {
        const src = sourceOf(raw)
        return src ? [normalizeSearchItem(src, raw)] : []
      })
      const warnings = r.misses
        .filter((m) => m.reason !== 'declined (no result)')
        .map((m) => ({ member: m.member, reason: m.reason }))
      return { items, warnings }
    }
    const priceSearch = async (q: string): Promise<StoredItem[]> => (await priceSearchDetailed(q)).items

    // 残值搜索：同上，行换成 resale-search（成员 provides=search-resale：转转回收…）。理由同上，不抽公共函数。
    const resaleSearch = async (q: string): Promise<StoredItem[]> => {
      const r = await executor().invoke('resale-search', q)
      if (!r || r.strategy !== 'concurrent') return []
      return r.items.flatMap((raw) => {
        const src = sourceOf(raw)
        return src ? [normalizeSearchItem(src, raw)] : []
      })
    }

    // Aggregated video/torrent search. The participating sources are no longer a
    // hardcoded list — they are derived from search-role bindings (flow-management),
    // declared by packages (`searchSources`). Same-source flows merge into ONE
    // physical fetch via the executor planner (N:1). SFW/NSFW stay distinct intents
    // (binding.nsfw). Each group's display metadata comes from searchMetaBySourceId (host table +
    // packages' `searchSources`); parsing is shape-detected per item (src/video/content/, flat /
    // paired / digest). One failing/slow group never blanks the rest. Ephemeral.
    // a foreign torrent site that stalls must not hold the whole aggregate hostage —
    // cap each source so the merged result returns at the slowest *responsive* source.
    const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
      ])
    /** Run one planner group (one source's merged physical fetch) → extract →
     *  aggregate. Never throws (errors become a failed timing). The query param is
     *  injected per-source (varies: keyword/query/name); flow config params (e.g.
     *  pansou channels) already merged into group.physicalParams by the planner.
     *
     *  只报数不报名：`key`/`label` 由 `videoSearchStream` 的跟踪表统一发（见那边的头注）。
     *  这里的 `label` 只进超时消息和日志，不进返回值。 */
    const searchOneGroup = async (group: SearchGroup, q: string, deduper: Deduper): Promise<SourceOutcome> => {
      const meta = searchMetaBySourceId(group.source_id)
      const label = meta?.label ?? group.source_id
      const t0 = Date.now()
      try {
        const params = { ...group.physicalParams, [meta?.param ?? 'keyword']: q }
        // 统一按 member kind 分流,无站点特例:provider 成员(如包出的 expand 组合体行)
        // 走 executor.invoke 递归跑其子链,取 items 型结果;source 成员维持 scheduler.readSource。
        const invokeProviderItems = async (): Promise<RawVideoItem[]> => {
          const r = await executor().invoke(group.source_id, q)
          return r && 'items' in r ? (r.items as RawVideoItem[]) : []
        }
        // 慢源自己声明上限（manifest 的 `member_timeout_ms`，recipe 写在 `meta.member_timeout_ms`）
        // ——桌面采集这类"点窗口 + 等渲染"的源按网络请求的尺子量必然被砍。慢不拖累别人：结果一条条
        // 流回，快的先显示，它最后补上。**和批量/MCP 路（executor → member-pipeline）读的是同一格**，
        // 见 `seeds.ts` 的 `SearchSourceMeta` 头注；默认值两条路各有各的（这里 15s、那边 25s），
        // 因为语义不同：这边有人盯着屏幕在等，那边是后台任务。
        const rawAll = (await withTimeout(
          group.provider ? invokeProviderItems() : config.readSource(group.source_id, params),
          registry.get(group.source_id)?.member_timeout_ms ?? VIDEO_SOURCE_TIMEOUT_MS, label,
        )) as RawVideoItem[]
        const f = facetOneSource(group.source_id, rawAll, q, {
          recordChannels: (sid, chans) => discoveredChannels.record(sid, chans),
          log,
          deduper,
        })
        return { part: f.part, timing: { ms: Date.now() - t0, count: f.count, dropped: f.dropped, status: f.count ? 'ok' : 'empty' } }
      } catch (e) {
        const msg = (e as Error)?.message ?? ''
        log(`[stream] video search ${group.source_id} failed: ${msg}`)
        return { part: { shows: [], loose: [] }, timing: { ms: Date.now() - t0, count: 0, dropped: 0, status: /timed out/.test(msg) ? 'timeout' : 'error' } }
      }
    }

    /** 见 `../../video/search-groups.ts`：把 Provider 行展开成流式扇出的 groups（行为与单测都在那儿）。 */
    const resourceSearchGroups = (providerId?: string): SearchGroup[] =>
      planResourceSearchGroups(
        { getProvider: (id) => channels.getProvider(id), resolvedMembers: (row) => executor().resolvedMembers(row) },
        providerId
      )

    // resource-search is a pure Provider row: concurrent fan-out over provides:'search-download'
    // catalog sources, each item carrying its producing source id via the #2c provenance tag. NO
    // builtin aggregator source backs this any more — batch/MCP search dogfoods the row via invoke()
    // then reproduces per-source extract+facet at the call site (facetResources); the streaming path
    // fans out over the same row members (resourceSearchGroups). NOTE: the executor's concurrent
    // branch has NO per-member 15s timeout — only the streaming path's searchOneGroup guards with
    // withTimeout; acceptable for pansou-only, flagged for when the row grows multi-source.
    const facetResources = (
      q: string,
      items: unknown[],
      misses: Array<{ member: string; reason: string }>,
      providerId = 'resource-search',
    ): VideoSearchResult => {
      const bySource = new Map<string, RawVideoItem[]>()
      for (const raw of items) {
        const sid = sourceOf(raw)
        if (!sid) continue
        const list = bySource.get(sid) ?? []
        list.push(raw as RawVideoItem)
        bySource.set(sid, list)
      }
      const parts: VideoPart[] = []
      const timings: VideoSourceTiming[] = []
      // 批量路：`bySource` 的迭代序 = items 里各源首次出现的顺序 = Provider 成员声明序
      // （执行器注释：成员声明顺序即合并优先级）。确定性，与流式路的先到先得不同。
      const deduper = new Deduper()
      for (const [sourceId, rawAll] of bySource) {
        const t0 = Date.now()
        const f = facetOneSource(sourceId, rawAll, q, {
          recordChannels: (sid, chans) => discoveredChannels.record(sid, chans),
          log,
          deduper,
        })
        parts.push(f.part)
        timings.push({ key: f.key, label: f.label, ms: Date.now() - t0, count: f.count, dropped: f.dropped, status: f.count ? 'ok' : 'empty' })
      }
      // sources that declined/errored never produced items → surface them as failed timings
      // (empty vs error/timeout mirrors searchOneGroup's status). 'declined (no result)' = empty.
      // 寻址键→sourceId→包声明元数据的映射逻辑收在 missTimings（search/seeds.ts）——它现查
      // `providerId` 这一行的 resolvedMembers，槽位覆盖时不会用错行；直接单测过，这里不重复注释。
      timings.push(...missTimings(misses, providerId, {
        getProvider: (id) => channels.getProvider(id),
        resolvedMembers: (row) => executor().resolvedMembers(row),
      }))
      timings.sort((a, b) => b.ms - a.ms) // slowest first — cull candidates
      return buildResult(parts, timings)
    }

    // Batch / MCP resource search: dogfood the resource-search Provider row (concurrent fan-out →
    // raw items with per-source provenance), then facet at the call site — the same path the HTTP
    // non-stream branch takes. Kept (not deleted) because MCP video_search consumes it (serve.ts).
    const videoSearch = async (q: string, _opts: { nsfw?: boolean } = {}): Promise<VideoSearchResult> => {
      const r = await executor().invoke('resource-search', q)
      if (!r || r.strategy !== 'concurrent') return buildResult([], [])
      return facetResources(q, r.items, r.misses)
    }

    /** 流式搜索的整段逻辑（init → 完成序 source → done）在 `../../video/search-stream.ts`，
     *  单测也在那儿；这里只把三个真身依赖接进去。**`opts` 必须整体透传**——`providerId`
     *  这一跳丢了，线上就是「换了 Provider 等于没换」（search-stream.test.ts 守着）。 */
    const videoSearchStream = (q: string, opts: { nsfw?: boolean; providerId?: string } = {}): AsyncGenerator<VideoSearchEvent> =>
      streamVideoSearch({ resourceSearchGroups, searchMetaBySourceId, searchOneGroup }, q, opts)

    ctx.provide('search', {
      normalizeSearchItem,
      renormalizeItems,
      contentSearch,
      contentSearchDetailed,
      priceSearch,
      priceSearchDetailed,
      resaleSearch,
      videoSearch,
      videoSearchStream,
      facetResources,
    } satisfies SearchFanoutService)
  },
}
