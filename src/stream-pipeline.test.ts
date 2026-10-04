import { describe, it, expect } from 'vitest'
import { makeStreamItem, persistItems } from './stream-pipeline.ts'
import { DedupStore } from './dedup-store.ts'
import type { AdRules } from './content/ad-filter.ts'

const rules: AdRules = { keywords: ['推广'], domains: ['ad.example.com'] }

describe('makeStreamItem — ad classification', () => {
  it('flags an item whose title matches a keyword rule', () => {
    const item = makeStreamItem('s1', '/r', { title: '【推广】买它', link: 'https://x.com/1' }, rules)
    expect(item.muted).toEqual({ reason: 'ad', rule: '推广' })
  })

  it('flags an item whose link host matches a domain rule', () => {
    const item = makeStreamItem('s1', '/r', { title: 'clean', link: 'https://ad.example.com/promo' }, rules)
    expect(item.muted).toEqual({ reason: 'ad', rule: 'ad.example.com' })
  })

  it('flags an item whose category array carries a keyword (v2ex 推广 node)', () => {
    const item = makeStreamItem('s1', '/r', { title: '低佣开户抽音箱', link: 'https://v2ex.com/t/1', category: ['推广'] }, rules)
    expect(item.muted).toEqual({ reason: 'ad', rule: '推广' })
  })

  it('normalizes a string-valued category before matching', () => {
    const item = makeStreamItem('s1', '/r', { title: 'clean', link: 'https://v2ex.com/t/2', category: '推广' }, rules)
    expect(item.muted).toEqual({ reason: 'ad', rule: '推广' })
  })

  it('leaves a clean item unmuted', () => {
    const item = makeStreamItem('s1', '/r', { title: '正常文章', link: 'https://news.ycombinator.com/x' }, rules)
    expect(item.muted).toBeUndefined()
  })

  it('never mutes when no rules are supplied', () => {
    const item = makeStreamItem('s1', '/r', { title: '推广', link: 'https://ad.example.com/x' })
    expect(item.muted).toBeUndefined()
  })
})

describe('makeStreamItem source_id', () => {
  const raw = { guid: 'g1', title: 'hello', link: 'https://x/1' }

  it('stamps the provided source_id', () => {
    const it = makeStreamItem('my-stream', '/douyin/follow', raw, undefined, 'douyin-follow')
    expect(it.source_id).toBe('douyin-follow')
    expect(it.stream_id).toBe('my-stream')
  })

  it('leaves source_id undefined when not provided (legacy path)', () => {
    const it = makeStreamItem('s1', '/r', raw)
    expect(it.source_id).toBeUndefined()
  })
})

describe('makeStreamItem season', () => {
  const raw = { guid: 'g1', title: 'hello', link: 'https://x/1' }

  it('stamps the provided season', () => {
    const it = makeStreamItem('my-stream', '/r', raw, undefined, undefined, undefined, 3)
    expect(it.season).toBe(3)
  })

  it('leaves season undefined when not provided (old streams unaffected)', () => {
    const it = makeStreamItem('my-stream', '/r', raw)
    expect(it.season).toBeUndefined()
  })
})

describe('makeStreamItem — title-include filter (只看包含)', () => {
  const inc = ['纯享']
  it('keeps an item whose title contains a keyword', () => {
    const it = makeStreamItem('s1', '/r', { title: '第1期纯享上集', link: 'https://x/1' }, undefined, undefined, inc)
    expect(it.muted).toBeUndefined()
  })
  it('folds an item whose title matches no keyword', () => {
    const it = makeStreamItem('s1', '/r', { title: '先导片 抢金赛', link: 'https://x/2' }, undefined, undefined, inc)
    expect(it.muted).toEqual({ reason: 'filtered', rule: '纯享' })
  })
  it('is case-insensitive', () => {
    const it = makeStreamItem('s1', '/r', { title: 'FULL version', link: 'https://x/3' }, undefined, undefined, ['full'])
    expect(it.muted).toBeUndefined()
  })
  it('no include list → never folds', () => {
    expect(makeStreamItem('s1', '/r', { title: 'anything', link: 'https://x/4' }).muted).toBeUndefined()
    expect(makeStreamItem('s1', '/r', { title: 'anything', link: 'https://x/5' }, undefined, undefined, []).muted).toBeUndefined()
  })
  it('an ad-muted item keeps its ad reason (ad classification wins over include-fold)', () => {
    // title is ad-muted (推广) AND lacks the include keyword — ad reason must not be overwritten
    const it = makeStreamItem('s1', '/r', { title: '推广买它', link: 'https://x/6' }, rules, undefined, ['纯享'])
    expect(it.muted).toEqual({ reason: 'ad', rule: '推广' })
  })
})

describe('makeStreamItem — pubDate', () => {
  // Unix time in SECONDS is what douyin (create_time) and many CN APIs publish. Read as
  // milliseconds — Date()'s default for a bare number — every one of them lands in 1970.
  it('reads a bare number below the ms threshold as epoch SECONDS', () => {
    const item = makeStreamItem('s1', '/r', { title: 't', pubDate: 1751500000 })
    expect(item.timestamp).toBe(new Date(1751500000 * 1000).toISOString())
  })

  it('still reads a real millisecond epoch as milliseconds', () => {
    const ms = 1751500000000
    const item = makeStreamItem('s1', '/r', { title: 't', pubDate: ms })
    expect(item.timestamp).toBe(new Date(ms).toISOString())
  })

  it('leaves an ISO string alone', () => {
    const iso = '2026-07-01T10:00:00.000Z'
    expect(makeStreamItem('s1', '/r', { title: 't', pubDate: iso }).timestamp).toBe(iso)
  })
})

describe('persistItems — batched, dedup-guarded persist', () => {
  const raw = (id: string) => ({ guid: id, title: `t-${id}`, link: `https://x/${id}` })

  it('commits all fresh items in ONE batch and notifies AFTER the commit', async () => {
    const dedup = new DedupStore(':memory:')
    const order: string[] = []
    let committedCount = -1
    const res = await persistItems(
      's1', '/r', [raw('a'), raw('b')], undefined, dedup,
      async () => { order.push('notify') },
      undefined, undefined, undefined,
      (fresh) => { committedCount = fresh.length; order.push('commit') },
    )
    expect(res).toEqual({ fetched: 2, written: 2 })
    expect(committedCount).toBe(2) // a single batched commit carrying both
    expect(order).toEqual(['commit', 'notify', 'notify']) // durable write, THEN per-item notify
    dedup.close()
  })

  it('skips already-seen items on a re-harvest (dedup), committing an empty batch', async () => {
    const dedup = new DedupStore(':memory:')
    await persistItems('s1', '/r', [raw('a')], undefined, dedup, undefined, undefined, undefined, undefined, () => {})
    let second = -1
    const res = await persistItems(
      's1', '/r', [raw('a')], undefined, dedup, undefined, undefined, undefined, undefined,
      (f) => { second = f.length },
    )
    expect(res).toEqual({ fetched: 1, written: 0 })
    expect(second).toBe(0)
    dedup.close()
  })

  it('writes a duplicate id appearing twice in ONE harvest only once (intra-batch guard)', async () => {
    const dedup = new DedupStore(':memory:')
    let committed = -1
    const res = await persistItems(
      's1', '/r', [raw('a'), raw('a')], undefined, dedup, undefined, undefined, undefined, undefined,
      (f) => { committed = f.length },
    )
    expect(res.written).toBe(1)
    expect(committed).toBe(1)
    dedup.close()
  })
})
