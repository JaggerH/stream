import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MappingStore } from './mapping-store.ts'
import { openNetdiskDb, type NetdiskDb } from './db.ts'
import { NetdiskService, type LeftEntry } from './sync.ts'
import type { AlistClient, AlistFile } from './alist-client.ts'
import type { InvokeLlm } from './match-generate.ts'

const file = (name: string, size: number): AlistFile => ({ name, size, isDir: false })
function fakeAlist(files: AlistFile[]): AlistClient {
  return { listDir: async () => files, listDirRecursive: async () => files, rawUrl: async () => 'http://cdn/x' } as unknown as AlistClient
}

describe('sync 把 LeftEntry.airDate 落进 MappingEntry', () => {
  let db: NetdiskDb
  let store: MappingStore
  beforeEach(() => { db = openNetdiskDb(':memory:'); store = new MappingStore(db) })
  afterEach(() => { vi.useRealTimers() })

  it('新建壳与后续同步都带 airDate；左侧没给的集不带', async () => {
    vi.useFakeTimers()
    let left: LeftEntry[] = [
      { leftKey: 'tmdb:1:S01E01', title: '第 1 集', airDate: '2026-08-01' },
      { leftKey: 'tmdb:1:S01E02', title: '第 2 集' },
    ]
    const svc = new NetdiskService({ store, alist: fakeAlist([file('S01E01.mkv', 5_000_000)]), listLeft: async () => left, invokeLlm: vi.fn<InvokeLlm>() })
    const set = await svc.bind({ left: { kind: 'tmdb', id: '1', media: 'tv', title: 'X' }, dirPath: '/d' })
    expect(set.entries.find((e) => e.leftKey === 'tmdb:1:S01E01')!.airDate).toBe('2026-08-01')
    expect(set.entries.find((e) => e.leftKey === 'tmdb:1:S01E02')!.airDate).toBeUndefined()

    // TMDb 后来补了第 2 集的日期 → 下次 sync 跟上（不是只在建壳那一刻写一次）。
    // 跨过左侧清单的短命备忘（10 分钟 TTL，见 sync.ts leftOf）才够得着这次取数。
    left = left.map((l) => (l.leftKey === 'tmdb:1:S01E02' ? { ...l, airDate: '2026-08-08' } : l))
    vi.advanceTimersByTime(11 * 60_000)
    const again = await svc.sync(set)
    expect(again.entries.find((e) => e.leftKey === 'tmdb:1:S01E02')!.airDate).toBe('2026-08-08')
    // 落库回读也在
    const reloaded = new MappingStore(db).get(set.id)!
    expect(reloaded.entries.find((e) => e.leftKey === 'tmdb:1:S01E01')!.airDate).toBe('2026-08-01')
  })
})
