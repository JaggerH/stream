import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Outbox } from './outbox.ts'

const newPath = () => join(mkdtempSync(join(tmpdir(), 'ob-')), 'o.db')
const mk = () => new Outbox(newPath(), Database)

describe('Outbox', () => {
  it('append 落盘、pending 按到达顺序取回', () => {
    const o = mk()
    o.append({ id: 'a', source: 's', receivedAt: 1, payload: '{}' })
    o.append({ id: 'b', source: 's', receivedAt: 2, payload: '{}' })
    expect(o.pending().map((e) => e.id)).toEqual(['a', 'b'])
  })
  it('重复 id 不二次入库（幂等第一闸）', () => {
    const o = mk()
    expect(o.append({ id: 'a', source: 's', receivedAt: 1, payload: '{}' })).toBe(true)
    expect(o.append({ id: 'a', source: 's', receivedAt: 9, payload: '{}' })).toBe(false)
    expect(o.pending().length).toBe(1)
  })
  it('ackDone 后不再 pending；重开库（模拟子进程重启）后仍不 pending——落盘可续', () => {
    const p = newPath()
    const o1 = new Outbox(p, Database)
    o1.append({ id: 'a', source: 's', receivedAt: 1, payload: '{}' })
    o1.ackDone(['a'], 100)
    o1.close()
    const o2 = new Outbox(p, Database)
    expect(o2.pending().length).toBe(0)
  })
  it('prune 只清过期的 done，pending 不动', () => {
    const o = mk()
    o.append({ id: 'a', source: 's', receivedAt: 1, payload: '{}' })
    o.ackDone(['a'], 100)
    o.append({ id: 'b', source: 's', receivedAt: 2, payload: '{}' })
    expect(o.prune(200)).toBe(1)
    expect(o.pending().map((e) => e.id)).toEqual(['b'])
  })
})
