import { describe, it, expect, vi } from 'vitest'
import { MappingStore } from './mapping-store.ts'
import { openNetdiskDb } from './db.ts'
import { NetdiskService, type LeftEntry } from './sync.ts'

/**
 * 「一个 TMDb 作品最多一条绑定」——bindingForTmdb 的注释早就声明了这条不变量（按 (id, media)
 * 唯一），但过去只有调用方在查重，bind 自己照单全收。真实事故：《进击的巨人》的
 * map_18d863 / map_9fe142，同 id 同目录，boundAt 相差 0.3 秒——一次转存的两个并发请求
 * 双双读到「没绑过」，各建一条。
 */
function svc(store: MappingStore, files: { name: string; size: number }[] = [], left: LeftEntry[] = []): NetdiskService {
  return new NetdiskService({
    store,
    alist: { listDirRecursive: async () => files, listDir: async () => files },
    listLeft: async (): Promise<LeftEntry[]> => left,
    invokeLlm: vi.fn(),
    log: () => {},
  } as never)
}

const WORK = { kind: 'tmdb' as const, id: '1429', media: 'tv' as const, title: '进击的巨人' }

describe('bind() 的唯一性约束', () => {
  it('同作品同目录再 bind → 复用原绑定重算，不新建', async () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    const s = svc(store, [{ name: 'S01E01.mkv', size: 1 }], [{ leftKey: 'tmdb:1429:S01E01', title: '第一集' }])

    const first = await s.bind({ left: WORK, dirPath: '/quark/From Stream/tv-1429' })
    const second = await s.bind({ left: WORK, dirPath: '/quark/From Stream/tv-1429' })

    expect(second.id).toBe(first.id)
    expect(store.list()).toHaveLength(1)
  })

  it('同作品换了目录再 bind → 走 rebind，旧目录进 rightHistory，仍只有一条', async () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    const s = svc(store, [{ name: 'S01E01.mkv', size: 1 }], [{ leftKey: 'tmdb:1429:S01E01', title: '第一集' }])

    const first = await s.bind({ left: WORK, dirPath: '/quark/From Stream/旧目录' })
    const second = await s.bind({ left: WORK, dirPath: '/quark/From Stream/tv-1429' })

    expect(second.id).toBe(first.id)
    expect(second.right.path).toBe('/quark/From Stream/tv-1429')
    expect(second.rightHistory.map((h) => h.path)).toContain('/quark/From Stream/旧目录')
    expect(store.list()).toHaveLength(1)
  })

  // 这条是本次修复的靶心：两个请求并发进 bind，第二个必须看得见第一个。bind 里从查重到
  // store.save 之间没有 await（save 是同步的 writeFileSync），窗口因此被关掉。
  it('并发 bind 同一作品 → 只建出一条绑定', async () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    const s = svc(store, [{ name: 'S01E01.mkv', size: 1 }], [{ leftKey: 'tmdb:1429:S01E01', title: '第一集' }])

    const [a, b] = await Promise.all([
      s.bind({ left: WORK, dirPath: '/quark/From Stream/tv-1429' }),
      s.bind({ left: WORK, dirPath: '/quark/From Stream/tv-1429' }),
    ])

    expect(store.list()).toHaveLength(1)
    expect(a.id).toBe(b.id)
  })

  it('不同作品各建各的（约束只按 (id, media) 收口，不误伤）', async () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    const s = svc(store)

    await s.bind({ left: WORK, dirPath: '/quark/From Stream/tv-1429' })
    await s.bind({ left: { ...WORK, id: '261391', title: '喜剧之王单口季' }, dirPath: '/quark/From Stream/tv-261391' })
    // TMDb id 按媒体类型分命名空间：同号的 movie 与 tv 是两部不同作品，不能互相顶掉。
    await s.bind({ left: { kind: 'tmdb', id: '1429', media: 'movie', title: '同号电影' }, dirPath: '/quark/From Stream/movie-1429' })

    expect(store.list()).toHaveLength(3)
  })

  // 订阅流绑定不收这条约束：一个流合理地可以绑多个目录（怡乐播客的付费/下架就是两个目录，
  // 且历史上由手工建绑走 POST /api/netdisk/mappings，不经过转存闭环）。
  it('stream 绑定不受唯一性约束', async () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    const s = svc(store)
    const left = { kind: 'stream' as const, streamId: 'yile', title: '怡乐播客' }

    await s.bind({ left, dirPath: '/quark/From Stream/怡楽播客/付费' })
    await s.bind({ left, dirPath: '/quark/From Stream/怡楽播客/下架' })

    expect(store.list()).toHaveLength(2)
  })
})
