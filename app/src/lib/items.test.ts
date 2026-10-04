import { describe, it, expect } from 'vitest'
import { ADS_CHANNEL, partitionForView, partitionFollowing } from './items.ts'
import type { Item, ChannelStream, CollectedItem } from './types.ts'
import { mergeFollowingTimeline } from './items.ts'

const mk = (id: string, muted?: boolean, stream_id = 's'): Item => ({
  id,
  stream_id,
  type: 'post',
  title: id,
  timestamp: '',
  fetched_at: '',
  ...(muted ? { muted: { reason: 'ad' as const, rule: '推广' } } : {}),
})

const items: Item[] = [mk('a'), mk('ad1', true), mk('b'), mk('ad2', true)]

describe('partitionForView', () => {
  it('excludes muted items from a normal stream view', () => {
    expect(partitionForView(items, 's1').map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('excludes muted items from the All Latest view (null)', () => {
    expect(partitionForView(items, null).map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('shows only muted items in the ads channel', () => {
    expect(partitionForView(items, ADS_CHANNEL).map((i) => i.id)).toEqual(['ad1', 'ad2'])
  })

  it('excludes audio-stream items from non-music views', () => {
    const mixed = [mk('t1'), mk('song1', false, 'pl'), mk('t2'), mk('song2', false, 'pl')]
    const audioIds = new Set(['pl'])
    // All Latest: audio (歌单) items routed out
    expect(partitionForView(mixed, null, audioIds).map((i) => i.id)).toEqual(['t1', 't2'])
    // a specific (non-audio) channel: unaffected
    expect(partitionForView(mixed, 's1', audioIds).map((i) => i.id)).toEqual(['t1', 't2'])
  })
})

describe('partitionFollowing', () => {
  const mk = (id: string, newCount?: number): ChannelStream =>
    ({
      id, description: id, sources: [], cadence_seconds: 0, vault_subdir: id,
      ...(newCount === undefined ? {} : { newCount }),
    } as ChannelStream)

  it('splits followed (has newCount) from rankings (no newCount)', () => {
    const { following, rankings } = partitionFollowing([mk('r1'), mk('show1', 3), mk('r2'), mk('show2', 0)])
    expect(following.map((s) => s.id)).toEqual(['show1', 'show2'])
    expect(rankings.map((s) => s.id)).toEqual(['r1', 'r2'])
  })

  it('treats newCount:0 as followed (you follow it, just no new episodes)', () => {
    const { following } = partitionFollowing([mk('show', 0)])
    expect(following.map((s) => s.id)).toEqual(['show'])
  })
})

describe('mergeFollowingTimeline', () => {
  const mkStream = (id: string): ChannelStream =>
    ({ id, description: id, sources: [], cadence_seconds: 0, vault_subdir: id, newCount: 0 } as ChannelStream)
  const colStream = (streamId: string): CollectedItem =>
    ({ key: `stream:${streamId}`, kind: 'stream', domain: 'video', streamId, title: streamId, firstCollectedAt: 0 })
  const colTmdb = (id: string, media: 'movie' | 'tv' = 'movie'): CollectedItem =>
    ({ key: `tmdb:${media}:${id}`, kind: 'tmdb', domain: 'video', tmdbId: id, media, title: id, firstCollectedAt: 0 })

  it('interleaves stream and tmdb entries in collected (added_at DESC) order', () => {
    const following = [mkStream('s1'), mkStream('s2')]
    const collected = [colTmdb('t1'), colStream('s2'), colTmdb('t2'), colStream('s1')]
    const keys = mergeFollowingTimeline(collected, following).map((e) => e.kind === 'stream' ? e.stream.id : e.item.key)
    expect(keys).toEqual(['tmdb:movie:t1', 's2', 'tmdb:movie:t2', 's1'])
  })

  it('skips collected stream entries with no live ChannelStream (e.g. stream deleted)', () => {
    const entries = mergeFollowingTimeline([colStream('gone'), colTmdb('t1')], [])
    expect(entries.map((e) => e.kind === 'stream' ? e.stream.id : e.item.key)).toEqual(['tmdb:movie:t1'])
  })

  it('falls back to reversed array order for following streams missing from collected (fetch failed)', () => {
    const following = [mkStream('old'), mkStream('new')]
    const entries = mergeFollowingTimeline([], following)
    expect(entries.map((e) => e.kind === 'stream' ? e.stream.id : '?')).toEqual(['new', 'old'])
  })

  it('appends missing-from-collected streams after the collected timeline, without duplicating', () => {
    const following = [mkStream('inCol'), mkStream('extraA'), mkStream('extraB')]
    const entries = mergeFollowingTimeline([colTmdb('t1'), colStream('inCol')], following)
    expect(entries.map((e) => e.kind === 'stream' ? e.stream.id : e.item.key))
      .toEqual(['tmdb:movie:t1', 'inCol', 'extraB', 'extraA'])
  })

  it('ignores non-video kinds defensively', () => {
    const track = { key: 'track:p:1', kind: 'track', domain: 'audio', platform: 'p', trackId: '1', title: 'x', firstCollectedAt: 0 } as CollectedItem
    expect(mergeFollowingTimeline([track], [])).toEqual([])
  })
})
