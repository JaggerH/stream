/**
 * Golden ad-fixture corpus: one JSON per labeled item, keyed by item id. The
 * directory itself is the "processed" set — gen skips ids that already have a
 * file. Fixtures store only the fields classifyAd consumes (no PII). Positives
 * must mute, negatives must not — see ad-fixtures.test.ts. See
 * docs/superpowers/specs/2026-06-14-ad-fixture-loop-design.md.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { AdFields } from './ad-filter.ts'
import type { StreamItem } from '../types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const FIXTURES_DIR = join(HERE, '__fixtures__', 'ads')

export interface AdFixture {
  task: 'ad'
  label: 'positive' | 'negative'
  reason: string
  source: string
  fields: AdFields
  meta: { itemId: string; capturedAt: string; note?: string }
}

/** Extract the classifier-consumed fields from a stored item (no PII). */
export function streamItemToFields(item: StreamItem): AdFields {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawCat = (item.raw as any)?.category
  const categories = Array.isArray(rawCat) ? rawCat.map(String) : rawCat != null ? [String(rawCat)] : []
  return {
    title: item.title,
    text: item.body_text,
    urls: [item.url, ...(item.attachments ?? [])].filter((u): u is string => !!u),
    categories,
  }
}

export function fixturePath(itemId: string): string {
  return join(FIXTURES_DIR, `${itemId}.json`)
}

export function hasFixture(itemId: string): boolean {
  return existsSync(fixturePath(itemId))
}

export function writeFixture(fx: AdFixture): void {
  mkdirSync(FIXTURES_DIR, { recursive: true })
  writeFileSync(fixturePath(fx.meta.itemId), JSON.stringify(fx, null, 2) + '\n')
}

/** Build + write a fixture from a stored item. Idempotent by item id (overwrite). */
export function writeFixtureFromItem(
  item: StreamItem,
  label: 'positive' | 'negative',
  capturedAt: string
): AdFixture {
  const fx: AdFixture = {
    task: 'ad',
    label,
    reason: item.muted?.reason ?? 'ad',
    source: item.stream_id,
    fields: streamItemToFields(item),
    meta: { itemId: item.id, capturedAt },
  }
  writeFixture(fx)
  return fx
}

export function loadFixtures(): AdFixture[] {
  if (!existsSync(FIXTURES_DIR)) return []
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf-8')) as AdFixture)
}

/** Negative fixtures' fields — the precision guard set for suggestRules. */
export function loadNegativeFields(): AdFields[] {
  return loadFixtures().filter((fx) => fx.label === 'negative').map((fx) => fx.fields)
}
