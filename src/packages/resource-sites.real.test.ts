import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UserStore } from '../store/user-store.ts'
import { ensureSystemRows, pruneDeadMembers } from '../providers/seed.ts'
import {
  BUILTIN_LAYER_SCAN, linkTableOf, loadRecipePackages, providerDeclarationsOf, retiredRoutesOf, searchSourcesOf, servingPoliciesOf,
} from '../replay/recipe-package.ts'
import { loadPlugins } from '../plugins/loader.ts'
import { identityOf, setPackageIdentities } from '../providers/identities.ts'
import { downloadPageKind } from '../video/resolve.ts'
import { setLinkDeclarationSource } from '../links/recognize.ts'
import { searchMetaBySourceId, setPackageSearchSources } from '../search/seeds.ts'
import { refererForUrl, setServingPolicySource } from '../media/serving.ts'

/**
 * 资源站（BT 影视 / 盘搜 / BT 之家）的站点知识住在各自的包里，宿主只剩机制。这里对**真实出货的
 * `packages/`** 钉住：它们的声明装得进来、互相指得上（成员 / 元数据指的源真的存在），而宿主那几张表
 * 经装配层挂上之后给出和搬家前一样的答案。任何一格声明漏写或写错，表现都是「某个能力静默不在」
 * ——资源搜索少一个源、下载页不打解析标——没有一处会喊，所以由这里喊。
 */
const PACKAGES_DIR = fileURLToPath(new URL('../../packages', import.meta.url))
const loaded = loadRecipePackages(PACKAGES_DIR, BUILTIN_LAYER_SCAN)
const pkgs = loaded.descriptors
const knownSources = new Set<string>([
  ...loaded.recipes.keys(),
  ...pkgs.flatMap((d) => d.sources.map((s) => s.id)),
  ...loadPlugins(PACKAGES_DIR).flatMap((p) => (p.sources ?? []).map((s) => s.id)),
])

afterEach(() => {
  setPackageIdentities([])
  setPackageSearchSources(() => [])
  setLinkDeclarationSource(() => [])
})

describe('资源站的包声明（真实 packages/）', () => {
  it('BT 影视的组合体行由包出：被身份表接受，expand 配置与 provides 标签都在，成员指向真实 recipe', () => {
    expect(setPackageIdentities(providerDeclarationsOf(pkgs))).toEqual([])
    const row = identityOf('btbtla')!
    expect(row).toMatchObject({ category: 'search', strategy: 'expand', provides: ['search-download'], declaredBy: '@streamapp/btbtla' })
    expect(row.expand?.map).toEqual({ detailUrl: '$item.detailUrl' })
    const members = row.defaultMembers.map((m) => (m as { source: string }).source)
    expect(members).toEqual(['@streamapp/btbtla/btbtla-search', '@streamapp/btbtla/btbtla-detail'])
    for (const m of members) expect(knownSources.has(m), m).toBe(true)
  })

  it('三个站的资源搜索元数据都由包声明，且指的源 / 行真实存在', () => {
    const decls = searchSourcesOf(pkgs)
    const byKey = new Map(decls.map((d) => [d.key, d]))
    expect(byKey.get('btbtla')).toMatchObject({ provider: 'btbtla', param: 'name', kind: 'digest' })
    expect(byKey.get('pansou')).toMatchObject({ source: '@streamapp/pansou/pansou-search', param: 'keyword', kind: 'digest' })
    expect(byKey.get('1lou')).toMatchObject({ source: '@streamapp/1lou/1lou-search', param: 'keyword', kind: 'flat' })
    // RSSHub 目录路由（`rsshub:` id，rsshub 包声明）不在包源表里——它们来自目录，本地无 RSSHub 检出时验不到。
    for (const d of decls) if (d.source && !d.source.startsWith('rsshub:')) expect(knownSources.has(d.source), d.source).toBe(true)

    // 挂进宿主的查表之后，答案与搬家前一致（标签 / 站内搜索页）。
    setPackageSearchSources(() => decls)
    expect(searchMetaBySourceId('btbtla')?.searchUrl?.('上载新生')).toBe(`https://www.btbtla.com/search/${encodeURIComponent('上载新生')}`)
    expect(searchMetaBySourceId('@streamapp/pansou/pansou-search')?.label).toBe('盘搜')
    // 站内搜索已是 /search/ 单页应用（旧 search.htm?keyword= 会挂 30–90s 不回），点进去要落到它。
    expect(searchMetaBySourceId('@streamapp/1lou/1lou-search')?.searchUrl?.('a b')).toBe('https://www.1lou.me/search/?q=a%20b')
  })

  it('资源搜索行的 auto 段收得到 BT 之家与盘搜（manifest 申报了 search-download，参数名是 keyword）', () => {
    const provides = (id: string) => [
      ...pkgs.flatMap((d) => d.sources),
      ...loadPlugins(PACKAGES_DIR).flatMap((p) => p.sources ?? []),
    ].find((s) => s.id === id)
    for (const id of ['@streamapp/1lou/1lou-search', '@streamapp/pansou/pansou-search']) {
      const m = provides(id)
      expect(m?.provides, id).toContain('search-download')
      expect(m?.key_param, id).toBe('keyword')
    }
  })

  it('BT 之家顶掉了 RSSHub 那条旧路由（资源搜索行里残留的旧成员启动时由 pruneDeadMembers 清掉）', () => {
    expect(retiredRoutesOf(pkgs).has('rsshub:1lou/search/:keyword')).toBe(true)
  })

  it('磁力解析源住 BT 影视包（局部名不变），申报 resolve-download 让下载解析行的 auto 段收它', () => {
    const m = loadPlugins(PACKAGES_DIR).flatMap((p) => p.sources ?? []).find((s) => s.id === '@streamapp/btbtla/magnet-btbtla')
    expect(m).toMatchObject({ adapter: 'builtin', provides: ['resolve-download'], fixed_params: { mode: 'magnet' } })
    expect(knownSources.has('@streamapp/builtin/magnet-btbtla')).toBe(false)
  })

  // 依赖 seed.ts 的「死成员在内置层恰好有一个同局部名的新全名 → 改指」规则：存量库里
  // download-resolve 行上的旧全名要被接到新包，而不是当成「代码删了」静默清掉。
  it('存量 download-resolve 行上的旧全名 @streamapp/builtin/magnet-btbtla → 改指到 BT 影视包', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resource-sites-prune-'))
    const store = new UserStore(join(dir, 'stream.db'))
    try {
      ensureSystemRows(store)
      store.patchProvider('download-resolve', { members: [{ source: '@streamapp/builtin/magnet-btbtla' }] })
      const lookup = {
        get: (id: string) => (knownSources.has(id) ? {} : undefined),
        builtinIdsByLocalName: (local: string) => [...knownSources].filter((id) => id.slice(id.lastIndexOf('/') + 1) === local),
      }
      const pruned = pruneDeadMembers(store, lookup, () => true, () => new Map()).filter((p) => p.providerId === 'download-resolve')
      expect(pruned).toEqual([{ providerId: 'download-resolve', sourceId: '@streamapp/builtin/magnet-btbtla', restoredDefaults: false, movedTo: '@streamapp/btbtla/magnet-btbtla' }])
      expect(store.getProvider('download-resolve')!.members).toEqual([{ source: '@streamapp/btbtla/magnet-btbtla' }])
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  // 搬家等价：这 6 条 RSSHub 目录路由的元数据以前写在宿主 `SEARCH_SOURCE_META`，现在由 rsshub 包的
  // `searchSources` 声明。下面的期望值是搬前那张表的原样（searchUrl 代入同一个词得同一个地址）。
  // 目录 id（`rsshub:…`）不归任何包命名空间，装载期不补前缀——补了就查不中，徽标退化成裸键。
  it('RSSHub 目录路由的资源搜索元数据由 rsshub 包声明，与搬前宿主表逐字段相同', () => {
    setPackageSearchSources(() => searchSourcesOf(pkgs))
    const q = '上 载&x'
    const e = encodeURIComponent(q)
    const expected: Array<[string, { key: string; label: string; param: string; nsfw: boolean; url?: string }]> = [
      ['rsshub:nyaa/search/:query?', { key: 'nyaa', label: 'Nyaa', param: 'query', nsfw: false, url: `https://nyaa.si/?q=${e}` }],
      ['rsshub:comicat/search/:keyword', { key: 'comicat', label: '漫猫', param: 'keyword', nsfw: false, url: `https://comicat.org/search.php?keyword=${e}` }],
      ['rsshub:bangumi.moe/:tags{.+}?', { key: 'bangumi-moe', label: '萌番组', param: 'tags', nsfw: false }],
      ['rsshub:nyaa/sukebei/search/:query?', { key: 'nyaa-r18', label: 'Nyaa(R18)', param: 'query', nsfw: true, url: `https://sukebei.nyaa.si/?q=${e}` }],
      ['rsshub:u3c3/search/:keyword/:preview?', { key: 'u3c3', label: 'U3C3', param: 'keyword', nsfw: true, url: `https://www.u3c3.com/?search=${e}` }],
      ['rsshub:javdb/search/:keyword?/:filter?/:sort?', { key: 'javdb', label: 'JavDB', param: 'keyword', nsfw: true, url: `https://javdb.com/search?q=${e}&f=all` }],
    ]
    for (const [sourceId, want] of expected) {
      const m = searchMetaBySourceId(sourceId)
      expect(m, sourceId).toBeDefined()
      expect({ key: m!.key, label: m!.label, param: m!.param, nsfw: m!.nsfw, kind: m!.kind }).toEqual({ key: want.key, label: want.label, param: want.param, nsfw: want.nsfw, kind: 'flat' })
      expect(m!.searchUrl?.(q)).toBe(want.url)
    }
  })

  // 搬家等价：豆瓣图床的 Referer 以前在 image-fetch.ts / poster-similarity.ts 各写一遍，现在由 rsshub
  // 包的 serving 声明、两处同问 refererForUrl。
  it('影视榜单海报图床的 Referer 由 rsshub 包声明（与搬前相同）；别的图床不带', () => {
    setServingPolicySource(() => servingPoliciesOf(pkgs))
    try {
      expect(refererForUrl('https://img1.doubanio.com/view/photo/p2895.jpg')).toBe('https://movie.douban.com/')
      expect(refererForUrl('https://doubanio.com/x.jpg')).toBe('https://movie.douban.com/')
      expect(refererForUrl('https://sns-webpic-qc.xhscdn.com/a.jpg')).toBeUndefined()
      expect(refererForUrl('https://image.tmdb.org/t/p/original/a.jpg')).toBeUndefined()
    } finally { setServingPolicySource(() => []) }
  })

  it('下载中转页文法由 BT 影视包声明：磁力页认领为 magnet、网盘页在册为 unknown、别家不认', () => {
    setLinkDeclarationSource(() => linkTableOf(pkgs).entries)
    expect(downloadPageKind('https://www.btbtla.com/tdown/842351654.html')).toBe('magnet')
    expect(downloadPageKind('https://btbtla.com/pdown/1.html')).toBe('unknown')
    expect(downloadPageKind('https://pan.quark.cn/s/abc')).toBeNull()
  })
})
