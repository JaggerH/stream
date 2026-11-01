import { describe, it, expect } from 'vitest'
import { BrowserAdapter, normalizePageText, CAP_WINDOW_MS, type PageRenderer } from './adapter.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

const manifest = { id: 'browser-page', adapter: 'browser' } as unknown as SourceManifest

const stub: PageRenderer = {
  render: async (url) => ({ url, title: 'Hello', text: 'body text', html: '<p>body text</p>' }),
}

describe('BrowserAdapter', () => {
  it('renders a url into one page item', async () => {
    const a = new BrowserAdapter(stub)
    const { items } = (await a.fetch({ url: 'https://example.com/feed' }, manifest)) as { items: Array<Record<string, unknown>> }
    expect(items).toHaveLength(1)
    expect(items[0].guid).toBe('https://example.com/feed')
    expect(items[0].title).toBe('Hello')
    expect(items[0].url).toBe('https://example.com/feed')
  })

  // 页面标题就在手里，报上去 = 订阅这条流时名字自动填好（scheduler → backfillLabel）。
  it('reports the page title as the feed title', async () => {
    const a = new BrowserAdapter(stub)
    const res = (await a.fetch({ url: 'https://example.com/feed' }, manifest)) as { title?: string }
    expect(res.title).toBe('Hello')
  })

  it('omits the feed title when the page has none', async () => {
    const untitled: PageRenderer = { render: async (url) => ({ url, title: '', text: '', html: '' }) }
    const res = (await new BrowserAdapter(untitled).fetch({ url: 'https://example.com' }, manifest)) as { title?: string }
    expect(res.title).toBeUndefined()
  })

  it('throws an actionable error when url is missing', async () => {
    const a = new BrowserAdapter(stub)
    await expect(a.fetch({}, manifest)).rejects.toThrow(/url/)
  })

  it('has id "browser"', () => {
    expect(new BrowserAdapter(stub).id).toBe('browser')
  })
})

describe('BrowserAdapter — track_changes', () => {
  /** Renderer whose body text is scripted per call; lets tests walk the page through states. */
  const changing = (texts: string[]) => {
    let i = 0
    return {
      render: async (url: string) => ({
        url,
        title: 'Changelog',
        text: texts[Math.min(i++, texts.length - 1)],
        html: `<p>${texts[0]}</p>`,
      }),
    }
  }
  const tracked = { url: 'https://example.com/changelog', track_changes: true }
  const itemsOf = async (a: BrowserAdapter, params: Record<string, unknown>) =>
    ((await a.fetch(params, manifest)) as { items: Array<Record<string, unknown>> }).items

  it('keeps the page-address identity when track_changes is absent (snapshot semantics)', async () => {
    const a = new BrowserAdapter(changing(['v1', 'v2', 'v3']))
    const first = await itemsOf(a, { url: 'https://example.com/changelog' })
    const second = await itemsOf(a, { url: 'https://example.com/changelog' })
    expect(first[0].guid).toBe('https://example.com/changelog')
    expect(second[0].guid).toBe('https://example.com/changelog') // identity never rotates
  })

  it('emits a baseline item whose guid is url#content-digest', async () => {
    const a = new BrowserAdapter(changing(['v1 body']))
    const first = await itemsOf(a, tracked)
    expect(first).toHaveLength(1)
    expect(String(first[0].guid)).toMatch(/^https:\/\/example\.com\/changelog#[0-9a-f]{16}$/)
  })

  // The adapter never "swallows" a repeat itself: unchanged content re-emits under the SAME
  // identity, and each stream's own dedup decides what is new. That is what lets two streams
  // watch one url (see the two-stream test below) without the second losing its baseline.
  it('re-emits unchanged content under the same identity instead of going silent', async () => {
    const a = new BrowserAdapter(changing(['same body', 'same body']))
    const first = await itemsOf(a, tracked)
    const second = await itemsOf(a, tracked)
    expect(second).toHaveLength(1)
    expect(second[0].guid).toBe(first[0].guid)
  })

  it('emits exactly one item when the content substantively changes', async () => {
    const a = new BrowserAdapter(changing(['v1 body', 'v2 body with new release']))
    const first = await itemsOf(a, tracked)
    const second = await itemsOf(a, tracked)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(second[0].guid).not.toBe(first[0].guid) // digest differs per content
  })

  it('keeps the identity stable across noise-only changes: timestamps and relative ages', async () => {
    const a = new BrowserAdapter(
      changing(['Released v2 — 2026-11-01 10:00', 'Released v2 — 2026-11-01 10:05 5 min ago']),
    )
    const first = await itemsOf(a, tracked)
    const second = await itemsOf(a, tracked)
    expect(second[0].guid).toBe(first[0].guid) // same digest → the pipeline's dedup writes 0
  })

  it('keeps the identity stable across a title-only rewrite (title is not part of the digest)', async () => {
    let title = 'First'
    const t: PageRenderer = {
      render: async (url) => ({ url, title, text: 'stable body', html: '' }),
    }
    const a = new BrowserAdapter(t)
    const first = await itemsOf(a, tracked)
    title = 'Second'
    const second = await itemsOf(a, tracked)
    expect(second[0].guid).toBe(first[0].guid)
  })

  it('caps NEW digests at 6 per page per rolling 24h and stays silent after', async () => {
    let now = 0
    const texts = Array.from({ length: 10 }, (_, i) => `state ${i}`)
    const a = new BrowserAdapter(changing(texts), { now: () => now })
    for (let i = 0; i < 6; i++) {
      expect(await itemsOf(a, tracked)).toHaveLength(1) // each new digest within the cap emits
      now += 3_600_000 // one harvest per hour, the manifest cadence
    }
    for (let i = 0; i < 3; i++) {
      expect(await itemsOf(a, tracked)).toHaveLength(0) // cap reached: changes no longer emitted
      now += 3_600_000
    }
    now += CAP_WINDOW_MS // the window slides out
    expect(await itemsOf(a, tracked)).toHaveLength(1) // latest content wins
  })

  it('never counts repeat digests against the cap — A→B→A spends one slot for A', async () => {
    let now = 0
    let text = 'A'
    const a = new BrowserAdapter(
      { render: async (url) => ({ url, title: 'T', text, html: '' }) },
      { now: () => now },
    )
    await itemsOf(a, tracked) // A: slot 1
    text = 'B'
    await itemsOf(a, tracked) // B: slot 2
    text = 'A'
    expect(await itemsOf(a, tracked)).toHaveLength(1) // A again: emitted, no slot
    for (let i = 0; i < 4; i++) {
      text = `new ${i}`
      expect(await itemsOf(a, tracked)).toHaveLength(1) // slots 3–6 still available
    }
    text = 'one too many'
    expect(await itemsOf(a, tracked)).toHaveLength(0) // 6 new digests in the window: capped
  })

  it('serves two streams watching the same url: both baselines, both changes, one slot', async () => {
    let now = 0
    let text = 'v1 body'
    const a = new BrowserAdapter(
      { render: async (url) => ({ url, title: 'T', text, html: '' }) },
      { now: () => now },
    )
    // Two streams = two identical fetches (dedup is per stream, downstream of the adapter).
    const first = await itemsOf(a, tracked)
    const second = await itemsOf(a, tracked) // the second stream's FIRST harvest
    expect(second).toHaveLength(1) // it gets its baseline, not silence
    expect(second[0].guid).toBe(first[0].guid)
    text = 'v2 body'
    now += 3_600_000
    const change1 = await itemsOf(a, tracked)
    const change2 = await itemsOf(a, tracked)
    expect(change1).toHaveLength(1)
    expect(change2[0].guid).toBe(change1[0].guid) // both streams see the change…
    // …but the digest is new once: only 4 more new digests fit in this 24h window.
    for (let i = 0; i < 4; i++) {
      text = `state ${i}`
      now += 3_600_000
      expect(await itemsOf(a, tracked)).toHaveLength(1)
    }
    text = 'capped'
    now += 3_600_000
    expect(await itemsOf(a, tracked)).toHaveLength(0)
  })

  it('spends no cap slot on unchanged harvests', async () => {
    let now = 0
    let text = 'same'
    const a = new BrowserAdapter(
      { render: async (url) => ({ url, title: 'T', text, html: '' }) },
      { now: () => now },
    )
    await itemsOf(a, tracked) // baseline 'same': the FIRST new digest, slot 1
    for (let i = 0; i < 20; i++) {
      now += 30_000
      expect(await itemsOf(a, tracked)).toHaveLength(1) // re-emitted under the same identity
    }
    for (let i = 0; i < 5; i++) {
      text = `change ${i}` // slots 2–6 still there: unchanged harvests consumed none
      now += 60_000
      expect(await itemsOf(a, tracked)).toHaveLength(1)
    }
    text = 'capped'
    expect(await itemsOf(a, tracked)).toHaveLength(0)
  })

  it('normalizes whitespace-only differences away (same identity)', async () => {
    const a = new BrowserAdapter(changing(['a  b\n\nc', ' a b c ']))
    const first = await itemsOf(a, tracked)
    const second = await itemsOf(a, tracked)
    expect(second[0].guid).toBe(first[0].guid)
  })

  it('accepts the string form "true" for track_changes', async () => {
    const a = new BrowserAdapter(changing(['v1 body']))
    const items = await itemsOf(a, { url: 'https://example.com/changelog', track_changes: 'true' })
    expect(items).toHaveLength(1)
    expect(String(items[0].guid)).toContain('#')
  })
})

describe('normalizePageText', () => {
  it('collapses whitespace', () => {
    expect(normalizePageText('  a\n\n  b\tc  ')).toBe('a b c')
  })

  it('strips absolute dates, clock times and relative ages', () => {
    expect(normalizePageText('Updated 2026-11-01 10:00:00 — posted 5 minutes ago')).toBe('Updated — posted')
    expect(normalizePageText('发布于 2026/11/1 08:05')).toBe('发布于')
    expect(normalizePageText('3 分钟前更新')).toBe('更新')
  })

  it('keeps content that merely sits next to a timestamp', () => {
    expect(normalizePageText('Release 2.0 shipped on 2026-11-01')).toBe('Release 2.0 shipped on')
  })
})
