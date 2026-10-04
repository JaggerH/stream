import { describe, it, expect, vi } from 'vitest'
import { MappingStore } from './mapping-store.ts'
import { openNetdiskDb } from './db.ts'
import { NetdiskService, type LeftEntry } from './sync.ts'
import type { MappingSet } from './types.ts'

/** 残留绑定踩雷现场：目录已被删/移，AList 列目录/取直链都报 `failed get dir: object not found`。 */
const GONE = '[alist] code 500: failed get objs: failed get dir: object not found'

function bind(store: MappingStore, path: string): MappingSet {
  const set: MappingSet = {
    id: 'map_gone',
    left: { kind: 'tmdb', id: '1', media: 'tv', title: '某剧' },
    right: { kind: 'alist-dir', path, boundAt: '2026-07-24T00:00:00.000Z' },
    rightHistory: [],
    autoSync: false,
    entries: [{ leftKey: 'tmdb:1:S01E01', leftTitle: '第一集', rightFile: '第一集.mkv', status: 'auto' }],
  }
  store.save(set)
  return set
}

function svcWith(store: MappingStore, alist: unknown): NetdiskService {
  return new NetdiskService({
    store, alist, listLeft: async (): Promise<LeftEntry[]> => [], invokeLlm: vi.fn(), log: () => {},
  } as never)
}

describe('netdisk broken-binding mark (b)', () => {
  it('resolve 撞 object not found → binding 标 broken（含时间 + 错误文本）', async () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    bind(store, '/网盘/已删目录')
    const svc = svcWith(store, { rawUrl: async () => { throw new Error(GONE) } })
    const hit = { setId: 'map_gone', dirPath: '/网盘/已删目录', rightFile: '第一集.mkv' }

    await expect(svc.resolveUrl(hit as never)).rejects.toThrow(/object not found/)

    const set = store.get('map_gone')!
    expect(set.broken).toBeDefined()
    expect(set.broken!.message).toContain('object not found')
    expect(new Date(set.broken!.at).getTime()).toBeGreaterThan(0)
  })

  it('无关的临时 500（非 not-found）不标 broken', async () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    bind(store, '/网盘/正常目录')
    const svc = svcWith(store, { rawUrl: async () => { throw new Error('[alist] code 500: internal server error') } })
    const hit = { setId: 'map_gone', dirPath: '/网盘/正常目录', rightFile: '第一集.mkv' }

    await expect(svc.resolveUrl(hit as never)).rejects.toThrow()
    expect(store.get('map_gone')!.broken).toBeUndefined()
  })

  it('下次 resolve 成功 → broken 标记自动清除', async () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    const set = bind(store, '/网盘/目录')
    set.broken = { at: '2026-07-24T00:00:00.000Z', message: GONE }
    store.save(set)

    const svc = svcWith(store, { rawUrl: async () => 'https://cdn.example/file.mkv' })
    await svc.resolveUrl({ setId: 'map_gone', dirPath: '/网盘/目录', rightFile: '第一集.mkv' } as never)

    expect(store.get('map_gone')!.broken).toBeUndefined()
  })

  // sync 路径：过去 object-not-found 一路抛到端点（`POST /mappings/:id/sync` → 500），更要命的是
  // 6 小时一轮的 netdisk-autosync「任一 set 失败 → 整个任务 throw」，一条目录被删的绑定就让自动
  // 同步永久红着。而 broken 此前只由播放/转写的 resolve 触发——没人点播就永远不标。真实事故见
  // 2026-07-25：map_0cf455 / map_953eb1 目录早没了，sync 实测回 500。
  it('sync 撞 object not found → 标 broken 且**不抛**（否则拖垮 netdisk-autosync 整轮）', async () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    bind(store, '/网盘/已删目录')
    const svc = svcWith(store, { listDirRecursive: async () => { throw new Error(GONE) } })

    const out = await svc.sync(store.get('map_gone')!)

    expect(out.broken?.message).toContain('object not found')
    expect(out.lastSyncAt).toBeTruthy()
    expect(store.get('map_gone')!.broken).toBeDefined()
  })

  it('sync 撞临时错误 → 照常抛，绝不标 broken（一次网络抖动不该把好绑定判死）', async () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    bind(store, '/网盘/正常目录')
    const svc = svcWith(store, { listDirRecursive: async () => { throw new Error('[alist] code 500: context deadline exceeded') } })

    await expect(svc.sync(store.get('map_gone')!)).rejects.toThrow(/deadline/)
    expect(store.get('map_gone')!.broken).toBeUndefined()
  })

  // corrected 是跨目录变化都要守住的决定，也是重训规则的训练数据。目录回来时 rebind 靠指纹认亲继承。
  it('标 broken 时 entries 一律不动（人工订正不能因为目录暂时没了就丢）', async () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    const set = bind(store, '/网盘/已删目录')
    set.entries = [{ leftKey: 'tmdb:1:S01E01', leftTitle: '第一集', rightFile: '我手工指的.mkv', status: 'confirmed', corrected: true } as never]
    store.save(set)
    const svc = svcWith(store, { listDirRecursive: async () => { throw new Error(GONE) } })

    await svc.sync(store.get('map_gone')!)

    const after = store.get('map_gone')!
    expect(after.entries).toHaveLength(1)
    expect(after.entries[0].rightFile).toBe('我手工指的.mkv')
  })

  it('GET /api/netdisk/mappings 的载荷（store.list）带出健康态', () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    const set = bind(store, '/网盘/目录')
    set.broken = { at: '2026-07-24T00:00:00.000Z', message: GONE }
    store.save(set)

    const listed = store.list().find((s) => s.id === 'map_gone')!
    expect(listed.broken?.message).toContain('object not found')
  })
})

/** 一部作品挂两条同 leftKey 绑定（一有效一残留）——(c) 换绑选路的原料。 */
function twoBindings(store: MappingStore): void {
  const common = {
    left: { kind: 'tmdb' as const, id: '1', media: 'tv' as const, title: '某剧' },
    rightHistory: [] as MappingSet['rightHistory'],
    autoSync: false,
  }
  const broken: MappingSet = {
    ...common,
    id: 'map_broken',
    right: { kind: 'alist-dir', path: '/网盘/已删目录', boundAt: '2026-07-24T00:00:00.000Z' },
    lastSyncAt: '2026-07-24T02:00:00.000Z', // 更新——若只按 lastSyncAt 会赢
    broken: { at: '2026-07-24T03:00:00.000Z', message: GONE },
    entries: [{ leftKey: 'tmdb:1:S01E01', leftTitle: '第一集', rightFile: '坏.mkv', status: 'auto' }],
  }
  const good: MappingSet = {
    ...common,
    id: 'map_good',
    right: { kind: 'alist-dir', path: '/网盘/好目录', boundAt: '2026-07-24T00:00:00.000Z' },
    lastSyncAt: '2026-07-24T01:00:00.000Z',
    entries: [{ leftKey: 'tmdb:1:S01E01', leftTitle: '第一集', rightFile: '好.mkv', status: 'auto' }],
  }
  store.save(broken)
  store.save(good)
}

describe('netdisk (c) item 入口回退：选路原料', () => {
  it('lookupAll：同 leftKey 的全部命中，健康的排前、broken 的排后（即便 broken 的 lastSyncAt 更新）', () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    twoBindings(store)
    const svc = svcWith(store, {})

    const hits = svc.lookupAll('tmdb:1:S01E01')

    expect(hits.map((h) => h.setId)).toEqual(['map_good', 'map_broken'])
    expect(hits[0]).toMatchObject({ dirPath: '/网盘/好目录', rightFile: '好.mkv' })
  })

  it('lookupAll：leftKey 无命中 → 空数组', () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    twoBindings(store)
    const svc = svcWith(store, {})
    expect(svc.lookupAll('tmdb:1:S09E09')).toEqual([])
  })

  it('bindingForTmdb：多绑定时优先返回健康的那条（find 第一条可能命中坏的）', () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    twoBindings(store)
    const svc = svcWith(store, {})
    expect(svc.bindingForTmdb('1', 'tv')?.id).toBe('map_good')
  })

  it('bindingForTmdb：全部坏时仍返回第一条（有绑定的事实不丢）', () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    const only: MappingSet = {
      id: 'map_broken', left: { kind: 'tmdb', id: '1', media: 'tv', title: '某剧' },
      right: { kind: 'alist-dir', path: '/网盘/已删目录', boundAt: '2026-07-24T00:00:00.000Z' },
      rightHistory: [], autoSync: false, broken: { at: '2026-07-24T03:00:00.000Z', message: GONE },
      entries: [{ leftKey: 'tmdb:1:S01E01', leftTitle: '第一集', rightFile: '坏.mkv', status: 'auto' }],
    }
    store.save(only)
    const svc = svcWith(store, {})
    expect(svc.bindingForTmdb('1', 'tv')?.id).toBe('map_broken')
  })
})
