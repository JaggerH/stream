import { describe, expect, it } from 'vitest'
import { createResearchWatchers } from './research-watchers.ts'

interface Started { streamId: string; dir: string; stopped: boolean }

function harness(channels: Array<{ present: string; stream_ids: string[] }>, dirs: Record<string, string>) {
  const started: Started[] = []
  let current = channels
  let dirTable = dirs
  const watchers = createResearchWatchers({
    listChannels: () => current,
    dirForStream: (id) => {
      const dir = dirTable[id]
      if (!dir) throw new Error(`no dir for ${id}`)
      return dir
    },
    start: ({ dir, streamId }) => {
      const rec: Started = { streamId, dir, stopped: false }
      started.push(rec)
      return () => { rec.stopped = true }
    },
  })
  return {
    watchers,
    started,
    live: () => started.filter((s) => !s.stopped),
    setChannels: (next: typeof channels) => { current = next },
    setDirs: (next: Record<string, string>) => { dirTable = next },
  }
}

describe('ResearchWatchers.sync — 运行期的 watcher 集合', () => {
  it('只给 research present 的频道起 watcher', () => {
    const h = harness(
      [{ present: 'research', stream_ids: ['a'] }, { present: 'timeline', stream_ids: ['b'] }],
      { a: '/d/a', b: '/d/b' },
    )
    h.watchers.sync()
    expect(h.live().map((s) => s.streamId)).toEqual(['a'])
  })

  it('去重：一条流被两个 research 频道引用只起一个 watcher', () => {
    const h = harness(
      [{ present: 'research', stream_ids: ['a'] }, { present: 'research', stream_ids: ['a', 'c'] }],
      { a: '/d/a', c: '/d/c' },
    )
    h.watchers.sync()
    expect(h.started.length).toBe(2)
    expect(h.live().map((s) => s.streamId).sort()).toEqual(['a', 'c'])
  })

  it('幂等：同一份频道表连调两次不产生第二批，也不误停已有的', () => {
    const h = harness([{ present: 'research', stream_ids: ['a', 'c'] }], { a: '/d/a', c: '/d/c' })
    h.watchers.sync()
    h.watchers.sync()
    expect(h.started.length).toBe(2)
    expect(h.started.every((s) => !s.stopped)).toBe(true)
  })

  it('卸载：频道挪出 research → 对应 watcher 停掉', () => {
    const h = harness([{ present: 'research', stream_ids: ['a'] }], { a: '/d/a' })
    h.watchers.sync()
    h.setChannels([{ present: 'timeline', stream_ids: ['a'] }])
    h.watchers.sync()
    expect(h.started[0]!.stopped).toBe(true)
    expect(h.live()).toEqual([])
  })

  it('卸载：频道被删（流不再被任何 research 频道引用）→ watcher 停掉', () => {
    const h = harness([{ present: 'research', stream_ids: ['a'] }], { a: '/d/a' })
    h.watchers.sync()
    h.setChannels([])
    h.watchers.sync()
    expect(h.started[0]!.stopped).toBe(true)
  })

  it('卸载 + 重起：改绑成员导致 artifacts 目录变了 → 停旧的，起盯新目录的', () => {
    const h = harness([{ present: 'research', stream_ids: ['a'] }], { a: '/d/old' })
    h.watchers.sync()
    h.setDirs({ a: '/d/new' })
    h.watchers.sync()
    expect(h.started.length).toBe(2)
    expect(h.started[0]).toMatchObject({ dir: '/d/old', stopped: true })
    expect(h.started[1]).toMatchObject({ dir: '/d/new', stopped: false })
  })

  it('目录取不到就跳过这条流——源没配全不是错误路径，而且下一次 sync 还能补上', () => {
    const h = harness([{ present: 'research', stream_ids: ['a'] }], {})
    expect(() => h.watchers.sync()).not.toThrow()
    expect(h.started).toEqual([])
    h.setDirs({ a: '/d/a' })
    h.watchers.sync()
    expect(h.live().map((s) => s.dir)).toEqual(['/d/a'])
  })

  it('stopAll 停掉全部，且之后再 sync 能重建', () => {
    const h = harness([{ present: 'research', stream_ids: ['a', 'c'] }], { a: '/d/a', c: '/d/c' })
    h.watchers.sync()
    h.watchers.stopAll()
    expect(h.started.every((s) => s.stopped)).toBe(true)
    h.watchers.sync()
    expect(h.live().length).toBe(2)
  })
})
