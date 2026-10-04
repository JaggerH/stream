import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserStore } from '../store/user-store.ts'
import { Registry } from '../registry/registry.ts'
import type { SourceManifest } from '../manifest/types.ts'
import { ProviderStatsStore } from '../providers/stats-store.ts'
import { ProviderExecutor } from '../providers/executor.ts'
import { ProviderDirectory } from '../providers/directory.ts'
import { SYSTEM_IDENTITIES } from '../providers/system/index.ts'
import { resourceSearchGroups } from './search-groups.ts'

function mk(partial: Partial<SourceManifest> & { id: string }): SourceManifest {
  return {
    schema_version: 1, adapter: 'fake', type: 'post', description: partial.id,
    topics: [], example_queries: [], capabilities: ['timeline'], auth: { type: 'none' },
    params_schema: {}, cadence_hint_seconds: 1800, discoverable: true, ...partial,
  }
}

/** 流式资源搜索的扇出计划：Provider 行 → groups。HTTP 层的两条测试只钉住「解析出的行 id
 *  被传下去了」（用的是假 generator），真正「换了行 = 换了扇出成员」这一环靠这里守。 */
describe('resourceSearchGroups', () => {
  let dir: string
  let store: UserStore
  let stats: ProviderStatsStore
  let exec: ProviderExecutor

  const registry = new Registry([
    mk({ id: 'pansou', provides: ['search-download'], priority: 1 }),
    mk({ id: 'zuna-dl', matchers: ['music.163.com/song'], priority: 1 }),
    mk({ id: 'toubiec-dl', matchers: ['music.163.com/song'], priority: 2 }),
  ])

  const deps = () => ({
    getProvider: (id: string) => store.getProvider(id),
    resolvedMembers: exec.resolvedMembers.bind(exec),
  })

  function putProvider(p: Partial<Parameters<UserStore['putProvider']>[0]> & { id: string }) {
    store.putProvider({
      label: '', description: '', category: 'search', serves: [], strategy: 'concurrent',
      members: [], contract: null, options: {}, ...p,
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'search-groups-'))
    store = new UserStore(join(dir, 'stream.db'))
    stats = new ProviderStatsStore(join(dir, 'cache.db'))
    exec = new ProviderExecutor({ directory: new ProviderDirectory(store, SYSTEM_IDENTITIES), registry, stats, fetchSource: async () => [] })
  })
  afterEach(() => {
    store.close()
    stats.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // 这是本文件的承重条：providerId 一旦被忽略（例如有人把调用改回无参），两行会给出同一套
  // 成员——写入成功、测试全绿、线上「换了 Provider 等于没换」。
  it('fans out over the named row: two rows → different source_id sets', () => {
    putProvider({ id: 'resource-search', members: [{ source: 'pansou' }] })
    putProvider({ id: 'nsfw-search', members: [{ source: 'zuna-dl' }, { source: 'toubiec-dl' }] })

    const globalRow = resourceSearchGroups(deps(), 'resource-search').map((g) => g.source_id)
    const overrideRow = resourceSearchGroups(deps(), 'nsfw-search').map((g) => g.source_id)

    expect(globalRow).toEqual(['pansou'])
    expect(overrideRow).toEqual(['zuna-dl', 'toubiec-dl'])
    expect(new Set(overrideRow)).not.toEqual(new Set(globalRow))
  })

  it('defaults to the global resource-search row when no id is given', () => {
    putProvider({ id: 'resource-search', members: [{ source: 'pansou' }] })
    putProvider({ id: 'nsfw-search', members: [{ source: 'zuna-dl' }] })
    expect(resourceSearchGroups(deps()).map((g) => g.source_id)).toEqual(['pansou'])
  })

  it('unknown row id → no groups (never silently falls back to the global row)', () => {
    putProvider({ id: 'resource-search', members: [{ source: 'pansou' }] })
    expect(resourceSearchGroups(deps(), 'no-such-row')).toEqual([])
  })

  // 扇出计划的其余两条形状(与「换行」正交,顺手钉住): auto 段展开 + $input 洞剥离 + {provider} 成员标记
  it('expands auto segments, strips the $input hole, and marks {provider} members', () => {
    putProvider({ id: 'child', members: [{ source: 'pansou' }] })
    putProvider({
      id: 'resource-search',
      members: [
        { source: 'pansou', params: { keyword: '$input', channels: 'tgsearchers' } },
        { provider: 'child' },
        { mode: 'auto', matches: 'music.163.com/song' },
      ],
    })
    expect(resourceSearchGroups(deps(), 'resource-search')).toEqual([
      { source_id: 'pansou', provider: false, physicalParams: { channels: 'tgsearchers' } },
      { source_id: 'child', provider: true, physicalParams: {} },
      { source_id: 'zuna-dl', provider: false, physicalParams: {} },
      { source_id: 'toubiec-dl', provider: false, physicalParams: {} },
    ])
  })
})
