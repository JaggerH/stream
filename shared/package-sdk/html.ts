/**
 * Tiny html helpers for normalizers (Node, no DOM). Regex-based — sufficient for
 * the RSSHub item fragments we normalize; not a general html parser.
 *
 * 住 `shared/`：包里的 normalizer 和宿主的 normalizer 同吃这一份；
 * 纯函数被 inline 进包的 bundle 无害。`Media` 只借类型（编译期抹掉，dist 里没有）。
 */
import type { Media } from '../../src/content/types.ts'

type ImageMedia = Extract<Media, { kind: 'image' }>

/**
 * 解码一个**属性值**里的 HTML 实体。src/href 取出来的是转义过的文本，不解码就等于把
 * `&amp;` 当成 URL 的一部分带走。
 *
 * 掘金实测：封面是签名 CDN 链（`?rk3s=…&x-expires=…&x-signature=…`），未解码时浏览器请求
 * 的是查询参数名叫 `amp;x-expires` 的 URL，签名校验不过 → 403，整屏卡片一张图不出。**后端
 * 这一侧没有任何一处会喊**——URL 非空、media 有值、archetype 是 gallery，全都"正常"。
 */
function decodeAttr(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    // &amp; 必须最后解——先解它会把 `&amp;lt;` 这种双重转义误解成 `<`
    .replace(/&amp;/gi, '&')
}

/** Extract <img src> as image media, in document order. */
export function extractImages(html: string): ImageMedia[] {
  const out: ImageMedia[] = []
  const re = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    // skip RSSHub's hidden width=0 dup-cover prefixes
    if (/\bwidth=["']?0\b/.test(m[0]) || /\bhidden\b/.test(m[0])) continue
    out.push({ kind: 'image', url: decodeAttr(m[1]) })
  }
  return out
}

/** Extract all <a href>text</a> as {url, text}, in document order. */
export function extractLinks(html: string): Array<{ url: string; text: string }> {
  const out: Array<{ url: string; text: string }> = []
  const re = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) out.push({ url: decodeAttr(m[1]), text: toText(m[2]) })
  return out
}

/** First <a href> matching an optional predicate. */
export function firstLink(html: string, test?: (href: string) => boolean): string | undefined {
  const re = /<a\b[^>]*\bhref=["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const href = decodeAttr(m[1])
    if (!test || test(href)) return href
  }
  return undefined
}

/** Strip all tags → plain text, normalize whitespace, decode a few entities. */
export function toText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Remove <img> tags (e.g. a video cover already shown by the player). */
export function stripImages(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, '')
}
