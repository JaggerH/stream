import type { SubLangKind } from '../../src/media/subtitle-lang.ts'

// 迅雷字幕接口：GET api-shoulei-ssl.xunlei.com/oracle/subtitle?name=<压制文件名>。
// 实测约束（Rick and Morty S07/S08 活体，2026-07-24，spec 2026-07-24-subtitle-scrape-provider-design）：
// HTTP 200 ~0.6s，`{code:0, result:"ok", data:[]}`；接口的名字匹配**宽松、必串台**（查 S08E01 会混进
// S01E08 这类数字翻转集），`languages` / `score` / `duration` 几乎全空或不可信——唯一可靠的过滤是从
// `name` 抽 `SxxExx` 与目标严格数值比对。直链落在字幕 CDN 上（下面的主机白名单）。

const XUNLEI_URL = 'https://api-shoulei-ssl.xunlei.com/oracle/subtitle'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** 允许取字节的主机后缀（防 SSRF：track id 是客户端透传回来的，可被伪造成任意 URL）。 */
const ALLOWED_HOST_SUFFIXES = ['geilijiasu.com', 'xunlei.com']

/** 迅雷 `/oracle/subtitle` 的一条 data 项（只列用得上的字段；其余忽略）。 */
export interface XunleiEntry {
  gcid?: string
  url: string
  ext?: string
  name: string
  duration?: number
  languages?: string[]
  score?: number
}

/** 包交给宿主的一条候选（成员合同见 src/providers/system/subtitle-search.ts）。`id` 就是直链。 */
export interface SubtitleHit {
  id: string
  name: string
  nameHint: SubLangKind
  label: string
}

export function isAllowedXunleiHost(url: string): boolean {
  let host: string
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    host = u.hostname.toLowerCase()
  } catch {
    return false
  }
  return ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))
}

/** 从文件名抽 `SxxExx`（大小写不敏感，容分隔符、E 位宽）。抽不出 → null（电影/无季集）。 */
export function parseSeasonEpisode(name: string): { s: number; e: number } | null {
  const m = /s(\d{1,2})[\s._-]*e(\d{1,3})/i.exec(name)
  if (!m) return null
  return { s: Number(m[1]), e: Number(m[2]) }
}

/** 去掉最后一个扩展名、收尾空白——语言探不出时用它区分同源多条轨。 */
export function cleanSubName(name: string): string {
  return name.replace(/\.[a-z0-9]{1,5}$/i, '').trim()
}

/** 从文件名猜语言（不可信，仅给宿主排序 + 内容抓取失败时兜底；真语言由宿主从内容判）。 */
export function classifySubtitleName(name: string): SubLangKind {
  const s = name.toLowerCase()
  const hasEng = /英文|英语|\beng\b|english/.test(s)
  const hasSimp = /简体|简中|\bchs\b|\bsc\b|zh-?cn|zh-?hans|\bgb\b/.test(s)
  const hasTrad = /繁体|繁體|繁中|\bcht\b|\btc\b|big5|zh-?hant/.test(s)
  if (hasSimp && hasEng) return 'simp-eng'
  if (hasTrad && hasEng) return 'trad-eng'
  if (hasSimp) return 'simp'
  if (hasTrad) return 'trad'
  if (hasEng) return 'eng'
  return 'unknown'
}

/**
 * 迅雷结果严格过滤（保持接口顺序；排序归宿主）：
 *  - 目标有 SxxExx：只留 name 抽出的 (季,集) **数值全等** 目标的条目；抽不出 SxxExx 的剔除（防串台）。
 *  - 目标无 SxxExx（电影）：不做季集过滤，全部保留。
 *  - 完全重名（迅雷同名返回多遍）对用户不可区分，折叠成一条。
 */
export function filterXunlei(entries: XunleiEntry[], videoFile: string): SubtitleHit[] {
  const target = parseSeasonEpisode(videoFile)
  const out: SubtitleHit[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    if (!e?.url || !isAllowedXunleiHost(e.url)) continue
    if (target) {
      const se = parseSeasonEpisode(e.name)
      if (!se || se.s !== target.s || se.e !== target.e) continue
    }
    const name = cleanSubName(e.name)
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ id: e.url, name, nameHint: classifySubtitleName(e.name), label: '迅雷' })
  }
  return out
}

/** 调迅雷接口 → 过滤后的候选。任何错误 → []（静默降级：兜底路径，一家挂了不拖累别家）。 */
export async function searchXunlei(videoFile: string, fetchImpl: typeof fetch = fetch): Promise<SubtitleHit[]> {
  try {
    const u = `${XUNLEI_URL}?name=${encodeURIComponent(videoFile)}`
    const res = await fetchImpl(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
    if (!res.ok) return []
    const body = (await res.json()) as { data?: XunleiEntry[] }
    const data = Array.isArray(body?.data) ? body.data : []
    return filterXunlei(data, videoFile)
  } catch {
    return []
  }
}

/** 按候选 id（直链）取字幕字节。主机不在白名单 → 抛（宿主转成 400/502，不静默）。 */
export async function fetchXunleiSubtitle(id: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  if (!isAllowedXunleiHost(id)) throw new Error(`[xunlei] 拒绝取字节：${id} 不是迅雷字幕主机`)
  const res = await fetchImpl(id, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`[xunlei] subtitle HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}
