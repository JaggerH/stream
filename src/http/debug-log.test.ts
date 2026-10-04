import { describe, it, expect } from 'vitest'
import { DebugLog } from './debug-log.ts'
import type { DebugEntry } from '../debug.ts'

const entry = (over: Partial<DebugEntry> = {}): DebugEntry => ({
  id: 'c:k@1',
  at: 1,
  channel: 'c',
  key: 'k',
  title: 't',
  summary: 's',
  ok: true,
  fields: [],
  ...over,
})

describe('DebugLog', () => {
  it('keeps the newest `capacity` entries', () => {
    const log = new DebugLog(2)
    for (const id of ['a', 'b', 'c']) log.put(entry({ id }))
    expect(log.recent().map((e) => e.id)).toEqual(['c', 'b'])
  })

  it('filters by channel and key', () => {
    const log = new DebugLog()
    log.put(entry({ id: 'a', channel: 'x', key: 'k1' }))
    log.put(entry({ id: 'b', channel: 'y', key: 'k1' }))
    log.put(entry({ id: 'c', channel: 'x', key: 'k2' }))
    expect(log.recent({ channel: 'x' }).map((e) => e.id)).toEqual(['c', 'a'])
    expect(log.recent({ channel: 'x', key: 'k2' }).map((e) => e.id)).toEqual(['c'])
  })

  // 这条守的是接线本身：环里的东西重启就没了,所以每一条都必须**无条件**流到 sink（落盘那份）。
  // 「哪些值得留档」的判据只有 debug-sink.ts 里那一份 —— 若哪天有人在这里补一个 ok 过滤,
  // 就成了两份会各自漂移的判据,这条会当场红。
  it('forwards every entry to the sink — including successful ones (the sink decides what to keep)', () => {
    const seen: string[] = []
    const log = new DebugLog(200, (e) => void seen.push(`${e.id}:${e.ok}`))
    log.put(entry({ id: 'good', ok: true }))
    log.put(entry({ id: 'bad', ok: false }))
    expect(seen).toEqual(['good:true', 'bad:false'])
  })

  it('forwards even entries that the ring has already evicted', () => {
    const seen: string[] = []
    const log = new DebugLog(1, (e) => void seen.push(e.id))
    log.put(entry({ id: 'a' }))
    log.put(entry({ id: 'b' }))
    expect(log.recent().map((e) => e.id)).toEqual(['b'])
    expect(seen).toEqual(['a', 'b'])
  })

  it('clear() empties the ring', () => {
    const log = new DebugLog()
    log.put(entry())
    log.clear()
    expect(log.recent()).toEqual([])
  })
})
