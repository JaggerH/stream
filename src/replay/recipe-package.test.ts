import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRecipePackages, mountRecipePackages, mergeRecipePackagesByFacility, DECLARATION_FIELDS, RECIPE_PACKAGE_SCHEMA_VERSION, USER_LAYER_SCAN, BUILTIN_LAYER_SCAN, OFFICIAL_SCOPE, TRUST_SIDECAR, readPackageTrust, servingPoliciesOf, retiredRoutesOf, providerDeclarationsOf, linkTableOf, rsshubNamespaceNormalizersOf, rsshubNoBrowserNamespacesOf, rsshubCookieEnvOf } from './recipe-package.ts'
import { makeRecipePackageStore } from './recipe-store.ts'
import { dirNameFor } from './recipe-install.ts'
import type { BrowserRecipe } from './recipe.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'recipe-pkg-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const RECIPE_JSON = JSON.stringify({
  version: 1, kind: 'browser', sourceId: 'demo-feed', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
  loginCheck: { loggedIn: '.me', wall: '.login-wall' },
  actions: [{ kind: 'scroll', dwell_s: [1, 2], maxTimes: 3, noProgressStop: 2 }],
  harvest: { urlPattern: '*/feed*', dedupeBy: 'id', itemsAt: 'data', targetCount: 2, mapping: { title: 't' }, assert: [] },
})

/** writes a minimal valid package under <base>/<facility>/ */
function writePkg(
  facility: string,
  over: {
    sourceId?: string
    schemaVersion?: number
    targetCount?: number
    manifestLines?: string[]
    /** skip manifests.yaml → the Source must be SYNTHESIZED from the recipe (recipeToManifest) */
    noManifests?: boolean
    /** embed a `meta` block in the recipe body → self-describing source */
    recipeMeta?: Record<string, unknown>
    /** stream.rateLimit —— 用于归并「取最严」测试 */
    rateLimit?: { burst: number; perMinute: number; maxWaitMs?: number }
    /** stream.name —— serving 策略的 label 从它来 */
    name?: string
    /** stream.serving */
    serving?: Array<{ match: string; hosts?: string[]; reason: string }>
    /** stream.retires */
    retires?: Record<string, string>
    /** stream.providers */
    providers?: Array<Record<string, unknown>>
    /** stream.trackUrl（迁移期别名，装载时翻译进 links） */
    trackUrl?: string[]
    /** stream.links */
    links?: Record<string, unknown>
    /** stream.rsshubNamespaces */
    rsshubNamespaces?: string[]
    /** stream.rsshubNoBrowserNamespaces */
    rsshubNoBrowserNamespaces?: string[]
    /** stream.rsshubCookieEnv */
    rsshubCookieEnv?: string
    /** root `name`（npm 包名）—— 默认 `@test/<facility>`；两层放不同包名时才传 */
    pkgName?: string
    /** root `version` —— 默认 `1.0.0`；归并「版本高者为准」测试用。传 `null` = 不写 version 字段。 */
    pkgVersion?: string | null
  } = {},
  base: string = dir,
) {
  const p = join(base, facility)
  mkdirSync(p, { recursive: true })
  const sourceId = over.sourceId ?? 'demo-feed'
  writeFileSync(join(p, 'package.json'), JSON.stringify({
    name: over.pkgName ?? `@test/${facility}`,
    ...(over.pkgVersion === null ? {} : { version: over.pkgVersion ?? '1.0.0' }),
    keywords: ['stream-recipe'],
    stream: {
      type: 'recipe',
      facility,
      schemaVersion: over.schemaVersion ?? RECIPE_PACKAGE_SCHEMA_VERSION,
      cookieDomain: 'x.com',
      author: 'tester',
      ...(over.rateLimit ? { rateLimit: over.rateLimit } : {}),
      ...(over.name ? { name: over.name } : {}),
      ...(over.serving ? { serving: over.serving } : {}),
      ...(over.retires ? { retires: over.retires } : {}),
      ...(over.providers ? { providers: over.providers } : {}),
      ...(over.trackUrl ? { trackUrl: over.trackUrl } : {}),
      ...(over.links ? { links: over.links } : {}),
      ...(over.rsshubNamespaces ? { rsshubNamespaces: over.rsshubNamespaces } : {}),
      ...(over.rsshubNoBrowserNamespaces ? { rsshubNoBrowserNamespaces: over.rsshubNoBrowserNamespaces } : {}),
      ...(over.rsshubCookieEnv ? { rsshubCookieEnv: over.rsshubCookieEnv } : {}),
    },
  }))
  // A schema-valid manifest per the shared manifestSchema (same bar as plugin sources).
  // Deliberately omits example_queries → exercises the schema default. When present it is
  // a FULL OVERRIDE; skip it (noManifests) to force synthesis from the recipe.
  if (!over.noManifests) {
    writeFileSync(join(p, 'manifests.yaml'), [
      `- id: ${sourceId}`,
      '  adapter: replay',
      '  description: demo feed for the recipe-package loader test',
      '  topics: []',
      '  capabilities: [timeline]',
      '  cadence_hint_seconds: 1800',
      '  auth:',
      '    type: none',
      ...(over.manifestLines ?? []),
    ].join('\n'))
  }
  const recipeObj = JSON.parse(RECIPE_JSON.replace('"demo-feed"', `"${sourceId}"`))
  recipeObj.harvest.targetCount = over.targetCount ?? 2
  if (over.recipeMeta) recipeObj.meta = over.recipeMeta
  writeFileSync(join(p, `${sourceId}.recipe.json`), JSON.stringify(recipeObj))
}

/** writePkg 的包名是 `@test/<facility>`，所以它出的全名长这样。recipe 文件里写的仍是局部名。 */
const fq = (facility: string, sourceId = 'demo-feed') => `@test/${facility}/${sourceId}`

describe('loadRecipePackages', () => {
  it('loads a package: descriptor fields + manifests + recipes keyed by 全名', () => {
    writePkg('demo')
    const { descriptors, recipes } = loadRecipePackages(dir)
    expect(descriptors).toHaveLength(1)
    expect(descriptors[0]).toMatchObject({ facility: 'demo', cookieDomain: 'x.com' })
    expect(descriptors[0].sources[0]).toMatchObject({ id: fq('demo'), adapter: 'replay' })
    // 键是全名，而 recipe **正文里的 sourceId 仍是局部名**——前缀是宿主合成的，不写进文件。
    expect(recipes.get(fq('demo'))).toMatchObject({ kind: 'browser', sourceId: 'demo-feed' })
  })

  it('refuses (loud, not silent) a package whose schemaVersion is newer than supported', () => {
    writePkg('future', { schemaVersion: RECIPE_PACKAGE_SCHEMA_VERSION + 1 })
    expect(() => loadRecipePackages(dir)).toThrow(/schemaVersion|升级/i)
    expect(() => loadRecipePackages(dir)).toThrow(/future/)
  })

  // §9.1-① / ⑤：命名空间化把「跨包重名」从冲突变成常态，只留下同包内那一半。
  it('两个包各有一个同名 recipe → 装载成功，两条全名并存', () => {
    writePkg('a')
    writePkg('b') // same local sourceId demo-feed
    const { recipes, descriptors } = loadRecipePackages(dir)
    expect([...recipes.keys()].sort()).toEqual([fq('a'), fq('b')])
    expect(descriptors.flatMap((d) => d.sources.map((s) => s.id)).sort()).toEqual([fq('a'), fq('b')])
  })

  it('同一个包里两个文件写同一个局部名 → 仍然抛（它们会合成出同一个全名，后一份静默盖掉前一份）', () => {
    writePkg('demo')
    // 同一个 sourceId，第二个文件名不同
    writeFileSync(join(dir, 'demo', 'twin.recipe.json'), RECIPE_JSON)
    expect(() => loadRecipePackages(dir)).toThrow(/demo-feed/)
  })

  it('refuses (loud) a leftover flat yaml at the top level, but ignores other flat files', () => {
    // 统一扫描器的立场：顶层残留的 *.yaml 是迁移遗漏 —— 静默忽略会让人以为它还生效。
    // 其他扁平文件（旧的 <facility>.json 单体 recipe 等）照旧跳过，不是包。
    writeFileSync(join(dir, 'legacy.json'), '{}')
    writePkg('demo')
    expect(loadRecipePackages(dir).descriptors).toHaveLength(1)
    writeFileSync(join(dir, 'legacy.yaml'), 'id: old\n')
    expect(() => loadRecipePackages(dir)).toThrow(/legacy\.yaml/)
  })

  it("leftovers: 'ignore' → 用户数据目录里的无关 yaml 不再拖垮整次加载", () => {
    // 用户数据目录不是仓库：往里放一个无关的 .yaml 不该让后端启动失败。
    writeFileSync(join(dir, 'my-notes.yaml'), 'anything: goes\n')
    writePkg('demo')
    expect(() => loadRecipePackages(dir)).toThrow(/my-notes\.yaml/)
    expect(loadRecipePackages(dir, { leftovers: 'ignore' }).descriptors).toHaveLength(1)
  })

  it("leftovers: 'ignore' 不吞 schemaVersion 上界那条信任边界", () => {
    writeFileSync(join(dir, 'stray.yaml'), 'x: 1\n')
    writePkg('future', { schemaVersion: RECIPE_PACKAGE_SCHEMA_VERSION + 1 })
    expect(() => loadRecipePackages(dir, { leftovers: 'ignore' })).toThrow(/schemaVersion/i)
  })

  it('skips subdirectories without package.json', () => {
    mkdirSync(join(dir, 'not-a-pkg'))
    writeFileSync(join(dir, 'not-a-pkg', 'readme.md'), 'hi')
    writePkg('demo')
    expect(loadRecipePackages(dir).descriptors).toHaveLength(1)
  })

  it('reads name/version from package.json root', () => {
    writePkg('foo')
    const { descriptors } = loadRecipePackages(dir)
    expect(descriptors[0].name).toBe('@test/foo')
    expect(descriptors[0].version).toBe('1.0.0')
  })

  it('skips directories without package.json (legacy package.yaml no longer recognized)', () => {
    mkdirSync(join(dir, 'stray'), { recursive: true })
    writeFileSync(join(dir, 'stray', 'package.yaml'), 'type: recipe\nfacility: x\nschemaVersion: 1\n')
    expect(loadRecipePackages(dir).descriptors).toHaveLength(0)
  })

  it('rejects package.json without a stream field', () => {
    mkdirSync(join(dir, 'bad'), { recursive: true })
    writeFileSync(join(dir, 'bad', 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }))
    expect(() => loadRecipePackages(dir)).toThrow(/stream/)
  })

  it('missing dir → empty result (first run)', () => {
    const { descriptors, recipes } = loadRecipePackages(join(dir, 'nope'))
    expect(descriptors).toEqual([])
    expect(recipes.size).toBe(0)
  })

  it('an invalid recipe body fails validation with the file named', () => {
    writePkg('demo')
    writeFileSync(join(dir, 'demo', 'broken.recipe.json'), JSON.stringify({ kind: 'browser', sourceId: 'broken' }))
    expect(() => loadRecipePackages(dir)).toThrow(/broken/)
  })

  it('runs manifests through the shared manifestSchema: omitted example_queries defaults to []', () => {
    // Regression: recipe manifests used to be raw-cast (not validated), so an omitted
    // example_queries reached the registry as undefined → publicSourceDetail did
    // `m.example_queries[0]` → 500. It must default to [] like every plugin source does.
    writePkg('demo')
    const { descriptors } = loadRecipePackages(dir)
    expect(descriptors[0].sources[0].example_queries).toEqual([])
  })

  it('preserves matchers + homepage on recipe manifests (load-bearing for radar resolve)', () => {
    writePkg('demo', { manifestLines: ['  matchers: [x.com/u/:id]', '  homepage: x.com'] })
    const src = loadRecipePackages(dir).descriptors[0].sources[0]
    expect(src.matchers).toEqual(['x.com/u/:id'])
    expect(src.homepage).toBe('x.com')
  })

  it('refuses (loud, package named) a manifest that fails the schema', () => {
    // capabilities is required (min 1) — a manifest without it must fail loud at load,
    // not silently enter the registry and blow up later at detail-fetch.
    writePkg('demo', { manifestLines: [] })
    writeFileSync(join(dir, 'demo', 'manifests.yaml'), ['- id: bad', '  adapter: replay', '  description: no capabilities here', '  auth:', '    type: none', '  cadence_hint_seconds: 60'].join('\n'))
    expect(() => loadRecipePackages(dir)).toThrow(/demo/)
    expect(() => loadRecipePackages(dir)).toThrow(/capabilities/i)
  })

  it('synthesizes a Source from a manifest-less recipe via its meta block', () => {
    // The self-service path: an agent drops a recipe with a meta block, no manifests.yaml.
    writePkg('demo', { noManifests: true, recipeMeta: { description: '雪球 用户动态', categories: ['finance'], radar: ['xueqiu.com/u/:id'] } })
    const src = loadRecipePackages(dir).descriptors[0].sources[0]
    expect(src).toMatchObject({ id: fq('demo'), adapter: 'replay', capabilities: ['timeline'], auth: { type: 'none' } })
    expect(src.description).toBe('雪球 用户动态')
    expect(src.matchers).toEqual(['xueqiu.com/u/:id'])
  })

  it('meta passthrough: title/normalizer/provides/homepage/effects reach the synthesized manifest', () => {
    writePkg('demo', { noManifests: true, recipeMeta: {
      title: 'T', normalizer: 'xhs', provides: ['search-content'],
      homepage: 'example.com', effects: ['write'],
    } })
    const m = loadRecipePackages(dir).descriptors[0].sources[0]
    expect(m.title).toBe('T')
    expect(m.normalizer).toBe('xhs')
    expect(m.provides).toEqual(['search-content'])
    expect(m.homepage).toBe('example.com')
    expect((m as { effects?: string[] }).effects).toEqual(['write'])
  })

  it('a bare recipe (no meta, no manifests.yaml) still yields one valid Source', () => {
    writePkg('demo', { noManifests: true })
    const { descriptors } = loadRecipePackages(dir)
    expect(descriptors[0].sources).toHaveLength(1)
    expect(descriptors[0].sources[0]).toMatchObject({ id: fq('demo'), adapter: 'replay', example_queries: [] })
    expect(descriptors[0].sources[0].description.length).toBeGreaterThan(0) // placeholder from facility
  })

  it('a hand-written manifests.yaml entry fully overrides the synthesized manifest', () => {
    writePkg('demo', { recipeMeta: { description: 'FROM META' } })
    const src = loadRecipePackages(dir).descriptors[0].sources[0]
    expect(src.description).toBe('demo feed for the recipe-package loader test') // manifest wins over meta
  })

  it('accepts the new descriptor shape (no type field, id instead of facility key)', () => {
    const d2 = join(dir, 'newshape')
    mkdirSync(d2, { recursive: true })
    writeFileSync(
      join(d2, 'package.json'),
      JSON.stringify({ name: '@streamapp/newshape', version: '2.0.0', stream: { id: 'newshape', facility: 'newshape' } }),
    )
    writeFileSync(join(d2, 'demo.recipe.json'), RECIPE_JSON.replace('demo-feed', 'newshape-feed'))
    const { descriptors, recipes } = loadRecipePackages(dir)
    expect(descriptors.map((p) => p.facility)).toContain('newshape')
    expect(recipes.has('@streamapp/newshape/newshape-feed')).toBe(true)
  })

  it('包里有 states.json → 读进 descriptors[].states；id 必须带 <facility>/ 前缀', () => {
    writePkg('xhs')
    writeFileSync(join(dir, 'xhs', 'states.json'), JSON.stringify({
      states: [{ id: 'xhs/results', features: [{ kind: 'dom', selector: '.note' }] }],
      transitions: [],
    }))
    const { descriptors } = loadRecipePackages(dir, USER_LAYER_SCAN)
    expect(descriptors[0]!.states?.states.map((s) => s.id)).toEqual(['xhs/results'])
  })

  it('没有 states.json → 缺席（undefined），不是空图', () => {
    writePkg('xhs')
    const { descriptors } = loadRecipePackages(dir, USER_LAYER_SCAN)
    expect(descriptors[0]!.states).toBeUndefined()
  })

  it('states.json 非法（特征为空 / 前缀不对 / 不是 JSON）→ 拒这个包，报文件名', () => {
    writePkg('xhs')
    const p = join(dir, 'xhs', 'states.json')
    writeFileSync(p, JSON.stringify({ states: [{ id: 'other/x', features: [] }], transitions: [] }))
    expect(() => loadRecipePackages(dir, USER_LAYER_SCAN)).toThrow(/states\.json/)
    // 前缀对了但特征为空 —— 一张半对的图比没有更坏（identify 会静默认错）
    writeFileSync(p, JSON.stringify({ states: [{ id: 'xhs/x', features: [] }], transitions: [] }))
    expect(() => loadRecipePackages(dir, USER_LAYER_SCAN)).toThrow(/states\.json/)
    writeFileSync(p, '{ not json')
    expect(() => loadRecipePackages(dir, USER_LAYER_SCAN)).toThrow(/states\.json/)
  })
})

describe('mountRecipePackages', () => {
  const builtin = () => join(dir, 'builtin')
  const user = () => join(dir, 'user')

  it('merges builtin + user packages into one manifest list + recipe map', () => {
    writePkg('demo', {}, builtin())
    writePkg('other', { sourceId: 'other-feed' }, user())
    const { manifests, recipes } = mountRecipePackages(builtin(), user())
    expect(manifests.map((m) => m.id).sort()).toEqual([fq('demo'), fq('other', 'other-feed')].sort())
    expect(recipes.size).toBe(2)
  })

  // 同一个 npm 名的两层 → 整包只装版本高的那一层（`pickLayers`）。用户从 npm 装 `@streamapp/xhs`
  // 的新版顶掉内置那个 `@streamapp/xhs`，是这条线一直支持的升级路径；反过来装了旧版就整包跳过。
  // 不按 id 逐条覆盖：内置包的 `manifests.yaml` 另有一条 curated 路进 registry，逐条覆盖管不到它。
  describe('同 npm 名两层都在 → 只装版本高的那一层的一切（manifests + recipes）', () => {
    it('用户层严格更高 → manifests / recipes 恰是用户层那套，内置一条不进；id 仍自报内置（裸名歧义靠它判胜者）', () => {
      writePkg('demo', { targetCount: 2, pkgVersion: '1.0.0' }, builtin())
      writePkg('demo', { targetCount: 9, pkgVersion: '9.9.9' }, user())
      const { manifests, recipes, builtinIds, byPackage, pick } = mountRecipePackages(builtin(), user())
      expect(manifests.map((m) => m.id)).toEqual([fq('demo')])   // 恰一份，不重复、没有内置那份
      expect((recipes.get(fq('demo')) as BrowserRecipe).harvest.targetCount).toBe(9)
      expect(byPackage.map((p) => p.dir)).toEqual([join(user(), 'demo')])   // 内置那个包目录根本不在装载名单里
      expect([...builtinIds]).toEqual([fq('demo')])   // 新版就是内置包本身，站到内置的位置上
      expect([...pick.skipBuiltinNames]).toEqual(['@test/demo'])
    })

    it('用户层更低 → 内置那套是唯一的一套，用户层整包跳过（不是"同 id 覆盖"）', () => {
      writePkg('demo', { targetCount: 2, pkgVersion: '1.2.0' }, builtin())
      writePkg('demo', { targetCount: 9, pkgVersion: '1.1.9' }, user())
      const { manifests, recipes, byPackage, builtinIds, pick } = mountRecipePackages(builtin(), user())
      expect(manifests.map((m) => m.id)).toEqual([fq('demo')])
      expect((recipes.get(fq('demo')) as BrowserRecipe).harvest.targetCount).toBe(2)
      expect(byPackage.map((p) => p.dir)).toEqual([join(builtin(), 'demo')])
      expect([...builtinIds]).toEqual([fq('demo')])
      expect([...pick.skipUserNames]).toEqual(['@test/demo'])
    })

    it('版本相等 → 内置（同上一条）', () => {
      writePkg('demo', { targetCount: 2 }, builtin())
      writePkg('demo', { targetCount: 9 }, user())
      const { recipes, byPackage } = mountRecipePackages(builtin(), user())
      expect((recipes.get(fq('demo')) as BrowserRecipe).harvest.targetCount).toBe(2)
      expect(byPackage).toHaveLength(1)
    })

    it('输的那层里的坏 recipe 不报（它本来就不装）；赢的那层照常', () => {
      writePkg('demo', { pkgVersion: '1.0.0' }, builtin())
      writePkg('demo', { pkgVersion: '9.9.9' }, user())
      writeFileSync(join(builtin(), 'demo', 'broken.recipe.json'), '{not json')
      const errors: string[] = []
      const { manifests } = mountRecipePackages(builtin(), user(), (dir) => errors.push(dir))
      expect(errors).toEqual([])
      expect(manifests.map((m) => m.id)).toEqual([fq('demo')])
    })

    it('pick 冻住（热重载）：新出现的同名新版若顶掉的内置有 curated → 这一轮不装、进 deferred；两层各自照旧；只报新对的日志', () => {
      writePkg('demo', { targetCount: 2, pkgVersion: '1.0.0' }, builtin())
      writePkg('known', { sourceId: 'k-feed', pkgVersion: '1.0.0' }, builtin())
      writePkg('demo', { targetCount: 9, pkgVersion: '9.9.9' }, user())
      writePkg('known', { sourceId: 'k-feed', pkgVersion: '9.9.9' }, user())
      const logs: string[] = []
      const frozen = { skipBuiltinNames: new Set(['@test/known']), skipUserNames: new Set<string>() }
      const m = mountRecipePackages(builtin(), user(), undefined, {
        pick: frozen, log: (l) => logs.push(l), builtinHasCurated: (name) => name === '@test/demo',
      })
      expect(m.deferred).toEqual(['@test/demo'])
      expect((m.recipes.get(fq('demo')) as BrowserRecipe).harvest.targetCount).toBe(2)   // 内置那份仍在
      expect(m.byPackage.map((p) => p.dir).sort()).toEqual([join(builtin(), 'demo'), join(user(), 'known')].sort())
      expect(m.pick.skipBuiltinNames).toBe(frozen.skipBuiltinNames)
      expect(logs).toEqual(['[stream] package @test/demo: user layer 9.9.9 supersedes builtin 1.0.0'])   // known 不再报
    })

    it('pick 冻住、顶掉的内置没有 curated → 照常两层都装（同全名用户层盖）、不进 deferred', () => {
      writePkg('demo', { targetCount: 2, pkgVersion: '1.0.0' }, builtin())
      writePkg('demo', { targetCount: 9, pkgVersion: '9.9.9' }, user())
      const m = mountRecipePackages(builtin(), user(), undefined, {
        pick: { skipBuiltinNames: new Set(), skipUserNames: new Set() }, builtinHasCurated: () => false,
      })
      expect(m.deferred).toEqual([])
      expect((m.recipes.get(fq('demo')) as BrowserRecipe).harvest.targetCount).toBe(9)
      expect(m.manifests.map((x) => x.id)).toEqual([fq('demo')])
    })

    it('pick 冻住时用户层输了的那侧仍现算剔除（剔用户层永远不会撞 curated）', () => {
      writePkg('demo', { targetCount: 2, pkgVersion: '2.0.0' }, builtin())
      writePkg('demo', { targetCount: 9, pkgVersion: '1.0.0' }, user())
      const m = mountRecipePackages(builtin(), user(), undefined, { pick: { skipBuiltinNames: new Set(), skipUserNames: new Set() } })
      expect((m.recipes.get(fq('demo')) as BrowserRecipe).harvest.targetCount).toBe(2)
      expect(m.byPackage).toHaveLength(1)
    })

    it('顶掉的内置被禁用（supersededBuiltinDisabled）→ 用户层那份也不装，开关照样生效', () => {
      writePkg('demo', { pkgVersion: '1.0.0' }, builtin())
      writePkg('demo', { pkgVersion: '9.9.9' }, user())
      const m = mountRecipePackages(builtin(), user(), undefined, { supersededBuiltinDisabled: (name) => name === '@test/demo' })
      expect(m.manifests).toEqual([])
      expect(m.recipes.size).toBe(0)
      expect([...m.pick.skipBuiltinNames]).toEqual(['@test/demo'])   // 谁高照旧按版本判，禁用只管装不装
    })

    it('不同 npm 名（第三方给同一个 facility 的附加包）→ 两层都装', () => {
      writePkg('demo', { pkgVersion: '1.0.0' }, builtin())
      writePkg('demo', { sourceId: 'extra-feed', pkgName: '@third/demo-extra', pkgVersion: '9.9.9' }, user())
      const { manifests, byPackage } = mountRecipePackages(builtin(), user())
      expect(manifests.map((m) => m.id).sort()).toEqual([fq('demo'), '@third/demo-extra/extra-feed'].sort())
      expect(byPackage).toHaveLength(2)
    })
  })

  // 反面：包名不同就**不再互相盖**——那不是特性，那正是这次要消灭的问题本体。
  it('两层不同包名、同局部名 → 并存，谁也不盖谁', () => {
    writePkg('a', {}, builtin())
    writePkg('b', {}, user())
    const { manifests, builtinIds } = mountRecipePackages(builtin(), user())
    expect(manifests.map((m) => m.id).sort()).toEqual([fq('a'), fq('b')])
    expect([...builtinIds]).toEqual([fq('a')])
  })

  it('stamps the package facility onto manifests that lack one', () => {
    writePkg('demo', {}, builtin())
    const { manifests } = mountRecipePackages(builtin(), user())
    expect(manifests[0].facility).toEqual({ key: 'demo', label: 'demo' })
  })

  it('missing dirs → empty mount (first run)', () => {
    const { manifests, recipes } = mountRecipePackages(builtin(), user())
    expect(manifests).toEqual([])
    expect(recipes.size).toBe(0)
  })

  it('用户目录里的无关 yaml 不影响挂载，仓库自带那层照旧大声拒绝', () => {
    writePkg('demo', {}, builtin())
    writePkg('other', { sourceId: 'other-feed' }, user())
    writeFileSync(join(user(), 'my-notes.yaml'), 'anything: goes\n')
    expect(mountRecipePackages(builtin(), user()).manifests.map((m) => m.id).sort())
      .toEqual([fq('demo'), fq('other', 'other-feed')].sort())
    expect(mergeRecipePackagesByFacility(builtin(), user()).list.map((d) => d.facility).sort())
      .toEqual(['demo', 'other'])

    writeFileSync(join(builtin(), 'leftover.yaml'), 'id: old\n')
    expect(() => mountRecipePackages(builtin(), user())).toThrow(/leftover\.yaml/)
    expect(() => mergeRecipePackagesByFacility(builtin(), user())).toThrow(/leftover\.yaml/)
  })

  // 启动路径专用的那档（spec 2026-08-29 §8）：**不给 onPackageError 照旧整层抛**——
  // 安装期和热重载各有自己的接法，那两条不能被这一档静默放行。
  it('onPackageError：坏包报一条、跳过，其余照常；不给就照旧整层抛', () => {
    writePkg('good', {}, user())
    const rotten = join(user(), 'rotten')
    mkdirSync(rotten, { recursive: true })
    writeFileSync(join(rotten, 'package.json'), JSON.stringify({ name: '@t/rotten', version: '1.0.0', stream: { facility: 'rotten' } }))
    writeFileSync(join(rotten, 'rotten-feed.recipe.json'), '{ "version": 1')   // 少一个括号

    expect(() => mountRecipePackages(builtin(), user())).toThrow(/rotten/)

    const bad: string[] = []
    const mounted = mountRecipePackages(builtin(), user(), (d, e) => void bad.push(`${d.split('/').pop()}: ${e.message}`))
    expect(mounted.manifests.map((m) => m.id)).toEqual([fq('good')])
    expect(mounted.byPackage.map((p) => p.dir.split('/').pop())).toEqual(['good'])
    expect(bad).toHaveLength(1)
    expect(bad[0]).toMatch(/^rotten: /)
  })

  // 跳过必须是干净的：坏包在半路抛，它前面已经解析出来的 recipe 不许留在全局表里——
  // 留下就是一份「查得到、但没有源指向它」的僵尸，而且会把后面同 id 的好包误判成撞名。
  it('跳过的包不留半份：它已解析的 recipe 不进 recipes 表', () => {
    const half = join(user(), 'half')
    mkdirSync(half, { recursive: true })
    writeFileSync(join(half, 'package.json'), JSON.stringify({ name: '@t/half', version: '1.0.0', stream: { facility: 'half' } }))
    writePkg('half', { sourceId: 'aaa-feed', noManifests: true }, user())   // 写进同一个目录：一好一坏
    writeFileSync(join(half, 'zzz-feed.recipe.json'), '{ "version": 1')

    const mounted = mountRecipePackages(builtin(), user(), () => {})
    expect(mounted.recipes.has('aaa-feed')).toBe(false)
    expect(mounted.manifests).toEqual([])
  })
})

/** 两层各放一个同名包（builtin 用 `1.0.0`、user 用 `1.0.1` 仅作区分标记，测试不断言版本），
 *  各一条 `send.recipe.json`（kind:'http' 最简形状，照 recipe-manifest.test.ts 的 http/object 夹具抄）。
 *  用于 §OFFICIAL_SCOPE 覆盖测试：调用方按 npm 包名（如 `@streamapp/demo` / `@other/demo`）建两层。 */
function twoLayers(name: string) {
  const builtinDir = mkdtempSync(join(tmpdir(), 'scope-builtin-'))
  const userDir = mkdtempSync(join(tmpdir(), 'scope-user-'))
  const write = (base: string, version: string) => {
    const p = join(base, dirNameFor(name))
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'package.json'), JSON.stringify({
      name,
      version,
      stream: { type: 'recipe', facility: 'demo', schemaVersion: RECIPE_PACKAGE_SCHEMA_VERSION },
    }))
    writeFileSync(join(p, 'manifests.yaml'), [
      '- id: send',
      '  adapter: replay',
      '  description: demo send action for OFFICIAL_SCOPE test',
      '  topics: []',
      '  capabilities: [timeline]',
      '  cadence_hint_seconds: 1800',
      '  auth:',
      '    type: none',
    ].join('\n'))
    writeFileSync(join(p, 'send.recipe.json'), JSON.stringify({
      version: 1, kind: 'http', sourceId: 'send', output: 'object',
      request: { url: 'https://x.com/api/send', method: 'GET' }, assert: [],
    }))
  }
  write(builtinDir, '1.0.0')
  write(userDir, '1.0.1')
  return { builtinDir, userDir }
}

describe('mountRecipePackages · 官方 scope 的同名覆盖仍算内置（secret_params 闸 3）', () => {
  it('@streamapp/ 同名覆盖：builtinRecipeIds 保留该 id，且拿到的是用户层那份', () => {
    const { builtinDir, userDir } = twoLayers('@streamapp/demo')
    try {
      const m = mountRecipePackages(builtinDir, userDir)
      expect(m.builtinRecipeIds.has('@streamapp/demo/send')).toBe(true)
      expect(m.recipes.get('@streamapp/demo/send')).not.toBe(
        loadRecipePackages(builtinDir, BUILTIN_LAYER_SCAN).recipes.get('@streamapp/demo/send'),
      )
    } finally {
      rmSync(builtinDir, { recursive: true, force: true })
      rmSync(userDir, { recursive: true, force: true })
    }
  })

  it('@streamapp/ 同名覆盖但带「核不上官方源」旁注 → 照第三方摘掉', () => {
    const { builtinDir, userDir } = twoLayers('@streamapp/demo')
    try {
      writeFileSync(join(userDir, dirNameFor('@streamapp/demo'), TRUST_SIDECAR),
        JSON.stringify({ official: false, reason: '镜像上的 @streamapp/demo@1.0.1 与官方源校验和不一致' }))
      const m = mountRecipePackages(builtinDir, userDir)
      expect(m.builtinRecipeIds.has('@streamapp/demo/send')).toBe(false)
      // 包本身照常挂上——旁注只管凭据，不管能不能用。
      expect(m.recipes.has('@streamapp/demo/send')).toBe(true)
    } finally {
      rmSync(builtinDir, { recursive: true, force: true })
      rmSync(userDir, { recursive: true, force: true })
    }
  })

  it('readPackageTrust：没文件 = 官方；坏文件 = 不官方（只往低了错）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trust-'))
    try {
      expect(readPackageTrust(dir)).toEqual({ official: true })
      writeFileSync(join(dir, TRUST_SIDECAR), '{not json')
      expect(readPackageTrust(dir).official).toBe(false)
      writeFileSync(join(dir, TRUST_SIDECAR), JSON.stringify({ official: true }))
      expect(readPackageTrust(dir)).toEqual({ official: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@other/ 同名覆盖：id 被摘掉（第三方不拿凭据）', () => {
    const { builtinDir, userDir } = twoLayers('@other/demo')
    try {
      const m = mountRecipePackages(builtinDir, userDir)
      expect(m.builtinRecipeIds.has('@other/demo/send')).toBe(false)
    } finally {
      rmSync(builtinDir, { recursive: true, force: true })
      rmSync(userDir, { recursive: true, force: true })
    }
  })
})

describe('makeRecipePackageStore', () => {
  it('loads from the package map first, falls back to the file store', () => {
    writePkg('demo')
    const { recipes } = loadRecipePackages(dir)
    const fallback = { load: (id: string) => { throw new Error(`fallback miss: ${id}`) } }
    const store = makeRecipePackageStore(recipes, fallback)
    expect(store.load(fq('demo'))).toMatchObject({ sourceId: 'demo-feed', kind: 'browser' })
    expect(() => store.load('nope')).toThrow(/fallback miss: nope/)
  })

  it('unknown sourceId without a fallback throws a named error', () => {
    const store = makeRecipePackageStore(new Map())
    expect(() => store.load('ghost')).toThrow(/ghost/)
  })
})

// I-1 的回归锁：install 热挂载后 reloadRecipePackages 重跑 mergeRecipePackagesByFacility 重建
// byFacility 快照——旧实现只换 registry/liveRecipes，从不重建这份，导致新装包的 rateLimit 活体
// 读不到（重启前无限速采集，直击本分支核心安全承诺）。这里对纯函数验证：往 userDir 放一个新
// facility 包，重跑函数，其 rateLimit 必须出现在 byFacility 里。
describe('mergeRecipePackagesByFacility（I-1 热挂载重建快照）', () => {
  it('先 builtin-only → 往 userDir 放新 facility 包 → 重跑后新 facility 的 rateLimit 出现', () => {
    const builtinDir = mkdtempSync(join(tmpdir(), 'rp-builtin-'))
    const userDir = mkdtempSync(join(tmpdir(), 'rp-user-'))
    try {
      writePkg('demo', { rateLimit: { burst: 5, perMinute: 10 } }, builtinDir)

      // 起点：只有 builtin，userDir 里还没有 xhs 包
      const before = mergeRecipePackagesByFacility(builtinDir, userDir)
      expect(before.byFacility.has('xhs')).toBe(false)

      // 模拟 install：往 userDir 放一个带 rateLimit 的新 facility 包
      writePkg('xhs', { sourceId: 'xhs-home', rateLimit: { burst: 2, perMinute: 3, maxWaitMs: 9000 } }, userDir)

      // 重跑（= reloadRecipePackages 走的同一把尺）：新 facility 的 rateLimit 必须出现
      const after = mergeRecipePackagesByFacility(builtinDir, userDir)
      expect(after.byFacility.get('xhs')?.rateLimit).toEqual({ burst: 2, perMinute: 3, maxWaitMs: 9000 })
      expect(after.list.some((p) => p.facility === 'xhs')).toBe(true)
    } finally {
      rmSync(builtinDir, { recursive: true, force: true })
      rmSync(userDir, { recursive: true, force: true })
    }
  })

  it('同 facility 两层（不同 npm 名的附加包）都声明 rateLimit → 取最严（clampRateLimit）', () => {
    const builtinDir = mkdtempSync(join(tmpdir(), 'rp-builtin2-'))
    const userDir = mkdtempSync(join(tmpdir(), 'rp-user2-'))
    try {
      writePkg('xhs', { sourceId: 'xhs-b', rateLimit: { burst: 5, perMinute: 10 } }, builtinDir)
      writePkg('xhs', { sourceId: 'xhs-u', pkgName: '@third/xhs-extra', rateLimit: { burst: 2, perMinute: 30 } }, userDir)
      const { byFacility } = mergeRecipePackagesByFacility(builtinDir, userDir)
      // burst 取小(2)、perMinute 取小(10) —— user 层不能放宽 builtin 的闸门
      expect(byFacility.get('xhs')?.rateLimit).toMatchObject({ burst: 2, perMinute: 10 })
    } finally {
      rmSync(builtinDir, { recursive: true, force: true })
      rmSync(userDir, { recursive: true, force: true })
    }
  })
})

// 同 facility 的第三方 recipe 包合法：它叠加 recipe 与展示字段。**同 npm 名的两层先由 pickLayers 只留
// 版本高的一层**（用户层严格更高才是用户层，相等 / 更低 / 缺版本一律内置——内置随宿主同版本出货，
// 用户层那份可能是任何旧版，旧版少一格声明就是静默丢能力；内置包也发 npm，`stream update` 拿到的
// 新版本就是为了让用户不升宿主也能拿到新声明——所以新版必须赢、且赢的是整包）。到归并点撞上的
// 只剩**不同 npm 名**（第三方附加包）：版本号不可比，声明一律内置为准、用户层只叠加。
describe('mergeRecipePackagesByFacility（同 facility 两层：同 npm 名整包按版本取一层；不同 npm 名声明内置为准、叠加）', () => {
  const ROW = {
    id: 'xhs-note', category: 'resolve', serveKeys: ['xhs'], strategy: 'sequential',
    label: 'xhs 取笔记', description: 'd', members: [{ mode: 'auto', matches: 'xhs.com/note' }],
    callsites: ['music.track.resolve'],
  }
  let builtinDir: string
  let userDir: string
  beforeEach(() => {
    builtinDir = mkdtempSync(join(tmpdir(), 'rp-builtin3-'))
    userDir = mkdtempSync(join(tmpdir(), 'rp-user3-'))
  })
  afterEach(() => {
    rmSync(builtinDir, { recursive: true, force: true })
    rmSync(userDir, { recursive: true, force: true })
  })

  it('内置声明了 providers / serving / rsshubNoBrowserNamespaces，用户层同 facility 没声明 → 合并后仍是内置的', () => {
    writePkg('xhs', {
      sourceId: 'xhs-b', name: '小红书',
      providers: [ROW],
      serving: [{ match: 'xhscdn.com', reason: '直链 403' }],
      rsshubNoBrowserNamespaces: ['xiaohongshu'],
      rsshubNamespaces: ['xiaohongshu'],
    }, builtinDir)
    writePkg('xhs', { sourceId: 'xhs-u', pkgName: '@third/xhs-extra' }, userDir)
    const { byFacility, list } = mergeRecipePackagesByFacility(builtinDir, userDir)
    const xhs = byFacility.get('xhs')!
    expect(xhs.providers).toEqual([ROW])
    expect(xhs.serving?.map((s) => s.match)).toEqual(['xhscdn.com'])
    expect(xhs.rsshubNoBrowserNamespaces).toEqual(['xiaohongshu'])
    expect(xhs.rsshubNamespaces).toEqual(['xiaohongshu'])
    // 下游读表的口径也一样：Provider 行 / 送字节策略 / 目录命名空间都还在
    expect(providerDeclarationsOf(list).map((r) => r.declaration.id)).toEqual(['xhs-note'])
    expect(servingPoliciesOf(list).map((p) => p.match)).toEqual(['xhscdn.com'])
    expect([...rsshubNoBrowserNamespacesOf(list)]).toEqual(['xiaohongshu'])
  })

  it('两层都声明同一格、版本相等 → 内置为准，用户层那份不盖', () => {
    writePkg('xhs', { sourceId: 'xhs-b', serving: [{ match: 'new.cdn', reason: 'new' }], rsshubCookieEnv: 'XHS_COOKIE_{web_session}' }, builtinDir)
    writePkg('xhs', { sourceId: 'xhs-u', pkgName: '@third/xhs-old', serving: [{ match: 'old.cdn', reason: 'old' }], rsshubCookieEnv: 'XHS_OLD_{a1}' }, userDir)
    const xhs = mergeRecipePackagesByFacility(builtinDir, userDir).byFacility.get('xhs')!
    expect(xhs.serving?.map((s) => s.match)).toEqual(['new.cdn'])
    expect(xhs.rsshubCookieEnv).toBe('XHS_COOKIE_{web_session}')
  })

  it('用户层版本更低 → 内置为准（停更的旧包不许顶掉随宿主出货的声明）', () => {
    writePkg('xhs', { sourceId: 'xhs-b', pkgVersion: '1.4.0', providers: [ROW], serving: [{ match: 'new.cdn', reason: 'new' }] }, builtinDir)
    writePkg('xhs', { sourceId: 'xhs-u', pkgName: '@third/xhs-old', pkgVersion: '1.3.9', providers: [{ ...ROW, id: 'xhs-old' }], serving: [{ match: 'old.cdn', reason: 'old' }] }, userDir)
    const xhs = mergeRecipePackagesByFacility(builtinDir, userDir).byFacility.get('xhs')!
    expect(xhs.providers).toEqual([ROW])
    expect(xhs.serving?.map((s) => s.match)).toEqual(['new.cdn'])
  })

  it('同 npm 名、用户层版本严格更高 → 用户层为准（stream update 就是靠这条把新声明送到手）', () => {
    writePkg('xhs', { sourceId: 'xhs-b', pkgName: '@streamapp/xhs', pkgVersion: '1.0.0', providers: [ROW], serving: [{ match: 'old.cdn', reason: 'old' }], rsshubCookieEnv: 'XHS_OLD_{a1}' }, builtinDir)
    const NEW_ROW = { ...ROW, id: 'xhs-note-v2' }
    writePkg('xhs', { sourceId: 'xhs-u', pkgName: '@streamapp/xhs', pkgVersion: '1.1.0', providers: [NEW_ROW], serving: [{ match: 'new.cdn', reason: 'new' }], rsshubCookieEnv: 'XHS_COOKIE_{web_session}' }, userDir)
    const { byFacility, list } = mergeRecipePackagesByFacility(builtinDir, userDir)
    const xhs = byFacility.get('xhs')!
    expect(xhs.providers).toEqual([NEW_ROW])
    expect(xhs.serving?.map((s) => s.match)).toEqual(['new.cdn'])
    expect(xhs.rsshubCookieEnv).toBe('XHS_COOKIE_{web_session}')
    expect(providerDeclarationsOf(list).map((r) => r.declaration.id)).toEqual(['xhs-note-v2'])
  })

  it('不同 npm 名、用户层版本更高 → 仍内置为准（不同包的版本号不可比；第三方附加包只叠加）', () => {
    writePkg('xhs', { sourceId: 'xhs-b', pkgName: '@streamapp/xhs', pkgVersion: '1.0.0', providers: [ROW], serving: [{ match: 'b.cdn', reason: 'b' }] }, builtinDir)
    writePkg('xhs', { sourceId: 'xhs-u', pkgName: '@third/xhs-extra', pkgVersion: '5.0.0', providers: [{ ...ROW, id: 'third' }], serving: [{ match: 'u.cdn', reason: 'u' }], links: { hosts: ['xhs-note.com'] } }, userDir)
    const xhs = mergeRecipePackagesByFacility(builtinDir, userDir).byFacility.get('xhs')!
    expect(xhs.providers).toEqual([ROW])
    expect(xhs.serving?.map((s) => s.match)).toEqual(['b.cdn'])
    expect(xhs.links?.hosts).toEqual([{ host: 'xhs-note.com', platform: 'xhs' }])   // 内置没声明的格照样叠加
  })

  it('同 npm 名、用户层更高但没声明内置声明过的格 → 内置整包不装，那格随之消失（新版少一格 = 作者删的，不是旧版丢能力）', () => {
    writePkg('xhs', { sourceId: 'xhs-b', pkgName: '@streamapp/xhs', pkgVersion: '1.0.0', providers: [ROW], rsshubNoBrowserNamespaces: ['xiaohongshu'] }, builtinDir)
    writePkg('xhs', { sourceId: 'xhs-u', pkgName: '@streamapp/xhs', pkgVersion: '2.0.0', serving: [{ match: 'new.cdn', reason: 'new' }] }, userDir)
    const { byFacility, list } = mergeRecipePackagesByFacility(builtinDir, userDir)
    const xhs = byFacility.get('xhs')!
    expect(xhs.version).toBe('2.0.0')
    expect(xhs.providers).toBeUndefined()
    expect(xhs.rsshubNoBrowserNamespaces).toBeUndefined()
    expect(xhs.serving?.map((s) => s.match)).toEqual(['new.cdn'])
    expect(xhs.sources.map((m) => m.id)).toEqual(['@streamapp/xhs/xhs-u'])   // 内置那层的 source 也不在并集里
    expect(list).toHaveLength(1)
  })

  it('同 npm 名、用户层更低 → 用户层整包不装：声明 / sources 全是内置的', () => {
    writePkg('xhs', { sourceId: 'xhs-b', pkgName: '@streamapp/xhs', pkgVersion: '2.0.0', providers: [ROW] }, builtinDir)
    writePkg('xhs', { sourceId: 'xhs-u', pkgName: '@streamapp/xhs', pkgVersion: '1.0.0', serving: [{ match: 'old.cdn', reason: 'old' }] }, userDir)
    const xhs = mergeRecipePackagesByFacility(builtinDir, userDir).byFacility.get('xhs')!
    expect(xhs.version).toBe('2.0.0')
    expect(xhs.providers).toEqual([ROW])
    expect(xhs.serving).toBeUndefined()
    expect(xhs.sources.map((m) => m.id)).toEqual(['@streamapp/xhs/xhs-b'])
  })

  it('用户层缺 version / 版本不合法 → 内置为准（看不懂的版本号不许赢）', () => {
    writePkg('xhs', { sourceId: 'xhs-b', pkgVersion: '1.0.0', serving: [{ match: 'new.cdn', reason: 'new' }] }, builtinDir)
    writePkg('xhs', { sourceId: 'xhs-u', pkgName: '@third/xhs-nover', pkgVersion: null, serving: [{ match: 'old.cdn', reason: 'old' }] }, userDir)
    expect(mergeRecipePackagesByFacility(builtinDir, userDir).byFacility.get('xhs')!.serving?.map((s) => s.match)).toEqual(['new.cdn'])

    rmSync(join(userDir, 'xhs'), { recursive: true, force: true })
    writePkg('xhs', { sourceId: 'xhs-u', pkgName: '@third/xhs-badver', pkgVersion: 'v9.9.9', serving: [{ match: 'old.cdn', reason: 'old' }] }, userDir)
    expect(mergeRecipePackagesByFacility(builtinDir, userDir).byFacility.get('xhs')!.serving?.map((s) => s.match)).toEqual(['new.cdn'])
  })

  it('预发布：用户层 1.1.0-beta.1 高于内置 1.0.0 → 用户层；内置 1.1.0 正式版高于用户层 1.1.0-beta.1 → 内置', () => {
    writePkg('xhs', { sourceId: 'xhs-b', pkgName: '@streamapp/xhs', pkgVersion: '1.0.0', serving: [{ match: 'b.cdn', reason: 'b' }] }, builtinDir)
    writePkg('xhs', { sourceId: 'xhs-u', pkgName: '@streamapp/xhs', pkgVersion: '1.1.0-beta.1', serving: [{ match: 'u.cdn', reason: 'u' }] }, userDir)
    expect(mergeRecipePackagesByFacility(builtinDir, userDir).byFacility.get('xhs')!.serving?.map((s) => s.match)).toEqual(['u.cdn'])

    rmSync(join(builtinDir, 'xhs'), { recursive: true, force: true })
    writePkg('xhs', { sourceId: 'xhs-b', pkgName: '@streamapp/xhs', pkgVersion: '1.1.0', serving: [{ match: 'b.cdn', reason: 'b' }] }, builtinDir)
    expect(mergeRecipePackagesByFacility(builtinDir, userDir).byFacility.get('xhs')!.serving?.map((s) => s.match)).toEqual(['b.cdn'])
  })

  it('展示字段（stream.name → label、npm name / version）用户层覆盖', () => {
    writePkg('xhs', { sourceId: 'xhs-b', name: '小红书', providers: [ROW] }, builtinDir)
    writePkg('xhs', { sourceId: 'xhs-u', pkgName: '@third/xhs-extra', name: '小红书·增强' }, userDir)
    const xhs = mergeRecipePackagesByFacility(builtinDir, userDir).byFacility.get('xhs')!
    expect(xhs.label).toBe('小红书·增强')
    expect(xhs.name).toBe('@third/xhs-extra')
    expect(xhs.dir).toBe(join(userDir, 'xhs'))
    expect(xhs.providers).toEqual([ROW])   // 展示字段换了，声明照旧是内置的
  })

  it('用户层声明了内置没有的那格 → 收下（叠加，不是覆盖）', () => {
    writePkg('xhs', { sourceId: 'xhs-b', providers: [ROW] }, builtinDir)
    writePkg('xhs', { sourceId: 'xhs-u', pkgName: '@third/xhs-extra', links: { hosts: ['xhs-note.com'] }, retires: { 'rsshub:xiaohongshu/old': '包里有更好的' } }, userDir)
    const xhs = mergeRecipePackagesByFacility(builtinDir, userDir).byFacility.get('xhs')!
    expect(xhs.links?.hosts).toEqual([{ host: 'xhs-note.com', platform: 'xhs' }])
    expect(xhs.retires).toEqual({ 'rsshub:xiaohongshu/old': '包里有更好的' })
    expect(xhs.providers).toEqual([ROW])
  })

  it('rateLimit 不在 DECLARATION_FIELDS 里，照旧取最严', () => {
    expect(DECLARATION_FIELDS).not.toContain('rateLimit')
    writePkg('xhs', { sourceId: 'xhs-b', rateLimit: { burst: 5, perMinute: 10 } }, builtinDir)
    writePkg('xhs', { sourceId: 'xhs-u', pkgName: '@third/xhs-extra', rateLimit: { burst: 2, perMinute: 30 } }, userDir)
    expect(mergeRecipePackagesByFacility(builtinDir, userDir).byFacility.get('xhs')?.rateLimit).toMatchObject({ burst: 2, perMinute: 10 })
  })

  it('两层的 recipe 与 source 都挂上：用户层是叠加，不是顶掉内置那份', () => {
    writePkg('xhs', { sourceId: 'xhs-b', providers: [ROW] }, builtinDir)
    writePkg('xhs', { sourceId: 'xhs-u', pkgName: '@third/xhs-extra' }, userDir)
    // recipe：mountRecipePackages 按全名装载，两层各自的都在
    const mounted = mountRecipePackages(builtinDir, userDir)
    expect([...mounted.recipes.keys()].sort()).toEqual(['@test/xhs/xhs-b', '@third/xhs-extra/xhs-u'])
    expect(mounted.manifests.map((m) => m.id).sort()).toEqual(['@test/xhs/xhs-b', '@third/xhs-extra/xhs-u'])
    // 描述符的 sources 也是两层并集：按 sourceId 反查包的消费者得看得到内置那条
    const xhs = mergeRecipePackagesByFacility(builtinDir, userDir).byFacility.get('xhs')!
    expect(xhs.sources.map((m) => m.id).sort()).toEqual(['@test/xhs/xhs-b', '@third/xhs-extra/xhs-u'])
  })
})

describe('facility 级声明：serving / retires', () => {
  it('serving 读进描述符，label 取 stream.name，没有 name 就用 facility', () => {
    writePkg('lz', { name: '荔枝 FM', serving: [{ match: '.lz.fm', hosts: ['cdn1.lz.fm'], reason: 'cdn0 403' }] })
    writePkg('nolabel', { serving: [{ match: 'nolabel.com', reason: 'r' }] })
    const { descriptors } = loadRecipePackages(dir, USER_LAYER_SCAN)
    const lz = descriptors.find((d) => d.facility === 'lz')!
    expect(lz.serving).toEqual([{ match: '.lz.fm', hosts: ['cdn1.lz.fm'], reason: 'cdn0 403', label: '荔枝 FM' }])
    expect(descriptors.find((d) => d.facility === 'nolabel')!.serving?.[0].label).toBe('nolabel')
  })

  it('serving.hosts 含私网地址 → 这个包被跳过（onPackageError），其余照装', () => {
    writePkg('bad', { serving: [{ match: 'bad.com', hosts: ['10.0.0.1'], reason: 'r' }] })
    writePkg('good')
    const errors: string[] = []
    const { descriptors } = loadRecipePackages(dir, { ...USER_LAYER_SCAN, onPackageError: (_d, e) => errors.push(e.message) })
    expect(descriptors.map((d) => d.facility)).toEqual(['good'])
    expect(errors.join('\n')).toMatch(/私网/)
  })

  it('归并：同 facility 两层都声明 serving、版本相等 → 内置为准（serving 在 DECLARATION_FIELDS 里）', () => {
    const builtin = mkdtempSync(join(tmpdir(), 'b-')); const user = mkdtempSync(join(tmpdir(), 'u-'))
    try {
      writePkg('lz', { serving: [{ match: '.lz.fm', hosts: ['cdn1.lz.fm'], reason: 'b' }] }, builtin)
      writePkg('lz', { pkgName: '@third/lz', serving: [{ match: '.lz.fm', hosts: ['cdn9.lz.fm'], reason: 'u' }] }, user)
      const { byFacility } = mergeRecipePackagesByFacility(builtin, user)
      expect(DECLARATION_FIELDS).toContain('serving')
      expect(byFacility.get('lz')!.serving![0].hosts).toEqual(['cdn1.lz.fm'])
    } finally { rmSync(builtin, { recursive: true, force: true }); rmSync(user, { recursive: true, force: true }) }
  })

  it('servingPoliciesOf / retiredRoutesOf 把所有包的声明并成一张表', () => {
    writePkg('a', { serving: [{ match: 'a.com', reason: 'r' }], retires: { 'rsshub:a/x/:id': '关了' } })
    writePkg('b', { retires: { 'rsshub:b/y/:id': '也关了' } })
    const { list } = mergeRecipePackagesByFacility(mkdtempSync(join(tmpdir(), 'e-')), dir)
    expect(servingPoliciesOf(list).map((p) => p.match)).toEqual(['a.com'])
    expect([...retiredRoutesOf(list).entries()]).toEqual([['rsshub:a/x/:id', '关了'], ['rsshub:b/y/:id', '也关了']])
  })
})

describe('facility 级声明：providers / links / rsshubNamespaces', () => {
  const ROW = {
    id: 'a-track', category: 'resolve', serveKeys: ['a'], strategy: 'sequential',
    label: 'A 取歌', description: 'd', members: [{ mode: 'auto', matches: 'a.com/song' }],
    callsites: ['music.track.resolve'],
  }

  it('三样都读进描述符', () => {
    writePkg('a', { providers: [ROW], links: { hosts: ['a.com'], patterns: [{ kind: 'track', pattern: '^https://a\\.com/song/(?<id>\\d+)' }] }, rsshubNamespaces: ['aa'], rsshubNoBrowserNamespaces: ['aa'] })
    const d = loadRecipePackages(dir, USER_LAYER_SCAN).descriptors.find((x) => x.facility === 'a')!
    expect(d.providers).toEqual([ROW])
    expect(d.links).toEqual({ hosts: [{ host: 'a.com', platform: 'a' }], shortHosts: [], patterns: [{ kind: 'track', pattern: '^https://a\\.com/song/(?<id>\\d+)', platform: 'a' }] })
    expect(d.rsshubNamespaces).toEqual(['aa'])
    expect(d.rsshubNoBrowserNamespaces).toEqual(['aa'])
  })

  it('rsshubNoBrowserNamespacesOf 取各包的并集；两个包说同一个命名空间不算冲突', () => {
    const set = rsshubNoBrowserNamespacesOf([
      { rsshubNoBrowserNamespaces: ['aa', 'bb'] },
      { rsshubNoBrowserNamespaces: ['aa'] },
      {},
    ])
    expect([...set].sort()).toEqual(['aa', 'bb'])
  })

  it('坏的 trackUrl → 这个包被跳过（onPackageError），其余照装', () => {
    writePkg('bad', { trackUrl: ['no-group'] })
    writePkg('good')
    const errors: string[] = []
    const { descriptors } = loadRecipePackages(dir, { ...USER_LAYER_SCAN, onPackageError: (_d, e) => errors.push(e.message) })
    expect(descriptors.map((d) => d.facility)).toEqual(['good'])
    expect(errors.join('\n')).toMatch(/捕获组/)
  })

  // packageName（npm 名）一路带到建出来那条行的 `options.declaredBy`——`ensureSystemRows` 的清退
  // 分支靠它分清「代码删了这条行」和「这一轮这个包没装上」。
  it('providerDeclarationsOf 带上声明它的 facility 与 npm 包名', () => {
    writePkg('a', { providers: [ROW] })
    const { list } = mergeRecipePackagesByFacility(mkdtempSync(join(tmpdir(), 'e-')), dir)
    expect(providerDeclarationsOf(list)).toEqual([{ facility: 'a', packageName: '@test/a', declaration: ROW }])
  })

  it('老 trackUrl 翻译进认领表：platform 恒等于包 facility，package 是 npm 名', () => {
    writePkg('a', { trackUrl: ['a\\.com/song/(\\d+)', 'a\\.cn/s/(\\d+)'] })
    const { list } = mergeRecipePackagesByFacility(mkdtempSync(join(tmpdir(), 'e-')), dir)
    const [entry] = linkTableOf(list).entries
    expect(entry.package).toBe('@test/a')
    expect(entry.hosts).toEqual([{ host: 'a.com', platform: 'a' }, { host: 'a.cn', platform: 'a' }])
    expect(entry.patterns.map((p) => [p.kind, p.platform])).toEqual([['track', 'a'], ['track', 'a']])
  })

  it('rsshubNamespaceNormalizersOf：ns → facility；两个包认领同一个 ns → 抛', () => {
    writePkg('a', { rsshubNamespaces: ['aa', 'bb'], name: 'A 站' })
    const one = mergeRecipePackagesByFacility(mkdtempSync(join(tmpdir(), 'e-')), dir)
    expect([...rsshubNamespaceNormalizersOf(one.list).entries()]).toEqual([['aa', { normalizer: 'a', label: 'A 站' }], ['bb', { normalizer: 'a', label: 'A 站' }]])
    writePkg('b', { rsshubNamespaces: ['aa'] })
    const two = mergeRecipePackagesByFacility(mkdtempSync(join(tmpdir(), 'e2-')), dir)
    expect(() => rsshubNamespaceNormalizersOf(two.list)).toThrow(/aa/)
  })
})

describe('rsshubCookieEnvOf', () => {
  it('按 facility 并成一张表', () => {
    const map = rsshubCookieEnvOf([
      { facility: 'a', rsshubCookieEnv: 'A_COOKIE_{Uid}' },
      { facility: 'b' },
    ] as never)
    expect(map.get('a')).toBe('A_COOKIE_{Uid}')
    expect(map.has('b')).toBe(false)
  })
  it('认领的 RSSHub 命名空间也进键（inject.ref 是命名空间，不一定等于 facility）', () => {
    const map = rsshubCookieEnvOf([
      { facility: 'netease', rsshubNamespaces: ['163'], rsshubCookieEnv: 'X_{a}' },
    ] as never)
    expect(map.get('163')).toBe('X_{a}')
    expect(map.get('netease')).toBe('X_{a}')
  })
  it('同一键两个包写不同模板 → 先到的赢，出声', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const map = rsshubCookieEnvOf([
      { facility: 'a', rsshubNamespaces: ['ns'], rsshubCookieEnv: 'A_{x}' },
      { facility: 'b', rsshubNamespaces: ['ns'], rsshubCookieEnv: 'B_{x}' },
    ] as never)
    expect(map.get('ns')).toBe('A_{x}')
    expect(map.get('b')).toBe('B_{x}')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
