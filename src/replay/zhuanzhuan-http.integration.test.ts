import { describe, expect, it } from 'vitest'
import { loadRecipePackages } from './recipe-package.ts'
import { makeHttpFetch } from './http-fetch.ts'
import { interpret } from './interpret.ts'
import { pickResaleRow } from '../agent/purchase/resale-pick.ts'

// Live-only: hits app.zhuanzhuan.com. Skipped unless STREAM_LIVE=1 so `pnpm test` stays offline.
const live = process.env.STREAM_LIVE === '1' ? it : it.skip

// 按文件自己的位置找 packages/，不信 cwd——worktree 里 shell 的 cwd 会漂回主检出，那里没有这个包，
// 于是 recipe 读成 undefined、`if (kind !== 'http') return` 把用例放成假绿（真撞过一次）。
const PACKAGES = new URL('../../packages', import.meta.url).pathname

describe('zhuanzhuan recycle http recipe (live)', () => {
  live('型号名 → 一行一个型号，带最高回收价；精确对名挑得出问的那台', async () => {
    const recipe = loadRecipePackages(PACKAGES).recipes.get('@streamapp/zhuanzhuan/zhuanzhuan-recycle')
    expect(recipe?.kind).toBe('http')
    if (recipe?.kind !== 'http') return

    const { items } = await interpret(
      recipe,
      { fetchInPage: makeHttpFetch(recipe) },
      { keyword: '一加 Ace 6' },
    )

    // 接口自带型号归一：Ace 6 / 6T / 至尊版 / 上一代 Ace 5 一起回——所以下面要精确对名。
    expect(items.length).toBeGreaterThan(1)
    expect(String(items[0].guid)).toMatch(/^zhuanzhuan-model-\d+$/)
    expect(String(items[0].description)).toMatch(/最高回收价 ¥\d+/)

    const hit = pickResaleRow(
      '一加 Ace 6',
      items.map((i) => ({ title: String(i.title), excerpt: String(i.description), source: '转转回收' })),
    )
    expect(hit).not.toBeNull()
    expect(hit!.resale).toBeGreaterThan(500)
  }, 30_000)

  live('搜不到的型号 → 空手（respData 在、keyWordResult 空），不是故障', async () => {
    const recipe = loadRecipePackages(PACKAGES).recipes.get('@streamapp/zhuanzhuan/zhuanzhuan-recycle')
    expect(recipe?.kind).toBe('http')
    if (recipe?.kind !== 'http') return
    const { items } = await interpret(recipe, { fetchInPage: makeHttpFetch(recipe) }, { keyword: '不存在的手机XYZ123' })
    expect(items).toHaveLength(0)
  }, 30_000)
})
