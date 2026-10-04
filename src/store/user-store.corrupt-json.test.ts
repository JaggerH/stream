/**
 * stream.db 里一格 JSON 写坏了（手工改库、导入残缺分享包、迁移中断），**整张表不能因此消失**。
 *
 * 代价不是"少一个频道"：`listChannels()` 在开机路径上（采集调度装载、研究频道 watcher 注册），
 * 裸 `JSON.parse` 抛出去的下场是后端根本起不来——8900 上没人听，而现象长得像"改崩了"。
 * 所以这里钉两件事：坏的那一行降级成空值**照常列出**，且每一次降级都往回调喊一声（用户可见的
 * 通知就接在那上面，`dedupeKey` 由 `table:rowId:column` 三格拼成，见 bootstrap 的 onRowDegraded）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { UserStore, type RowDegradation } from './user-store.ts'

/** 通知那一端就是这么拼 dedupeKey 的——同一个坏格子只吵一次。 */
const dedupeKeyOf = (d: RowDegradation): string => `store-row-degraded:${d.table}:${d.rowId}:${d.column}`

describe('UserStore：坏掉的 JSON 列降级读出，不掀翻整张表', () => {
  let dir: string
  let dbPath: string
  let store: UserStore
  let degraded: RowDegradation[]

  /** 绕过 store 直接把某一格写成非法 JSON——这正是现实里坏数据的来路（不经 put*）。 */
  const corrupt = (table: string, id: string, column: string, raw: string, keyColumn = 'id'): void => {
    const db = new Database(dbPath)
    const changed = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${keyColumn} = ?`).run(raw, id).changes
    db.close()
    // 夹具没写进去却断言"降级了"，会得到一条永远绿的假测试
    expect(changed).toBe(1)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'user-store-corrupt-'))
    dbPath = join(dir, 'stream.db')
    degraded = []
    store = new UserStore(dbPath, undefined, (info) => { degraded.push(info) })
    // console.warn 是给排查的那一路，测试里不需要看它刷屏
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const putChannels = (): void => {
    store.putChannel({ id: 'ch-bad', label: '坏的', present: 'timeline', stream_ids: ['s1'], system: false, options: { a: 1 } })
    store.putChannel({ id: 'ch-ok', label: '好的', present: 'timeline', stream_ids: ['s2'], system: false, options: { b: 2 } })
  }
  const putStreams = (): void => {
    store.putStream({ id: 'st-bad', label: '坏流', strategy: 'fanout', cadence_seconds: 60, members: [], contract: { c: 1 }, options: {} })
    store.putStream({ id: 'st-ok', label: '好流', strategy: 'fanout', cadence_seconds: 60, members: [], options: {} })
  }

  it('channels.stream_ids 坏 → 那一行降级成 []，其它行照常列出', () => {
    putChannels()
    corrupt('channels', 'ch-bad', 'stream_ids', '[{"broken"')
    const list = store.listChannels()
    expect(list.map((c) => c.id)).toContain('ch-bad')
    expect(list.map((c) => c.id)).toContain('ch-ok')
    expect(list.find((c) => c.id === 'ch-bad')!.stream_ids).toEqual([])
    // 降级只波及坏的那一格：同一行的 options、以及好的那一行都原样
    expect(list.find((c) => c.id === 'ch-bad')!.options).toEqual({ a: 1 })
    expect(list.find((c) => c.id === 'ch-ok')!.stream_ids).toEqual(['s2'])
    expect(degraded).toEqual([
      { table: 'channels', rowId: 'ch-bad', column: 'stream_ids', fallback: '[]', raw: '[{"broken"' },
    ])
    expect(dedupeKeyOf(degraded[0]!)).toBe('store-row-degraded:channels:ch-bad:stream_ids')
  })

  it('channels.options 坏 → 降级成 {}', () => {
    putChannels()
    corrupt('channels', 'ch-bad', 'options', 'not json')
    const bad = store.getChannel('ch-bad')!
    expect(bad.options).toEqual({})
    expect(bad.stream_ids).toEqual(['s1'])
    expect(degraded.map(dedupeKeyOf)).toEqual(['store-row-degraded:channels:ch-bad:options'])
  })

  it('streams.members 坏 → 降级成 []，listStreams() 不抛', () => {
    putStreams()
    corrupt('streams', 'st-bad', 'members', '{{{')
    const list = store.listStreams()
    expect(list.map((s) => s.id)).toContain('st-bad')
    expect(list.map((s) => s.id)).toContain('st-ok')
    expect(list.find((s) => s.id === 'st-bad')!.members).toEqual([])
    expect(degraded).toEqual([
      { table: 'streams', rowId: 'st-bad', column: 'members', fallback: '[]', raw: '{{{' },
    ])
    expect(dedupeKeyOf(degraded[0]!)).toBe('store-row-degraded:streams:st-bad:members')
  })

  it('streams.contract 坏 → 降级成 undefined', () => {
    putStreams()
    corrupt('streams', 'st-bad', 'contract', '<html>nope</html>')
    const bad = store.getStream('st-bad')!
    expect(bad.contract).toBeUndefined()
    expect(degraded.map((d) => [d.column, d.fallback])).toEqual([['contract', 'undefined']])
  })

  it('streams.options 坏 → 降级成 {}', () => {
    putStreams()
    corrupt('streams', 'st-bad', 'options', 'undefined')
    expect(store.getStream('st-bad')!.options).toEqual({})
    expect(degraded.map((d) => [d.column, d.fallback])).toEqual([['options', '{}']])
  })

  // ── providers：和频道/流同一条判据，`listProviders()` 同样在开机路径附近 ──
  const putProviders = (): void => {
    store.putProvider({
      id: 'pv-bad', label: '坏 provider', description: '', category: 'search', serves: ['x'],
      strategy: 'expand', members: [{ id: 'm1' } as any], contract: { c: 1 }, options: { o: 1 },
      expand: { of: 'm1' } as any,
    })
    store.putProvider({
      id: 'pv-ok', label: '好 provider', description: '', category: 'search', serves: ['y'],
      strategy: 'sequential', members: [], options: {},
    })
  }

  it('providers.serves 坏 → 降级成 []，其它 provider 照常列出', () => {
    putProviders()
    corrupt('providers', 'pv-bad', 'serves', '["unclosed')
    const list = store.listProviders()
    expect(list.map((p) => p.id)).toContain('pv-bad')
    expect(list.map((p) => p.id)).toContain('pv-ok')
    expect(list.find((p) => p.id === 'pv-bad')!.serves).toEqual([])
    // 同一行的其它列没被波及
    expect(list.find((p) => p.id === 'pv-bad')!.options).toEqual({ o: 1 })
    expect(list.find((p) => p.id === 'pv-ok')!.serves).toEqual(['y'])
    expect(degraded).toEqual([
      { table: 'providers', rowId: 'pv-bad', column: 'serves', fallback: '[]', raw: '["unclosed' },
    ])
    expect(dedupeKeyOf(degraded[0]!)).toBe('store-row-degraded:providers:pv-bad:serves')
  })

  it('providers.members 坏 → 降级成 []', () => {
    putProviders()
    corrupt('providers', 'pv-bad', 'members', 'oops')
    expect(store.getProvider('pv-bad')!.members).toEqual([])
    expect(degraded.map((d) => [d.column, d.fallback])).toEqual([['members', '[]']])
  })

  it('providers.contract 坏 → 降级成 null（= 接受任何结果，本来就是合法状态）', () => {
    putProviders()
    corrupt('providers', 'pv-bad', 'contract', '{')
    expect(store.getProvider('pv-bad')!.contract).toBeNull()
    expect(degraded.map((d) => [d.column, d.fallback])).toEqual([['contract', 'null']])
  })

  it('providers.options 坏 → 降级成 {}', () => {
    putProviders()
    corrupt('providers', 'pv-bad', 'options', '[,]')
    expect(store.getProvider('pv-bad')!.options).toEqual({})
    expect(degraded.map((d) => [d.column, d.fallback])).toEqual([['options', '{}']])
  })

  it('providers.expand 坏 → 整格缺席，不是塞一个空的 expand 进去', () => {
    putProviders()
    corrupt('providers', 'pv-bad', 'expand', 'nope')
    const bad = store.getProvider('pv-bad')!
    // 「没有 expand」和「有一个空 expand」是两个意思：后者会被 composition 当成"声明了但展不出来"
    expect('expand' in bad).toBe(false)
    expect(degraded.map((d) => d.column)).toEqual(['expand'])
  })

  // ── provider bindings：`provider_ids` 原先裸 parse，`params` 原先静默吞 ──
  it('provider_bindings.provider_ids 坏 → 降级成 []，listProviderBindings() 不抛', () => {
    store.putProviderBinding({ callsiteId: 'cs-bad', providerIds: ['p1'], params: { m: 1 } })
    store.putProviderBinding({ callsiteId: 'cs-ok', providerIds: ['p2'] })
    corrupt('provider_bindings', 'cs-bad', 'provider_ids', '][', 'callsite_id')
    const list = store.listProviderBindings()
    expect(list.map((b) => b.callsiteId)).toEqual(['cs-bad', 'cs-ok'])
    expect(list.find((b) => b.callsiteId === 'cs-bad')!.providerIds).toEqual([])
    expect(list.find((b) => b.callsiteId === 'cs-ok')!.providerIds).toEqual(['p2'])
    expect(dedupeKeyOf(degraded[0]!)).toBe('store-row-degraded:provider_bindings:cs-bad:provider_ids')
  })

  it('provider_bindings.params 坏 → 仍当未设置（行为不变），但不再是静默的', () => {
    store.putProviderBinding({ callsiteId: 'cs', providerIds: ['p1'], params: { m: 1 } })
    corrupt('provider_bindings', 'cs', 'params', 'x', 'callsite_id')
    const b = store.getProviderBinding('cs')!
    expect(b.params).toBeUndefined()
    expect(b.providerIds).toEqual(['p1'])
    expect(degraded.map((d) => [d.column, d.fallback])).toEqual([['params', '未设置']])
  })

  // ── video_details：可重建的缓存侧，降级 = 缓存未命中（调用方本来就在处理 null）──
  it('video_details.detail_json 坏 → 当缓存未命中，getVideoDetail 不抛', () => {
    store.putVideoDetail({
      cacheKey: 'vd-1', identity: {} as any, images: {}, imageCandidates: [], failures: [],
      fetchedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z',
    })
    corrupt('video_details', 'vd-1', 'detail_json', 'truncated{', 'cache_key')
    expect(store.getVideoDetail('vd-1')).toBeNull()
    expect(dedupeKeyOf(degraded[0]!)).toBe('store-row-degraded:video_details:vd-1:detail_json')
  })

  it('正常行一条都不降级（零回归）', () => {
    putChannels()
    putStreams()
    putProviders()
    store.putProviderBinding({ callsiteId: 'cs', providerIds: ['p1'], params: { m: 1 } })
    const channels = store.listChannels()
    const streams = store.listStreams()
    const providers = store.listProviders()
    expect(channels.find((c) => c.id === 'ch-bad')!.stream_ids).toEqual(['s1'])
    expect(channels.find((c) => c.id === 'ch-ok')!.options).toEqual({ b: 2 })
    expect(streams.find((s) => s.id === 'st-bad')!.contract).toEqual({ c: 1 })
    expect(streams.find((s) => s.id === 'st-ok')!.members).toEqual([])
    expect(providers.find((p) => p.id === 'pv-bad')!.serves).toEqual(['x'])
    expect(providers.find((p) => p.id === 'pv-bad')!.expand).toEqual({ of: 'm1' })
    expect(providers.find((p) => p.id === 'pv-ok')!.contract).toBeNull()
    expect(store.getProviderBinding('cs')!.params).toEqual({ m: 1 })
    expect(degraded).toEqual([])
  })

  it('不传回调也不抛（默认那一档只写日志）', () => {
    const quietPath = join(dir, 'quiet.db')
    const quiet = new UserStore(quietPath)
    quiet.putChannel({ id: 'ch', label: 'x', present: 'timeline', stream_ids: [], system: false, options: {} })
    const db = new Database(quietPath)
    db.prepare('UPDATE channels SET options = ? WHERE id = ?').run('nope', 'ch')
    db.close()
    expect(() => quiet.listChannels()).not.toThrow()
    expect(quiet.getChannel('ch')!.options).toEqual({})
    quiet.close()
  })
})
