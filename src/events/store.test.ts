import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore } from './store.ts'

describe('EventStore', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'events-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const path = () => join(dir, 'events.json')

  it('append assigns monotonic ids and survives a restart', () => {
    const s1 = new EventStore(path())
    const a = s1.append({ type: 'transcribe.done', title: 'A', severity: 'info' })
    const b = s1.append({ type: 'harvest.error', title: 'B', severity: 'error' })
    expect(b.id).toBeGreaterThan(a.id)
    const s2 = new EventStore(path()) // reload from disk
    expect(s2.list().map((e) => e.title)).toEqual(['B', 'A']) // newest first
    expect(s2.append({ type: 'x', title: 'C', severity: 'info' }).id).toBeGreaterThan(b.id)
  })

  it('list filters by since (id cursor) and types', () => {
    const s = new EventStore(path())
    const a = s.append({ type: 't1', title: 'A', severity: 'info' })
    s.append({ type: 't2', title: 'B', severity: 'info' })
    expect(s.list({ since: a.id }).map((e) => e.title)).toEqual(['B'])
    expect(s.list({ types: ['t1'] }).map((e) => e.title)).toEqual(['A'])
  })

  it('markRead sets readAt; unreadCount and findUnreadByDedupeKey respect it', () => {
    const s = new EventStore(path())
    const a = s.append({ type: 't', title: 'A', severity: 'warn', dedupeKey: 'k' })
    expect(s.findUnreadByDedupeKey('k')?.id).toBe(a.id)
    expect(s.unreadCount()).toBe(1)
    s.markRead({ all: true })
    expect(s.unreadCount()).toBe(0)
    expect(s.findUnreadByDedupeKey('k')).toBeUndefined()
    const b = s.append({ type: 't', title: 'B', severity: 'warn' })
    s.markRead({ ids: [b.id] })
    expect(s.unreadCount()).toBe(0)
  })

  it('touch refreshes at and persists', () => {
    let t = 1000
    const s = new EventStore(path(), () => t)
    const a = s.append({ type: 't', title: 'A', severity: 'info' })
    t = 2000
    expect(s.touch(a.id)?.at).toBe(2000)
    expect(new EventStore(path()).list()[0].at).toBe(2000)
  })

  it('detail 跟着整条走过一次重启 —— 它是复制出去贴给 AI 的那份现场', () => {
    const s1 = new EventStore(path())
    s1.append({ type: 't', title: 'A', severity: 'error', detail: 'reason=not-awake\n容器=running' })
    expect(new EventStore(path()).list()[0].detail).toBe('reason=not-awake\n容器=running')
  })

  it('读旧文件（那时还没有 detail 这一格）不炸，只是没有 detail', () => {
    // 持久化是整份 JSON 重写、无迁移；唯一要钉的是"缺这一格"必须是合法输入而不是异常。
    writeFileSync(path(), JSON.stringify({
      nextId: 9,
      events: [{ id: 8, type: 't', at: 1, title: '旧的一条', severity: 'info' }],
    }))
    const s = new EventStore(path())
    expect(s.list()[0].detail).toBeUndefined()
    expect(s.append({ type: 't', title: 'B', severity: 'info' }).id).toBe(9)
  })

  it('prunes to 500 entries and 10 days on append', () => {
    let t = 0
    const s = new EventStore(path(), () => t)
    for (let i = 0; i < 510; i++) s.append({ type: 't', title: `e${i}`, severity: 'info' })
    expect(s.list()).toHaveLength(500)
    t = 11 * 24 * 3600_000 // everything so far is now >10d old
    s.append({ type: 't', title: 'fresh', severity: 'info' })
    expect(s.list()).toHaveLength(1)
  })
})
