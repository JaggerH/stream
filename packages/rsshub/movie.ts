import type { Normalizer } from '../../src/content/normalize.ts'
import type { ContentMeta } from '../../src/content/types.ts'
import { extractImages, stripImages, toText } from '../../shared/package-sdk/index.ts'

/**
 * Movie/series normalizer for the 影视 (video-present) channel.
 *
 * 住在 rsshub 包里，因为它解析的是本包 `manifests.yaml` 里那几条影视榜单路由（豆瓣 / TMDB / IMDb）
 * 的 description 文案——那是这几家站的知识，宿主不认识（spec 2026-09-26-backend-residue-stage8 §2.1）。
 * 宿主只消费它写下的通用字段：`meta.rating/year/genres/source`（卡片徽标）与 `meta.discovery`
 * （TMDb/OMDb 认不出作品时的详情兜底，`src/video/discovery-fallback.ts`）。
 *
 * Douban / TMDB / IMDb RSSHub routes each bake rating / year / genre into their html
 * `description` in a DIFFERENT shape (verified against the route sources under
 * a separately configured RSSHub checkout), so we dispatch on the source's manifest id and parse
 * each family. Whatever a route doesn't carry is simply left undefined — the poster card
 * renders only the fields present. The cover is the route's <img>; structured fields land
 * in `Content.meta` for the MovieChannel view to render as badges/chips.
 */

// Label lines in the description are metadata, not prose — drop them so `text` is just the
// synopsis/plot (used by the detail view, not the tile).
const LABEL_MARKERS = [
  '标题：', '评分：', '片长：', '制片国家', '导演：', '主演：', '标签：',
  '影片类型：', '上映日期：', '想看：', '类型：',
  'User Score', 'Vote Count', 'Original title', 'IMDb RATING',
]

function synopsis(desc: string): string | undefined {
  // IMDb wraps the poster in <figure><img><figcaption>…</figcaption></figure>; the caption
  // is image alt-text, not plot — drop it before we treat the rest as prose.
  const withoutCaption = desc.replace(/<figcaption\b[^>]*>.*?<\/figcaption>/gis, '')
  const kept = toText(stripImages(withoutCaption))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !LABEL_MARKERS.some((m) => l.includes(m)))
    .map((l) => l.replace(/^影片信息[：:]\s*/, '').replace(/^剧情简介[：:]\s*/, ''))
    .filter(Boolean)
  const t = kept.join('\n').trim()
  return t || undefined
}

function firstMatch(s: string, re: RegExp): string | undefined {
  const m = s.match(re)
  return m ? m[1] : undefined
}

/** Normalize a parsed rating to one decimal; drop 0 / non-numeric (douban unrated,
 *  TMDB vote_average 0 for unreleased titles) so the card shows no badge instead of "0". */
function normRating(v: string | undefined): string | undefined {
  if (!v) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n.toFixed(1)
}

type MovieSource = 'douban' | 'tmdb' | 'imdb'

/** 卡片 / 详情上「评分来自谁」的显示名——宿主和前端都不认识这几家，文案由本包给。 */
const SOURCE_LABEL: Record<MovieSource, string> = { douban: '豆瓣', tmdb: 'TMDB', imdb: 'IMDb' }

function sourceOf(id: string): MovieSource {
  if (id.includes('imdb')) return 'imdb'
  if (id.includes('tmdb')) return 'tmdb'
  return 'douban'
}

function labelLine(desc: string, label: string): string | undefined {
  const m = desc.match(new RegExp(`${label}：\\s*([^<\\n]+)`, 'i'))
  return m?.[1]?.trim() || undefined
}

function nameList(v: string | undefined): string[] | undefined {
  const out = (v ?? '').split(/\s*[/／、]\s*/).map((s) => s.trim()).filter(Boolean)
  return out.length ? out : undefined
}

function discoveryOf(desc: string): NonNullable<ContentMeta['discovery']> {
  const runtime = labelLine(desc, '片长')?.match(/(\d+)\s*分钟/)?.[1]
  const directors = nameList(labelLine(desc, '导演'))
  const actors = nameList(labelLine(desc, '主演'))
  return {
    ...(runtime ? { runtimeMinutes: Number(runtime) } : {}),
    ...(directors ? { directors } : {}),
    ...(actors ? { actors } : {}),
  }
}

function yearFromDate(v: unknown): string | undefined {
  if (!v) return undefined
  const d = v instanceof Date ? v : new Date(String(v))
  const y = d.getFullYear?.()
  return Number.isFinite(y) && y > 1800 ? String(y) : undefined
}

export const movieNormalizer: Normalizer = (raw, manifest) => {
  const desc = String(raw.description ?? '')
  const source = sourceOf(manifest?.id ?? '')
  const cover = extractImages(desc)[0]?.url
  let title = raw.title ? String(raw.title) : undefined
  const meta: ContentMeta = { source, sourceLabel: SOURCE_LABEL[source] }

  if (source === 'imdb') {
    // title arrives as "1. The Shawshank Redemption (1994)" (rank + name + year).
    if (title) {
      meta.year = firstMatch(title, /\((\d{4})/)
      title = title.replace(/^\s*\d+\.\s*/, '').replace(/\s*\((?:\d{4}).*?\)\s*$/, '').trim()
    }
    meta.rating = firstMatch(desc, /IMDb RATING:\s*([\d.]+)/)
    if (Array.isArray(raw.category) && raw.category.length) {
      const g = (raw.category as unknown[]).map(String).map((s) => s.trim()).filter(Boolean)
      if (g.length) meta.genres = g
    }
  } else if (source === 'tmdb') {
    meta.rating = firstMatch(desc, /User Score:\s*([\d.]+)/)
    meta.year = yearFromDate(raw.pubDate ?? raw.pubdate)
  } else {
    // douban — playing / ustop / weekly all put "评分：X" in the description.
    meta.rating = firstMatch(desc, /评分：\s*([\d.]+)/)
    // ustop: "影片类型：喜剧 | 动画 | 冒险"
    const typeLine = firstMatch(desc, /影片类型：\s*([^<]+?)\s*<br/)
    if (typeLine) {
      const g = typeLine.split(/\s*[|｜]\s*/).map((s) => s.trim()).filter(Boolean)
      if (g.length) meta.genres = g
    }
    // weekly: "标签：YEAR / COUNTRY / GENRE1 GENRE2 / DIRECTOR / ACTORS"
    const subtitle = firstMatch(desc, /标签：\s*([^<]+)/)
    if (subtitle) {
      meta.year = meta.year ?? firstMatch(subtitle, /((?:19|20)\d{2})/)
      const parts = subtitle.split('/').map((s) => s.trim()).filter(Boolean)
      if (!meta.genres && parts.length >= 3) {
        const g = parts[2].split(/\s+/).map((s) => s.trim()).filter(Boolean)
        if (g.length) meta.genres = g
      }
    }
    // 豆瓣的榜单条目是「发现」，不是外部 id 权威——但它的 description 里带着一小撮可信的详情
    // （片长 / 导演 / 主演）。申报成 `meta.discovery`，宿主在 TMDb/OMDb 认不出作品时拿它兜底
    // （`src/video/discovery-fallback.ts`），宿主自己不再解析这份文案。TMDB / IMDb 不申报：
    // 它们本身就是外部 id 权威，认不出就是认不出。
    meta.discovery = discoveryOf(desc)
  }

  meta.rating = normRating(meta.rating)

  const media = cover ? [{ kind: 'image' as const, url: cover }] : undefined
  return {
    archetype: media ? 'gallery' : 'text',
    title,
    text: synopsis(desc),
    media,
    meta,
  }
}
