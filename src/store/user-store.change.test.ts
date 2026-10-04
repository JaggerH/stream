/**
 * 「库存变了」的订阅（`UserStore.onChange`）。
 *
 * 它撑着的是「对话里让 AI 改完配置，界面自己跟上」那条链：AI 走 MCP 工具，一个网页事件都不
 * 经过，所以通知必须挂在**所有写的必经之路**上，也就是这一层。漏挂某个写方法不会报错——
 * 只会让那一类改动在界面上永远不出现，所以逐个方法钉住。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserStore } from './user-store.ts'
import { DEFAULT_SPACE_ID } from './types.ts'

describe('UserStore 的库存变更通知', () => {
  let dir: string
  let store: UserStore
  let hits: number
  let off: () => void
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'user-store-change-'))
    store = new UserStore(join(dir, 'stream.db'))
    hits = 0
    off = store.onChange(() => { hits += 1 })
  })
  afterEach(() => {
    off()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const stream = (id: string) => ({ id, label: id, strategy: 'fanout' as const, cadence_seconds: 1800, members: [], options: {} })

  it('建/改/删 Stream 都通知', () => {
    store.putStream(stream('s1'))
    expect(hits).toBe(1)
    store.putStream({ ...stream('s1'), label: '改个名' })
    expect(hits).toBe(2)
    store.removeStream('s1')
    expect(hits).toBeGreaterThan(2)
  })

  it('建/改/删频道都通知——patchChannel 也算（它走 putChannel）', () => {
    store.putChannel({ id: 'c1', label: '频道', present: 'timeline', stream_ids: [], options: {} })
    const afterCreate = hits
    expect(afterCreate).toBeGreaterThan(0)
    store.patchChannel('c1', { label: '改名了' })
    expect(hits).toBe(afterCreate + 1)
    store.removeChannel('c1')
    expect(hits).toBe(afterCreate + 2)
  })

  it('建/删空间都通知', () => {
    store.putSpace({ id: 'sp', label: '研究', position: 1, system: false })
    const afterCreate = hits
    expect(afterCreate).toBeGreaterThan(0)
    store.removeSpace('sp')
    expect(hits).toBeGreaterThan(afterCreate)
  })

  // 删不掉的东西不该通知：收到通知的一端会去重读一次名录，而什么都没变——那是一次白跑的
  // 往返，且会让"有通知 = 有变化"这条判据失真。
  it('删不动的（默认空间 / 不存在的频道）不通知', () => {
    expect(store.removeSpace(DEFAULT_SPACE_ID)).toBe(false)
    expect(store.removeChannel('没有这个频道')).toBe(false)
    expect(hits).toBe(0)
  })

  // 订阅者自己抛错不能表现成写失败——写已经落盘了。
  it('订阅者抛错不影响写入，也不影响别的订阅者', () => {
    const off2 = store.onChange(() => { throw new Error('boom') })
    let other = 0
    const off3 = store.onChange(() => { other += 1 })
    expect(() => store.putStream(stream('s2'))).not.toThrow()
    expect(store.getStream('s2')).not.toBeNull()
    expect(other).toBe(1)
    off2(); off3()
  })

  it('退订之后不再收到', () => {
    off()
    store.putStream(stream('s3'))
    expect(hits).toBe(0)
    off = () => {}
  })
})
