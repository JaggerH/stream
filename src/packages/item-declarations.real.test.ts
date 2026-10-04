import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BUILTIN_LAYER_SCAN, loadRecipePackages } from '../replay/recipe-package.ts'
import { projectItem, sourceSitesOf } from './item-projection.ts'

/**
 * 对**真实出货的 `packages/`** 钉住 `stream.item` 这一格：前端的作者位与点赞 / 收藏按钮只看后端
 * 投影出来的 `author_enrich` / `actions`，宿主前端不认识任何站——包里漏写一格，按钮就静默消失，
 * 没有一处会喊，所以由这里喊。只断言「有这么一类包、投影得出来」，不点名站：守卫不许宿主测试之外
 * 的源码认识它们，而这份测试要的也只是「声明装得进来且指得上本包的东西」。
 */
const PACKAGES_DIR = fileURLToPath(new URL('../../packages', import.meta.url))
const loaded = loadRecipePackages(PACKAGES_DIR, BUILTIN_LAYER_SCAN)
const pkgs = loaded.descriptors
const withItem = pkgs.filter((p) => p.item)

describe('内置包的 stream.item 声明', () => {
  it('至少一个包声明了动作、至少一个包声明了作者现取入口（走空 = 前端按钮全没了）', () => {
    expect(withItem.some((p) => p.item!.actions?.length)).toBe(true)
    expect(withItem.some((p) => p.item!.authorEnrich)).toBe(true)
  })

  it('每个动作的 recipe 真的装在本包里', () => {
    for (const p of withItem) {
      for (const a of p.item!.actions ?? []) {
        expect(loaded.recipes.has(a.recipe), `${p.facility} 的动作 ${a.id} 指向 ${a.recipe}`).toBe(true)
        expect(a.recipe.startsWith(`${p.name}/`)).toBe(true)
      }
    }
  })

  it('声明了 item 的包都给了 homepage（条目与源目录的站点格靠它）', () => {
    for (const p of withItem) expect(sourceSitesOf(pkgs)({ id: 'x', facility: { key: p.facility } }), p.facility).toBeTruthy()
  })

  it('本包的源产出的条目投影得出声明（端到端：源目录那条按 facility 归属）', () => {
    for (const p of withItem) {
      const item = {
        source_id: `${p.name}/whatever`,
        author: 'someone',
        content: { enrich: { source: 'x', params: new Proxy({}, { get: () => 'v' }) } },
      }
      const out = projectItem(item, { packages: pkgs, lookup: (id) => ({ id, facility: { key: p.facility, label: p.label ?? p.facility } }) })
      if (p.item!.authorEnrich) expect(out.author_enrich?.source).toBe(p.item!.authorEnrich.enricher)
      if (p.item!.actions?.length) expect(out.actions?.map((a) => a.id)).toEqual(p.item!.actions.map((a) => a.id))
    }
  })
})
