import type { RawVideoItem } from './extract.ts'
import { parseSourceItems } from './content/to-release.ts'
import { aggregate } from './aggregate.ts'
import { searchMetaBySourceId } from '../search/seeds.ts'
import type { Deduper } from './dedupe.ts'
import type { VideoPart } from './types.ts'

// 炸弹护栏：pansou 偶尔返回上千条；全量 extract/aggregate/JSON 序列化会同步卡死
// 事件循环（和浏览器）。截原始量（CPU）与交付量（体积）。
export const MAX_RAW_ITEMS = 400
export const MAX_LOOSE = 200
export const MAX_SHOWS = 80

export interface FacetSourceDeps {
  /** 观测到的 pansou 频道名 → 发现池（可读性） */
  recordChannels?: (sourceId: string, channels: string[]) => void
  log?: (msg: string) => void
  /** 跨源去重器。同一个实例喂多个源 → 先来的赢。不传 = 不去重。
   *  顺序语义由调用方决定：批量路按 Provider 成员声明顺序（确定性），
   *  流式路按到达顺序（先到先得——要按声明优先级就得等齐，那就废掉了流式）。 */
  deduper?: Deduper
}

export interface FacetedSource {
  key: string
  label: string
  part: VideoPart
  count: number
  /** 被跨源去重丢掉的 release 数 */
  dropped: number
}

/**
 * 一个源的原始条目 → 分面结果。批量路（facetResources）与流式路（searchOneGroup）
 * 共用这一份——两条路曾各抄一份，任何收窄/去重都得插两遍，是长歪的起点。
 * 纯函数（除注入的 recordChannels/log 副作用），不发网络请求，可单测。
 */
export function facetOneSource(
  sourceId: string,
  rawAll: RawVideoItem[],
  q: string,
  deps: FacetSourceDeps = {},
): FacetedSource {
  const meta = searchMetaBySourceId(sourceId)
  const key = meta?.key ?? sourceId
  const label = meta?.label ?? sourceId
  const raw = rawAll.length > MAX_RAW_ITEMS ? rawAll.slice(0, MAX_RAW_ITEMS) : rawAll
  // content 解析器层:每条 raw item → 归一 DownloadRow[] → Release(全 loose)。按 item 形态
  // 自动检测(flat/paired/digest),把源差异吸收在解析器里。digest(pansou 合集)按 query 去噪。
  // 见 docs/superpowers/specs/2026-07-18-content-parser-abstraction-design.md。
  const grouped = parseSourceItems(key, raw, q)
  const { kept, dropped } = deps.deduper ? deps.deduper.admit(grouped) : { kept: grouped, dropped: 0 }
  // 纯扁平模型:所有 release 都是 loose(show:null),aggregate 只做去重后的收束,shows[] 恒空。
  const part = aggregate(kept, { minGroupSize: 2 })
  if (meta?.kind === 'digest') {
    const chans = part.loose.map((r) => r.channel).filter((c): c is string => !!c)
    if (chans.length) deps.recordChannels?.(sourceId, chans)
  }
  if (part.loose.length > MAX_LOOSE) part.loose = part.loose.slice(0, MAX_LOOSE)
  if (part.shows.length > MAX_SHOWS) part.shows = part.shows.slice(0, MAX_SHOWS)
  if (rawAll.length > MAX_RAW_ITEMS) deps.log?.(`[stream] ${key}: capped ${rawAll.length} raw → ${raw.length} (bomb guard)`)
  const count = part.shows.reduce((n, ss) => n + ss.qualities.reduce((m, qb) => m + qb.releases.length, 0), 0) + part.loose.length
  return { key, label, part, count, dropped }
}
