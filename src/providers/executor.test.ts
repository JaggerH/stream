import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserStore } from '../store/user-store.ts'
import { Registry } from '../registry/registry.ts'
import type { SourceManifest } from '../manifest/types.ts'
import type { ProviderRecord } from '../store/types.ts'
import { ProviderStatsStore } from './stats-store.ts'
import { ProviderExecutor, sourceOf, ProviderCycleError, ProviderDepthError } from './executor.ts'
import { ProviderDirectory } from './directory.ts'
import { SYSTEM_IDENTITIES, type SystemIdentity } from './system/index.ts'

function mk(partial: Partial<SourceManifest> & { id: string }): SourceManifest {
  return {
    schema_version: 1, adapter: 'fake', type: 'post', description: partial.id,
    topics: [], example_queries: [], capabilities: ['timeline'], auth: { type: 'none' },
    params_schema: {}, cadence_hint_seconds: 1800, discoverable: true, ...partial,
  }
}

/** 成员一律是 Source：测试用 fetchSource 分发表模拟各源行为
 *  （items 型 [] = decline / object 型 null = decline / throw = 失败）。 */
type SourceBehavior = (input: unknown, params?: Record<string, unknown>) => Promise<unknown[] | Record<string, unknown> | null>

describe('ProviderExecutor', () => {
  let dir: string
  let store: UserStore
  let stats: ProviderStatsStore
  let fetched: Array<{ sourceId: string; input: unknown }>
  let behaviors: Record<string, SourceBehavior>
  let exec: ProviderExecutor

  const registry = new Registry([
    mk({ id: 'nt-primary', provides: ['netease-track'], priority: 1 }),
    mk({ id: 'nt-mirror', provides: ['netease-track'], priority: 2 }),
    mk({ id: 'zuna-dl', matchers: ['music.163.com/song'], priority: 1 }),
    mk({ id: 'toubiec-dl', matchers: ['music.163.com/song'], priority: 2 }),
    mk({ id: 'pod-a', categories: ['podcast'], key_param: 'id', priority: 1 }),
    mk({ id: 'pod-b', categories: ['podcast'], key_param: 'uid', priority: 2 }),
  ])

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exec-'))
    store = new UserStore(join(dir, 'stream.db'))
    stats = new ProviderStatsStore(join(dir, 'cache.db'))
    fetched = []
    behaviors = {
      'nt-primary': async () => [], // declines
      'nt-mirror': async () => [{ from: 'nt-mirror' }],
    }
    exec = new ProviderExecutor({
      directory: new ProviderDirectory(store, SYSTEM_IDENTITIES), registry, stats,
      fetchSource: async (sourceId, input, params) => {
        fetched.push({ sourceId, input })
        const b = behaviors[sourceId]
        if (!b) throw new Error(`no behavior for ${sourceId}`)
        return b(input, params)
      },
    })
  })
  afterEach(() => {
    store.close()
    stats.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function putProvider(p: Partial<Parameters<UserStore['putProvider']>[0]> & { id: string }) {
    store.putProvider({
      label: '', description: '', category: 'resolve', serves: [], strategy: 'sequential',
      members: [], contract: null, options: {}, ...p,
    })
  }

  it('resolvedMembers 标出 {provider} 成员的 kind', () => {
    putProvider({ id: 'child', category: 'search', strategy: 'concurrent', members: [{ source: 'nt-mirror' }] })
    putProvider({ id: 'parent', category: 'search', strategy: 'concurrent', members: [{ provider: 'child' }, { source: 'nt-mirror' }] })
    const rec = store.getProvider('parent')!
    const rm = exec.resolvedMembers(rec)
    expect(rm).toEqual([
      { name: 'child', sourceId: 'child', params: undefined, kind: 'provider' },
      { name: 'nt-mirror', sourceId: 'nt-mirror', params: undefined, kind: 'source' },
    ])
  })

  it('{provider} 成员：子 items 并入父结果，源标成员名', async () => {
    behaviors['child-src'] = async () => [{ id: 'x', __k: 'from-child' }]
    behaviors['parent-src'] = async () => [{ id: 'y', __k: 'from-parent' }]
    putProvider({ id: 'child', category: 'search', strategy: 'concurrent', members: [{ source: 'child-src' }] })
    putProvider({ id: 'parent', category: 'search', strategy: 'concurrent', members: [{ provider: 'child' }, { source: 'parent-src' }] })
    const r = await exec.invoke('parent', 'q')
    expect(r?.strategy).toBe('concurrent')
    const items = (r as { items: unknown[] }).items
    expect(items.map((i) => sourceOf(i))).toEqual(['child', 'parent-src'])
  })

  it('{provider} 成员 decline（子返回 []）不产出也不失败', async () => {
    behaviors['child-src'] = async () => []
    behaviors['parent-src'] = async () => [{ id: 'y' }]
    putProvider({ id: 'child', category: 'search', strategy: 'concurrent', members: [{ source: 'child-src' }] })
    putProvider({ id: 'parent', category: 'search', strategy: 'concurrent', members: [{ provider: 'child' }, { source: 'parent-src' }] })
    const r = await exec.invoke('parent', 'q')
    expect((r as { items: unknown[] }).items.length).toBe(1)
  })

  it('自引用 → ProviderCycleError，不发生 invoke 循环', async () => {
    putProvider({ id: 'selfp', category: 'search', strategy: 'concurrent', members: [{ provider: 'selfp' }] })
    await expect(exec.invoke('selfp', 'q')).rejects.toBeInstanceOf(ProviderCycleError)
  })

  it('环 A→B→A → ProviderCycleError', async () => {
    putProvider({ id: 'A', category: 'search', strategy: 'concurrent', members: [{ provider: 'B' }] })
    putProvider({ id: 'B', category: 'search', strategy: 'concurrent', members: [{ provider: 'A' }] })
    await expect(exec.invoke('A', 'q')).rejects.toBeInstanceOf(ProviderCycleError)
  })

  it('超过最大组合深度 → ProviderDepthError', async () => {
    const n = 10
    for (let i = 0; i < n; i++)
      putProvider({ id: `p${i}`, category: 'search', strategy: 'concurrent', members: [{ provider: `p${i + 1}` }] })
    putProvider({ id: `p${n}`, category: 'search', strategy: 'concurrent', members: [{ source: 'nt-mirror' }] })
    await expect(exec.invoke('p0', 'q')).rejects.toBeInstanceOf(ProviderDepthError)
  })

  it('expand: 每个 A-handle 用其字段参数化 B，B items 装配进该条 links[]', async () => {
    const bParams: Array<Record<string, unknown> | undefined> = []
    behaviors['a-src'] = async () => [
      { title: 'S1', detailUrl: 'https://x/detail/1' },
      { title: 'S2', detailUrl: 'https://x/detail/2' },
    ]
    behaviors['b-src'] = async (_input, params) => {
      bParams.push(params)
      const id = String((params as { detailUrl: string }).detailUrl).split('/').pop()
      return [{ title: `row-${id}`, link: `magnet:?xt=urn:btih:${id}` }]
    }
    putProvider({
      id: 'exp', category: 'search', strategy: 'expand',
      members: [{ source: 'a-src' }, { source: 'b-src' }],
      expand: { map: { detailUrl: '$item.detailUrl' }, assemble: { url: '$item.link', type: 'pathClassify', desc: '$item.title' } },
    })
    const r = await exec.invoke('exp', 'q')
    expect(r?.strategy).toBe('expand')
    const items = (r as { items: Array<{ title: string; links: Array<{ url: string; type: string; desc: string }> }> }).items
    expect(items.map((i) => i.title)).toEqual(['S1', 'S2'])
    expect(items[0].links).toEqual([{ url: 'magnet:?xt=urn:btih:1', type: 'magnet', desc: 'row-1' }])
    expect(bParams).toEqual([{ detailUrl: 'https://x/detail/1' }, { detailUrl: 'https://x/detail/2' }])
  })

  it('expand: 单个 B 失败被跳过不拖垮整体', async () => {
    behaviors['a-src'] = async () => [{ title: 'ok', detailUrl: 'u/1' }, { title: 'boom', detailUrl: 'u/2' }]
    behaviors['b-src'] = async (_i, p) => {
      if ((p as { detailUrl: string }).detailUrl === 'u/2') throw new Error('drill failed')
      return [{ title: 'r', link: 'magnet:?xt=urn:btih:1' }]
    }
    putProvider({ id: 'exp', category: 'search', strategy: 'expand', members: [{ source: 'a-src' }, { source: 'b-src' }],
      expand: { map: { detailUrl: '$item.detailUrl' }, assemble: { url: '$item.link', type: 'pathClassify', desc: '$item.title' } } })
    const r = await exec.invoke('exp', 'q')
    const items = (r as { items: Array<{ title: string }> }).items
    expect(items.map((i) => i.title)).toEqual(['ok'])
    expect((r as { misses: unknown[] }).misses.length).toBe(1)
  })

  it('expand: handle 数超 cap 只展开前 cap 个', async () => {
    behaviors['a-src'] = async () => Array.from({ length: 5 }, (_, i) => ({ title: `S${i}`, detailUrl: `u/${i}` }))
    behaviors['b-src'] = async () => [{ title: 'r', link: 'magnet:?xt=urn:btih:1' }]
    putProvider({ id: 'exp', category: 'search', strategy: 'expand', members: [{ source: 'a-src' }, { source: 'b-src' }],
      expand: { map: { detailUrl: '$item.detailUrl' }, assemble: { url: '$item.link', type: 'pathClassify', desc: '$item.title' }, handleCap: 2 } })
    const r = await exec.invoke('exp', 'q')
    expect((r as { items: unknown[] }).items.length).toBe(2)
  })

  /** 库里的 CHECK 约束拦得住写入,拦不住内存造行(导入/迁移/手改 db 都能造出来)。
   *  分发认不出这个名字时必须响亮报错——静默落进某个分支等于换了个策略偷偷跑。 */
  function executorWithRow(row: ProviderRecord): ProviderExecutor {
    const fakeStore = {
      listProviders: () => [row],
      getProvider: (id: string) => (id === row.id ? row : null),
    }
    return new ProviderExecutor({
      directory: new ProviderDirectory(fakeStore, SYSTEM_IDENTITIES), registry, stats,
      fetchSource: async () => [{ from: 'whatever' }],
    })
  }

  it('不认识的策略名响亮报错,不静默当 sequential 跑', async () => {
    const row: ProviderRecord = {
      id: 'weird', label: '', description: '', category: 'search', serves: ['k'],
      strategy: 'made-up' as never, members: [{ source: 'nt-mirror' }], contract: null, options: {},
    }
    await expect(executorWithRow(row).invoke(row.id, 'k'))
      .rejects.toThrow(/unknown strategy "made-up"/)
  })

  it('不认识的策略名在 collect 面同样响亮报错', async () => {
    const row: ProviderRecord = {
      id: 'weird2', label: '', description: '', category: 'search', serves: ['k'],
      strategy: 'made-up' as never, members: [{ source: 'nt-mirror' }], contract: null, options: {},
    }
    await expect(executorWithRow(row).collect(row.id, 'k'))
      .rejects.toThrow(/unknown strategy "made-up"/)
  })

  it('expand 行不支持 collect：说清楚而不是 undefined 崩', async () => {
    const row: ProviderRecord = {
      id: 'exp-collect', label: '', description: '', category: 'search', serves: ['k'],
      strategy: 'expand', members: [{ source: 'nt-mirror' }, { source: 'nt-primary' }], contract: null, options: {},
      expand: { map: { detailUrl: '$item.detailUrl' }, assemble: { url: '$item.link', type: 'pathClassify', desc: '$item.title' } },
    }
    await expect(executorWithRow(row).collect(row.id, 'k'))
      .rejects.toThrow(/strategy "expand" does not support collect/)
  })

  it('sequential: object 型成员的判决对象原样胜出（r.value 是对象本身）', async () => {
    behaviors.probe = async (input) => ({ validity: 'alive', files: [{ name: String(input) }] })
    putProvider({ id: 'p', serves: ['k'], members: [{ source: 'probe' }] })
    const r = (await exec.invoke('p', 'X1'))!
    expect(r.strategy).toBe('sequential')
    if (r.strategy === 'sequential') {
      expect(r.value).toEqual({ validity: 'alive', files: [{ name: 'X1' }] })
      expect(r.via).toBe('probe')
    }
  })

  it('sequential: object 型成员返回 null = decline 落 miss', async () => {
    behaviors.probe = async () => null
    behaviors.backup = async () => ({ validity: 'unknown', files: [] })
    putProvider({ id: 'p', serves: ['k'], members: [{ source: 'probe' }, { source: 'backup' }] })
    const r = (await exec.invoke('p', 'X'))!
    if (r.strategy === 'sequential') {
      expect(r.via).toBe('backup')
      expect(r.misses).toEqual([{ member: 'probe', reason: 'declined (no result)' }])
    }
  })

  it('sequential: empty-result decline falls over, first non-empty source wins with via + misses', async () => {
    behaviors.a = async () => []
    behaviors.b = async (input) => [{ got: input }]
    putProvider({ id: 'p', serves: ['k'], members: [{ source: 'a' }, { source: 'b' }] })
    const r = (await exec.invoke('p', 'X'))!
    expect(r).toMatchObject({ strategy: 'sequential', value: [{ got: 'X' }], via: 'b' })
    expect(r.misses).toEqual([{ member: 'a', reason: 'declined (no result)' }])
    expect(stats.of('p').byMember).toEqual({ a: 1, b: 1 }) // 每次真实 attempt 打点
  })

  it('sequential: lossless contract applies to the first element and falls to the next member', async () => {
    behaviors.lossy = async () => [{ format: 'mp3', bitDepth: 0 }]
    behaviors.lossless = async () => [{ format: 'flac' }]
    putProvider({
      id: 'dl', category: 'download', serves: ['netease'],
      members: [{ source: 'lossy' }, { source: 'lossless' }], contract: { accept: 'lossless' },
    })
    const r = (await exec.invoke('dl', { id: '1' }))!
    expect(r).toMatchObject({ via: 'lossless' })
    expect(r.misses[0]).toEqual({ member: 'lossy', reason: 'result did not meet the contract' })
  })

  it('sequential: throwing source is a miss with its message; all-fail returns value null', async () => {
    behaviors.boom = async () => { throw new Error('upstream 500') }
    putProvider({ id: 'p2', members: [{ source: 'boom' }] })
    const r = (await exec.invoke('p2', 'x'))!
    expect(r).toMatchObject({ strategy: 'sequential', value: null, via: null })
    expect(r.misses).toEqual([{ member: 'boom', reason: 'upstream 500', stack: expect.any(String) }])
  })

  it('concurrent: merges every member result, lists contributing sources, failures become misses', async () => {
    behaviors.s1 = async () => [{ id: 1 }, { id: 2 }]
    behaviors.s2 = async () => { throw new Error('down') }
    behaviors.s3 = async () => [{ id: 3 }]
    putProvider({
      id: 'srch', category: 'search', serves: ['content'], strategy: 'concurrent',
      members: [{ source: 's1' }, { source: 's2' }, { source: 's3' }],
    })
    const r = (await exec.invoke('srch', 'q'))!
    expect(r.strategy).toBe('concurrent')
    if (r.strategy === 'concurrent') {
      expect(r.items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
      expect(r.sources).toEqual(['s1', 's3'])
    }
    expect(r.misses).toEqual([{ member: 's2', reason: 'down', stack: expect.any(String) }])
  })

  it('顺次行不支持 collect：首胜即停与"全收"自相矛盾，响亮拒绝', async () => {
    behaviors.first = async () => [{ id: 'first' }]
    putProvider({
      id: 'seq-collect', category: 'resolve', strategy: 'sequential',
      members: [{ source: 'first' }],
    })

    await expect(exec.collect('seq-collect', { title: 'Example' }))
      .rejects.toThrow(/strategy "sequential" does not support collect \(row seq-collect\)/)
  })

  it('collect concurrent: keeps every success in declared order and keeps failures', async () => {
    behaviors.first = async () => [{ id: 'first' }]
    behaviors.broken = async () => { throw new Error('offline') }
    behaviors.third = async () => [{ id: 'third' }]
    putProvider({
      id: 'detail', category: 'resolve', strategy: 'concurrent',
      members: [{ source: 'first' }, { source: 'broken' }, { source: 'third' }],
    })

    const r = (await exec.collect('detail', { title: 'Example' }))!

    expect(r.strategy).toBe('concurrent')
    expect(r.results).toEqual([
      { member: 'first', value: [{ id: 'first' }] },
      { member: 'third', value: [{ id: 'third' }] },
    ])
    expect(r.misses).toEqual([{ member: 'broken', reason: 'offline', stack: expect.any(String) }])
    expect(fetched.map((f) => f.sourceId)).toEqual(['first', 'broken', 'third'])
  })

  it('collect concurrent: returns declared member order rather than completion order', async () => {
    behaviors.slow = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return [{ id: 'slow' }]
    }
    behaviors.fast = async () => [{ id: 'fast' }]
    putProvider({
      id: 'images', category: 'resolve', strategy: 'concurrent',
      members: [{ source: 'slow' }, { source: 'fast' }],
    })

    const r = (await exec.collect('images', { title: 'Example' }))!

    expect(r.strategy).toBe('concurrent')
    expect(r.results).toEqual([
      { member: 'slow', value: [{ id: 'slow' }] },
      { member: 'fast', value: [{ id: 'fast' }] },
    ])
    expect(r.misses).toEqual([])
  })

  it('concurrent: every merged item carries its producing source (per-item provenance)', async () => {
    behaviors.s1 = async () => [{ id: 1 }, { id: 2 }]
    behaviors.s3 = async () => [{ id: 3 }]
    putProvider({
      id: 'prov', category: 'search', serves: ['content'], strategy: 'concurrent',
      members: [{ source: 's1' }, { source: 's3' }],
    })
    const r = (await exec.invoke('prov', 'q'))!
    if (r.strategy === 'concurrent') {
      // each item traces back to the source that produced it — aligned to the merged order
      expect(r.items.map((it) => sourceOf(it))).toEqual(['s1', 's1', 's3'])
      // provenance is non-enumerable: invisible to structural equality AND to JSON serialization
      expect(r.items[0]).toEqual({ id: 1 })
      expect(JSON.parse(JSON.stringify(r.items[0]))).toEqual({ id: 1 })
    }
  })

  it('provides auto segment carries its params ($input filled), symmetric with the matches segment', async () => {
    const seen: Array<{ sourceId: string; params?: Record<string, unknown> }> = []
    behaviors['nt-primary'] = async (_input, params) => { seen.push({ sourceId: 'nt-primary', params }); return [{ a: 1 }] }
    behaviors['nt-mirror'] = async (_input, params) => { seen.push({ sourceId: 'nt-mirror', params }); return [{ b: 2 }] }
    putProvider({
      id: 'cs', category: 'search', serves: ['content'], strategy: 'concurrent',
      members: [{ mode: 'auto', provides: 'netease-track', params: { mode: 'search', keyword: '$input', count: 20 } }],
    })
    // resolvedMembers surfaces the segment params on every expanded provides member ($input unfilled)
    expect(exec.resolvedMembers(store.getProvider('cs')!).map((m) => m.params)).toEqual([
      { mode: 'search', keyword: '$input', count: 20 },
      { mode: 'search', keyword: '$input', count: 20 },
    ])
    await exec.invoke('cs', 'camping')
    // each member fetched with $input filled from the call
    expect(seen.map((s) => s.sourceId)).toEqual(['nt-primary', 'nt-mirror'])
    expect(seen[0].params).toEqual({ mode: 'search', keyword: 'camping', count: 20 })
  })

  it('auto member segment expands from registry provides order; exclude applies by name', async () => {
    putProvider({
      id: 'nt', serves: ['music.163.com'],
      members: [{ mode: 'auto', provides: 'netease-track' }],
    })
    const r = (await exec.invoke('nt', '42'))!
    // nt-primary declines (empty) → nt-mirror wins; both attempted through fetchSource
    expect(fetched.map((f) => f.sourceId)).toEqual(['nt-primary', 'nt-mirror'])
    expect(r).toMatchObject({ via: 'nt-mirror' })

    store.patchProvider('nt', { options: { exclude: ['nt-primary'] } })
    fetched = []
    await exec.invoke('nt', '42')
    expect(fetched.map((f) => f.sourceId)).toEqual(['nt-mirror'])
  })

  it('match: 具名压兜底；category 必须一致；按 (category,key) 直接路由过去', async () => {
    behaviors.generic = async () => [{ via: 'generic' }]
    behaviors.special = async () => [{ via: 'special' }]
    putProvider({ id: 'fallback', category: 'transform', serves: ['*'], members: [{ source: 'generic' }] })
    putProvider({ id: 'bili', category: 'transform', serves: ['bilibili.com'], members: [{ source: 'special' }] })
    expect(exec.match('transform', 'bilibili.com').map((p) => p.id)).toEqual(['bili'])
    expect(exec.match('transform', 'unknown.com').map((p) => p.id)).toEqual(['fallback'])
    expect(exec.match('search', 'bilibili.com')).toEqual([])

    const r = (await exec.invoke({ category: 'transform', key: 'unknown.com' }, 'u'))!
    expect(r).toMatchObject({ via: 'generic', provider: 'fallback' })
  })

  it('fallback:false 时兜底行不算命中——守门方（网盘三处）就是靠这个说“不支持”', () => {
    putProvider({ id: 'fallback', category: 'transform', serves: ['*'], members: [{ source: 'generic' }] })
    putProvider({ id: 'bili', category: 'transform', serves: ['bilibili.com'], members: [{ source: 'special' }] })
    const directory = new ProviderDirectory(store, SYSTEM_IDENTITIES)
    expect(directory.match('transform', 'unknown.com', { fallback: false })).toEqual([])
    expect(directory.match('transform', 'bilibili.com', { fallback: false }).map((m) => m.row.id)).toEqual(['bili'])
  })

  it('落到兜底行的那次调用，信封上带 viaFallback；具名命中与按 id 直调都不带', async () => {
    behaviors.generic = async () => [{ via: 'generic' }]
    behaviors.special = async () => [{ via: 'special' }]
    // 这一条也走 collect，所以兜底行用 concurrent（collect 只有全收语义的行支持）。
    putProvider({ id: 'fallback', category: 'transform', serves: ['*'], strategy: 'concurrent', members: [{ source: 'generic' }] })
    putProvider({ id: 'bili', category: 'transform', serves: ['bilibili.com'], members: [{ source: 'special' }] })
    expect((await exec.invoke({ category: 'transform', key: 'unknown.com' }, 'u'))!.viaFallback).toBe(true)
    expect((await exec.invoke({ category: 'transform', key: 'bilibili.com' }, 'u'))!.viaFallback).toBeUndefined()
    expect((await exec.invoke('fallback', 'u'))!.viaFallback).toBeUndefined()
    expect((await exec.collect({ category: 'transform', key: 'unknown.com' }, 'u'))!.viaFallback).toBe(true)
    expect((await exec.collect('fallback', 'u'))!.viaFallback).toBeUndefined()
  })

  it('invoke unknown id or unmatched (variant,key) returns null', async () => {
    expect(await exec.invoke('nope', 'x')).toBeNull()
    expect(await exec.invoke({ category: 'download', key: 'zzz' }, 'x')).toBeNull()
  })

  it('matches auto segment expands via registry.matching, injecting the segment params ($input filled)', async () => {
    const seen: Array<{ sourceId: string; params?: Record<string, unknown> }> = []
    behaviors['zuna-dl'] = async (_input, params) => { seen.push({ sourceId: 'zuna-dl', params }); return [] }
    behaviors['toubiec-dl'] = async (_input, params) => { seen.push({ sourceId: 'toubiec-dl', params }); return [{ ok: 1 }] }
    putProvider({
      id: 'ntm', serves: ['music.163.com'],
      members: [{ mode: 'auto', matches: 'music.163.com/song', params: { id: '$input', level: 'lossless' } }],
    })
    const r = (await exec.invoke('ntm', '42'))!
    // priority order zuna → toubiec; each carries the segment params with $input filled from the call
    expect(seen.map((s) => s.sourceId)).toEqual(['zuna-dl', 'toubiec-dl'])
    expect(seen[0].params).toEqual({ id: '42', level: 'lossless' })
    expect(r).toMatchObject({ via: 'toubiec-dl' })
  })

  it('category auto segment expands via registry.inCategory，每个源用自己的 key_param 装 $input', async () => {
    const seen: Array<{ sourceId: string; params?: Record<string, unknown> }> = []
    behaviors['pod-a'] = async (_i, params) => { seen.push({ sourceId: 'pod-a', params }); return [] }
    behaviors['pod-b'] = async (_i, params) => { seen.push({ sourceId: 'pod-b', params }); return [{ ok: 1 }] }
    putProvider({ id: 'pf', serves: ['podcast'], members: [{ mode: 'auto', category: 'podcast' }] })
    const r = (await exec.invoke('pf', '42'))!
    expect(seen).toEqual([
      { sourceId: 'pod-a', params: { id: '42' } },
      { sourceId: 'pod-b', params: { uid: '42' } },
    ])
    expect(r).toMatchObject({ via: 'pod-b' })
  })

  it('dedups across expansion by source id — an earlier pin suppresses the same id from a later auto segment', async () => {
    behaviors['zuna-dl'] = async () => [{ ok: 1 }]
    behaviors['toubiec-dl'] = async () => [{ ok: 2 }]
    putProvider({
      id: 'ntd', serves: ['music.163.com'], strategy: 'concurrent',
      members: [
        { source: 'zuna-dl', params: { pinned: true } },
        { mode: 'auto', matches: 'music.163.com/song', params: { id: '$input' } },
      ],
    })
    const r = (await exec.invoke('ntd', '7'))!
    // zuna-dl appears once (the pin), toubiec-dl once (from the auto segment)
    expect(exec.resolvedMembers(store.getProvider('ntd')!).map((m) => m.name)).toEqual(['zuna-dl', 'toubiec-dl'])
    if (r.strategy === 'concurrent') expect(r.sources).toEqual(['zuna-dl', 'toubiec-dl'])
  })

  it('substitutes $input holes in member params before dispatch', async () => {
    const seen: unknown[] = []
    behaviors.holey = async (_input, params) => { seen.push(params); return [{ ok: 1 }] }
    putProvider({ id: 'h', members: [{ source: 'holey', params: { song_id: '$input', level: 'lossless' } }] })
    await exec.invoke('h', '99')
    expect(seen[0]).toEqual({ song_id: '99', level: 'lossless' })
  })

  it('opts.overrides merge over member params by key at call time', async () => {
    const seen: Array<Record<string, unknown> | undefined> = []
    behaviors.cap = async (_input, params) => { seen.push(params); return [{ ok: 1 }] }
    putProvider({ id: 'ov', members: [{ source: 'cap', params: { id: '$input', level: 'lossless' } }] })
    await exec.invoke('ov', 'song123', { overrides: { level: 'exhigh' } })
    expect(seen[0]).toEqual({ id: 'song123', level: 'exhigh' })
  })

  it('opts.accept overrides the row contract for this call (skips non-lossless)', async () => {
    behaviors.lossy = async () => [{ format: 'mp3' }]
    behaviors.flac = async () => [{ format: 'flac' }]
    putProvider({ id: 'nc', members: [{ source: 'lossy' }, { source: 'flac' }], contract: null })
    const r = (await exec.invoke('nc', 'x', { accept: 'lossless' }))!
    expect(r).toMatchObject({ via: 'flac' })
    // without accept, the first (mp3) wins since the row has no contract
    const r2 = (await exec.invoke('nc', 'x'))!
    expect(r2).toMatchObject({ via: 'lossy' })
  })

  it('同一 source 两个实例名共存,各自寻址;调用账本按实例名分开', async () => {
    const seen: Array<Record<string, unknown> | undefined> = []
    behaviors['llm-openai'] = async (_input, params) => { seen.push(params); return [{ tag: params?.tag }] }
    putProvider({
      // 行 id 刻意不用系统 id `llm`：系统行的身份（category/serves/strategy/contract）由代码说了算，
      // 拿系统 id 建一条 strategy 不同的行是配不出来的形状，测不出这里要测的实例名寻址。
      id: 'llm-multi', category: 'llm', serves: ['summarize'], strategy: 'concurrent',
      members: [
        { source: 'llm-openai', name: 'deepseek', params: { tag: 'A' } },
        { source: 'llm-openai', name: 'kimi', params: { tag: 'B' } },
      ],
    })
    // 寻址键 = 实例名;真源 id 一并带回(视图层按它查 manifest/health)
    const rm = exec.resolvedMembers(store.getProvider('llm-multi')!)
    expect(rm.map((m) => m.name)).toEqual(['deepseek', 'kimi'])
    expect(rm.map((m) => m.sourceId)).toEqual(['llm-openai', 'llm-openai'])

    const r = (await exec.invoke('llm-multi', 'q'))!
    // 两个实例都真的跑了,且 fetchSource 收到的是真源 id、各自的 params
    expect(fetched.map((f) => f.sourceId)).toEqual(['llm-openai', 'llm-openai'])
    expect(seen).toEqual([{ tag: 'A' }, { tag: 'B' }])
    if (r.strategy === 'concurrent') {
      expect(r.sources).toEqual(['deepseek', 'kimi']) // 行级贡献者 = 寻址键
      // 但 per-item 溯源标的是**真源 id**:读回它的调用点拿它查 manifest/normalizer
      expect(r.items.map((it) => sourceOf(it))).toEqual(['llm-openai', 'llm-openai'])
    }
    // 账本 byMember 的键是实例名,不再被同源合并成一条
    expect(stats.of('llm-multi').byMember).toEqual({ deepseek: 1, kimi: 1 })

    // exclude 按实例名过滤:排掉 deepseek 只剩 kimi 参战
    store.patchProvider('llm-multi', { options: { exclude: ['deepseek'] } })
    fetched = []
    const r2 = (await exec.invoke('llm-multi', 'q'))!
    expect(fetched.length).toBe(1)
    if (r2.strategy === 'concurrent') expect(r2.sources).toEqual(['kimi'])
  })

  it('sequential 行里同源双实例:第一个 decline 时降级到第二个,via 是实例名', async () => {
    behaviors['llm-openai'] = async (_input, params) => (params?.tag === 'A' ? [] : [{ ok: 1 }])
    putProvider({
      id: 'llmseq', category: 'llm', strategy: 'sequential',
      members: [
        { source: 'llm-openai', name: 'a', params: { tag: 'A' } },
        { source: 'llm-openai', name: 'b', params: { tag: 'B' } },
      ],
    })
    const r = (await exec.invoke('llmseq', 'q'))!
    expect(r).toMatchObject({ via: 'b' })
    expect(r.misses.map((m) => m.member)).toEqual(['a'])
    expect(r.timings.map((t) => t.member)).toEqual(['a', 'b'])
  })

  it('不带 name 的成员:寻址键退化为 sourceId,行为与旧版逐字节一致', async () => {
    behaviors['zuna-dl'] = async () => [{ ok: 1 }]
    putProvider({ id: 'plain', strategy: 'concurrent', members: [{ source: 'zuna-dl', params: { p: 1 } }] })
    expect(exec.resolvedMembers(store.getProvider('plain')!)).toEqual([
      { name: 'zuna-dl', sourceId: 'zuna-dl', params: { p: 1 }, kind: 'source' },
    ])
    const r = (await exec.invoke('plain', 'x'))!
    if (r.strategy === 'concurrent') expect(r.sources).toEqual(['zuna-dl'])
    expect(stats.of('plain').byMember).toEqual({ 'zuna-dl': 1 })
  })
})

// ── 一个慢成员不许绑架整次并发扇出 ────────────────────────────────────────────────────
//
// 活体（2026-07-29）：内容搜索里 douyin-search 跑了 115s / 139s，整个搜索就陪着它——用户
// 等了两分钟，而 xhs 3s 的结果早就躺在那儿了。video search 早有
// VIDEO_SOURCE_TIMEOUT_MS，expand 有单钻超时+总预算，唯独这条并发路没有。
describe('ProviderExecutor 并发成员超时', () => {
  let dir: string
  let store: UserStore
  let stats: ProviderStatsStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exec-timeout-'))
    store = new UserStore(join(dir, 'stream.db'))
    stats = new ProviderStatsStore(join(dir, 'cache.db'))
    store.putProvider({
      id: 'search', label: '', description: '', category: 'search', strategy: 'concurrent',
      serves: ['*'], members: [{ source: 'fast' }, { source: 'slow' }],
      contract: null, options: {},
    } as never)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const build = (perMemberTimeoutMs: number, delays: Record<string, number>) =>
    new ProviderExecutor({
      directory: new ProviderDirectory(store, SYSTEM_IDENTITIES),
      registry: new Registry([mk({ id: 'fast' }), mk({ id: 'slow' })]),
      stats,
      perMemberTimeoutMs,
      fetchSource: async (sourceId) => {
        await new Promise((r) => setTimeout(r, delays[sourceId] ?? 0))
        return [{ id: sourceId }]
      },
    })

  it('慢成员超时后，快成员的结果照常返回', async () => {
    const r = await build(50, { fast: 0, slow: 5000 }).invoke('search', 'q')
    expect(r?.strategy).toBe('concurrent')
    expect(((r as { items: Array<{ id: string }> }).items).map((i) => i.id)).toEqual(['fast'])
  })

  it('超时的成员变成 miss，说清楚它是超时不是别的', async () => {
    // 用户看到的必须是"抖音超时了"，不是结果里悄悄少一个源。
    const r = await build(50, { fast: 0, slow: 5000 }).invoke('search', 'q')
    const miss = (r as { misses: Array<{ member: string; reason: string }> }).misses
      .find((m) => m.member === 'slow')
    expect(miss).toBeTruthy()
    expect(miss!.reason).toMatch(/timed out/i)
  })

  it('超时的成员在 timings 里记成 error —— 分源明细要能看见它', async () => {
    const r = await build(50, { fast: 0, slow: 5000 }).invoke('search', 'q')
    const t = (r as { timings: Array<{ member: string; outcome: string }> }).timings
      .find((x) => x.member === 'slow')
    expect(t?.outcome).toBe('error')
  })

  it('不配超时就不超时 —— 别给别的调用点凭空加一道闸', async () => {
    const r = await build(0, { fast: 0, slow: 30 }).invoke('search', 'q')
    expect(((r as { items: Array<{ id: string }> }).items).map((i) => i.id).sort()).toEqual(['fast', 'slow'])
  })

  it('manifest.member_timeout_ms 覆盖默认闸——慢源自己申报更长墙钟,只慢自己这一格', async () => {
    // douyin 拟人路径 ~40s > 默认 25s:按源申报,别把全局闸抬高让所有搜索陪等。
    const exec = new ProviderExecutor({
      directory: new ProviderDirectory(store, SYSTEM_IDENTITIES),
      registry: new Registry([mk({ id: 'fast' }), mk({ id: 'slow', member_timeout_ms: 5000 })]),
      stats,
      perMemberTimeoutMs: 50,
      fetchSource: async (sourceId) => {
        await new Promise((r) => setTimeout(r, sourceId === 'slow' ? 200 : 0))
        return [{ id: sourceId }]
      },
    })
    const r = await exec.invoke('search', 'q')
    // slow 用了 200ms(> 默认 50ms 闸、< 自己申报的 5s)——不该被砍
    expect(((r as { items: Array<{ id: string }> }).items).map((i) => i.id).sort()).toEqual(['fast', 'slow'])
  })
})

/**
 * 包出的 Provider 行可以申报 `provides`，于是 `{mode:'auto', provides}` 段把它当组合成员收进去——
 * 宿主的聚合行（资源搜索）不必再点名任何站的组合体。行拿到的是**原始输入**（它自己的成员各自
 * 填 `$input`），段参数只给源成员用。
 */
describe('auto provides 段也收申报了 provides 的 Provider 行', () => {
  let dir: string
  let store: UserStore
  let stats: ProviderStatsStore
  const identity = (id: string, provides?: string[]): SystemIdentity => ({
    id, category: 'search', serveKeys: [id], fallback: false, strategy: 'concurrent', contract: null,
    defaultLabel: id, defaultDescription: id, defaultMembers: [], ...(provides ? { provides } : {}),
  })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exec-provides-'))
    store = new UserStore(join(dir, 'stream.db'))
    stats = new ProviderStatsStore(join(dir, 'cache.db'))
  })
  afterEach(() => { store.close(); stats.close(); rmSync(dir, { recursive: true, force: true }) })

  function build(identities: SystemIdentity[], fetchSource: (id: string, input: unknown, params?: Record<string, unknown>) => Promise<unknown[]>) {
    const put = (id: string, members: ProviderRecord['members']) => store.putProvider({
      id, label: id, description: '', category: 'search', serves: [id], strategy: 'concurrent', members, contract: null, options: {},
    })
    const registry = new Registry([mk({ id: 'kw-src', provides: ['search-x'] })])
    const exec = new ProviderExecutor({
      directory: new ProviderDirectory(store, new Map(identities.map((i) => [i.id, i]))), registry, stats, fetchSource,
    })
    return { put, exec }
  }

  it('聚合行的 auto 段 = 源成员 + 申报了同一标签的行；行拿原始输入', async () => {
    const calls: Array<{ id: string; input: unknown; params?: Record<string, unknown> }> = []
    const { put, exec } = build([identity('agg'), identity('combo', ['search-x']), identity('other', ['search-y'])], async (id, input, params) => {
      calls.push({ id, input, params })
      return [{ from: id }]
    })
    put('agg', [{ mode: 'auto', provides: 'search-x', params: { keyword: '$input' } }])
    put('combo', [{ source: 'combo-src', params: { name: '$input' } }])
    put('other', [{ source: 'other-src' }])

    expect(exec.resolvedMembers(store.getProvider('agg')!)).toEqual([
      { name: 'kw-src', sourceId: 'kw-src', params: { keyword: '$input' }, kind: 'source' },
      { name: 'combo', sourceId: 'combo', params: undefined, kind: 'provider' },
    ])
    const r = await exec.invoke('agg', '上载新生')
    expect((r as { items: unknown[] }).items.map((i) => sourceOf(i)).sort()).toEqual(['combo', 'kw-src'])
    expect(calls.find((c) => c.id === 'kw-src')?.params).toEqual({ keyword: '上载新生' })
    expect(calls.find((c) => c.id === 'combo-src')?.params).toEqual({ name: '上载新生' })
    expect(calls.some((c) => c.id === 'other-src')).toBe(false)
  })

  it('行自己申报了这个标签、自己又有这个 auto 段 → 不把自己收进来（不是环）', async () => {
    const { put, exec } = build([identity('agg', ['search-x'])], async (id) => [{ from: id }])
    put('agg', [{ mode: 'auto', provides: 'search-x' }])
    expect(exec.resolvedMembers(store.getProvider('agg')!).map((m) => m.name)).toEqual(['kw-src'])
    await expect(exec.invoke('agg', 'q')).resolves.toBeTruthy()
  })

  it('显式 {provider} 成员在前 → auto 段不重复收它；exclude 按行 id 生效', async () => {
    const { put, exec } = build([identity('agg'), identity('combo', ['search-x'])], async (id) => [{ from: id }])
    put('agg', [{ provider: 'combo' }, { mode: 'auto', provides: 'search-x' }])
    put('combo', [{ source: 'combo-src' }])
    expect(exec.resolvedMembers(store.getProvider('agg')!).map((m) => m.name)).toEqual(['combo', 'kw-src'])
    store.patchProvider('agg', { members: [{ mode: 'auto', provides: 'search-x' }], options: { exclude: ['combo'] } })
    expect(exec.resolvedMembers(store.getProvider('agg')!).map((m) => m.name)).toEqual(['kw-src'])
  })
})
