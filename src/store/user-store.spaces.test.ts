/**
 * 空间（频道之上那一层）的存储层。盯的都是"错了不会报错、只会静默消失"的那几处：
 * 存量库开库后的落点、删空间时成员去哪、系统频道每次开库会不会被拽回默认空间。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { UserStore } from './user-store.ts'
import { DEFAULT_SPACE_ID } from './types.ts'

describe('UserStore 空间', () => {
  let dir: string
  let store: UserStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'user-store-spaces-'))
    store = new UserStore(join(dir, 'stream.db'))
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('开库自建默认空间，且是系统行', () => {
    const def = store.getSpace(DEFAULT_SPACE_ID)
    expect(def).toBeTruthy()
    expect(def!.system).toBe(true)
  })

  it('新建频道不给归属就落默认空间', () => {
    const ch = store.putChannel({ id: 'c1', label: '甲', present: 'timeline', stream_ids: [], options: {} })
    expect(ch.space_id).toBe(DEFAULT_SPACE_ID)
  })

  it('空间可以是空的——建完没有任何频道，它照样在', () => {
    store.putSpace({ id: 's1', label: '研究', position: 1 })
    expect(store.listSpaces().map((s) => s.id)).toContain('s1')
  })

  it('列表按 position 升序，同值按 id 兜底', () => {
    store.putSpace({ id: 'b', label: 'B', position: 5 })
    store.putSpace({ id: 'a', label: 'A', position: 5 })
    store.putSpace({ id: 'z', label: 'Z', position: 1 })
    expect(store.listSpaces().map((s) => s.id)).toEqual([DEFAULT_SPACE_ID, 'z', 'a', 'b'])
  })

  it('删空间把成员挪回默认空间，不删频道', () => {
    store.putSpace({ id: 's1', label: '研究', position: 1 })
    store.putChannel({ id: 'c1', label: '甲', present: 'timeline', stream_ids: [], options: {}, space_id: 's1' })
    expect(store.removeSpace('s1')).toBe(true)
    const ch = store.getChannel('c1')
    expect(ch).toBeTruthy()
    expect(ch!.space_id).toBe(DEFAULT_SPACE_ID)
  })

  it('默认空间删不掉——删了无主频道就没有落点了', () => {
    expect(store.removeSpace(DEFAULT_SPACE_ID)).toBe(false)
    expect(store.getSpace(DEFAULT_SPACE_ID)).toBeTruthy()
  })

  it('默认空间可以改名（"不能删"不等于"不能改"）', () => {
    expect(store.patchSpace(DEFAULT_SPACE_ID, { label: '常用' })?.label).toBe('常用')
    // 改完不会在下次开库被改回去：ensureDefaultSpace 只在缺席时建。
    store.close()
    store = new UserStore(join(dir, 'stream.db'))
    expect(store.getSpace(DEFAULT_SPACE_ID)!.label).toBe('常用')
  })

  it('挪过的系统频道不会被下一次开库拽回默认空间', () => {
    store.putSpace({ id: 's1', label: '研究', position: 1 })
    store.patchChannel('default-timeline', { space_id: 's1' })
    store.close()
    store = new UserStore(join(dir, 'stream.db'))
    expect(store.getChannel('default-timeline')!.space_id).toBe('s1')
  })

  it('nextSpacePosition 是当前最大 +1（新建的排在最后，不插进中间）', () => {
    store.putSpace({ id: 's1', label: 'A', position: 3 })
    expect(store.nextSpacePosition()).toBe(4)
  })

  it('指向已不存在的空间的频道，读回来落默认空间——不从侧栏里消失', () => {
    store.putChannel({ id: 'c1', label: '甲', present: 'timeline', stream_ids: [], options: {} })
    // 绕过 removeSpace 的事务，制造出"孤儿归属"这个本不该出现的状态。
    const raw = new Database(join(dir, 'stream.db'))
    raw.prepare('UPDATE channels SET space_id = ? WHERE id = ?').run('ghost', 'c1')
    raw.close()
    store.close()
    store = new UserStore(join(dir, 'stream.db'))
    expect(store.getChannel('c1')!.space_id).toBe(DEFAULT_SPACE_ID)
  })

  it('存量库（没有 space_id 列）开库后，既有频道一次就位', () => {
    store.close()
    // 模拟老库：直接把列删掉再让 UserStore 重新开。
    const raw = new Database(join(dir, 'stream.db'))
    raw.exec('ALTER TABLE channels DROP COLUMN space_id')
    raw.close()
    store = new UserStore(join(dir, 'stream.db'))
    expect(store.getChannel('default-timeline')!.space_id).toBe(DEFAULT_SPACE_ID)
  })
})
