import type { SourceManifest } from '../manifest/types.ts'

export interface RankedSource {
  manifest: SourceManifest
  score: number
}

export interface SearchBackend {
  rank(query: string, manifests: SourceManifest[], k: number): RankedSource[]
}

/** Split a query into lowercased tokens on whitespace/punctuation. CJK runs stay intact. */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，。、;；:：!！?？/|()()\[\]"'`]+/u)
    .map((t) => t.trim())
    .filter(Boolean)
}

function haystack(m: SourceManifest): string {
  return [m.description, m.topics.join(' '), (m.categories ?? []).join(' '), m.example_queries.join(' ')]
    .join(' ')
    .toLowerCase()
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = hay.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = hay.indexOf(needle, idx + needle.length)
  }
  return count
}

/**
 * v1 lexical ranking: term-frequency by substring match over
 * description + topics + example_queries. Substring (not whole-token) match
 * keeps it usable for CJK where whitespace segmentation does not apply.
 * Non-discoverable manifests (escape hatches) are excluded from ranking.
 */
export class LexicalSearch implements SearchBackend {
  rank(query: string, manifests: SourceManifest[], k: number): RankedSource[] {
    const tokens = tokenize(query)
    if (tokens.length === 0) return []

    const scored: RankedSource[] = []
    for (const m of manifests) {
      if (m.discoverable === false) continue
      const hay = haystack(m)
      let score = 0
      for (const t of tokens) score += countOccurrences(hay, t)
      if (score > 0) scored.push({ manifest: m, score })
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }
}
