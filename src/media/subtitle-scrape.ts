// 字幕在线搜刮的**宿主机制**——网盘视频既无内嵌轨、同目录也无 sibling 外挂时的最后一条来源。
// 重点是非中国区影视（国产剧供给侧就没有外挂中文字幕）。
//
// 宿主不认识任何字幕站：站点的 API、过滤规则、主机白名单都住各自的包，经系统行 `subtitle-search`
// 以 `provides: [search-subtitle]` 自动收成员（成员合同见 src/providers/system/subtitle-search.ts）。
// 这里只留：
//  - track 命名空间：`embed:` / `file:` 之外的 **`scrape:<源全名>:<base64url(包给的 id)>`**。前端只透传，
//    宿主解码后调**那个源**的 `op:'fetch'` 取字节——宿主从不 fetch 任何字幕站的 URL。
//  - 排序（文件名语言线索只当排序线索）、语言落定（从内容判，`subtitle-lang.ts`）、每种「语言 · 来源」只留一条。
//
// 设计与实测约束的来历见 docs/superpowers/specs/2026-07-24-subtitle-scrape-provider-design.md（行为不变：
// 迅雷主力、射手彩票、搜刮全 miss / 报错一律静默降级为空）。

import { detectSubtitleLang, langDisplayName, langCode, vttHasCues, type SubLangKind } from './subtitle-lang.ts'
import type { ProviderExecutor } from '../providers/executor.ts'

/** 字幕搜刮这一行的 id（系统身份 `src/providers/system/subtitle-search.ts`）。 */
export const SUBTITLE_SEARCH_PROVIDER = 'subtitle-search'

/** 一条搜刮候选（尚未定语言）。语言要等抓内容探测出来才知道——文件名不可信，见 subtitle-lang.ts。 */
export interface ScrapeCandidate {
  /** `scrape:<源全名>:<base64url(包给的 id)>`——前端透传回来，宿主据此找回那个源。 */
  id: string
  /** 去扩展名的原始文件名。语言探不出时的兜底区分信息。 */
  name: string
  /** 来源：菜单 label 的后半段（包自报）。 */
  source: string
  /** 文件名给的语言线索（不可信，仅在内容抓取失败时兜底）。 */
  nameHint: SubLangKind
  /** 排序用：越小越靠前（简中英 < 简 < 繁中英 < 繁 < 英 < 未知）。 */
  rank: number
}

/** 一条落定的字幕 track（label = `语言 · 来源`）。id 前端只透传不解析。 */
export interface ScrapeTrack {
  id: string
  lang?: string
  title: string
}

/** Range 读器：给偏移与长度，返回那段字节。网盘侧由 AList rawUrl + HTTP Range 实现。 */
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>

/** 执行器里这条机制用得到的两个口（测试可注入假的）。 */
export type SubtitleExecutor = Pick<ProviderExecutor, 'collect' | 'resolvedMembersOf'>

/** 排序权重：简中英 < 简 < 繁中英 < 繁 < 英 < 未知。抓内容前先按这个把最可能是简体中文的排前面，
 *  好优先探测。文件名线索不可信——只当**排序线索**，不当结论。 */
const KIND_RANK: Record<SubLangKind, number> = {
  'simp-eng': 0,
  simp: 1,
  'trad-eng': 2,
  trad: 3,
  eng: 4,
  unknown: 5,
}

// ---- track id 编解码 ----

const SCRAPE_PREFIX = 'scrape:'

export function encodeScrapeTrackId(member: string, id: string): string {
  return `${SCRAPE_PREFIX}${member}:${Buffer.from(id, 'utf8').toString('base64url')}`
}

/** `scrape:<成员>:<b64url>` → `{ member, id }`；不是这个形状 → null。成员名（源全名）不含 `:`，按最后一个 `:` 切。 */
export function decodeScrapeTrackId(trackId: string): { member: string; id: string } | null {
  if (!trackId.startsWith(SCRAPE_PREFIX)) return null
  const rest = trackId.slice(SCRAPE_PREFIX.length)
  const cut = rest.lastIndexOf(':')
  if (cut <= 0 || cut === rest.length - 1) return null
  const id = Buffer.from(rest.slice(cut + 1), 'base64url').toString('utf8')
  return id ? { member: rest.slice(0, cut), id } : null
}

// ---- 搜 ----

interface MemberHit { id?: unknown; name?: unknown; nameHint?: unknown; label?: unknown }

const isKind = (v: unknown): v is SubLangKind => typeof v === 'string' && v in KIND_RANK

/**
 * 扇出 `subtitle-search` 行的全部成员，合并成候选并按文件名线索稳定排序（同档保留成员与接口顺序）。
 * 恒不抛：行不在 / 成员全 miss / 报错一律 `[]`（兜底路径，静默降级）。
 */
export async function searchSubtitles(
  executor: SubtitleExecutor,
  input: { name: string; size?: number; read?: RangeReader },
): Promise<ScrapeCandidate[]> {
  try {
    const r = await executor.collect(SUBTITLE_SEARCH_PROVIDER, { op: 'search', ...input })
    if (!r) return []
    const out: ScrapeCandidate[] = []
    for (const { member, value } of r.results) {
      for (const hit of (Array.isArray(value) ? value : []) as MemberHit[]) {
        if (typeof hit?.id !== 'string' || !hit.id) continue
        const nameHint = isKind(hit.nameHint) ? hit.nameHint : 'unknown'
        out.push({
          id: encodeScrapeTrackId(member, hit.id),
          name: typeof hit.name === 'string' ? hit.name : '',
          source: typeof hit.label === 'string' && hit.label ? hit.label : member,
          nameHint,
          rank: KIND_RANK[nameHint],
        })
      }
    }
    return out.sort((a, b) => a.rank - b.rank) // Array.prototype.sort 稳定，同 rank 保序
  } catch {
    return []
  }
}

// ---- 取 ----

/** 这条 track 的源已经不在 `subtitle-search` 行里（包被关了 / 卸了）——响亮报，不当空。 */
export class SubtitleSourceGone extends Error {
  constructor(readonly member: string) {
    super(`字幕来源 ${member} 已不在「字幕搜刮」里（包被关掉或卸载了）`)
  }
}

/**
 * 按 track id 找回那个源，只调它的 `op:'fetch'` 取字节。不是 `scrape:` 形状 → 抛 Error；
 * 源不在行里 → 抛 `SubtitleSourceGone`；源失败 → 抛它的原因。
 */
export async function fetchSubtitleBytes(executor: SubtitleExecutor, trackId: string): Promise<Uint8Array> {
  const parsed = decodeScrapeTrackId(trackId)
  if (!parsed) throw new Error(`不是字幕搜刮的 track：${trackId}`)
  const members = executor.resolvedMembersOf(SUBTITLE_SEARCH_PROVIDER) ?? []
  if (!members.some((m) => m.name === parsed.member)) throw new SubtitleSourceGone(parsed.member)
  const others = members.filter((m) => m.name !== parsed.member).map((m) => m.name)
  const r = await executor.collect(SUBTITLE_SEARCH_PROVIDER, { op: 'fetch', id: parsed.id }, { excludeMembers: others })
  const value = r?.results.find((x) => x.member === parsed.member)?.value
  const bytes = (Array.isArray(value) ? value[0] : value) as { bytes?: unknown } | undefined
  if (bytes?.bytes instanceof Uint8Array) return bytes.bytes
  const miss = r?.misses.find((m) => m.member === parsed.member)
  throw new Error(`[subtitle] ${parsed.member} 没取到字节${miss ? `：${miss.reason}` : ''}`)
}

// ---- 落定语言标注：抓内容探测，label = `语言 · 来源` ----

/** 抓一条候选的（已转 VTT 的）文本用于探测语言；失败/超限返回 null。由路由层注入（带缓存 + 超时）。 */
export type SubtitleTextFetcher = (cand: ScrapeCandidate) => Promise<string | null>

/**
 * 给候选定语言、落成最终 track。语言从**内容**判（文件名不可信）：并发抓前 `cap` 条候选的文本、
 * 逐条 detectSubtitleLang；抓不到就退回文件名线索、再不行标「未知」。
 *
 * 归并：每个「语言 · 来源」只留排最前的一条——菜单就是「简体中文·迅雷 / 繁體中文·迅雷 / 英文·迅雷」
 * 几行，一眼可选。唯独「未知」不折叠（探测失败的兜底场景，留几条 + 缀文件名让用户还能挑）。
 */
export async function labelScrapeCandidates(
  cands: ScrapeCandidate[],
  fetchText: SubtitleTextFetcher,
  opts?: { cap?: number; unknownKeep?: number },
): Promise<ScrapeTrack[]> {
  const cap = opts?.cap ?? 12
  const unknownKeep = opts?.unknownKeep ?? 4
  const head = cands.slice(0, cap)
  const probed = await Promise.all(
    head.map(async (c) => {
      const text = await fetchText(c).catch(() => null)
      // 抓到了内容，但转出来没有对白（只含字体的空壳 .ass）→ 死轨，整条丢掉，别让用户点了不显示。
      // 只有抓成功才判空——抓失败（null，网络问题）不算空，退回文件名线索、别误杀。
      if (text !== null && !vttHasCues(text)) return null
      return { cand: c, kind: text ? detectSubtitleLang(text) : c.nameHint }
    }),
  )
  const labeled = probed.filter((x): x is { cand: ScrapeCandidate; kind: SubLangKind } => x !== null)
  labeled.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]) // 简体中文在最前

  const perTitle = new Map<string, number>()
  const out: ScrapeTrack[] = []
  for (const { cand, kind } of labeled) {
    const base = `${langDisplayName(kind)} · ${cand.source}`
    if (kind === 'unknown') {
      // 语言真判不出：留几条并缀文件名区分（此时文件名是唯一的抓手）。
      const n = (perTitle.get(base) ?? 0) + 1
      perTitle.set(base, n)
      if (n > unknownKeep) continue
      out.push({ id: cand.id, lang: langCode(kind), title: `${base} · ${cand.name}` })
    } else {
      // 已知语言：每个「语言·来源」只留一条，菜单清爽。
      if (perTitle.has(base)) continue
      perTitle.set(base, 1)
      out.push({ id: cand.id, lang: langCode(kind), title: base })
    }
  }
  return out
}
