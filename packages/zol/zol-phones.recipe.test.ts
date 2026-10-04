// packages/zol/zol-phones.recipe.test.ts
//
// 这条 recipe 有两个**安静出错**的点，各钉一条：
//   ① 被反爬闸挡住时上游回的是 200（185 字节的 meta-refresh），不是 4xx。抓取层不会喊，
//      表现成 0 行——跟「今天没有新品」一模一样。assert 是唯一会喊的那一格。
//   ② 型号取错节点：`h3 a` 的文本会带上宣传语尾巴，而那种名字拿去比价核价查不到、
//      拿去去重也归不到一起。干净的名字在 `a.pic img` 的 alt 上。
//
// 夹具是手写的最小页，不是抓回来的整页（255KB 不该进仓库）；它只保留这两条判据要用的结构。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '../../src/http/build-identity.ts'
import { makeHtmlFetch } from '../../src/replay/html-fetch.ts'
import { interpretHtml } from '../../src/replay/interpret-html.ts'
import type { HtmlRecipe } from '../../src/replay/recipe.ts'
import { catalogsOf, pickCatalog, pickBands } from '../../src/agent/purchase/universe-catalog.ts'

const recipe = (): HtmlRecipe => {
  const r = JSON.parse(
    readFileSync(join(repoRoot, 'packages', 'zol', 'zol-phones.recipe.json'), 'utf8'),
  ) as HtmlRecipe
  r.pagination = { ...r.pagination, maxPages: 1 }
  return r
}

/** 真实抓到的反爬挡板页（2026-09-02，185 字节，HTTP 200）。 */
const BLOCKED =
  '<html><body><meta http-equiv="refresh" content="0.1;url=https://service.zol.com.cn/checking?backurl=https://detail.zol.com.cn/cell_phone_index/subcate57_list_2000_1.html"></body></html>'

/** 一行产品的最小结构：宣传语在嵌套 span 里、图和干净型号在 a.pic img 上、价格拆成两个 b。 */
const ROW = `
<li data-follow-id="p2173757">
  <a href="/cell_phone/index2173757.shtml" class="pic"
     ><img .src="https://2f.zol-img.com.cn/product/276.png" alt="Redmi K100 Pro（12GB/256GB） "></a>
  <h3><a href="/cell_phone/index2173757.shtml" title="Redmi K100 Pro（12GB/256GB） 旗舰双芯，185Hz高刷屏"
      >Redmi K100 Pro（12GB/256GB）  <span>旗舰双芯，185Hz高刷屏</span></a></h3>
  <div class="price-row">
    <span class="price price-normal"><b class="price-sign">￥</b><b class="price-type">3699</b></span>
  </div>
</li>`

const pageWith = (rows: string) =>
  `<html><head><title>t</title></head><body><div class="pic-mode-box"><ul>${rows}</ul>
   <ul class="rank-list"><li><p><a title="侧栏机型">侧栏机型</a></p><p class="price"><em>￥2699</em></p></li></ul>
   </div></body></html>`

const run = (html: string) => {
  const r = recipe()
  const fetchHtml = makeHtmlFetch(r, undefined, (async () =>
    new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch)
  return interpretHtml(r, { fetchHtml }, { price: '2000' })
}

describe('zol-phones recipe', () => {
  it('被反爬闸挡住（200 + 185 字节）→ 抛 drift，绝不安静地回 0 行', async () => {
    await expect(run(BLOCKED)).rejects.toThrow()
  })

  it('型号取 a.pic img 的 alt——不带宣传语尾巴', async () => {
    const out = await run(pageWith(ROW))
    const rows = out.items as unknown as Array<Record<string, string>>
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('Redmi K100 Pro（12GB/256GB）')
    expect(rows[0].title).not.toMatch(/旗舰双芯|185Hz/)
  })

  it('价格取 .price-type（纯数字，￥ 在同级的 .price-sign 里）', async () => {
    const rows = (await run(pageWith(ROW))).items as unknown as Array<Record<string, string>>
    expect(rows[0].description).toBe('3699')
  })

  it('行选择器不把侧栏「新增点评产品」算进来', async () => {
    // 侧栏那条也有价格、也有标题，只差 data-follow-id——所以选择器一旦放宽成 `li` 就会混进来。
    const out = await run(pageWith(ROW))
    const rows = out.items as unknown as Array<Record<string, string>>
    expect(rows.map((r) => r.title)).not.toContain('侧栏机型')
  })

  it('列表图取懒加载的 .src，不是占位的 src', async () => {
    const rows = (await run(pageWith(ROW))).items as unknown as Array<Record<string, string>>
    expect(rows[0].image).toBe('https://2f.zol-img.com.cn/product/276.png')
  })
})

// 「手机该去哪份产品库、按哪几档问」是这个站的事实，住在 recipe 的 `meta.catalog` 里；
// 宿主（`src/agent/purchase/universe-catalog.ts`）只读这张表、不认识任何站。
// 这几条钉的是**宿主读到的样子**：声明一写错，购买决策的手机品类会静默掉进发现循环。
describe('zol-phones 的产品库声明', () => {
  const index = () => catalogsOf(new Map([['@streamapp/zol/zol-phones', recipe()]]))

  it('声明合法，宿主读得到', () => {
    const r = index()
    expect(r.problems).toEqual([])
    expect(r.catalogs).toHaveLength(1)
  })

  it('手机品类挑中它', () => {
    expect(pickCatalog(index().catalogs, ['手机'])?.sourceId).toBe('@streamapp/zol/zol-phones')
    expect(pickCatalog(index().catalogs, ['扫地机器人'])).toBeUndefined()
  })

  it('价格是站上固定的四档，按参数 price 问', () => {
    const c = index().catalogs[0]!
    expect(c.param).toBe('price')
    expect(pickBands(c.bands!, {})).toEqual(['0', '2000', '4600', '7600'])
    // 5000 以内：4600 档跨过 5000×1.2 的标价上限，要一起取
    expect(pickBands(c.bands!, { max: 5000 })).toEqual(['0', '2000', '4600'])
  })

  it('每档只翻 3 页，所以不许声明 exhaustive——取回的是样本不是全集', () => {
    expect(index().catalogs[0]!.exhaustive).toBe(false)
    // `recipe()` 为了测试把翻页压成 1 页，这里读原文
    const raw = JSON.parse(readFileSync(join(repoRoot, 'packages', 'zol', 'zol-phones.recipe.json'), 'utf8'))
    expect(raw.pagination.maxPages).toBe(3)
  })

  it('params_schema 声明的参数就是产品库按档问的那个参数', () => {
    const c = index().catalogs[0]!
    expect(Object.keys(recipe().meta?.params_schema ?? {})).toContain(c.param)
  })
})
