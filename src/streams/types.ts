import type { AdRules } from '../content/ad-filter.ts'

export interface StreamMember {
  plugin_id?: string
  source_template_id?: string
  source_id?: string
  params: Record<string, unknown>
  season?: number
}

export interface Stream {
  id: string
  description: string
  sources: StreamMember[]
  cadence_seconds: number
  vault_subdir: string
  /** upstream 形状(存储/采集权威)。见 SourceManifest.mode。'collection' → 每采全量 + **按成员
   *  source 分片覆盖**(且过两道闸门,见 collection-replace-guard.ts) + 排除出时间线;
   *  'feed'/缺失 → 增量 + append/evict 滑窗。 */
  mode?: 'feed' | 'collection'
  /** how the scheduler harvests this stream's `sources` (ARCHITECTURE.md Data Scheduling):
   *  - 'fanout' (default/absent): fetch every source each tick and merge via the dedup store.
   *  - 'exclusive': treat `sources` as an ordered ladder, harvest only the first healthy one
   *    (see the source-failover capability + SourceHealthStore). */
  strategy?: 'fanout' | 'exclusive'
  /** T1 harvest policy (opt-in): first-harvest backfill depth vs steady-state incremental
   *  (ARCHITECTURE.md Data Scheduling → Harvest policy). Absent = no limit injection. */
  harvest?: { backfillLimit?: number; incrementalLimit?: number }
  /** 「这个名字只是占位，首次采集成功后用真名覆盖」（`src/store/auto-name.ts`）。
   *
   *  **它必须活在 Stream 上、而不只在 StreamRecord 的 options 里**：订阅有两条路——前端走
   *  `POST /api/streams`（`shared/subscribe` 里直接写 `options.labelAuto`），对话里的
   *  `subscribe_source` 走 `StreamService.subscribe(stream)`。`Stream` 少了这一格，后一条路
   *  就永远拿不到自动命名，于是流名永远停在调用方随手编的那句话上——两条路能力不等，
   *  而且不报错。 */
  label_auto?: boolean
  /** cover image for the stream, attached by the API for audio streams (the cover of the
   *  most recent stored item that has one). Display-only; not persisted. */
  image?: string
  /** optional rules ADDED on top of the built-in defaults + config.yaml global ad_filter,
   *  scoped to this stream only. Union semantics (mergeAdRules) — cannot suppress a global
   *  rule, only add more. Edited via PATCH /api/channels/:channelId/streams/:streamId/ad-filter. */
  ad_filter?: AdRules
  /** 只看包含 (title-include allow-filter): keep only items whose title contains at least one of
   *  these keywords; non-matching items are folded (muted, reason 'filtered') at ingest. Empty/
   *  absent = no filtering. Applied in makeStreamItem. Edited via
   *  PATCH /api/channels/:channelId/streams/:streamId/title-filter. */
  title_include?: string[]
}
