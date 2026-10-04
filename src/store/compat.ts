import type { Stream } from '../streams/types.ts'
import type { AdRules } from '../content/ad-filter.ts'
import type { StreamRecord } from './types.ts'

/** 采集管线消费运行时 Stream；这两个转换是 StreamRecord(库) ⇄ Stream(管线) 的桥。
 *  strategy 词汇两侧同为 fanout|exclusive——直通，不再翻译（术语统一后，2026-07-04）。
 *  桥的彻底移除（Scheduler 直接吃 StreamRecord）是后续独立 change。 */
export function streamRecordToStream(s: StreamRecord): Stream {
  const o = s.options as Record<string, any>
  return {
    id: s.id,
    description: s.label,
    sources: s.members.map((m) => ({ plugin_id: m.plugin, source_template_id: m.source, params: m.params, season: m.season })),
    cadence_seconds: s.cadence_seconds,
    vault_subdir: o.vault_subdir ?? s.id,
    ...(o.mode ? { mode: o.mode } : {}),
    strategy: s.strategy,
    ...(o.harvest ? { harvest: o.harvest } : {}),
    ...(o.labelAuto ? { label_auto: true } : {}),
    ...(o.ad_filter ? { ad_filter: o.ad_filter as AdRules } : {}),
    ...(Array.isArray(o.title_include) && o.title_include.length ? { title_include: o.title_include as string[] } : {}),
  }
}

export function streamToStreamRecord(ns: Stream): StreamRecord {
  return {
    id: ns.id,
    label: ns.description || ns.id,
    strategy: ns.strategy ?? 'fanout',
    cadence_seconds: ns.cadence_seconds,
    members: ns.sources.map((src) => ({
      plugin: src.plugin_id ?? '',
      source: src.source_template_id ?? src.source_id ?? '',
      params: src.params ?? {},
      season: src.season,
    })),
    options: {
      ...(ns.vault_subdir ? { vault_subdir: ns.vault_subdir } : {}),
      ...(ns.mode ? { mode: ns.mode } : {}),
      ...(ns.harvest ? { harvest: ns.harvest } : {}),
      // 名字是占位、等首采改名（auto-name.ts 消费的就是 options.labelAuto 这一格）。
      // 两个方向都要映射：少了任一边，走这条路建的流要么拿不到自动命名、要么改完名再读回来
      // 又变回"待改名"，第二次采集把用户改过的名字盖掉。
      ...(ns.label_auto ? { labelAuto: true } : {}),
      ...(ns.ad_filter ? { ad_filter: ns.ad_filter } : {}),
      ...(ns.title_include && ns.title_include.length ? { title_include: ns.title_include } : {}),
    },
  }
}
