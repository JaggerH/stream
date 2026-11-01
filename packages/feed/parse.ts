/**
 * Minimal RSS 2.0 + Atom feed parser — just enough structure to turn a feed document
 * into raw items with a STABLE per-entry identity.
 *
 * Why hand-rolled and not a dependency: the fields that matter for a timeline source are
 * five per entry (id, link, title, published date, body) plus the channel title. A focused
 * parser over those is ~150 lines and fully covered by fixture tests; a general XML
 * toolchain buys nothing here and drags a runtime dep into every install.
 *
 * Identity is the whole point of this adapter: items carry the FEED's own guid/id (falling
 * back to the entry link), never the feed URL — so a new entry in an already-subscribed
 * feed produces a new item (a page-address identity would make every re-harvest a dedup
 * no-op; see the stream-pipeline test for that failure mode).
 */

export interface FeedEntry {
  /** The feed's own per-entry identity: RSS <guid> or Atom <id>; falls back to the link. */
  guid: string
  link?: string
  title?: string
  /** Best-effort entry body (html or text as the feed ships it) — feeds makeStreamItem's `description`. */
  description?: string
  /** RSS <pubDate> or Atom <published>/<updated>, verbatim (makeStreamItem parses it). */
  pubDate?: string
  author?: string
}

export interface ParsedFeed {
  title?: string
  items: FeedEntry[]
}

const ENTITIES: Record<string, string> = {
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m)
}

/** Inner text of a tag: CDATA sections verbatim, otherwise XML-escaped text decoded. */
function inner(block: string, tag: string): string | undefined {
  // Match the tag by STRICT local name (any namespace prefix, but the name itself must be
  // exact): a suffix match would read <subtitle> for `title` and <guid> for `id` — both real
  // shapes in hybrid feeds. First occurrence wins.
  const re = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${tag}\\s*>`,
    'i',
  )
  const m = block.match(re)
  if (!m) return undefined
  const raw = m[1]
  if (raw.includes('<![CDATA[')) {
    return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
  }
  return decodeEntities(raw.replace(/<[^>]+>/g, '').trim())
}

/** Atom entries carry the link in an attribute: <link rel="alternate" href="…">.
 *  Prefer rel=alternate / no rel; skip rel=self (the feed itself) and rel=enclosure. */
function atomLink(block: string): string | undefined {
  const re = /<link\b([^>]*)\/?>/g
  let best: string | undefined
  for (const m of block.matchAll(re)) {
    const attrs = m[1] ?? ''
    const rel = attrs.match(/\brel=["']([^"']*)["']/i)?.[1] ?? ''
    const href = attrs.match(/\bhref=["']([^"']*)["']/i)?.[1]
    if (!href) continue
    if (rel === 'self' || rel === 'enclosure') continue
    if (rel === 'alternate' || rel === '') return href
    best ??= href
  }
  return best
}

const BLOCK_SPLIT = /<(?:[\w-]+:)?(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?(?:item|entry)\s*>/gi

export function parseFeed(xml: string): ParsedFeed {
  const body = xml.replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!--[\s\S]*?-->/g, '')
  const isAtom = /<feed[\s>]/i.test(body.split(/<(?:[\w-]+:)?(?:item|entry)\b/i)[0] ?? '')
  const items: FeedEntry[] = []
  for (const m of body.matchAll(BLOCK_SPLIT)) {
    const b = m[1]
    const guid = (isAtom ? inner(b, 'id') : inner(b, 'guid')) ?? atomLink(b) ?? inner(b, 'link')
    if (!guid) continue // no identity, no item — a dedup-less re-harvest is worse than a gap
    const link = isAtom ? (atomLink(b) ?? inner(b, 'link')) : inner(b, 'link')
    items.push({
      guid,
      ...(link ? { link } : {}),
      ...(inner(b, 'title') ? { title: inner(b, 'title') } : {}),
      // content:encoded (RSS, namespaced) wins — it is the full body; description is the teaser.
      description: inner(b, 'encoded') ?? inner(b, 'content') ?? inner(b, 'summary') ?? inner(b, 'description'),
      pubDate: inner(b, 'pubDate') ?? inner(b, 'published') ?? inner(b, 'updated') ?? inner(b, 'date'),
      author: inner(b, 'author') ?? inner(b, 'name'),
    })
  }
  // Channel title: first <title> that is not inside an item/entry block.
  const beforeItems = body.split(/<(?:[\w-]+:)?(?:item|entry)\b/i)[0] ?? ''
  const title = inner(beforeItems, 'title')
  return { ...(title ? { title } : {}), items }
}
