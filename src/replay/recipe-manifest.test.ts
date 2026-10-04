import { describe, it, expect } from 'vitest'
import { recipeToManifest } from './recipe-manifest.ts'
import type { Recipe, RecipeMeta } from './recipe.ts'

// recipeToManifest reads only sourceId + meta; the rest of the recipe body is
// irrelevant to the projection, so a minimal cast keeps the tests focused.
function recipe(meta?: RecipeMeta, sourceId = 'demo'): Recipe {
  return {
    version: 1, kind: 'browser', sourceId, cookieDomain: 'x.com', entryUrl: 'https://x.com/',
    loginCheck: { loggedIn: '.me', wall: '.wall' }, actions: [],
    harvest: { mode: 'dom', itemSelector: '.c', fields: { id: { selector: 'a', attr: 'href' } }, dedupeBy: 'id', targetCount: 2 },
    meta,
  } as unknown as Recipe
}

/** 这些用例关心的是 meta 怎么投影，不是命名空间；统一用同一个包名前缀。
 *  全名由宿主用包的 npm 名合成（见 registry/source-id.ts）。 */
const NS = '@t/demo-pkg'
const toManifest = (r: Recipe, facility: string, ns = NS) => recipeToManifest(r, facility, ns)

describe('recipeToManifest', () => {
  it('bare recipe → schema-valid manifest with derived defaults', () => {
    const m = toManifest(recipe(), 'demo-fac')
    expect(m).toMatchObject({
      id: '@t/demo-pkg/demo',
      adapter: 'replay',
      type: 'post',
      capabilities: ['timeline'],
      auth: { type: 'none' }, // replay ignores auth; none is the safe display default
      example_queries: [],
      categories: [],
      topics: [],
      cadence_hint_seconds: 172800, // recipe 未声明 hint 时的默认采集周期（2d）
      discoverable: true,
      facility: { key: 'demo-fac', label: 'demo-fac' },
    })
    expect(m.description).toContain('demo-fac') // placeholder derived from the facility label
  })

  it('meta fields flow into the manifest', () => {
    const m = toManifest(
      recipe({ description: '雪球 — 用户动态', categories: ['finance'], capabilities: ['timeline'], cadence_hint_seconds: 600 }),
      'xueqiu',
    )
    expect(m.description).toBe('雪球 — 用户动态')
    expect(m.categories).toEqual(['finance'])
    expect(m.cadence_hint_seconds).toBe(600)
  })

  // 榜单/名册型 recipe 的存储语义。漏投影时不会报错，只会静默把一份有界名单当成无界时间线
  // （增量 + 滑窗、还灌进收件箱主流），所以由测试钉住而不是靠 review。
  it('meta.mode 投影成 manifest.mode；不声明就不带该字段（由 scheduler 现场判定）', () => {
    expect(toManifest(recipe({ mode: 'collection' }), 'demo-fac').mode).toBe('collection')
    expect(toManifest(recipe(), 'demo-fac').mode).toBeUndefined()
  })

  it('meta.radar → radar (structured) + matchers (flattened)', () => {
    const m = toManifest(recipe({ description: 'x', radar: ['xueqiu.com/u/:id'] }), 'xueqiu')
    expect(m.radar).toEqual([{ source: ['xueqiu.com/u/:id'] }])
    expect(m.matchers).toEqual(['xueqiu.com/u/:id'])
  })

  it('auth defaults to none, but meta overrides it', () => {
    expect(toManifest(recipe(), 'f').auth).toEqual({ type: 'none' })
    const m = toManifest(recipe({ description: 'x', auth: { type: 'token', name: 'X' } }), 'f')
    expect(m.auth).toEqual({ type: 'token', name: 'X' })
  })

  it('malformed meta fails loud, naming the source', () => {
    expect(() => toManifest(recipe({ cadence_hint_seconds: -5 }), 'f')).toThrow(/demo/)
    expect(() => toManifest(recipe({ cadence_hint_seconds: -5 }), 'f')).toThrow(/cadence_hint_seconds/)
  })

  // Minor 5/6: `meta.action` 是 run_action_recipe 的权限开关（只有 === true 才能被跑），但这份
  // schema 此前 non-strict 且没把 action 收进 shape 里——一条写错类型的 recipe（比如手滑写成
  // `"action": "true"` 字符串）会在装载期被静默放过，`recipe.meta?.action === true` 在运行时
  // 判它"不是动作"（=== 比较对字符串永远是 false），而不是在加载期就报错点名。这条钉住
  // "写错类型必须在加载期就炸"，不是留到 run_action_recipe 运行时才悄悄拒绝。
  it('meta.action 类型不对（字符串而非布尔）→ 加载期就报错点名，不是静默放过', () => {
    expect(() => toManifest(recipe({ action: 'true' } as unknown as RecipeMeta), 'f')).toThrow(/demo/)
    expect(() => toManifest(recipe({ action: 'true' } as unknown as RecipeMeta), 'f')).toThrow(/action/)
  })

  // recipe 里写的是**局部名**，全名（`<npm 包名>/<局部名>`）在投影这一步合成——
  // 这是「装载期加前缀」那条边界唯一的落点，包作者的文件里一个包名都不出现。
  it('id = <包名>/<recipe 里写的局部名>', () => {
    expect(toManifest(recipe(undefined, 'xhs-home'), 'xhs', '@streamapp/xhs').id).toBe('@streamapp/xhs/xhs-home')
    expect(toManifest(recipe(undefined, 'fetch-url'), 'b', 'local/evil').id).toBe('local/evil/fetch-url')
  })

  it('http object 输出投影成 manifest.output（items/缺省不带该字段）', () => {
    const probe = {
      version: 1, kind: 'http', sourceId: 'probe', output: 'object',
      request: { url: 'https://x.com/a', method: 'GET' }, assert: [],
    } as unknown as Recipe
    expect(toManifest(probe, 'f').output).toBe('object')
    expect(toManifest(recipe(), 'f').output).toBeUndefined()
  })
})
