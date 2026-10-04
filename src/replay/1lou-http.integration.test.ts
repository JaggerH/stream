import { describe, expect, it } from 'vitest'
import { loadRecipePackages } from './recipe-package.ts'
import { makeHttpFetch } from './http-fetch.ts'
import { interpret } from './interpret.ts'

// Live-only: hits www.1lou.me 的搜索接口（/search/api/search.php）。Skipped unless STREAM_LIVE=1。
// 站的搜索页已是空壳单页应用，行全靠这个 JSON 接口画出来，所以 recipe 是 kind:'http' 而不是 html
// （离线守卫在 packages/1lou/1lou-search.test.ts，吃活体原样回包）。这条只验活体接口今天还是不是那个形状。
// 注意（2026-09-24 实测）：这个搜索后端会整段时间回 502/504，红了先看它是不是又在宕。
const live = process.env.STREAM_LIVE === '1' ? it : it.skip

describe('1lou-search http recipe (live)', () => {
  live('hits the search API and maps every row to a thread link, no browser', async () => {
    const recipe = loadRecipePackages('packages').recipes.get('@streamapp/1lou/1lou-search')
    expect(recipe?.kind).toBe('http')
    if (recipe?.kind !== 'http') return

    const { items } = await interpret(recipe, { fetchInPage: makeHttpFetch(recipe) }, { keyword: '流浪地球' })

    expect(items.length).toBeGreaterThan(0)
    const first = items[0]
    expect(first.title).toBeTruthy()
    expect(String(first.link)).toMatch(/^https:\/\/www\.1lou\.me\/thread-\d+\.htm$/)
    expect(first.guid).toBe(first.link)
  }, 60_000)
})
