/**
 * 「在页面上 Ctrl+V 一条链接 → 打开它的详情」。
 *
 * 粘贴是用户自己的一下，浏览器把剪贴板内容直接交给页面：不弹读取权限，也天然满足"骑登录态的
 * 现取必须对应用户明确的一次打开"（见 `enrich.ts` 的 `allowsAutomaticEnrichment`）。所以这里
 * 不读剪贴板、不轮询，只接 `paste` 事件。
 *
 * 链接 → 详情要的 `Item`，分两路，后端都是现成的门：
 * - **有包认领**（`/api/links/recognize` 非 null）：交给 `/api/media/from-url`，认领它的包现取
 *   标题/作者/媒体/正文。取失败就报失败——不退到网页正文，平台页面抽出来只会是登录墙。
 * - **没人认领**：先试 `/api/media/from-url`（图片视频直链它认得）；它不认得就做成 `link` 原型，
 *   详情打开时自己按网页抽正文（`enrichParamsFor` 的 link 分支）。
 *
 * 这一条不进库：它是一次性的打开，`id` 只为详情内部做键。
 */
import { api, type Connection } from './api.ts'
import type { FetchUrlResult, Item, Media } from './types.ts'

/** 分享文案里常见的中文标点和括号都不属于链接——遇到就截断。 */
const URL_RE = /https?:\/\/[^\s，。！？、；：“”‘’（）《》【】<>"'`]+/i
/** 链接末尾挂着的英文标点（句号、逗号、右括号……）多半是句子的，不是链接的。 */
const TRAILING_PUNCT_RE = /[.,;:!?)\]}]+$/

/** 从一段粘贴文字里找出第一条 http(s) 链接。小红书/抖音分享出来是"标题 + 短链 + 一句引导语"。 */
export function firstUrlIn(text: string): string | null {
  const m = URL_RE.exec(text)
  if (!m) return null
  const url = m[0].replace(TRAILING_PUNCT_RE, '')
  try {
    new URL(url)
  } catch {
    return null
  }
  return url
}

/** 光标在可编辑的地方（输入框、对话框、富文本）时，粘贴就是粘贴，不归我们接管。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')) return true
  return target instanceof HTMLElement && target.isContentEditable === true
}

/** `label` 进 `source_label`：详情头上那枚来源徽章读它，缺了会退到 `stream_id`（一个内部名）。 */
function shell(url: string, title: string, label: string, content: Item['content']): Item {
  const now = new Date().toISOString()
  return { id: `paste:${url}`, stream_id: 'paste', source_label: label, type: 'post', title, url, content, timestamp: now, fetched_at: now }
}

/** 没人认领的网页：`link` 原型，详情打开时自己抽正文。 */
export function linkItem(url: string): Item {
  const host = new URL(url).hostname
  // 作者那格缺了详情同样退到 `stream_id`；普通网页没有作者，站名是最接近的那个。
  return { ...shell(url, url, host, { archetype: 'link', media: [{ kind: 'link', url }] }), author: host }
}

/** 包现取回来的那一份 → 详情要的 `Item`。原型按媒体形状定：有视频是视频，有图是图集，否则是文字。 */
export function itemFromFetched(url: string, r: FetchUrlResult): Item {
  const media: Media[] = r.media.map((m) => m.kind === 'video'
    ? { kind: 'video', url: m.url, poster: m.poster, duration_s: m.duration_s }
    : { kind: 'image', url: m.url })
  const archetype = media.some((m) => m.kind === 'video') ? 'video' : media.length > 0 ? 'gallery' : 'text'
  const firstLine = r.text?.split('\n').find((l) => l.trim() !== '')?.trim()
  const title = r.title?.trim() || firstLine || url
  return {
    ...shell(url, title, r.platform, { archetype, title: r.title, text: r.text, media }),
    author: r.author || r.platform,
    author_avatar: r.author_avatar,
  }
}

export type PastedLink = { item: Item } | { error: string }

/** 一条链接 → 详情要的 `Item`，或一句给人看的失败原因。网络错误也收成 `{ error }`，不抛。 */
export async function resolvePastedLink(conn: Connection, url: string): Promise<PastedLink> {
  try {
    const ref = await api.recognizeLink(conn, url)
    if (ref) {
      const r = await api.mediaFromUrl(conn, ref.url)
      return r.error ? { error: r.error } : { item: itemFromFetched(ref.url, r) }
    }
    const r = await api.mediaFromUrl(conn, url)
    return r.error ? { item: linkItem(url) } : { item: itemFromFetched(url, r) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
