/**
 * Evaluation metrics — the yardstick that makes iteration converge. A parser change
 * is an improvement iff these numbers move the right way; the suite fails when a hard
 * invariant (bad-link rate) regresses. See design §4.
 */
import type { DownloadRow } from '../types.ts'

/** A link is INVALID if it carries the truncation/garbage signatures we must never
 *  emit: whitespace, an unclosed 访问码 clause, a stray paren, or a non-URL scheme. */
export function isValidLink(url: string): boolean {
  if (!url) return false
  if (/\s/.test(url)) return false
  if (/[（）()]/.test(url)) return false
  if (/访问码|提取码|密码/.test(url)) return false
  // two URLs concatenated (a scheme appears AFTER position 0) = a broken split
  if (/.\bhttps?:\/\//i.test(url.slice(1))) return false
  if (/https?:\/\/.*https?:\/\//i.test(url)) return false
  return /^(https?:\/\/|magnet:|ed2k:\/\/)/i.test(url)
}

export interface CorpusReport {
  items: number
  rows: number
  badLinks: number
  badLinkRate: number
  emptyNames: number
  emptyNameRate: number
  /** rows whose name still looks like a URL — the "别显示链接" failure */
  urlAsName: number
  byParser: Record<string, number>
}

/** name that is really a URL — the exact failure the user called out. */
export function nameIsUrl(name: string): boolean {
  return /^https?:\/\//i.test(name.trim())
}

export function reportCorpus(perItem: Array<{ parser: string; rows: DownloadRow[] }>): CorpusReport {
  let rows = 0
  let badLinks = 0
  let emptyNames = 0
  let urlAsName = 0
  const byParser: Record<string, number> = {}
  for (const { parser, rows: rs } of perItem) {
    byParser[parser] = (byParser[parser] ?? 0) + 1
    for (const r of rs) {
      rows++
      if (!isValidLink(r.link)) badLinks++
      if (!r.name.trim()) emptyNames++
      if (nameIsUrl(r.name)) urlAsName++
    }
  }
  return {
    items: perItem.length,
    rows,
    badLinks,
    badLinkRate: rows ? badLinks / rows : 0,
    emptyNames,
    emptyNameRate: rows ? emptyNames / rows : 0,
    urlAsName,
    byParser,
  }
}

// ---- gold-based pairing / facet scoring ------------------------------------

export interface GoldRow {
  /** substring that MUST appear in the produced name (identity check) */
  nameHas: string
  /** substring the produced link must contain (share id / btih fragment) */
  linkHas: string
  netdisk?: string
  password?: string
  quality?: string
  season?: number
  coverageKind?: string
}

export interface PairScore {
  matched: number
  expected: number
  produced: number
  precision: number
  recall: number
  f1: number
  facetHits: number
  facetTotal: number
}

/** Match produced rows against gold expectations for one item. A gold row matches a
 *  produced row when the name contains `nameHas` AND the link contains `linkHas` —
 *  this is what catches the offset-pairing bug (right name on the wrong link). */
export function scoreItem(produced: DownloadRow[], gold: GoldRow[]): PairScore {
  let matched = 0
  let facetHits = 0
  let facetTotal = 0
  const used = new Set<number>()
  for (const g of gold) {
    const idx = produced.findIndex(
      (r, i) => !used.has(i) && r.name.includes(g.nameHas) && r.link.includes(g.linkHas),
    )
    if (idx < 0) continue
    used.add(idx)
    matched++
    const r = produced[idx]
    if (g.netdisk != null) { facetTotal++; if (r.netdisk === g.netdisk) facetHits++ }
    if (g.password != null) { facetTotal++; if (r.password === g.password) facetHits++ }
    if (g.quality != null) { facetTotal++; if (r.quality === g.quality) facetHits++ }
    if (g.season != null) { facetTotal++; if (r.season === g.season) facetHits++ }
    if (g.coverageKind != null) { facetTotal++; if (r.coverage.kind === g.coverageKind) facetHits++ }
  }
  const precision = produced.length ? matched / produced.length : 0
  const recall = gold.length ? matched / gold.length : 0
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
  return { matched, expected: gold.length, produced: produced.length, precision, recall, f1, facetHits, facetTotal }
}
