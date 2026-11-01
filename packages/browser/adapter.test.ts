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

  it('emits 0 items when the normalized content is unchanged', async () => {
    const a = new BrowserAdapter(changing(['same body', 'same body']))
    await itemsOf(a, tracked)
    expect(await itemsOf(a, tracked)).toHaveLength(0)
  })

  it('emits exactly one item when the content substantively changes', async () => {
    const a = new BrowserAdapter(changing(['v1 body', 'v2 body with new release']))
    const first = await itemsOf(a, tracked)
    const second = await itemsOf(a, tracked)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(second[0].guid).not.toBe(first[0].guid) // digest differs per content
  })

  it('ignores noise-only changes: timestamps and relative ages', async () => {
    const a = new BrowserAdapter(
      changing(['Released v2 — 2026-11-01 10:00', 'Released v2 — 2026-11-01 10:05 5 min ago']),
    )
    await itemsOf(a, tracked)
    expect(await itemsOf(a, tracked)).toHaveLength(0)
  })

  it('ignores a title-only rewrite (title is not part of the content digest)', async () => {
    let title = 'First'
    const t: PageRenderer = {
      render: async (url) => ({ url, title, text: 'stable body', html: '' }),
    }
    const a = new BrowserAdapter(t)
    await itemsOf(a, tracked)
    title = 'Second'
    expect(await itemsOf(a, tracked)).toHaveLength(0)
  })

  it('caps emissions at 10 per page per rolling hour and stays silent after', async () => {
    let now = 0
    const texts = Array.from({ length: 15 }, (_, i) => `state ${i}`)
    const a = new BrowserAdapter(changing(texts), { now: () => now })
    for (let i = 0; i < 10; i++) {
      expect(await itemsOf(a, tracked)).toHaveLength(1) // each distinct state within the cap emits
      now += 60_000 // one harvest per minute, all inside one window
    }
    for (let i = 0; i < 5; i++) {
      expect(await itemsOf(a, tracked)).toHaveLength(0) // cap reached: changes no longer emitted
      now += 60_000
    }
    now += CAP_WINDOW_MS // the window slides out
    expect(await itemsOf(a, tracked)).toHaveLength(1) // latest content wins
  })

  it('does not count unchanged harvests against the cap', async () => {
    let now = 0
    let text = 'same'
    const a = new BrowserAdapter(
      { render: async (url) => ({ url, title: 'T', text, html: '' }) },
      { now: () => now },
    )
    await itemsOf(a, tracked)
    for (let i = 0; i < 20; i++) {
      now += 30_000
      expect(await itemsOf(a, tracked)).toHaveLength(0) // 20 unchanged harvests, no slot burned
    }
    text = 'changed'
    expect(await itemsOf(a, tracked)).toHaveLength(1) // the change still emits (cap not exhausted)
  })

  it('normalizes whitespace-only differences away', async () => {
    const a = new BrowserAdapter(changing(['a  b\n\nc', ' a b c ']))
    await itemsOf(a, tracked)
    expect(await itemsOf(a, tracked)).toHaveLength(0)
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
