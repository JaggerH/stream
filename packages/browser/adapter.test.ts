import { describe, it, expect } from 'vitest'
import { BrowserAdapter, type PageRenderer } from './adapter.ts'
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
