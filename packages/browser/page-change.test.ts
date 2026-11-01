import { describe, it, expect } from 'vitest'
import { BrowserAdapter, type PageRenderer } from './adapter.ts'
import { persistItems } from '../../src/stream-pipeline.ts'
import { DedupStore } from '../../src/dedup-store.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

/**
 * Integration: the tracked browser-page source through the REAL harvest pipeline
 * (adapter → makeStreamItem → persistItems → DedupStore). Pins the behaviors the
 * page-change-tracking spec requires end to end:
 *   unchanged content twice → 0 written · substantive change → 1 written ·
 *   noise-only change → 0 written · hourly noise page ≤6 items per rolling 24h ·
 *   two streams on one url each get baseline + change.
 * The renderer is a stub — no browser is launched.
 */

const manifest = { id: 'browser-page', adapter: 'browser' } as unknown as SourceManifest
const STREAM = 'page-watch'

describe('browser-page change tracking through the harvest pipeline', () => {
  /** A page whose body text is scripted per fetch, plus a controllable clock for the cap. */
  const harness = () => {
    let text = 'v1 body'
    let now = 0
    const renderer: PageRenderer = {
      render: async (url) => ({ url, title: 'Changelog', text, html: `<p>${text}</p>` }),
    }
    const adapter = new BrowserAdapter(renderer, { now: () => now })
    const dedup = new DedupStore(':memory:')
    const harvest = (params: Record<string, unknown> = {}, streamId = STREAM) =>
      adapter.fetch({ url: 'https://example.com/changelog', ...params }, manifest).then((raw) => {
        const items = (raw as { items: unknown[] }).items
        return persistItems(streamId, 'browser-page', items, undefined, dedup)
      })
    const set = { body: (t: string) => (text = t), tick: (ms: number) => (now += ms) }
    return { harvest, set, close: () => dedup.close() }
  }

  it('same page content harvested twice writes 1 then 0 items', async () => {
    const h = harness()
    expect(await h.harvest({ track_changes: true })).toEqual({ fetched: 1, written: 1 })
    expect(await h.harvest({ track_changes: true })).toEqual({ fetched: 1, written: 0 }) // dedup swallows
    h.close()
  })

  it('a substantive content change writes exactly 1 new item', async () => {
    const h = harness()
    await h.harvest({ track_changes: true })
    h.set.body('v2 body — new release published')
    expect(await h.harvest({ track_changes: true })).toEqual({ fetched: 1, written: 1 })
    h.close()
  })

  it('a noise-only change (timestamps) writes 0 items', async () => {
    const h = harness()
    h.set.body('Released v2 — 2026-11-01 10:00')
    await h.harvest({ track_changes: true })
    h.set.body('Released v2 — 2026-11-01 10:05 5 min ago')
    expect(await h.harvest({ track_changes: true })).toEqual({ fetched: 1, written: 0 }) // same identity
    h.close()
  })

  // The manifest cadence is 3600s: one harvest per hour, 24 a day. A page that renders
  // differently on EVERY tick must not become 24 timeline items a day — over 48 hourly
  // harvests (two full days) no window of 24 consecutive harvests (= any rolling 24h) may
  // produce more than the cap of 6 items.
  it('a noise page harvested hourly stays within 6 items in ANY rolling 24h window', async () => {
    const h = harness()
    const perHarvest: number[] = []
    for (let i = 0; i < 48; i++) {
      h.set.body(`noise state ${i} — different every render`)
      perHarvest.push((await h.harvest({ track_changes: true })).written)
      h.set.tick(3_600_000)
    }
    for (let start = 0; start + 24 <= perHarvest.length; start++) {
      const window = perHarvest.slice(start, start + 24).reduce((a, b) => a + b, 0)
      expect(window).toBeLessThanOrEqual(6)
    }
    // and the cap actually binds: 48 harvests would write 48 uncapped; the budget is two days
    expect(perHarvest.reduce((a, b) => a + b, 0)).toBe(12)
    h.close()
  })

  it('default (no track_changes) keeps snapshot semantics through the pipeline', async () => {
    const h = harness()
    expect(await h.harvest()).toEqual({ fetched: 1, written: 1 })
    h.set.body('v2 — the page changed but nobody asked to track it')
    expect(await h.harvest()).toEqual({ fetched: 1, written: 0 })
    h.close()
  })

  // The adapter must not gate emissions on its own "last seen" memory — one engine
  // has ONE adapter instance shared by every stream, and dedup is per stream. Two streams on
  // the same url each get their baseline, each sees the change once.
  it('two streams on one url each get the baseline and each the change', async () => {
    const h = harness()
    const s1 = await h.harvest({ track_changes: true })
    const s2 = await h.harvest({ track_changes: true }, 'page-watch-2') // second stream, same url
    expect(s1).toEqual({ fetched: 1, written: 1 })
    expect(s2).toEqual({ fetched: 1, written: 1 }) // its own baseline, not silence
    h.set.body('v2 body — a real change')
    expect(await h.harvest({ track_changes: true })).toEqual({ fetched: 1, written: 1 })
    expect(await h.harvest({ track_changes: true }, 'page-watch-2')).toEqual({ fetched: 1, written: 1 })
    // the change was ONE new digest: a third stream now gets it as baseline without a new slot
    expect(await h.harvest({ track_changes: true }, 'page-watch-3')).toEqual({ fetched: 1, written: 1 })
    h.close()
  })
})
