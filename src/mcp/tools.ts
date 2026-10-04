import type { Registry } from '../registry/registry.ts'
import type { Scheduler, PreviewResult, TickResult } from '../scheduler.ts'
import { normalizeSource } from '../streams/store.ts'
import type { Stream } from '../streams/types.ts'
import type { Capability, Facility, PickSurface, SourceManifest } from '../manifest/types.ts'
import { pickableAnywhere, pickableIn } from '../manifest/pick.ts'
import type { PluginDescriptor } from '../plugins/types.ts'
import { buildSourceGroups, pluginGroupingMetadata, resolveSourceGroup } from '../plugins/grouping.ts'
import { validateParams } from './validate-params.ts'
import type { UserStore } from '../store/user-store.ts'
import type { ChannelPresent } from '../store/types.ts'
import { streamToStreamRecord } from '../store/compat.ts'
import { pluginIdForDescriptor } from '../registry/seal.ts'
import { publicSource, publicSourceDetail, type SourceDetail, type SourceSummary } from '../registry/public.ts'

export type { SourceSummary, SourceDetail } from '../registry/public.ts'

export interface StreamServiceDeps {
  registry: Registry
  scheduler: Scheduler
  plugins?: PluginDescriptor[]
  channels: UserStore
  /** Live per-plugin enable predicate (keyed by canonical plugin id). Injected by bootstrap so
   *  it reflects the settings overlay hot (a toggle shows up without a StreamService rebuild).
   *  Absent → everything enabled (MCP/test contexts that don't wire plugin toggling). */
  pluginEnabled?: (pluginId: string) => boolean
}

export interface StreamSummary {
  id: string
  description: string
}

export interface SourceCandidate {
  id: string
  adapter: string
  description: string
  type: string
  categories: string[]
  capabilities: Capability[]
  params_schema: Record<string, unknown>
  auth: string
  cadence_hint_seconds: number
  score: number
}

export type PluginStatusKind = 'ready' | 'needs_config' | 'disabled' | 'error'
export type PluginLaunchMode = 'builtin' | 'container' | 'external' | 'manual'
export type PluginHealth = 'healthy' | 'starting' | 'unhealthy' | 'unknown'

export interface PluginSummary {
  id: string
  name: string
  tagline?: string
  description?: string
  homepage?: string
  repository?: string
  docsUrl?: string
  status: PluginStatusKind
  /** user enable flag (required plugins are always true). Disabled → sources not registered
   *  on the next boot; catalog still lists the plugin (honest, not hidden). */
  enabled: boolean
  /** core plugin that can't be disabled (descriptor `required: true`) — UI locks the toggle on. */
  required: boolean
  launch: {
    mode: PluginLaunchMode
    health?: PluginHealth
  }
  capabilities: Capability[]
  sourceCount: number
  sourceGrouping?: {
    enabled: boolean
    resolver: string
  }
  topCategories?: Array<{ key: string; label: string; count: number }>
}

export interface PluginSourceListResponse {
  plugin: PluginSummary
  sources: SourceSummary[]
  groups: Array<{ key: string; label: string; count: number }>
  facets: {
    categories: Array<{ key: string; label: string; count: number }>
    capabilities: Array<{ key: string; label: string; count: number }>
    facilities: Array<{ key: string; label: string; count: number }>
  }
  nextCursor?: string
  total?: number
}

export interface PluginSourcesSearchResponse {
  sources: SourceSummary[]
  plugins: Array<{ id: string; name: string; count: number }>
  facets: {
    categories: Array<{ key: string; label: string; count: number }>
    capabilities: Array<{ key: string; label: string; count: number }>
  }
  nextCursor?: string
  total?: number
}

export interface StreamStatus {
  id: string
  last_tick: string | null
  item_count: number
}

export interface SourceInfo {
  id: string
  description: string
  type: string
  categories: string[]
  capabilities: Capability[]
  params_schema: Record<string, unknown>
  auth: string
  cadence_hint_seconds: number
}

/** 插件怎么起：由 descriptor 自己申报（`package.json#stream.backend` 有值 = 起容器），不由宿主背
 *  一份名单——名单会在包增删时漂（新加一个带容器的包，名单不改它就被报成 builtin，而且没有一处
 *  会喊）。`rsshub` 是唯一例外：它是宿主外一台独立服务，descriptor 里没有容器声明。 */
export function pluginLaunchMode(pluginId: string, descriptors: PluginDescriptor[]): PluginLaunchMode {
  if (pluginId === 'rsshub') return 'external'
  const descriptor = descriptors.find((d) => pluginIdForDescriptor(d) === pluginId)
  return descriptor?.backend ? 'container' : 'builtin'
}

type PluginMetadata = Pick<PluginSummary, 'name' | 'tagline' | 'description' | 'homepage' | 'repository' | 'docsUrl'>

function descriptorMetadata(descriptor: PluginDescriptor): PluginMetadata {
  return {
    name: descriptor.name ?? descriptor.id,
    tagline: descriptor.tagline,
    description: descriptor.description,
    homepage: descriptor.homepage,
    repository: descriptor.repository,
    docsUrl: descriptor.docsUrl,
  }
}

/** Plugin display metadata comes ONLY from descriptors (`packages/<id>/package.json` → `stream`); a plugin
 *  with sources but no descriptor falls back to its bare id. No second hardcoded copy. */
function pluginMetadata(descriptors: PluginDescriptor[], pluginId: string): PluginMetadata {
  const descriptor = descriptors.find((d) => pluginIdForDescriptor(d) === pluginId)
  return descriptor ? descriptorMetadata(descriptor) : { name: pluginId }
}

function pluginSourceGrouping(descriptors: PluginDescriptor[], pluginId: string): PluginSummary['sourceGrouping'] {
  const descriptor = descriptors.find((d) => pluginIdForDescriptor(d) === pluginId)
  return pluginGroupingMetadata(descriptor?.sourceGrouping)
}

/** Descriptor-declared "core plugin" flag (never a hardcoded id list). */
function pluginRequired(descriptors: PluginDescriptor[], pluginId: string): boolean {
  return descriptors.some((d) => pluginIdForDescriptor(d) === pluginId && d.required === true)
}


function facetCounts(values: string[]): Array<{ key: string; label: string; count: number }> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

const UNCLASSIFIED_FACILITY: Facility = { key: '', label: '未分类' }

function facetCountsKeyed(values: Facility[]): Array<{ key: string; label: string; count: number }> {
  const counts = new Map<string, { label: string; count: number }>()
  for (const v of values) {
    const entry = counts.get(v.key) ?? { label: v.label, count: 0 }
    entry.count++
    counts.set(v.key, entry)
  }
  return [...counts.entries()]
    .map(([key, v]) => ({ key, label: v.label, count: v.count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

/** The public shape `createMcpServer`/`toolCatalog`/`mountMcp` actually depend on — the real
 *  DI seam. `StreamService` implements it; disk-service (stdio, no backend) implements it with
 *  a plain object literal instead (read methods delegate, write/action methods throw
 *  NeedsBackendError). Kept in lockstep with the class body below — if you add a public method
 *  to StreamService, add it here too, or callers relying on the interface silently lose it. */
export interface StreamServiceLike {
  resolvePluginAndSource(sourceId: string): { pluginId: string; sourceId: string }
  list(): StreamSummary[]
  categories(): { category: string; count: number; searchable: number }[]
  plugins(): PluginSummary[]
  pluginSources(
    pluginId: string,
    opts?: { query?: string; category?: string; group?: string; facility?: string; limit?: number; cursor?: string; surface?: PickSurface }
  ): PluginSourceListResponse
  searchAllPluginSources(
    opts?: { query?: string; category?: string; capability?: string; searchable?: boolean; limit?: number; cursor?: string }
  ): PluginSourcesSearchResponse
  pluginSourceDetail(pluginId: string, sourceId: string): SourceDetail | undefined
  search(intent: string, k?: number, opts?: { searchable?: boolean; category?: string | string[] }): SourceCandidate[]
  read(id: string, params?: Record<string, unknown>): Promise<unknown[]>
  previewStream(streamId: string, opts?: { limit?: number }): Promise<PreviewResult>
  /** 同上，但**保持来源自己的顺序**、不截断——歌单导出要的是歌单顺序，不是时间序。 */
  readStreamInSourceOrder(streamId: string): Promise<PreviewResult>
  previewSource(sourceId: string, params?: Record<string, unknown>): Promise<PreviewResult>
  refreshStream(streamId: string): Promise<TickResult>
  sources(): SourceInfo[]
  subscribe(stream: Stream, channelId?: string): void
  ensureChannel(c: { id: string; label: string; present: ChannelPresent }): void
  /** 频道清单（id + 人看的名字）——「订到哪个频道」要按用户说的那个名字去找。 */
  listChannels(): Array<{ id: string; label: string; present: ChannelPresent }>
  scheduleFlowStream(stream: Stream): void
  scheduleResourceStream(stream: Stream): void
  updateResourceStream(stream: Stream): void
  rescheduleResourceStream(stream: Stream): void
  unscheduleResourceStream(id: string): void
  unsubscribe(id: string): boolean
  status(): StreamStatus[]
  streamsResource(): Stream[]
  topics(): string[]
}

/**
 * The behavioral core behind the MCP surface — pure methods over registry +
 * scheduler + named-stream store. The SDK server (server.ts) is a thin adapter
 * onto this. The agent-facing tool count is fixed regardless of source count.
 */
export class StreamService implements StreamServiceLike {
  constructor(private readonly deps: StreamServiceDeps) {}

  /** Resolves a full source ID into its plugin ID and local source ID under that plugin. */
  resolvePluginAndSource(sourceId: string): { pluginId: string; sourceId: string } {
    const manifest = this.deps.registry.get(sourceId)
    let pluginId = 'custom'
    let localId = sourceId

    if (manifest) {
      pluginId = manifest.pluginId ?? 'custom'
      if (sourceId.startsWith(`${pluginId}:`)) {
        localId = sourceId.slice(pluginId.length + 1)
      }
    } else {
      const idx = sourceId.indexOf(':')
      if (idx > 0) {
        pluginId = sourceId.slice(0, idx)
        localId = sourceId.slice(idx + 1)
      }
    }
    return { pluginId, sourceId: localId }
  }

  /** Curated named streams — the agent's default vocabulary. */
  list(): StreamSummary[] {
    return this.deps.scheduler.list().map((s) => ({ id: s.id, description: s.description }))
  }

  /** Top of the search tree — the category branches the AI navigates.
   *  The AI reads these, judges which branch a question belongs to, then
   *  calls search({ category, searchable }) for that branch. No embeddings:
   *  the LLM is the router, this is just the structured taxonomy. */
  categories(): { category: string; count: number; searchable: number }[] {
    const map = new Map<string, { count: number; searchable: number }>()
    for (const m of this.deps.registry.all()) {
      const isSearch = m.capabilities.includes('search')
      for (const c of m.categories ?? []) {
        const e = map.get(c) ?? { count: 0, searchable: 0 }
        e.count++
        if (isSearch) e.searchable++
        map.set(c, e)
      }
    }
    return [...map.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.count - a.count)
  }

  /** Product catalog: installed/enabled capability packages.
   *  目录诚实性：一个插件即使当前零已注册 source，只要有 descriptor（package.json 的 `stream`）就要列出——
   *  否则「有 descriptor 但未接线」的插件（如外接插件的 source 还没声明/adapter 还没注册）会从
   *  插件页静默消失，其能力也无从被选为 Provider 成员。零 source 的 descriptor-only 插件标
   *  needs_config（未接线/未就绪），有 source 的照旧 ready。 */
  plugins(): PluginSummary[] {
    const groups = new Map<string, SourceSummary[]>()
    for (const manifest of this.deps.registry.all()) {
      const summary = publicSource(manifest)
      groups.set(summary.pluginId, [...(groups.get(summary.pluginId) ?? []), summary])
    }
    const descriptors = this.deps.plugins ?? []
    // descriptor 存在但零已注册 source 的插件补一个空组（不覆盖已有组）——目录不静默丢插件。
    for (const descriptor of descriptors) {
      const id = pluginIdForDescriptor(descriptor)
      if (!groups.has(id)) groups.set(id, [])
    }
    const hasDescriptor = (id: string) => descriptors.some((d) => pluginIdForDescriptor(d) === id)
    return [...groups.entries()].map(([id, sources]) => {
      const metadata = pluginMetadata(descriptors, id)
      const required = pluginRequired(descriptors, id)
      // required plugins are always on; otherwise ask the live predicate (default enabled).
      const enabled = required || (this.deps.pluginEnabled ? this.deps.pluginEnabled(id) : true)
      // Status precedence: disabled wins (user turned it off — its zero sources are intentional,
      // not "未接线"). Else 零 source + 有 descriptor = 未接线 needs_config; else ready.
      const status: PluginStatusKind = !enabled
        ? 'disabled'
        : sources.length === 0 && hasDescriptor(id)
          ? 'needs_config'
          : 'ready'
      return {
        id,
        ...metadata,
        enabled,
        required,
        sourceGrouping: pluginSourceGrouping(descriptors, id),
        status,
        launch: { mode: pluginLaunchMode(id, descriptors), health: 'unknown' as const },
        capabilities: [...new Set(sources.flatMap((source) => source.capabilities))],
        sourceCount: sources.length,
        topCategories: facetCounts(sources.flatMap((source) => source.categories)).slice(0, 6),
      }
    }).sort((a, b) => b.sourceCount - a.sourceCount || a.id.localeCompare(b.id))
  }

  /** Lightweight sources owned by one plugin. Heavy docs/schema stay in detail. */
  pluginSources(
    pluginId: string,
    opts: { query?: string; category?: string; group?: string; facility?: string; limit?: number; cursor?: string; surface?: PickSurface } = {}
  ): PluginSourceListResponse {
    const descriptors = this.deps.plugins ?? []
    const pluginDescriptor = descriptors.find((d) => pluginIdForDescriptor(d) === pluginId)
    const plugin = this.plugins().find((p) => p.id === pluginId) ?? {
      id: pluginId,
      ...pluginMetadata(descriptors, pluginId),
      status: 'ready' as const,
      enabled: pluginRequired(descriptors, pluginId) || (this.deps.pluginEnabled ? this.deps.pluginEnabled(pluginId) : true),
      required: pluginRequired(descriptors, pluginId),
      launch: { mode: pluginLaunchMode(pluginId, descriptors), health: 'unknown' as const },
      capabilities: [],
      sourceCount: 0,
      sourceGrouping: pluginSourceGrouping(descriptors, pluginId),
      topCategories: [],
    }
    const query = opts.query?.trim().toLowerCase()
    const offset = opts.cursor ? Math.max(0, Number(opts.cursor) || 0) : 0
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 500))
    let all = this.deps.registry.all()
      .filter((manifest) => (manifest.pluginId ?? 'custom') === pluginId)
      // 选择面（见 `pickableIn`）：不报 surface = 总览，只滤掉"谁都不该挑"的那些。
      .filter((manifest) => (opts.surface ? pickableIn(manifest, opts.surface) : pickableAnywhere(manifest)))
    if (opts.category) all = all.filter((source) => (source.categories ?? []).includes(opts.category!))
    if (query) {
      all = all.filter((source) =>
        (() => {
          const group = pluginDescriptor?.sourceGrouping?.enabled
            ? resolveSourceGroup(source, pluginDescriptor) ?? UNCLASSIFIED_FACILITY
            : undefined
          return [
            source.id,
            source.title,
            source.description,
            source.facility?.key,
            source.facility?.label,
            group?.key,
            group?.label,
            ...(source.categories ?? []),
          ]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(query))
        })()
      )
    }
    const groups = pluginDescriptor?.sourceGrouping?.enabled ? buildSourceGroups(pluginDescriptor, all) : []
    if (opts.group !== undefined || opts.facility !== undefined) {
      const groupKey = opts.group ?? opts.facility
      if (pluginDescriptor?.sourceGrouping?.enabled) {
        all = all.filter((source) => ((resolveSourceGroup(source, pluginDescriptor) as Facility | undefined)?.key ?? '') === groupKey)
      }
    }
    const summaries = all.map(publicSource)
    const facets = {
      categories: facetCounts(all.flatMap((source) => source.categories ?? [])),
      capabilities: facetCounts(all.flatMap((source) => source.capabilities)),
      facilities: groups.length ? groups : facetCountsKeyed(summaries.map((source) => source.facility ?? UNCLASSIFIED_FACILITY)),
    }
    const page = summaries.slice(offset, offset + limit)
    const next = offset + limit < all.length ? String(offset + limit) : undefined
    return { plugin: { ...plugin, sourceCount: all.length }, sources: page, groups, facets, nextCursor: next, total: all.length }
  }

  /** Cross-plugin source-catalog search — the plugin-scoped `pluginSources` without the
   *  plugin filter; groups the match set by plugin instead of by facility. List-light. */
  searchAllPluginSources(
    opts: { query?: string; category?: string; capability?: string; searchable?: boolean; limit?: number; cursor?: string; surface?: PickSurface } = {}
  ): PluginSourcesSearchResponse {
    const descriptors = this.deps.plugins ?? []
    const query = opts.query?.trim().toLowerCase()
    const capability = opts.capability ?? (opts.searchable ? 'search' : undefined)
    const offset = opts.cursor ? Math.max(0, Number(opts.cursor) || 0) : 0
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 500))

    let all = this.deps.registry.all()
      // 同 `pluginSources`：这是同一个选择器的"跨插件搜"那一半，两半必须用同一把尺，
      // 否则搜索框会把左边列表刚滤掉的东西又端回来。
      .filter((m) => (opts.surface ? pickableIn(m, opts.surface) : pickableAnywhere(m)))
    if (opts.category) all = all.filter((m) => (m.categories ?? []).includes(opts.category!))
    if (capability) all = all.filter((m) => m.capabilities.includes(capability as Capability))
    if (query) {
      all = all.filter((m) =>
        [m.id, m.title, m.description, m.facility?.key, m.facility?.label, ...(m.categories ?? [])]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(query))
      )
    }

    const summaries = all.map(publicSource)
    const pluginCounts = new Map<string, number>()
    for (const s of summaries) pluginCounts.set(s.pluginId, (pluginCounts.get(s.pluginId) ?? 0) + 1)
    const plugins = [...pluginCounts.entries()]
      .map(([id, count]) => ({ id, name: pluginMetadata(descriptors, id).name, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))

    const facets = {
      categories: facetCounts(all.flatMap((m) => m.categories ?? [])),
      capabilities: facetCounts(all.flatMap((m) => m.capabilities)),
    }
    const page = summaries.slice(offset, offset + limit)
    const next = offset + limit < summaries.length ? String(offset + limit) : undefined
    return { sources: page, plugins, facets, nextCursor: next, total: summaries.length }
  }

  /** Heavy source detail fetched on demand. */
  pluginSourceDetail(pluginId: string, sourceId: string): SourceDetail | undefined {
    const manifest = this.deps.registry.get(sourceId)
    if (!manifest || (manifest.pluginId ?? 'custom') !== pluginId) return undefined
    return publicSourceDetail(manifest)
  }

  /** Navigate to sources. The AI narrows by `category` (its own judgment) and/or
   *  an `intent` string; `searchable` restricts to query-capable sources (answering
   *  a question vs browsing feeds). Either `intent` or `category` should be given. */
  search(
    intent: string,
    k = 8,
    opts: { searchable?: boolean; category?: string | string[] } = {}
  ): SourceCandidate[] {
    // a website spans multiple categories; the AI may pick several branches at once
    const cats = opts.category ? (Array.isArray(opts.category) ? opts.category : [opts.category]) : []
    const wide = cats.length || opts.searchable ? k * 20 : k
    // ranked by intent when given; otherwise browse the whole registry (score 0)
    let pool: Array<{ manifest: SourceManifest; score: number }> = intent.trim()
      ? this.deps.registry.search(intent, wide)
      : this.deps.registry.all().map((manifest) => ({ manifest, score: 0 }))
    if (cats.length) {
      pool = pool.filter((r) => {
        const mc = r.manifest.categories ?? []
        return cats.some((c) => mc.includes(c)) // OR-match across requested categories
      })
    }
    if (opts.searchable) pool = pool.filter((r) => r.manifest.capabilities.includes('search'))
    return pool.slice(0, k).map((r) => ({
      id: r.manifest.id,
      adapter: r.manifest.adapter,
      description: r.manifest.description,
      type: r.manifest.type,
      categories: r.manifest.categories ?? [],
      capabilities: r.manifest.capabilities,
      params_schema: r.manifest.params_schema,
      auth: r.manifest.auth.type,
      cadence_hint_seconds: r.manifest.cadence_hint_seconds,
      // RSSHub-catalog enrichment for the picker detail panel (display-only)
      notes: r.manifest.notes,
      docsMarkdown: r.manifest.docsMarkdown,
      requireConfig: r.manifest.requireConfig,
      nsfw: r.manifest.nsfw,
      homepage: r.manifest.homepage,
      example: r.manifest.example_queries[0],
      score: r.score,
    }))
  }

  /**
   * Invoke a named stream or source by id; JIT-validate params; return items.
   *
   * 双语义，但**两边都是实时取，都不落库**：id 是已订阅 Stream → `readStream` 逐个成员源
   * 现取一遍再合并（不是读 ItemStore 里已采集的那些）；id 是注册表里的 Source → 直采（绕过
   * Provider 行）。直采走 readSourceNormalized——同款归一化输出（StoredItem），所以 agent 从
   * 两个入口拿到的形状一致；失败不静默：errors 非空时抛首个错误（declined = 空结果不落
   * errors，与旧 readSource 的 throw 行为对齐）。
   *
   * **「读一个流」听起来像读库，实际是再跑一遍采集**——工具描述必须把这件事说出口，否则模型
   * 会拿它去回答「我时间线里有什么」，代价是一次全员实时拉取 + 一份和收件箱对不上的结果。
   */
  async read(id: string, params: Record<string, unknown> = {}): Promise<unknown[]> {
    if (this.deps.scheduler.has(id)) {
      return this.deps.scheduler.readStream(id)
    }
    const manifest = this.deps.registry.get(id)
    if (!manifest) throw new Error(`Unknown id: ${id}`)
    validateParams(manifest.params_schema, params) // throws before any fetch
    const { items, errors } = await this.deps.scheduler.readSourceNormalized(id, params)
    // errors 只含真实失败（declined = 空结果直接成功，不落 errors），首个即抛——
    // 与旧 readSource 的 throw 行为对齐，不让 agent 拿到"空数组"伪装的成功。
    if (errors.length > 0) throw new Error(`${id}: ${errors[0].reason}`)
    return items
  }

  /** Live preview of a whole stream — normalized + merged, NOT persisted (no store/dedup/health). */
  previewStream(streamId: string, opts: { limit?: number } = {}): Promise<PreviewResult> {
    return this.deps.scheduler.readStreamNormalized(streamId, opts)
  }

  /** 歌单导出用：实时快照，保持来源顺序（见 scheduler 侧的头注——顺序的真相源是歌单自己）。 */
  readStreamInSourceOrder(streamId: string): Promise<PreviewResult> {
    return this.deps.scheduler.readStreamInSourceOrder(streamId)
  }

  /** Live preview of ONE source with ad-hoc params (e.g. an unsaved config form). */
  previewSource(sourceId: string, params: Record<string, unknown> = {}): Promise<PreviewResult> {
    return this.deps.scheduler.readSourceNormalized(sourceId, params)
  }

  /** Manually harvest a stream NOW (a real tick — persists + dedups), so the user can
   *  verify re-harvest from the UI without waiting for the cadence. Returns {fetched, written}. */
  refreshStream(streamId: string): Promise<TickResult> {
    return this.deps.scheduler.tick(streamId)
  }

  /** Featured (curated) sources — small default list for the channel browser.
   *  The full RSSHub catalog (~3000) is reached via search(), not dumped here. */
  sources(): SourceInfo[] {
    return this.deps.registry
      .curated()
      .filter((m) => m.discoverable !== false)
      .map((m) => ({
        id: m.id,
        description: m.description,
        type: m.type,
        categories: m.categories ?? [],
        capabilities: m.capabilities,
        params_schema: m.params_schema,
        auth: m.auth.type,
        cadence_hint_seconds: m.cadence_hint_seconds,
      }))
  }

  /** 幂等 upsert 一个频道。存在就原样留着（不覆盖用户改过的 label），不存在就建。
   *
   *  **为什么要单独一个方法**：`subscribe(stream, channelId)` 拿到一个不存在的频道 id 时是
   *  静默不挂的（下面那句 `if (channel && ...)`）——流建了、调度加了、就是不属于任何频道，
   *  且没有任何一处报错。所以「按需建频道」必须是调用方一个显式的、排在 subscribe 前面的动作。 */
  ensureChannel(c: { id: string; label: string; present: ChannelPresent }): void {
    const store = this.deps.channels
    if (store.getChannel(c.id)) return
    store.putChannel({ id: c.id, label: c.label, present: c.present, stream_ids: [], options: {} })
  }

  listChannels(): Array<{ id: string; label: string; present: ChannelPresent }> {
    return this.deps.channels.listChannels().map((c) => ({ id: c.id, label: c.label, present: c.present }))
  }

  subscribe(stream: Stream, channelId?: string): void {
    const store = this.deps.channels
    let tid = channelId
    if (!tid) {
      // 隐式入频道：Stream 不再自带任何消费模式信号（kind 已删——消费模式只是 Channel 归属，
      // 见 UserStore.audioStreamIds），所以隐式 attach 一律落 timeline 频道（'mixed' 已收敛消失）；
      // 调用方要挂 audio 频道（歌单等）必须显式传 channelId。缺省则建默认 timeline 频道。
      const channel = store.listChannels().find((x) => x.present === 'timeline')
      tid = channel ? channel.id : 'default-timeline'
      if (!channel) store.putChannel({ id: 'default-timeline', label: '默认信箱', present: 'timeline', stream_ids: [], options: {} })
    }
    // normalize sources first (bare source_id → plugin_id + source_template_id via registry),
    // otherwise a frontend subscribe would store members with plugin '' (unschedulable).
    const normalized = { ...stream, sources: stream.sources.map((s) => normalizeSource(s, this.deps.registry)) }
    store.putStream(streamToStreamRecord(normalized))
    const channel = store.getChannel(tid)
    if (channel && !channel.stream_ids.includes(stream.id)) {
      store.patchChannel(tid, { stream_ids: [...channel.stream_ids, stream.id] })
    }
    // 排班判据必须在 attach **之后**问：attach 之前这条流还不属于任何频道，
    // `isCollected` 对「未被引用」答 true，闸门等于没装。判据只有一个出处（见 UserStore.isCollected），
    // 这里不写第二份 present 判断。live present（research/search）的流入库存档但不排班：
    // 它的语义是请求到来时现读、不落库，采集这一路会把去重/入库这些有状态副作用全跑一遍。
    if (!store.isCollected(stream.id)) return
    this.deps.scheduler.add(stream)
    // fetch once now so the new channel isn't empty until the first cadence tick
    void this.deps.scheduler.tick(stream.id).catch(() => {})
  }

  /** Register a derived stream with the scheduler only — not persisted to the user store.
   *  (The flow/binding system that owned flows.db was removed; this remains for ephemeral
   *  scheduler-only streams.) */
  scheduleFlowStream(stream: Stream): void {
    this.deps.scheduler.add(stream)
    void this.deps.scheduler.tick(stream.id).catch(() => {})
  }

  /** Resource API: register a stream with the scheduler without attaching it to a target.
   *
   *  **对已在调度里的流不再立刻抓一次**：注册本身按 id 幂等（`Scheduler.add` 是 upsert），
   *  所以调用方多调一次的代价全在这句「立刻抓一次」上——它会把去重/入库/vault 写入整套副作用
   *  再跑一遍，且不发出任何信号。这条路正是 POST /api/streams 排两次班那类接线错误的落点。 */
  scheduleResourceStream(stream: Stream): void {
    const alreadyScheduled = this.deps.scheduler.has(stream.id)
    this.deps.scheduler.add(stream)
    if (alreadyScheduled) return
    void this.deps.scheduler.tick(stream.id).catch(() => {})
  }

  /** Resource API: refresh the scheduler's copy after a metadata-only edit (label, ad_filter,
   *  vault_subdir…) — no reschedule, no re-fetch. Keeps streamsResource()/`/api/streams` in
   *  sync with the store when cadence/members are unchanged. */
  updateResourceStream(stream: Stream): void {
    this.deps.scheduler.update(stream)
  }

  /** Resource API: replace scheduler registration after cadence/source changes. */
  rescheduleResourceStream(stream: Stream): void {
    this.deps.scheduler.remove(stream.id)
    this.deps.scheduler.add(stream)
  }

  /** Resource API: deschedule after the stream row has been deleted. */
  unscheduleResourceStream(id: string): void {
    this.deps.scheduler.remove(id)
  }

  unsubscribe(id: string): boolean {
    const removed = this.deps.channels.removeStream(id) // 同步从所有 channel.stream_ids 摘除
    this.deps.scheduler.remove(id)
    return removed
  }

  status(): StreamStatus[] {
    const streams = this.deps.scheduler.list()
    const counts = this.deps.scheduler.itemCounts(streams.map((s) => s.id))
    return streams.map((s) => ({
      id: s.id,
      last_tick: this.deps.scheduler.lastTickAt(s.id) ?? null,
      item_count: counts.get(s.id) ?? 0,
    }))
  }

  /** Resource: full named streams (ambient vocabulary), each tagged with its AUTHORITATIVE
   *  `mode` so callers can tell collections/channels from timeline feeds. The raw stream's own
   *  `mode` is frequently absent (manifest-driven collections carry no stream-level mode —
   *  their collection-ness comes only from a member manifest); `scheduler.modeOf()` resolves
   *  that fallback, so this must NOT be read off the raw spread. Consumers (e.g. the
   *  default-timeline exclusion in http/app.ts) read `.mode` here, never `s.mode` directly. */
  streamsResource(): Stream[] {
    return this.deps.scheduler.list().map((s) => ({
      ...s,
      mode: this.deps.scheduler.modeOf(s.id),
    }))
  }

  /** Facet: aggregate topics across all sources — shape without enumeration. */
  topics(): string[] {
    return this.deps.registry.topics()
  }
}
