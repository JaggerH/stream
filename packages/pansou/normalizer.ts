import type { Normalizer } from '../../src/content/normalize.ts'
import type { Media } from '../../src/content/types.ts'

/** PanSou link type → human label (zh). */
const TYPE_LABEL: Record<string, string> = {
  baidu: '百度网盘',
  quark: '夸克网盘',
  aliyun: '阿里云盘',
  tianyi: '天翼云盘',
  uc: 'UC网盘',
  '115': '115网盘',
  '123': '123网盘',
  mobile: '移动云盘',
  xunlei: '迅雷云盘',
  pikpak: 'PikPak',
  magnet: '磁力',
  ed2k: 'ed2k',
}

interface PansouLink {
  type?: string
  url?: string
  password?: string
}
interface PansouResult {
  title?: string
  content?: string
  links?: PansouLink[]
  images?: string[]
}

/**
 * PanSou search-result normalizer — one SearchResult (a source message) → a link
 * Content: its netdisk shares become link cards labeled by type + 提取码, with the
 * message text as the body. Netdisk links can't be auto-downloaded (you 转存 then
 * download), so they're surfaced as plain links, not magnets.
 */
export const pansouNormalizer: Normalizer = (raw) => {
  const r = raw as PansouResult
  const links = (Array.isArray(r.links) ? r.links : []).filter((l) => l && l.url)
  const media: Media[] = links.map((l) => {
    const label = TYPE_LABEL[String(l.type ?? '')] ?? String(l.type ?? '网盘')
    return { kind: 'link', url: String(l.url), title: l.password ? `${label} · 提取码 ${l.password}` : label }
  })
  return {
    archetype: 'link',
    title: r.title ? String(r.title) : undefined,
    text: r.content ? String(r.content) : undefined,
    media,
  }
}
