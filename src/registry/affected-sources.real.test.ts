import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { loadRecipePackages, BUILTIN_LAYER_SCAN } from '../replay/recipe-package.ts'
import { DETAIL_SOURCE } from '../../packages/xhs/detail.ts'
import { namespacedSourceId } from './source-id.ts'
import { Registry } from './registry.ts'
import type { SourceManifest } from '../manifest/types.ts'

// 真的 `packages/` 目录里那份 `uses` 声明有没有说真话。
//
// 这条声明的两端住在不同的文件里：申报写在 recipe 的 `meta.uses`，真正去调那个源的是包的
// detail enricher（`packages/xhs/detail.ts` 的 `DETAIL_SOURCE`，经 `ctx.readSource` 按包名限定成全名）。
// 两边各写一份字面量的话，改了一边**不会有任何一处报错**——只会让「谁被连累」静静少算一条，
// 而且是在出事那一刻才用得上的那一条。
const PACKAGES_DIR = fileURLToPath(new URL('../../packages', import.meta.url))
const XHS_DETAIL_SOURCE_ID = namespacedSourceId('@streamapp/xhs', DETAIL_SOURCE)
const sources = (): SourceManifest[] =>
  loadRecipePackages(PACKAGES_DIR, BUILTIN_LAYER_SCAN).descriptors.flatMap(
    (d) => d.sources as unknown as SourceManifest[],
  )

describe('内置包的 uses 声明', () => {
  it('xhs 的 feed 源申报的 detail 源，就是 enrich 真去调的那一个', () => {
    const all = sources()
    for (const id of ['@streamapp/xhs/xhs-home', '@streamapp/xhs/xhs-search']) {
      const m = all.find((s) => s.id === id)
      expect(m, `${id} should load`).toBeTruthy()
      // 申报写的是局部名，投影期合成全名——比对的是全名，而不是「有没有这一格」。
      expect(m!.uses).toContain(XHS_DETAIL_SOURCE_ID)
    }
  })

  it('每一条 uses 都指着一个真的存在的源（写错了没人会喊）', () => {
    const all = sources()
    const ids = new Set(all.map((s) => s.id))
    const dangling = all.flatMap((s) => (s.uses ?? []).filter((u) => !ids.has(u)).map((u) => `${s.id} → ${u}`))
    expect(dangling).toEqual([])
  })

  it('detail 那份共用 recipe 漂了，用它的两个 feed 源一起被标出', () => {
    const r = new Registry(sources())
    const res = r.affectedSources(XHS_DETAIL_SOURCE_ID)
    expect(res.affected).toContain('@streamapp/xhs/xhs-home')
    expect(res.affected).toContain('@streamapp/xhs/xhs-search')
    expect(res.affected).toContain(XHS_DETAIL_SOURCE_ID)
    // 内置层里一条解析不到的边都不该有——有就是上面那条 dangling 守卫漏了什么。
    expect(res.unresolved).toEqual([])
  })

  it('存量形状（库里的两截行重组出来的 xhs:xhs-detail）也查得到', () => {
    const r = new Registry(sources())
    expect(r.affectedSources('xhs:xhs-detail').affected).toContain('@streamapp/xhs/xhs-home')
  })
})
