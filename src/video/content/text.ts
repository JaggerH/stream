/**
 * Deterministic text utilities shared by the parsers. No LLM, no heurist"guessing"
 * beyond regex/structure — every rule here is traceable to a real corpus pattern.
 */

/** A netdisk/magnet URL, its trailing 访问码, and where it sat in the text. */
export interface LinkToken {
  url: string
  password?: string
  /** char offset of the token start (incl. an optional 链接：prefix) in the source. */
  start: number
  /** char offset just past the token (incl. the 访问码 clause). */
  end: number
}

// A URL runs until whitespace or an opening paren (half/full-width) — that paren is
// where a （访问码：...) clause begins, and it must NOT be swallowed into the URL
// (that was the truncated-link bug: "https://…（访问码："). The negative lookahead
// also splits URLs concatenated with no separator ("…ca3bhttps://drive…" → two URLs).
const URL_RE = /https?:\/\/(?:(?!https?:\/\/)[^\s（()])+/g
// 访问码 / 提取码 / 密码 GLUED onto the URL with no paren (123pan: "…HSOX?提取码：xmhd",
// "…y9wWh提取码:ZY4K"). The optional leading ?/？ is a fake query string, not real params.
const PW_GLUE = /[?？]?\s*(?:访问码|提取码|密码|pwd|code)\s*[:：]?\s*([A-Za-z0-9]{3,8})/i
// 访问码 clause immediately AFTER the URL, parenthesized (189: "…（访问码：5mpm）").
const PW_AFTER =
  /^\s*[（(]\s*(?:访问码|提取码|密码|pwd|code)\s*[:：]?\s*([A-Za-z0-9]{3,8})\s*[)）]?/i
// magnet/ed2k schemes too (rare in pansou content, common as inline text elsewhere)
const MAGNET_RE = /(?:magnet:\?xt=urn:btih:|ed2k:\/\/)[^\s]+/gi

/** Trim trailing punctuation a URL should never end with (…）, …, 。, comma). */
function trimUrl(u: string): string {
  return u.replace(/[)）.,。、；;："'']+$/, '')
}

/** Split a raw URL token into a clean URL + a password glued onto it (if any). The
 *  spine of "never emit a truncated link": whatever comes after a password marker is
 *  NOT part of the URL. */
export function cleanUrl(raw: string): { url: string; password?: string } {
  const m = raw.match(PW_GLUE)
  if (m && m.index != null && m.index > 0) {
    return { url: trimUrl(raw.slice(0, m.index)), password: m[1] }
  }
  // also strip a trailing newline/whitespace-glued junk tail defensively
  const clean = trimUrl(raw.split(/\s/)[0])
  return { url: clean, password: undefined }
}

/**
 * Find every download link in a blob, each with its 访问码 (glued to the URL or in a
 * following paren) and its position. This is the spine of the digest parse: the text
 * BETWEEN links is what names them.
 */
export function findLinks(text: string): LinkToken[] {
  const out: LinkToken[] = []
  const push = (rawUrl: string, at: number, after: string) => {
    const { url, password: glued } = cleanUrl(rawUrl)
    if (!url) return
    // an optional "链接：" prefix belongs to the token, not to the preceding title
    const prefix = text.slice(Math.max(0, at - 4), at)
    const pm = prefix.match(/链接\s*[:：]\s*$/)
    const start = pm ? at - pm[0].length : at
    const after2 = glued ? undefined : after.match(PW_AFTER)
    const password = glued ?? after2?.[1]
    const end = at + rawUrl.length + (after2 ? after2[0].length : 0)
    out.push({ url, password, start, end })
  }
  for (const m of text.matchAll(URL_RE)) {
    const at = m.index ?? 0
    push(m[0], at, text.slice(at + m[0].length))
  }
  for (const m of text.matchAll(MAGNET_RE)) {
    const at = m.index ?? 0
    out.push({ url: m[0], start: at, end: at + m[0].length })
  }
  return out.sort((a, b) => a.start - b.start)
}

// Markers that introduce a description blurb — the resource NAME is what precedes them.
const BLURB_CUT = /[·]?\s*(?:📜\s*)?(?:介绍|简介|剧情|描述|内容简介)\s*[:：]/
// Trailing metadata junk that is never part of a name. NOTE: 🎬/📺 are LEADING
// decorations, not trailing delimiters — putting them here would let a title that
// merely STARTS with 🎬 be nuked whole (the `.*$/s` eats everything after the marker).
const TRAILING_JUNK =
  /(?:💾|📁|🏷|⏰|⬇️|🔍|📌|群聊|频道|大小|标签|来源|时间|更新|其他剧集|评论区|网盘专搜|如下)\s*[:：]?.*$/s
// Leading decorative markers.
const LEADING_MARK = /^[\s​]*(?:🗄|📁|📺|🎬|🎭|#\S+|【[^】]*】)?\s*/

/**
 * Clean a raw title/segment into a display name. Strips {tmdbid} markers, the
 * intro blurb (name precedes it), decorative emoji, and trailing metadata junk.
 * Returns '' when nothing usable survives (caller lowers confidence / drops).
 */
export function cleanName(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim()
  s = s.replace(/[{｛]\s*tmdb(?:id)?\s*[-:：]?\s*\d+\s*[}｝]/gi, ' ') // {tmdbid-126080}
  const cut = s.search(BLURB_CUT)
  if (cut > 0) s = s.slice(0, cut)
  s = s.replace(TRAILING_JUNK, ' ')
  s = s.replace(LEADING_MARK, '')
  // strip a leading field label ("名称：xxx" / "片名：xxx") — the value is the name
  s = s.replace(/^\s*(?:名称|片名|标题|剧名|番名|资源(?:名称)?)\s*[:：]\s*/, '')
  // drop a dangling 链接 label or stray parens left at the edges
  s = s.replace(/链接\s*[:：]?\s*$/, '').replace(/^[\s·|,，、]+|[\s·|,，、]+$/g, '').trim()
  return s
}

/** Does this blob contain real HTML markup? RSSHub torrent sources (nyaa/1lou/…) put
 *  an HTML `<a href>` description in `content`; a pansou digest is plain Telegram text.
 *  The digest parser uses this to refuse HTML (which it would otherwise shred into
 *  "<a href=" names). */
export function isHtml(s: string): boolean {
  return /<(?:a|img|br|p|div|span|strong|em|ul|ol|li|table|td|tr|th|b|i|h[1-6]|pre|code)\b[^>]*>|<\/[a-z]+>/i.test(s)
}

/** One work in a digest: its name and 1+ links (>1 = mirror shares of the same work). */
export interface DigestGroup {
  name: string
  links: LinkToken[]
}

/**
 * Split a digest blob into works. Tokenize by links; the text segment BEFORE a link
 * names it. A link with an EMPTY preceding segment is a MIRROR of the current work
 * (same resource on another netdisk, often concatenated with no separator), so it
 * attaches to the open group instead of starting a new one — this is what keeps a
 * "one work, five mirror links" post from exploding into five nameless rows.
 * Deterministic — see corpus §1. The trailing segment (after the last link) is junk.
 */
export function pairDigest(content: string): DigestGroup[] {
  const links = findLinks(content)
  if (!links.length) return []
  const groups: DigestGroup[] = []
  let prevEnd = 0
  for (const link of links) {
    const name = cleanName(content.slice(prevEnd, link.start))
    if (name || groups.length === 0) groups.push({ name, links: [link] })
    else groups[groups.length - 1].links.push(link) // no title → mirror of the open work
    prevEnd = link.end
  }
  return groups
}
