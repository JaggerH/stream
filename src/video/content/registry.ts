/**
 * Parser registry + auto-detection. Runs every parser's detect() on an item and
 * routes to the highest scorer. Detection keys on item SHAPE (not source id), so a
 * newly onboarded source of a known shape auto-routes with zero wiring.
 */
import { flatParser } from './parsers/flat.ts'
import { pairedParser } from './parsers/paired.ts'
import { digestParser } from './parsers/digest.ts'
import type { ContentParser, DownloadRow, RawDownloadItem } from './types.ts'

/** Order is irrelevant to correctness (max score wins); flat is the floor. */
export const PARSERS: ContentParser[] = [pairedParser, digestParser, flatParser]

export interface Routed {
  parser: ContentParser
  score: number
}

/** Pick the parser with the highest detect() score for this item. */
export function route(item: RawDownloadItem, parsers: ContentParser[] = PARSERS): Routed {
  let best: Routed = { parser: flatParser, score: -1 }
  for (const parser of parsers) {
    const score = parser.detect(item)
    if (score > best.score) best = { parser, score }
  }
  return best
}

/** Parse one raw item into normalized download rows via the auto-detected parser. */
export function parseItem(item: RawDownloadItem, parsers: ContentParser[] = PARSERS): DownloadRow[] {
  return route(item, parsers).parser.parse(item)
}
