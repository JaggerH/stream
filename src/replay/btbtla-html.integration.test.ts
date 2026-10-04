import { describe, expect, it } from 'vitest'
import { loadRecipePackages } from './recipe-package.ts'
import { makeHtmlFetch } from './html-fetch.ts'
import { interpretHtml } from './interpret-html.ts'

// Live-only: hits www.btbtla.com (search + detail). Skipped unless STREAM_LIVE=1 so `pnpm test` stays offline.
const live = process.env.STREAM_LIVE === '1' ? it : it.skip

describe('btbtla kind:html recipes (live)', () => {
  live('search 出季卡片（title + detailUrl，无浏览器）', async () => {
    const recipe = loadRecipePackages('packages').recipes.get('btbtla-search')
    expect(recipe?.kind).toBe('html')
    if (recipe?.kind !== 'html') return
    const { items } = await interpretHtml(recipe, { fetchHtml: makeHtmlFetch(recipe) }, { name: '上载新生' })
    expect(items.length).toBeGreaterThan(0)
    expect(String(items[0].detailUrl)).toMatch(/\/detail\//)
    expect(items[0].title).toBeTruthy()
  }, 30_000)

  live('detail 出下载行（title=行标题，link=/tdown|/pdown）', async () => {
    const search = loadRecipePackages('packages').recipes.get('btbtla-search')
    const recipe = loadRecipePackages('packages').recipes.get('btbtla-detail')
    if (search?.kind !== 'html' || recipe?.kind !== 'html') return
    const s = await interpretHtml(search, { fetchHtml: makeHtmlFetch(search) }, { name: '上载新生' })
    const detailUrl = String(s.items[0].detailUrl)
    const { items } = await interpretHtml(recipe, { fetchHtml: makeHtmlFetch(recipe) }, { detailUrl })
    expect(items.length).toBeGreaterThan(0)
    expect(String(items[0].link)).toMatch(/\/(tdown|pdown)\//)
    expect(items[0].title).toBeTruthy()
  }, 45_000)
})
