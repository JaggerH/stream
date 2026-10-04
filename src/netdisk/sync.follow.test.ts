import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MappingStore } from './mapping-store.ts'
import { openNetdiskDb, type NetdiskDb } from './db.ts'
import { NetdiskService, type LeftEntry } from './sync.ts'
import type { AlistClient } from './alist-client.ts'
import type { InvokeLlm } from './match-generate.ts'

const alist = { listDir: async () => [], listDirRecursive: async () => [], rawUrl: async () => 'http://cdn/x' } as unknown as AlistClient
const left: LeftEntry[] = [
  { leftKey: 'tmdb:1:S03E14', title: '第 14 集', airDate: '2026-09-01' },
  { leftKey: 'tmdb:1:S03E15', title: '第 15 集', airDate: '2026-09-08' },
]

describe('NetdiskService · 追更接缝', () => {
  let db: NetdiskDb, store: MappingStore, svc: NetdiskService
  beforeEach(() => {
    db = openNetdiskDb(':memory:'); store = new MappingStore(db)
    svc = new NetdiskService({ store, alist, listLeft: async () => left, invokeLlm: vi.fn<InvokeLlm>() })
  })
  it('新建 tv 绑定 follow 默认开；电影没有 follow', async () => {
    const tv = await svc.bind({ left: { kind: 'tmdb', id: '1', media: 'tv', title: 'X' }, dirPath: '/d' })
    expect(tv.follow).toEqual({ enabled: true, dryRuns: 0 })
    const mv = await svc.bind({ left: { kind: 'tmdb', id: '2', media: 'movie', title: 'M' }, dirPath: '/m' })
    expect(mv.follow).toBeUndefined()
  })
  it('matchExternalFiles 用绑定自己的谱认集，不写库', async () => {
    const set = await svc.bind({ left: { kind: 'tmdb', id: '1', media: 'tv', title: 'X' }, dirPath: '/d' })
    const r = await svc.matchExternalFiles(set, [{ name: 'S03/X.S03E14.1080p.mkv', size: 3_000_000_000 }, { name: 'S03/readme.txt', size: 3 }])
    expect(r.assignments.get('tmdb:1:S03E14')?.rightFile).toBe('S03/X.S03E14.1080p.mkv')
    expect(r.assignments.has('tmdb:1:S03E15')).toBe(false)
    expect(store.get(set.id)!.entries.every((e) => e.rightFile === null)).toBe(true)
  })
})
