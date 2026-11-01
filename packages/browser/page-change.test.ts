import { describe, it, expect } from 'vitest'
import { BrowserAdapter, CAP_WINDOW_MS, type PageRenderer } from './adapter.ts'
import { persistItems } from '../../src/stream-pipeline.ts'
import { DedupStore } from '../../src/dedup-store.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

/**
 * Integration: the tracked browser-page source through the REAL harvest pipeline
 * (adapter → makeStreamItem → persistItems → DedupStore). Pins the four behaviors the
 * page-change-tracking spec requires end to end:
 *   unchanged content twice → 0 written · substantive change → 1 written ·
 *   noise-only change → 0 written · past the anti-flood cap → nothing more.
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
    const harvest = (params: Record<string, unknown> = {}) =>
      adapter.fetch({ url: 'https://example.com/changelog', ...params }, manifest).then((raw) => {
        const items = (raw as { items: unknown[] }).items
        return persistItems(STREAM, 'browser-page', items, undefined, dedup)
      })
    const set = { body: (t: string) => (text = t), tick: (ms: number) => (now += ms) }
    return { harvest, set, close: () => dedup.close() }
  }

  it('same page content harvested twice writes 1 then 0 items', async () => {
    const h = harness()
    expect(await h.harvest({ track_changes: true })).toEqual({ fetched: 1, written: 1 })
    expect(await h.harvest({ track_changes: true })).toEqual({ fetched: 0, written: 0 })
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
    expect(await h.harvest({ track_changes: true })).toEqual({ fetched: 0, written: 0 })
    h.close()
  })

  it('past the anti-flood cap nothing more is produced (until the window slides)', async () => {
    const h = harness()
    let written = 0
    for (let i = 0; i < 10; i++) {
      h.set.body(`state ${i}`)
      const res = await h.harvest({ track_changes: true })
      written += res.written
      h.set.tick(60_000) // every harvest inside one rolling hour
    }
    expect(written).toBe(10) // capped budget, fully spent
    for (let i = 0; i < 5; i++) {
      h.set.body(`flood ${i}`)
      expect(await h.harvest({ track_changes: true })).toEqual({ fetched: 0, written: 0 })
      h.set.tick(60_000)
    }
    h.set.tick(CAP_WINDOW_MS) // window slides out
    expect((await h.harvest({ track_changes: true })).written).toBe(1) // latest content wins
    h.close()
  })

  it('default (no track_changes) keeps snapshot semantics through the pipeline', async () => {
    const h = harness()
    expect(await h.harvest()).toEqual({ fetched: 1, written: 1 })
    h.set.body('v2 — the page changed but nobody asked to track it')
    expect(await h.harvest()).toEqual({ fetched: 1, written: 0 })
    h.close()
  })
})
