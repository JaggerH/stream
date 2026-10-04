import { describe, it, expect } from 'vitest'
import type { ProviderCategory } from '../../store/types.ts'
import { SYSTEM_IDENTITIES } from './index.ts'
import { existsSync } from 'node:fs'
import { loadPlugins } from '../../plugins/loader.ts'
import { loadRecipePackages, mountRecipePackages } from '../../replay/recipe-package.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRsshubCatalog } from '../../rsshub-catalog.ts'
import { Registry } from '../../registry/registry.ts'
import { sealManifests } from '../../registry/seal.ts'

/** RSSHub 的构建产物路由目录，和 `bootstrap.ts` 用同一条推导。本地有 RSSHub 检出才存在；
 *  CI / 全新克隆没有，那时 `rsshub:` 成员这一半就是**没验到**，不是验过了。 */
const RSSHUB_CATALOG = process.env.RSSHUB_PKG
  ? process.env.RSSHUB_PKG.replace(/\/lib\/pkg\.ts$/, '/assets/build/routes.json')
  : ''

/** ProviderCategory 的全部取值。类型收窄时这里编译期报错（照 `loader.real.test.ts` 的钉数字
 *  先例：名单要有一个钉得住的地方，人的记性不算）。 */
const CATEGORIES: ProviderCategory[] = [
  'search', 'resolve', 'download', 'transform', 'transcribe', 'llm', 'metadata', 'images', 'data',
]

/** 同 category 内 serveKeys 跨行重复的**已知例外**。
 *
 *  `video-canonical` 与 `video-metadata` 同属 metadata、同认 `video-detail`：这两行**按 id 直调**
 *  （详情加载先取权威标识、再取元数据），从不经 `match()` 选行，所以同键不构成分发歧义。
 *  名单写死在这里而不是把不变量放宽——多出第 3 条重复就是红的。 */
const KNOWN_DUPLICATE_SERVE_KEYS: Array<{ category: ProviderCategory; key: string; ids: string[] }> = [
  { category: 'metadata', key: 'video-detail', ids: ['video-canonical', 'video-metadata'] },
]

describe('SYSTEM_IDENTITIES', () => {
  const identities = [...SYSTEM_IDENTITIES.values()]

  // 18：平台行（`netease-track` / `video-bilibili` / `video-douyin` / `video-tiktok`）、资源站的组合体
  // 与网盘行（`netdisk-*-quark` / `netdisk-verify-baidu`）各住自己包的 `stream.providers`（站点知识归包），
  // 经合并身份表进来，不在这张宿主静态表里。
  it('has exactly 18 rows, keyed by their own id', () => {
    expect(identities).toHaveLength(18)
    for (const identity of identities) expect(SYSTEM_IDENTITIES.get(identity.id)).toBe(identity)
  })

  // 看板数据平面退役（本任务）：builtin adapter 的 run-list/run-metrics/run-timeseries 三个
  // mode 已摘掉，这三条系统身份行不能再指向它们——留着就是一条只剩残缺成员的死配置。
  it('run-list/run-metrics/run-timeseries 三条系统行已退役', () => {
    for (const id of ['run-list', 'run-metrics', 'run-timeseries']) {
      expect(SYSTEM_IDENTITIES.has(id), id).toBe(false)
    }
  })

  it('every row carries a known ProviderCategory', () => {
    for (const identity of identities) expect(CATEGORIES).toContain(identity.category)
  })

  it('serveKeys do not repeat across rows of the same category (beyond the known pair)', () => {
    // category → serve 键 → 声明它的行。嵌套 Map 而不是拼接串当键：拼接符是个会咬人的细节。
    const seen = new Map<ProviderCategory, Map<string, string[]>>()
    for (const identity of identities) {
      const perKey = seen.get(identity.category) ?? new Map<string, string[]>()
      seen.set(identity.category, perKey)
      for (const key of identity.serveKeys) perKey.set(key, [...(perKey.get(key) ?? []), identity.id])
    }
    const duplicates = [...seen.entries()].flatMap(([category, perKey]) =>
      [...perKey.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ category, key, ids })),
    )
    expect(duplicates).toEqual(KNOWN_DUPLICATE_SERVE_KEYS)
  })

  it('has at most one fallback row per category', () => {
    const perCategory = new Map<ProviderCategory, string[]>()
    for (const identity of identities.filter((i) => i.fallback)) {
      perCategory.set(identity.category, [...(perCategory.get(identity.category) ?? []), identity.id])
    }
    for (const [category, ids] of perCategory) expect({ category, ids }).toEqual({ category, ids: [ids[0]] })
    // 今天的兜底行恰好三条，各占一个 category（transcribe 那条只有它自己在这个 category 里）。
    expect([...perCategory.entries()].map(([category, ids]) => [category, ids]))
      .toEqual([['transform', ['fetch-url']], ['llm', ['llm']], ['transcribe', ['transcribe']]])
  })

  /** 建行初值一条都不能缺：`ensureSystemRows` 拿它们填 DB 里 NOT NULL 的那几列，
   *  缺一个就是启动期插入失败。`llm` 的空成员是**故意**的（连接由用户自己加），故单列例外。 */
  it('every row carries the three build-time defaults', () => {
    for (const identity of identities) {
      expect(identity.defaultLabel, identity.id).toBeTruthy()
      expect(identity.defaultDescription, identity.id).toBeTruthy()
      expect(Array.isArray(identity.defaultMembers), identity.id).toBe(true)
      if (identity.id !== 'llm') expect(identity.defaultMembers.length, identity.id).toBeGreaterThan(0)
    }
  })

  /**
   * 具名成员必须指向**真的存在**的内置源。
   *
   * 这条守的是一种极安静的缺陷：行上写了个 id、库里没有这个源，成员就静默地取不到东西——
   * 行还在、页面还显示它、健康账里只是一直空手，没有任何一处会喊。真发生过：toubiec/zuna
   * 的能力从 RSSHub 路由迁成 recipe 之后，`music-search` 那两个成员仍写着 `rsshub:…` 的旧 id，
   * 于是四份 recipe 是死代码、而行指着一份即将被删掉的实现。
   *
   * `rsshub:` 开头的成员对照的是 RSSHub 的构建产物路由目录。**那份目录不在本仓**，本地没有
   * RSSHub 检出时这一半查不了——那时把它们跳过并在这里说清是「没验到」，不假装验过。
   * （正因为迁移把成员从 `rsshub:` 换成了 recipe id，这一半必须查：只查非 rsshub 的那半，
   * 恰好漏掉当初出问题的那两条。）`{mode:'auto'}` 成员没有 id，天然不适用。
   */
  it('every named default member points at a real source', () => {
    const hasCatalog = existsSync(RSSHUB_CATALOG)
    const known = new Set<string>([
      ...loadPlugins('packages').flatMap((p) => (p.sources ?? []).map((s) => s.id)),
      ...loadRecipePackages('packages').recipes.keys(),
      ...(hasCatalog ? loadRsshubCatalog(RSSHUB_CATALOG).map((m) => m.id) : []),
    ])
    const dangling = identities.flatMap((identity) =>
      identity.defaultMembers
        .map((m) => (m as { source?: string }).source)
        .filter((source): source is string => typeof source === 'string')
        .filter((source) => (hasCatalog ? true : !source.startsWith('rsshub:')))
        .filter((source) => !known.has(source))
        .map((source) => `${identity.id} → ${source}`),
    )
    expect({ checkedRsshubMembers: hasCatalog, dangling }).toEqual({ checkedRsshubMembers: hasCatalog, dangling: [] })
  })

  /** `expand` 与 `strategy:'expand'` 必须同进同退——只有一半的行会在执行器里静默变成一条
   *  取不到东西的顺序梯子。 */
  it('expand spec and expand strategy come as a pair', () => {
    for (const identity of identities) {
      expect(!!identity.expand, identity.id).toBe(identity.strategy === 'expand')
    }
  })

  it('podcast-feed 的成员按目录 category 现取，源码里不写任何站的 radar', () => {
    const pf = identities.find((i) => i.id === 'podcast-feed')!
    expect(pf.defaultMembers).toEqual([{ mode: 'auto', category: 'podcast' }])
  })

  /**
   * `{mode:'auto', category}` 是一条**间接**成员声明：行里写的是标签，成员由目录现算。
   * 只断言 `defaultMembers` 的字面形状，等于只验了"我写对了标签"，验不到"这个标签今天还
   * 捞得到人"——标签捞空时这一行是静默的"没有结果"，不是报错。
   *
   * 所以照真 registry 数一遍。`inCategory` 同时要求 `categories` 含标签**且**有 `key_param`
   * （订阅键要往里灌），而 RSSHub catalog 的路由从来不带 `key_param`——播客成员只能来自
   * curated 清单或 recipe 包。
   */
  it('podcast 这个标签在真 registry 里至少捞得到两个源', () => {
    const plugins = loadPlugins('packages')
    const recipes = mountRecipePackages('packages', join(tmpdir(), 'stream-no-user-recipes'))
    const registry = new Registry(sealManifests(plugins.flatMap((p) => p.sources ?? []), plugins))
    registry.swapGroup('recipes', sealManifests(recipes.manifests, plugins), recipes.builtinIds)
    const members = registry.inCategory('podcast').map((m) => m.id)
    expect(members.length, `podcast 成员: ${members.join(', ') || '（空）'}`).toBeGreaterThanOrEqual(2)
  })

  it('lyrics-search 的成员按目录 category 现取，行上不写任何具体歌词源', () => {
    const row = SYSTEM_IDENTITIES.get('lyrics-search')!
    expect(row.defaultMembers).toEqual([{ mode: 'auto', category: 'lyrics' }])
  })

  /** 同 podcast 那条一样，字面形状只验了"标签写对了"，验不到"这个标签今天还捞得到人"。 */
  it('目录里至少有一个 lyrics 类目的源，且它带 key_param（否则这一行展开是空的）', () => {
    const plugins = loadPlugins('packages')
    const recipes = mountRecipePackages('packages', join(tmpdir(), 'stream-no-user-recipes'))
    const registry = new Registry(sealManifests(plugins.flatMap((p) => p.sources ?? []), plugins))
    registry.swapGroup('recipes', sealManifests(recipes.manifests, plugins), recipes.builtinIds)
    const lyricsSources = registry.inCategory('lyrics')
    expect(lyricsSources.map((m) => m.id), 'categories 含 lyrics 且带 key_param 的源').not.toEqual([])
  })
})
