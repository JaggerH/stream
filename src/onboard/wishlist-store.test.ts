import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WishlistStore } from './wishlist-store.ts'

describe('WishlistStore', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wishlist-'))
    path = join(dir, 'onboard-wishlist.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('add 落盘并回填 id/at，list 最新在前', () => {
    let n = 0
    const store = new WishlistStore(path, { now: () => `2026-08-13T00:0${n}:00.000Z`, newId: () => `wl_${++n}` })
    store.add({ url: 'https://a.example/feed', goal: '找 A 的更新' })
    const second = store.add({ url: 'https://b.example', goal: '找 B', note: '看着像个论坛' })

    expect(second.id).toBe('wl_2')
    expect(second.note).toBe('看着像个论坛')
    const ids = store.list().map((e) => e.id)
    expect(ids).toEqual(['wl_2', 'wl_1']) // 最新在前
    // 真落了盘：换一个实例读同一个文件
    expect(new WishlistStore(path).list().map((e) => e.url)).toEqual(['https://b.example', 'https://a.example/feed'])
  })

  it('坏文件按空表冷启动，且不炸', () => {
    writeFileSync(path, '{ 这不是 json')
    const store = new WishlistStore(path)
    expect(store.list()).toEqual([])
    store.add({ url: 'https://c.example', goal: '找 C' })
    expect(store.list()).toHaveLength(1)
  })

  it('写盘是原子的：目录里不留 tmp 残骸', () => {
    const store = new WishlistStore(path)
    store.add({ url: 'https://d.example', goal: '找 D' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(1)
    expect(readdirSync(dir).filter((f) => f.includes('tmp'))).toEqual([])
  })

  it('remove 删掉一条，删不存在的回 false', () => {
    const store = new WishlistStore(path)
    const e = store.add({ url: 'https://e.example', goal: '找 E' })
    expect(store.remove(e.id)).toBe(true)
    expect(store.list()).toEqual([])
    expect(store.remove('nope')).toBe(false)
  })
})
