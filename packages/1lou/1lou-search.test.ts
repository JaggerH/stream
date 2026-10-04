/**
 * 1lou 搜索 recipe 的离线守卫：用活体接口的原样回包（`__fixtures__/search-api.json`，
 * 关键词「流浪地球」）跑一遍 `kind:'http'` 抽取，钉住请求形状与字段映射。
 *
 * 为什么是 JSON 不是 HTML：站点把搜索页改成了空壳单页应用，行全靠 `/search/api/search.php`
 * 画出来，页面 HTML 里一行都没有（见 README）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateRecipe } from '../../src/replay/recipe-store.ts'
import { interpret, ReplayDriftError, type ResolvedFetch } from '../../src/replay/interpret.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const raw = JSON.parse(readFileSync(join(HERE, '1lou-search.recipe.json'), 'utf-8'))
const fixture = JSON.parse(readFileSync(join(HERE, '__fixtures__', 'search-api.json'), 'utf-8'))

function load() {
  const recipe = validateRecipe('1lou-search', structuredClone(raw))
  if (recipe.kind !== 'http') throw new Error(`expected kind http, got ${recipe.kind}`)
  return recipe
}

describe('1lou-search recipe', () => {
  it('装载得起来，且是 http 类', () => {
    expect(load().kind).toBe('http')
  })

  it('请求打的是搜索接口，关键词进 q、页码进 page', async () => {
    const seen: ResolvedFetch[] = []
    await interpret(load(), { fetchInPage: async (req) => { seen.push(req); return fixture } }, { keyword: '流浪地球' })
    expect(seen).toHaveLength(1)
    const url = new URL(seen[0].url)
    expect(url.origin + url.pathname).toBe('https://www.1lou.me/search/api/search.php')
    expect(url.searchParams.get('q')).toBe('流浪地球')
    expect(url.searchParams.get('page')).toBe('1')
    expect(seen[0].method).toBe('GET')
  })

  it('活体样本的每一行都映射成带帖子链接的条目', async () => {
    const { items } = await interpret(load(), { fetchInPage: async () => fixture }, { keyword: '流浪地球' })
    const hits = fixture.data.hits as Array<{ tid: number; subject: string; username: string; create_date: number }>
    expect(hits.length).toBeGreaterThan(0)
    expect(items).toHaveLength(hits.length)
    for (const [i, it] of items.entries()) {
      expect(it.title).toBe(hits[i].subject)
      expect(it.link).toBe(`https://www.1lou.me/thread-${hits[i].tid}.htm`)
      expect(it.guid).toBe(it.link)
      expect(it.author).toBe(hits[i].username)
      // 秒级时间戳，stream-pipeline 的 parseTimestamp 按 <1e11 认成秒
      expect(it.pubDate).toBe(hits[i].create_date)
      expect(Number(it.pubDate)).toBeLessThan(1e11)
    }
    expect(items.some((it) => String(it.title).includes('流浪地球'))).toBe(true)
  })

  // 504 在 http-fetch 那层就按非 2xx 抛普通错误，到不了这里；这条守的是「200 但接口改了形状」。
  it('回包没有 data.hits（接口改版）⇒ drift，不是空结果', async () => {
    await expect(
      interpret(load(), { fetchInPage: async () => ({ ok: true, data: { results: [] } }) }, { keyword: 'x' }),
    ).rejects.toBeInstanceOf(ReplayDriftError)
  })
})
