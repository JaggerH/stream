import { describe, it, expect } from 'vitest'
import { describeShelfContract } from './shelf-contract.ts'
import { MemoryShelf } from './memory-shelf.ts'
import { AlistClient } from '../../shared/netdisk/alist-client.ts'
import { makeFakeOpenListServer } from './openlist-fake.ts'

describeShelfContract('memory', async () => {
  const shelf = new MemoryShelf()
  return {
    shelf,
    seed: async (files: Record<string, number>) => {
      for (const [p, s] of Object.entries(files)) shelf.put(p, s)
    },
  }
})

describeShelfContract('openlist(fake http)', async () => {
  const fake = makeFakeOpenListServer()
  const shelf = new AlistClient({ baseUrl: 'http://fake', token: 't', fetchFn: fake.fetch, sleep: async () => {} })
  return { shelf, seed: async (files: Record<string, number>) => fake.seed(files) }
})

describe('MemoryShelf.rename', () => {
  it('rename：同目录改名，旧路径消失、新路径同体量', async () => {
    const s = new MemoryShelf()
    s.put('/lib/S01/a.mkv', 7)
    await s.rename('/lib/S01/a.mkv', 'S01E01 - a.mkv')
    const names = (await s.listDirRecursive('/lib/S01', 0)).map((f) => f.name)
    expect(names).toEqual(['S01E01 - a.mkv'])
  })
})

// 空检查（execute.ts 的 cleanupEmptiedDirs）靠 includeDirs:true 才能看见「这一层还有个子目录」，
// 不必递归进去找文件——一个只剩空子目录的目录必须被判成"还有东西"。
describe('MemoryShelf.listDirRecursive includeDirs', () => {
  it('includeDirs:true 把空子目录也列出来', async () => {
    const s = new MemoryShelf()
    s.put('/lib/第三季/a.mkv', 1)
    await s.mkdir('/lib/第三季/花絮') // 空子目录，里面没有文件
    const out = await s.listDirRecursive('/lib/第三季', 0, true, true)
    expect(out).toContainEqual({ name: '花絮', size: 0, isDir: true })
  })

  it('includeDirs:false（默认）不列目录，只列文件', async () => {
    const s = new MemoryShelf()
    s.put('/lib/第三季/a.mkv', 1)
    await s.mkdir('/lib/第三季/花絮')
    const out = await s.listDirRecursive('/lib/第三季', 0, true)
    expect(out.every((f) => !f.isDir)).toBe(true)
  })
})

describe('假 OpenList：move 是异步的，客户端必须真的等', () => {
  it('waitMoved 转了不止一圈（第一次列还看得见那份，说明重试循环没被真空绿掉）', async () => {
    const fake = makeFakeOpenListServer()
    fake.seed({ '/src/a.mp3': 1 })
    const shelf = new AlistClient({ baseUrl: 'http://fake', token: 't', fetchFn: fake.fetch, sleep: async () => {} })
    await shelf.mkdir('/dst')
    const before = fake.stats.listCalls
    await shelf.move('/src', '/dst', ['a.mp3'])
    // ghost 撑 2 次快照 → 第 3 次才干净：move 之后至少 3 次 fs/list，即 waitMoved 转了 ≥3 圈。
    expect(fake.stats.listCalls - before).toBeGreaterThanOrEqual(3)
  })

  it('对已有目录幂等 mkdir，不会把它的缓存列表清成空', async () => {
    const fake = makeFakeOpenListServer()
    fake.seed({ '/p/a.mp3': 1 })
    const shelf = new AlistClient({ baseUrl: 'http://fake', token: 't', fetchFn: fake.fetch, sleep: async () => {} })
    await shelf.mkdir('/p') // 已经有东西的目录——置空快照等于凭空造一份不存在的空列表
    const out = await shelf.listDirRecursive('/p', 0, false)
    expect(out.map((f) => f.name)).toEqual(['a.mp3'])
  })
})
