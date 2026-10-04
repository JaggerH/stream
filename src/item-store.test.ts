import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ItemStore } from './item-store.ts'
import type { StreamItem } from './types.ts'

function item(id: string, stream: string, timestamp = '2026-06-08T00:00:00.000Z'): StreamItem {
  return {
    id,
    stream_id: stream,
    source_type: 'rsshub-bridge',
    source_route: '/x',
    fetched_at: '2026-06-08T00:00:00.000Z',
    timestamp,
    title: `t-${id}`,
    raw: {},
  }
}

describe('ItemStore', () => {
  let dir: string
  let store: ItemStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'items-'))
    store = new ItemStore(join(dir, 'items.db'), 2)
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns recent merged newest-first across streams', () => {
    store.add(item('a1', 'A'), 'post')
    store.add(item('b1', 'B'), 'conversation')
    store.add(item('a2', 'A'), 'post')
    const recent = store.recent()
    expect(recent.map((r) => r.id)).toEqual(['a2', 'b1', 'a1'])
    expect(recent[1].type).toBe('conversation')
  })

  it('addMany persists an entire batch in one transaction (same result as sequential add)', () => {
    store.addMany([item('a1', 'A'), item('b1', 'B'), item('a2', 'A')], 'post')
    expect(store.recent().map((r) => r.id)).toEqual(['a2', 'b1', 'a1'])
  })

  it('addMany respects the per-stream cap, evicting the oldest within the batch', () => {
    // capPerStream = 2 for this store
    store.addMany([item('a1', 'A'), item('a2', 'A'), item('a3', 'A')], 'post')
    expect(store.recent().map((r) => r.id)).toEqual(['a3', 'a2']) // a1 evicted
  })

  it('addMany is a no-op for an empty batch', () => {
    store.addMany([], 'post')
    expect(store.recent()).toEqual([])
  })

  it('filters by stream', () => {
    store.add(item('a1', 'A'), 'post')
    store.add(item('b1', 'B'), 'post')
    expect(store.recent({ stream: 'A' }).map((r) => r.id)).toEqual(['a1'])
  })

  it('all-latest orders by publish time (timestamp), not insertion order', () => {
    store.add(item('a1', 'A', '2026-06-01T00:00:00Z'), 'post') // inserted first, oldest publish
    store.add(item('b1', 'B', '2026-06-03T00:00:00Z'), 'post') // newest publish
    store.add(item('a2', 'A', '2026-06-02T00:00:00Z'), 'post') // middle
    expect(store.recent().map((r) => r.id)).toEqual(['b1', 'a2', 'a1'])
  })

  it('all-latest excludes excludeStreams; the stream itself still returns them', () => {
    store.add(item('a1', 'A'), 'post')
    store.add(item('c1', 'C'), 'post') // a collection/snapshot stream
    expect(store.recent({ excludeStreams: ['C'] }).map((r) => r.id)).toEqual(['a1'])
    expect(store.recent({ stream: 'C' }).map((r) => r.id)).toEqual(['c1']) // direct view unaffected
  })

  it('caps per stream, evicting oldest', () => {
    store.add(item('a1', 'A'), 'post')
    store.add(item('a2', 'A'), 'post')
    store.add(item('a3', 'A'), 'post') // cap=2 → a1 evicted
    expect(store.recent({ stream: 'A' }).map((r) => r.id)).toEqual(['a3', 'a2'])
  })

  it('ignores duplicate ids', () => {
    store.add(item('a1', 'A'), 'post')
    store.add(item('a1', 'A'), 'post')
    expect(store.recent({ stream: 'A' })).toHaveLength(1)
  })

  it('returns empty for no matches', () => {
    expect(store.recent()).toEqual([])
    expect(store.recent({ stream: 'none' })).toEqual([])
  })

  it('setMuted stamps a manual label onto a stored item', () => {
    store.add(item('a1', 'A'), 'post')
    store.setMuted('a1', { reason: 'lottery', rule: 'manual', manual: true })
    expect(store.recent()[0].muted).toEqual({ reason: 'lottery', rule: 'manual', manual: true })
  })

  it('setMuted(id, null) clears the flag', () => {
    store.add(item('a1', 'A'), 'post')
    store.setMuted('a1', { reason: 'ad', rule: 'manual', manual: true })
    store.setMuted('a1', null)
    expect(store.recent()[0].muted).toBeUndefined()
  })

  it('get returns a single stored item by id, or undefined', () => {
    store.add(item('a1', 'A'), 'post')
    expect(store.get('a1')?.id).toBe('a1')
    expect(store.get('nope')).toBeUndefined()
  })

  it('allMuted returns only muted items across streams', () => {
    store.add(item('a1', 'A'), 'post')
    store.add(item('b1', 'B'), 'post')
    store.setMuted('b1', { reason: 'ad', rule: 'manual', manual: true })
    const muted = store.allMuted()
    expect(muted.map((m) => m.id)).toEqual(['b1'])
    expect(muted[0].muted?.reason).toBe('ad')
  })

  it('replaceStream rebuilds a stream in order (items[0] newest), preserving muted', () => {
    const big = new ItemStore(join(dir, 'snap.db'), 100)
    // a scrambled prior state, with one muted item that must survive the swap
    big.add(item('old', 'C'), 'post')
    big.add(item('keep', 'C'), 'post')
    big.setMuted('keep', { reason: 'ad', rule: 'manual', manual: true })
    // upstream snapshot: newest-collected first; 'old' is no longer collected, 'keep' remains
    big.replaceStream('C', [item('c0', 'C'), item('keep', 'C'), item('c2', 'C')], 'post')
    const recent = big.recent({ stream: 'C' })
    expect(recent.map((r) => r.id)).toEqual(['c0', 'keep', 'c2']) // items[0] ends up on top
    expect(recent.find((r) => r.id === 'keep')?.muted).toEqual({ reason: 'ad', rule: 'manual', manual: true })
    expect(big.get('old')).toBeUndefined() // dropped — not in the new snapshot
    big.close()
  })

  it('replaceStream 带 sourceId 只换该 source 分片——多成员 collection 流互不抹除(活体事故回归)', () => {
    const big = new ItemStore(join(dir, 'snap3.db'), 100)
    // RSS 成员的存量(其一缺 source_id 模拟老行,但 id 不在新批 → 必须存活)
    big.add({ ...item('rss1', 'C'), source_id: 'rsshub:lizhi' }, 'post')
    big.add(item('rss-legacy', 'C'), 'post') // 无 source_id 的存量行
    // alist 成员快照落地:不得动 RSS 分片
    big.replaceStream('C', [{ ...item('nd1', 'C'), source_id: 'alist:alist-audio' }], 'post', 'alist:alist-audio')
    expect(new Set(big.recent({ stream: 'C' }).map((r) => r.id))).toEqual(new Set(['rss1', 'rss-legacy', 'nd1']))
    // alist 再采一轮(nd1 掉出、nd2 进入):只有 alist 分片被换
    big.replaceStream('C', [{ ...item('nd2', 'C'), source_id: 'alist:alist-audio' }], 'post', 'alist:alist-audio')
    expect(new Set(big.recent({ stream: 'C' }).map((r) => r.id))).toEqual(new Set(['rss1', 'rss-legacy', 'nd2']))
    // 缺 source_id 的老行,若 id 出现在本批 → 被本批替换,不重插成双行
    big.replaceStream('C', [{ ...item('rss-legacy', 'C'), source_id: 'rsshub:lizhi' }, { ...item('rss1', 'C'), source_id: 'rsshub:lizhi' }], 'post', 'rsshub:lizhi')
    const rows = big.recent({ stream: 'C' })
    expect(rows.filter((r) => r.id === 'rss-legacy')).toHaveLength(1)
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(['rss1', 'rss-legacy', 'nd2']))
    big.close()
  })

  it('countBySource 数的是"replaceStream 会替换掉的那一批"——同源分片，别的成员/别的流不算', () => {
    const big = new ItemStore(join(dir, 'count.db'), 100)
    big.add({ ...item('rss1', 'C'), source_id: 'rsshub:lizhi' }, 'post')
    big.add({ ...item('rss2', 'C'), source_id: 'rsshub:lizhi' }, 'post')
    big.add({ ...item('nd1', 'C'), source_id: 'alist:alist-audio' }, 'post')
    big.add(item('legacy', 'C'), 'post') // 无 source_id 的存量行
    big.add({ ...item('other', 'D'), source_id: 'rsshub:lizhi' }, 'post')
    expect(big.countBySource('C', 'rsshub:lizhi')).toBe(2)
    expect(big.countBySource('C', 'alist:alist-audio')).toBe(1)
    expect(big.countBySource('C', 'rsshub:nobody')).toBe(0)
    big.close()
  })

  it('replaceStream leaves other streams untouched', () => {
    const big = new ItemStore(join(dir, 'snap2.db'), 100)
    big.add(item('a1', 'A'), 'post')
    big.replaceStream('C', [item('c0', 'C')], 'post')
    expect(big.recent({ stream: 'A' }).map((r) => r.id)).toEqual(['a1'])
    big.close()
  })

  it('recentForStreams returns each stream capped at limitPerStream, newest-first (seq DESC)', () => {
    store.addMany([item('a1', 'A'), item('a2', 'A'), item('b1', 'B')], 'post')
    // capPerStream in beforeEach is 2, but recentForStreams' own limitPerStream param
    // is independent — ask for 1 per stream here.
    const byStream = store.recentForStreams(['A', 'B', 'C'], 1)
    expect(byStream.get('A')?.map((r) => r.id)).toEqual(['a2'])
    expect(byStream.get('B')?.map((r) => r.id)).toEqual(['b1'])
    expect(byStream.get('C') ?? []).toEqual([])
  })

  it('recentForStreams matches recent({stream, limit}) called individually for the same data', () => {
    store.addMany(
      [item('a1', 'A'), item('a2', 'A'), item('a3', 'A'), item('b1', 'B'), item('b2', 'B')],
      'post'
    )
    const streamIds = ['A', 'B', 'C']
    const batch = store.recentForStreams(streamIds, 2)
    for (const id of streamIds) {
      const individual = store.recent({ stream: id, limit: 2 })
      expect((batch.get(id) ?? []).map((r) => r.id)).toEqual(individual.map((r) => r.id))
    }
  })

  it('recentForStreams is empty for an empty stream id list', () => {
    store.addMany([item('a1', 'A')], 'post')
    expect(store.recentForStreams([], 5).size).toBe(0)
  })

  describe('recentForStreams cursor mode (Task 2b)', () => {
    // beforeEach's `store` has capPerStream=2 (exercises eviction elsewhere in this file); these
    // tests need every row to survive, so each uses its own high-cap store — same pattern as the
    // existing `replaceStream` tests above (`new ItemStore(join(dir, '...'), 100)`).
    let big: ItemStore
    beforeEach(() => { big = new ItemStore(join(dir, `big-${Math.random()}.db`), 100) })
    afterEach(() => big.close())

    it('cursor=true orders by sort key (timestamp||fetched_at) DESC, not seq — recovers an out-of-seq newest row', () => {
      // inserted oldest-publish-first (seq ASC == timestamp ASC), so a seq-window (top-by-seq)
      // would pick the wrong end for a small window; sort-key mode must pick by timestamp.
      big.add(item('old', 'A', '2026-01-01T00:00:00.000Z'), 'post')
      big.add(item('mid', 'A', '2026-01-02T00:00:00.000Z'), 'post')
      big.add(item('new', 'A', '2026-01-03T00:00:00.000Z'), 'post')
      const byStream = big.recentForStreams(['A'], 2, true)
      expect(byStream.get('A')?.map((r) => r.id)).toEqual(['new', 'mid'])
    })

    it('cursor={sortKey,id} predicate is strictly-after (excludes the cursor row itself) and tie-breaks by id DESC', () => {
      big.add(item('a1', 'A', '2026-01-01T00:00:00.000Z'), 'post')
      big.add(item('z-tie', 'A', '2026-01-02T00:00:00.000Z'), 'post')
      big.add(item('a-tie', 'A', '2026-01-02T00:00:00.000Z'), 'post')
      big.add(item('newest', 'A', '2026-01-03T00:00:00.000Z'), 'post')
      // cursor = the position just after 'newest' → should yield the tie pair, z-tie before a-tie
      const page1 = big.recentForStreams(['A'], 2, true)
      expect(page1.get('A')?.map((r) => r.id)).toEqual(['newest', 'z-tie'])
      const cursor = { sortKey: '2026-01-02T00:00:00.000Z', id: 'z-tie' }
      const page2 = big.recentForStreams(['A'], 2, cursor)
      expect(page2.get('A')?.map((r) => r.id)).toEqual(['a-tie', 'a1'])
    })

    it('sort-key expression matches JS `timestamp || fetched_at` for a NULL timestamp row', () => {
      const noTs = { id: 'no-ts', stream_id: 'A', source_type: 'rsshub-bridge', source_route: '/x', fetched_at: '2026-01-02T12:00:00.000Z', title: 'no-ts', raw: {} } as unknown as StreamItem
      big.add(item('ts-mid', 'A', '2026-01-02T00:00:00.000Z'), 'post')
      big.add(noTs, 'post') // no `timestamp` field at all → stored as SQL NULL → falls back to fetched_at
      big.add(item('ts-old', 'A', '2026-01-01T00:00:00.000Z'), 'post')
      const byStream = big.recentForStreams(['A'], 3, true)
      // JS: sortKeyOf(no-ts) = undefined || '2026-01-02T12:00:00.000Z' = fetched_at → sorts between ts-mid and... actually newest
      expect(byStream.get('A')?.map((r) => r.id)).toEqual(['no-ts', 'ts-mid', 'ts-old'])
    })

    it('sort-key expression matches JS `timestamp || fetched_at` for an empty-string timestamp row (falls through to fetched_at, unlike plain SQL COALESCE)', () => {
      const emptyTs = { id: 'empty-ts', stream_id: 'A', source_type: 'rsshub-bridge', source_route: '/x', fetched_at: '2026-01-02T18:00:00.000Z', timestamp: '', title: 'empty-ts', raw: {} } as unknown as StreamItem
      big.add(item('ts-mid', 'A', '2026-01-02T00:00:00.000Z'), 'post')
      big.add(emptyTs, 'post') // timestamp: '' — JS `'' || fetched_at` falls through to fetched_at
      big.add(item('ts-old', 'A', '2026-01-01T00:00:00.000Z'), 'post')
      const byStream = big.recentForStreams(['A'], 3, true)
      expect(byStream.get('A')?.map((r) => r.id)).toEqual(['empty-ts', 'ts-mid', 'ts-old'])
    })

    it('legacy no-cursor call keeps seq-window semantics unchanged (backward compat)', () => {
      // seq order != timestamp order here (inserted newest-publish-first)
      store.add(item('a1', 'A', '2026-01-03T00:00:00.000Z'), 'post')
      store.add(item('a2', 'A', '2026-01-02T00:00:00.000Z'), 'post')
      store.add(item('a3', 'A', '2026-01-01T00:00:00.000Z'), 'post')
      // no-cursor mode: top-by-seq DESC == most-recently-inserted-first == a3, a2
      const byStream = store.recentForStreams(['A'], 2)
      expect(byStream.get('A')?.map((r) => r.id)).toEqual(['a3', 'a2'])
    })

    it('cursor pagination with mixed-case ids on tie-break — both items reached, no skip', () => {
      // RED test: two items tie on sortKey with ids where byte order != localeCompare order.
      // Byte compare: 'a1' > 'B2' (0x61 > 0x42)
      // localeCompare: 'B2' > 'a1' (uppercase B < lowercase a in ICU)
      // With limit=1 pagination, SQL's byte-comparison predicate `id < 'a1'` will NOT return 'B2'.
      // But JS expects 'B2' to be next based on localeCompare ordering → permanently skipped.
      const ts = '2026-01-02T00:00:00.000Z'
      big.add(item('a1', 'A', ts), 'post')
      big.add(item('B2', 'A', ts), 'post')
      // Page 1: limit=1, should get the highest id by byte order (a1)
      const page1 = big.recentForStreams(['A'], 1, true)
      expect(page1.get('A')?.map((r) => r.id)).toEqual(['a1'])
      // Page 2: cursor after a1, limit=1, should get B2 (strictly after a1 in byte compare)
      const cursor = { sortKey: ts, id: 'a1' }
      const page2 = big.recentForStreams(['A'], 1, cursor)
      expect(page2.get('A')?.map((r) => r.id)).toEqual(['B2'])
    })
  })

  describe('rewriteItems', () => {
    it('rewrites matching rows, leaves null/same-ref rows untouched, scopes by streamId', () => {
      const store = new ItemStore(join(dir, 'rw.db'))
      store.add(item('a1', 's1'), 'post')
      store.add(item('a2', 's1'), 'post')
      store.add(item('b1', 's2'), 'post')
      const res = store.rewriteItems({ streamId: 's1' }, (it) => {
        if (it.id === 'a1') return { ...it, title: 'rewritten' }
        return null
      })
      expect(res).toEqual({ scanned: 2, updated: 1, parseErrors: 0 })
      expect(store.get('a1')!.title).toBe('rewritten')
      expect(store.get('a2')!.title).toBe('t-a2')
      expect(store.get('b1')!.title).toBe('t-b1')
      store.close()
    })

    it('does not persist the injected type column field into the json blob', () => {
      const store = new ItemStore(join(dir, 'rw2.db'))
      store.add(item('a1', 's1'), 'post')
      store.rewriteItems({}, (it) => ({ ...it, title: 'x' }))
      const raw = (store as unknown as { db: import('better-sqlite3').Database }).db
        .prepare('SELECT json FROM items WHERE id = ?').get('a1') as { json: string }
      expect(JSON.parse(raw.json)).not.toHaveProperty('type')
      store.close()
    })

    it('isolates a corrupt json row as parseErrors and keeps rewriting the rest', () => {
      const store = new ItemStore(join(dir, 'rw3.db'))
      store.add(item('a1', 's1'), 'post')
      store.add(item('a2', 's1'), 'post')
      ;(store as unknown as { db: import('better-sqlite3').Database }).db
        .prepare('UPDATE items SET json = ? WHERE id = ?').run('{broken', 'a1')
      const res = store.rewriteItems({}, (it) => ({ ...it, title: 'x' }))
      expect(res.parseErrors).toBe(1)
      expect(res.updated).toBe(1)
      expect(store.get('a2')!.title).toBe('x')
      store.close()
    })
  })
})

describe('ItemStore.maxSeq / newCountSince', () => {
  it('tracks max seq and counts items newer than a watermark', () => {
    const dir = mkdtempSync(join(tmpdir(), 'itemstore-'))
    const store = new ItemStore(join(dir, 'i.db')) // default cap — no eviction interference
    store.add(item('a', 's'), 'post')
    store.add(item('b', 's'), 'post')

    expect(store.maxSeq('s')).toBe(2)
    expect(store.newCountSince('s', 0)).toBe(2) // nothing seen → all new
    expect(store.newCountSince('s', 1)).toBe(1) // seen seq 1 → one new

    store.add(item('c', 's'), 'post')
    expect(store.maxSeq('s')).toBe(3)
    expect(store.newCountSince('s', 2)).toBe(1)
    expect(store.newCountSince('s', 3)).toBe(0) // caught up

    expect(store.maxSeq('empty')).toBe(0)
    expect(store.newCountSince('empty', 0)).toBe(0)
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('search() —— 读已采集进库那批（inbox_search 的查询层）', () => {
    let dir2: string
    let s: ItemStore
    /** 一条带作者与正文的条目（cap 不设小，这组用例要留住全部行）。 */
    function post(id: string, over: Partial<StreamItem> = {}): StreamItem {
      return { ...item(id, over.stream_id ?? 'S'), ...over } as StreamItem
    }
    beforeEach(() => {
      dir2 = mkdtempSync(join(tmpdir(), 'itemsearch-'))
      s = new ItemStore(join(dir2, 'i.db'))
      s.addMany(
        [
          post('x1', { author: '大道无形我有型', timestamp: '2026-08-05T00:00:00.000Z', title: '关于茅台', body_text: '我一直觉得茅台的生意模式很好' }),
          post('x2', { author: '大道无形我有型', timestamp: '2026-08-17T00:00:00.000Z', title: '闲聊', content: { archetype: 'text', text: '苹果的护城河还在' } }),
          post('x3', { author: '别人', timestamp: '2026-08-10T00:00:00.000Z', title: '茅台涨了' }),
          post('y1', { stream_id: 'T', author: '大道无形我有型', timestamp: '2026-08-12T00:00:00.000Z', title: '另一个流里的' }),
        ],
        'post',
      )
    })
    afterEach(() => {
      s.close()
      rmSync(dir2, { recursive: true, force: true })
    })

    it('无过滤 = 按发布时间倒序的全库', () => {
      const r = s.search({})
      expect(r.items.map((i) => i.id)).toEqual(['x2', 'y1', 'x3', 'x1'])
      expect(r.matched).toBe(4)
    })

    it('按作者过滤（子串，中文）', () => {
      expect(s.search({ author: '大道无形' }).items.map((i) => i.id)).toEqual(['x2', 'y1', 'x1'])
    })

    it('关键词 q 扫标题 / body_text / content.text 三处', () => {
      expect(s.search({ q: '茅台' }).items.map((i) => i.id).sort()).toEqual(['x1', 'x3']) // 标题 + body_text
      expect(s.search({ q: '护城河' }).items.map((i) => i.id)).toEqual(['x2']) // content.text
    })

    it('q 不扫 raw / url 那类字段 —— 否则命中一堆噪声', () => {
      s.add(post('z1', { title: '无关', raw: { note: '茅台' } }), 'post')
      expect(s.search({ q: '茅台' }).items.map((i) => i.id)).not.toContain('z1')
    })

    it('LIKE 通配符按字面匹配（% 不是"匹配一切"）', () => {
      s.add(post('p1', { title: '涨了 100%' }), 'post')
      expect(s.search({ q: '%' }).items.map((i) => i.id)).toEqual(['p1'])
    })

    it('时间窗含端点，且能与其它条件并用', () => {
      const r = s.search({ author: '大道无形我有型', since: '2026-08-05T00:00:00.000Z', until: '2026-08-12T00:00:00.000Z' })
      expect(r.items.map((i) => i.id)).toEqual(['y1', 'x1'])
    })

    it('按 stream 过滤，多个 stream 取并集', () => {
      expect(s.search({ streams: ['T'] }).items.map((i) => i.id)).toEqual(['y1'])
      expect(s.search({ streams: ['S', 'T'] }).matched).toBe(4)
    })

    it('limit 截断，但 matched 报的是全部命中数（否则没法说"还有多少没给你"）', () => {
      const r = s.search({ author: '大道无形我有型', limit: 2 })
      expect(r.items.map((i) => i.id)).toEqual(['x2', 'y1'])
      expect(r.matched).toBe(3)
    })

    it('order:asc = 最早的在前', () => {
      expect(s.search({ order: 'asc', limit: 1 }).items.map((i) => i.id)).toEqual(['x1'])
    })
  })

  it('newCountSince excludes muted (folded) items — badge counts only visible', () => {
    const dir = mkdtempSync(join(tmpdir(), 'itemstore-'))
    const store = new ItemStore(join(dir, 'i.db'))
    const muted = (id: string) => ({ id, stream_id: 's', timestamp: null, muted: { reason: 'filtered', rule: '纯享' } } as unknown as StreamItem)
    store.add(item('a', 's'), 'post')   // seq 1, visible
    store.add(muted('b'), 'post')        // seq 2, folded
    store.add(item('c', 's'), 'post')   // seq 3, visible
    expect(store.newCountSince('s', 0)).toBe(2) // a + c, not b
    expect(store.maxSeq('s')).toBe(3)           // maxSeq still counts the folded row's seq
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
