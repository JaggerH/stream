/**
 * Content normalization layer — `normalize(raw, manifest) → Content` picks a per-source
 * function from the registry below and maps a source's raw upstream payload to the one
 * typed display model (see docs/design/normalization-layer.md, the decision record this
 * module now matches). This is NOT rendering: the frontend still renders by archetype.
 *
 * There is a second, unrelated `normalize` elsewhere in this repo (e.g. packages/<id>/adapter/
 * normalize.ts) that maps a FACILITY'S API RESPONSE → a Stream item — one
 * layer upstream of this one. That earlier normalize hands its result to THIS module as
 * `raw`; this module never touches a facility's wire format directly. Don't conflate the
 * two: "normalize" here always means raw item → Content.
 */
import type { SourceManifest } from '../manifest/types.ts'
import type { Content, Media } from './types.ts'
import { extractImages, extractLinks, stripImages, toText } from './html.ts'
import { trackRefFromUrl } from '../audio/track-url.ts'

/** Loose shape of a raw RSSHub item (what adapters return). */
export interface RawItem {
  title?: string
  description?: string
  link?: string
  author?: string
  category?: string[]
  attachments?: Array<{ url: string; mime_type?: string; duration_in_seconds?: number }>
  [k: string]: unknown
}

export type Normalizer = (raw: RawItem, manifest: SourceManifest) => Content

/** Human-readable byte size: 1234567 → "1.2 MB". Empty for missing/zero/garbage. */
function formatSize(bytes: unknown): string {
  const n = typeof bytes === 'number' ? bytes : Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** Podcast `itunes_duration` is either plain seconds (some podcast sources) or "HH:MM:SS"/"MM:SS"
 *  (apple/ximalaya). Normalize to seconds; undefined when unparseable. */
function parseDuration(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const s = String(v).trim()
  if (/^\d+$/.test(s)) return Number(s)
  const parts = s.split(':').map(Number)
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return undefined
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

/** Generic normalizer over RSSHub html — works for most flat sources. */
export const defaultNormalizer: Normalizer = (raw, manifest) => {
  const desc = String(raw.description ?? '')
  const title = raw.title ? String(raw.title) : undefined

  // Torrent/magnet routes (nyaa, dytt, btbtla, …) carry the downloadable link in
  // `enclosure_url` — invisible to the html-based branches below, so surface it
  // first as a link the reader can copy/open. Universal across RSSHub BT routes.
  const enclosure = String(raw.enclosure_url ?? '')
  const enclosureType = String(raw.enclosure_type ?? '')
  const isTorrent =
    enclosure.startsWith('magnet:') ||
    enclosure.startsWith('ed2k:') ||
    /bittorrent|torrent/i.test(enclosureType)
  if (isTorrent && enclosure) {
    const size = formatSize(raw.enclosure_length)
    return {
      archetype: 'link',
      title,
      text: toText(stripImages(desc)) || undefined,
      media: [{ kind: 'link', url: enclosure, title: size ? `magnet · ${size}` : 'magnet' }],
    }
  }

  // 播客集（各家播客源，如 ximalaya、apple……）把可播音频放在 `enclosure_url`（audio/*）。
  // 音轨身份的来源：recipe mapping 的 `track_id`（字段路径，住 recipe）+ 所属包的 facility
  // （`platform`，住 package.json）；缺 track_id 时再看链接有没有被某包认领为曲目（见下方
  // linkTrack）。源码里不写任何站的 URL 正则——文法住在声明它的包里（spec 2026-09-26-link-recognition）。
  // `platform` 不许 recipe 自报：一个包不能把自己的音轨挂进别家的 platform:id 空间。
  const isAudio = enclosureType.startsWith('audio/') || /\.(mp3|m4a|aac|ogg|wav)(\?|$)/i.test(enclosure)
  const trackRef = podcastTrackRef(raw, manifest)
  if (isAudio && enclosure) {
    const cover = (typeof raw.itunes_item_image === 'string' && raw.itunes_item_image) || extractImages(desc)[0]?.url
    const pageUrl = typeof raw.link === 'string' ? raw.link : undefined
    const audio: Media = {
      kind: 'audio',
      url: enclosure,
      poster: cover || undefined,
      duration_s: parseDuration(raw.itunes_duration),
      page_url: pageUrl,
      ...(trackRef ?? {}),
    }
    return {
      archetype: 'audio',
      title,
      text: toText(stripImages(desc)) || undefined,
      media: [audio],
    }
  }

  // Podcast episodes with no public enclosure (paid / app-exclusive voices, etc. — see the
  // relevant facility package's README for a worked example).
  const podcastCover = (typeof raw.itunes_item_image === 'string' && raw.itunes_item_image) || undefined
  const paidPageUrl = typeof raw.link === 'string' ? raw.link : undefined
  if (trackRef) {
    // We can recover a stable track id → record it so the netdisk alignment layer can serve the
    // paid episode by platform:id. NO url at all: there is no origin-playable audio (that is what
    // `resolveOnly` means), and the resolve route is the reader's to build. This also gives the
    // item a keyable leftKey for the mapping.
    const audio: Media = {
      kind: 'audio',
      poster: podcastCover,
      duration_s: parseDuration(raw.itunes_duration),
      page_url: paidPageUrl,
      ...trackRef,
      // 没有原始直链、也没有 resolve Provider 认领这个 platform → 只有网盘里有才可播。
      resolveOnly: true,
    }
    return {
      archetype: 'audio',
      title,
      text: toText(stripImages(desc)) || undefined,
      media: [audio],
    }
  }
  // 第三处来源：recipe 映射没给 track_id，但条目链接被某个包**认领为曲目**（`stream.links` 的 track pattern）。
  // 典型是镜像站歌单——条目是它产出的，歌却是另一个平台的。平台取**链接的主人**（认领表里一个平台只归
  // 一个包），不是产出条目的镜像站，所以「包不能把音轨挂进别家 platform:id 空间」这条不变量照样成立：
  // 文法是那个平台的包自己声明的。形状照平台包自己的 normalizer（只存引用，播放 / 下载时现解）。
  const linkTrack = !trackRef && typeof raw.link === 'string' ? trackRefFromUrl(raw.link) : null
  if (linkTrack) {
    const topImage = typeof raw.image === 'string' && raw.image.trim() ? raw.image.trim() : undefined
    const audio: Media = {
      kind: 'audio',
      poster: podcastCover || topImage || extractImages(desc)[0]?.url,
      duration_s: parseDuration(raw.itunes_duration),
      page_url: raw.link as string,
      platform: linkTrack.platform,
      track_id: linkTrack.track_id,
    }
    return { archetype: 'audio', title, text: toText(stripImages(desc)) || undefined, media: [audio] }
  }
  // No recoverable id → surface the cover as image media so MusicChannel's itemPoster()
  // still shows a poster on the (greyed, unplayable) row.
  if (podcastCover) {
    const media: Media[] = [{ kind: 'image', url: podcastCover }]
    return {
      archetype: 'audio',
      title,
      text: toText(stripImages(desc)) || undefined,
      media,
    }
  }

  const player = raw.attachments?.find(
    (a) => (a.mime_type ?? '').includes('html') || /player|embed|\.mp4(\?|$)/i.test(a.url)
  )
  if (player) {
    const poster = extractImages(desc)[0]?.url
    return {
      archetype: 'video',
      title,
      text: toText(stripImages(desc)),
      media: [{ kind: 'video', embed: player.url, poster, duration_s: player.duration_in_seconds, page_url: raw.link }],
    }
  }

  const images = extractImages(desc)
  // RSSHub's top-level `image` (DataItem.image) is a cover the html branches never see — many
  // routes (e.g. iqiyi 分集, video lists) provide the poster THERE, not inline in description.
  // Surface it as image media so image-first views (the video poster wall) get a cover.
  const topImage = typeof raw.image === 'string' && raw.image.trim() ? raw.image.trim() : undefined
  if (images.length === 0 && topImage) images.push({ kind: 'image', url: topImage })
  if (images.length > 0) {
    return { archetype: 'gallery', title, text: toText(stripImages(desc)), media: images }
  }

  // link-feed item (e.g. HN): description is basically just <a> links, no real prose
  const links = extractLinks(desc)
  const proseSansLinks = toText(desc.replace(/<a\b[^>]*>.*?<\/a>/gi, '')).trim()
  if (links.length > 0 && proseSansLinks.length < 30) {
    return {
      archetype: 'link',
      title,
      text: proseSansLinks || undefined,
      media: links.map((l) => ({ kind: 'link' as const, url: l.url, title: l.text || l.url })),
    }
  }

  return { archetype: 'text', title, text: toText(desc) }
}

const registry = new Map<string, Normalizer>()

/**
 * 往注册表里加一个 normalizer。**同名重复一律抛错，不覆盖**——允许覆盖就等于让一个包
 * 静默换掉另一个包的展示逻辑（spec §7 R1：代码撞名是供应链攻击面，与 recipe 数据的
 * 用户层覆盖语义不同）。
 */
export function registerNormalizer(key: string, normalizer: Normalizer): void {
  if (registry.has(key)) {
    throw new Error(`normalizer "${key}" is already registered — refusing to overwrite (a package must not shadow another's normalizer)`)
  }
  registry.set(key, normalizer)
}

/**
 * 这个名字是不是已经被注册了。给装载器用：撞名必须在**调用包的 activate 之前**判掉，
 * 所以不能靠「先注册再看 registerNormalizer 抛不抛」——那时代码已经跑过了。
 */
export function hasNormalizer(key: string): boolean {
  return registry.has(key)
}

// 具名 normalizer 一律归包：带 `stream.code` 的包在 activate 里交出，由装载器注册——名单归包，
// 宿主这里没有静态表（影视榜单的 `movie` 住 `packages/rsshub/`，它解析的是那几家站的文案）。

/** mapping 给了 `track_id` 且这个源属于某个 facility → `(platform, track_id)`；缺任一 → undefined。 */
function podcastTrackRef(raw: RawItem, manifest: SourceManifest): { platform: string; track_id: string } | undefined {
  const id = raw.track_id
  const platform = manifest.facility?.key
  if (!platform || (typeof id !== 'string' && typeof id !== 'number')) return undefined
  const track_id = String(id).trim()
  return track_id ? { platform, track_id } : undefined
}

/**
 * 付费标的**唯一注入点**（契约：source 把源站标价映成 `raw.price`，>0 即付费）。放在这里而不是
 * 各 normalizer 里，是因为它与内容形态无关——任何源只要报得出价格，付费这个事实就成立。
 *
 * 为什么不复用 `media.resolveOnly`：那个标说的是「只能靠外部映射播」，网盘绑定一补上音频它就
 * 该消失；而付费是源站的属性，补上音频之后依然成立。混用会让「买过/已补齐的付费集」不再显示
 * 为付费（活体实测到的错，2026-07-24）。
 */
function withPaid(content: Content, raw: RawItem): Content {
  const price = Number(raw.price)
  return Number.isFinite(price) && price > 0 ? { ...content, paid: true } : content
}

/** Normalize a raw item to Content using the manifest's normalizer (or default).
 *  `normalizer` is the current field; `presenter` is kept as a deprecated alias so
 *  existing manifests (including user data outside this repo) keep resolving. */
export function normalize(raw: RawItem, manifest: SourceManifest): Content {
  const key = manifest.normalizer ?? manifest.presenter
  const p = (key && registry.get(key)) || defaultNormalizer
  try {
    return withPaid(p(raw, manifest), raw)
  } catch {
    // a broken normalizer must never drop the item — fall back to plain text
    return { archetype: 'text', title: raw.title ? String(raw.title) : undefined, text: toText(String(raw.description ?? '')) }
  }
}
