import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchMetaBySourceId, searchMetaByMemberKey, missTimings, setPackageSearchSources } from './seeds.ts'
import type { SearchSourceDeclaration } from '../packages/descriptor.ts'
import { UserStore } from '../store/user-store.ts'
import { Registry } from '../registry/registry.ts'
import { ProviderExecutor } from '../providers/executor.ts'
import { ProviderDirectory } from '../providers/directory.ts'
import { SYSTEM_IDENTITIES } from '../providers/system/index.ts'
import { ProviderStatsStore } from '../providers/stats-store.ts'
import type { SourceManifest } from '../manifest/types.ts'

function mk(partial: Partial<SourceManifest> & { id: string }): SourceManifest {
  return {
    schema_version: 1, adapter: 'fake', type: 'post', description: partial.id,
    topics: [], example_queries: [], capabilities: ['timeline'], auth: { type: 'none' },
    params_schema: {}, cadence_hint_seconds: 1800, discoverable: true, ...partial,
  }
}

// 包那一半的元数据由装配层挂进来（真实包的声明由 src/packages/resource-sites.real.test.ts 钉着）；
// 这里挂一份形状相同的夹具，测的是查表机制本身。
const PKG_DECLS: SearchSourceDeclaration[] = [
  { provider: 'combo-row', key: 'combo', label: '组合体', param: 'name', kind: 'digest', searchUrl: 'https://x.example/search/{q}' },
  { source: '@t/pansou/pansou-search', key: 'pansou', label: '盘搜', param: 'keyword', kind: 'digest' },
  // 目录路由形状（`rsshub:` id 不带包前缀，装载期原样保留）
  { source: 'rsshub:nyaa/search/:query?', key: 'nyaa', label: 'Nyaa', param: 'query', kind: 'flat' },
  { source: 'rsshub:nyaa/sukebei/search/:query?', key: 'nyaa-r18', label: 'Nyaa(R18)', param: 'query', kind: 'flat', nsfw: true },
]
beforeEach(() => setPackageSearchSources(() => PKG_DECLS))
afterEach(() => setPackageSearchSources(() => []))

describe('searchMetaBySourceId', () => {
  it('包声明的组合体行：source_id = 行 id，searchUrl 模板把 {q} 换成编码后的查询词', () => {
    const m = searchMetaBySourceId('combo-row')
    expect(m?.key).toBe('combo')
    expect(m?.kind).toBe('digest')
    expect(m?.searchUrl?.('上 载')).toBe(`https://x.example/search/${encodeURIComponent('上 载')}`)
  })

  it('目录路由按 source_id 精确查；宿主自己没有一行（装配层没挂 = 全查不中）', () => {
    expect(searchMetaBySourceId('rsshub:nyaa/search/:query?')).toMatchObject({ key: 'nyaa', nsfw: false })
    expect(searchMetaBySourceId('nope')).toBeUndefined()
    setPackageSearchSources(() => [])
    expect(searchMetaBySourceId('rsshub:nyaa/search/:query?')).toBeUndefined()
  })

  it('包声明的源按全名查得中；装配层没挂（包没装）就查不中', () => {
    expect(searchMetaBySourceId('@t/pansou/pansou-search')?.label).toBe('盘搜')
    setPackageSearchSources(() => [])
    expect(searchMetaBySourceId('@t/pansou/pansou-search')).toBeUndefined()
  })

  // 命名空间化之前落地的 Flow 行存的是裸名，而这张表现在写的是全名——精确没中时按局部名再对
  // 一次，否则这些行的标签会静默退化成裸键。
  it('存量裸名仍查得中（按局部名回落）', () => {
    expect(searchMetaBySourceId('pansou-search')?.key).toBe('pansou')
  })

  // catalog 路由的最后一段是路由参数：`rsshub:nyaa/search/:query?` 与
  // `rsshub:nyaa/sukebei/search/:query?` 的「局部名」一模一样，按它回落会张冠李戴。
  it('catalog 路由不走局部名回落（两条 nyaa 路由的最后一段相同）', () => {
    expect(searchMetaBySourceId('rsshub:nyaa/search/:query?')?.key).toBe('nyaa')
    expect(searchMetaBySourceId('rsshub:nyaa/sukebei/search/:query?')?.key).toBe('nyaa-r18')
    expect(searchMetaBySourceId('rsshub:made/up/:query?')).toBeUndefined()
  })
})

describe('searchMetaByMemberKey', () => {
  const members = [
    { name: 'pansou-search', sourceId: 'pansou-search' },
    // 显式实例名成员：寻址键(name)与真源 id 不同——miss.member 只会是寻址键
    { name: 'pansou-alt', sourceId: 'pansou-search' },
  ]

  it('成员带实例名——按 name 找到 sourceId 再查 meta,不再退化成裸键', () => {
    const m = searchMetaByMemberKey('pansou-alt', members)
    expect(m?.key).toBe('pansou')
    expect(m?.label).toBe('盘搜')
  })

  it('成员无实例名——寻址键本就是 sourceId,行为不变', () => {
    const m = searchMetaByMemberKey('pansou-search', members)
    expect(m?.key).toBe('pansou')
  })

  it('查不到成员也查不到 meta——回落 undefined,调用点再回落裸键', () => {
    expect(searchMetaByMemberKey('nope', members)).toBeUndefined()
  })
})

// 端到端：真 UserStore + 真 Registry + 真 ProviderExecutor，不桩 missTimings 内部用到的任何一环——
// 复审打回的就是"之前的窄测把 facetResources 整个桩掉，没打到 getProvider(providerId)→
// resolvedMembers(row) 的真实映射，也没构造真 miss"。这里让 executor 真的 decline 出一条 miss，
// 走 missTimings 真的查 getProvider/resolvedMembers，断言 label 是包声明里的展示名。
describe('missTimings（真 executor 产出的 miss，不桩内部任何一环）', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('带实例名的成员 decline → 真 miss 的 member 是寻址键,missTimings 查真行换回 sourceId 后报包声明的展示名', async () => {
    dir = mkdtempSync(join(tmpdir(), 'seeds-misstimings-'))
    const store = new UserStore(join(dir, 'stream.db'))
    const stats = new ProviderStatsStore(join(dir, 'stats.db'))
    const registry = new Registry([mk({ id: 'pansou-search', provides: ['search-download'], capabilities: ['search'] })])
    // 覆盖行：成员带实例名 'pansou-alt'（≠ 真 sourceId 'pansou-search'）——miss.member 只会报这个
    // 寻址键，是这条回归本身要守住的场景。
    store.putProvider({
      id: 'resource-search-alt', label: '资源搜索（覆盖）', description: '', category: 'search', serves: ['resources'],
      strategy: 'concurrent', members: [{ source: 'pansou-search', name: 'pansou-alt', params: { keyword: '$input' } }],
      contract: null, options: {}, system: false,
    })
    const executor = new ProviderExecutor({
      directory: new ProviderDirectory(store, SYSTEM_IDENTITIES), registry, stats,
      fetchSource: async () => [], // 空批 = decline（executor 语义），产出一条真 miss，不是手搓的
    })

    const r = await executor.invoke('resource-search-alt', 'q')
    expect(r?.strategy).toBe('concurrent')
    // 真 miss：member 是寻址键 'pansou-alt'，不是 sourceId 'pansou-search'
    expect(r!.misses).toEqual([{ member: 'pansou-alt', reason: 'declined (no result)' }])

    const timings = missTimings(r!.misses, 'resource-search-alt', {
      getProvider: (id) => store.getProvider(id),
      resolvedMembers: (row) => executor.resolvedMembers(row),
    })
    // 查到真行的 resolvedMembers 把 'pansou-alt' 换回 'pansou-search' 后命中包声明
    // ——label 是「盘搜」，不是退化的裸键 'pansou-alt'
    expect(timings).toEqual([{ key: 'pansou', label: '盘搜', ms: 0, count: 0, dropped: 0, status: 'empty' }])

    store.close()
    stats.close()
  })
})
