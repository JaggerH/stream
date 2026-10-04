import { describe, it, expect } from 'vitest'
import { StreamTable, STREAM_TABLE_MAX } from './streams.ts'

describe('StreamTable（noteId → 签名流地址，有界 LRU、不按时钟过期）', () => {
  it('set 之后 get 命中；没记过的 noteId → undefined', () => {
    const t = new StreamTable()
    expect(t.get('nope')).toBeUndefined()
    t.set('n1', 'http://cdn/x.mp4')
    expect(t.get('n1')).toBe('http://cdn/x.mp4')
  })

  it('再 set 一次覆盖旧地址', () => {
    const t = new StreamTable()
    t.set('n1', 'http://cdn/old.mp4')
    t.set('n1', 'http://cdn/new.mp4')
    expect(t.get('n1')).toBe('http://cdn/new.mp4')
    expect(t.size).toBe(1)
  })

  it('容量满了挤掉最久没碰的那条；get 会把命中的刷成最新', () => {
    const t = new StreamTable(2)
    t.set('a', 'http://cdn/a.mp4')
    t.set('b', 'http://cdn/b.mp4')
    expect(t.get('a')).toBe('http://cdn/a.mp4') // a 刷新，b 成了最旧
    t.set('c', 'http://cdn/c.mp4')
    expect(t.size).toBe(2)
    expect(t.get('b')).toBeUndefined()
    expect(t.get('a')).toBe('http://cdn/a.mp4')
    expect(t.get('c')).toBe('http://cdn/c.mp4')
  })

  it('缺省容量 200；不足容量时一条都不丢', () => {
    expect(STREAM_TABLE_MAX).toBe(200)
    const t = new StreamTable()
    for (let i = 0; i < STREAM_TABLE_MAX; i++) t.set(`n${i}`, `http://cdn/${i}.mp4`)
    expect(t.size).toBe(STREAM_TABLE_MAX)
    expect(t.get('n0')).toBe('http://cdn/0.mp4')
  })
})
