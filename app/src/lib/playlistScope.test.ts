import { describe, expect, it } from 'vitest'
import { buildMemberRows, filterRows, moveInOrder, myPlaylistCards, planScopeResolution, rowCollectKey, shouldBounceCollection } from './playlistScope.ts'
import { collectedItemKey } from './api.ts'
import type { CollectedItem, Item } from './types.ts'

const member = (over: Partial<CollectedItem>): CollectedItem =>
  ({ key: 'x', kind: 'episode', domain: 'audio', title: 'T', firstCollectedAt: 0, ...over }) as CollectedItem

describe('rowCollectKey', () => {
  it('platform track rows keep the track namespace (和「我的喜欢」同键)', () => {
    expect(rowCollectKey({ id: 'i1', likeRef: { platform: 'netease', trackId: '9' } }, 'pod-a'))
      .toEqual({ kind: 'track', platform: 'netease', trackId: '9' })
  })
  it('direct-url episodes get an episode key; no stream context → null', () => {
    expect(rowCollectKey({ id: 'ep:1' }, 'pod-a')).toEqual({ kind: 'episode', streamId: 'pod-a', itemId: 'ep:1' })
    expect(rowCollectKey({ id: 'ep:1' }, null)).toBeNull()
  })
})

describe('collectedItemKey (episode)', () => {
  it('round-trips itemId with colons', () => {
    expect(collectedItemKey({ kind: 'episode', streamId: 'pod-a', itemId: 'ep:1' })).toBe('episode:pod-a:ep:1')
  })
})

describe('filterRows', () => {
  const rows = [
    { title: '衣柜播客 第1期', author: '主播A', album: '' },
    { title: '晚风 第2期', author: '主播B', album: '系列X' },
  ]
  it('matches title/author/album case-insensitively, empty query passes through', () => {
    expect(filterRows(rows, '第1期')).toHaveLength(1)
    expect(filterRows(rows, '主播b')).toHaveLength(1)
    expect(filterRows(rows, '系列x')).toHaveLength(1)
    expect(filterRows(rows, '  ')).toHaveLength(2)
    expect(filterRows(rows, '没有的')).toHaveLength(0)
  })
})

describe('rowCollectKey — scope 行(row.id 是合成 key,必须走 collectKey 而不是重新拼)', () => {
  // 镜像 MusicChannel 里 scopeRows 的构造:row.id = m.key(合成串),真身份另存 collectKey。
  it('same-stream episode member round-trips to its original key', () => {
    const m = member({ key: 'episode:pod-a:e1', itemId: 'e1', streamId: 'pod-a' })
    const row = { id: m.key, collectKey: { kind: 'episode' as const, streamId: m.streamId!, itemId: m.itemId! } }
    expect(collectedItemKey(rowCollectKey(row, 'pod-a')!)).toBe(m.key)
  })
  it('cross-stream episode member round-trips to ITS OWN stream, not the anchor/current sel', () => {
    const m = member({ key: 'episode:pod-b:e2', itemId: 'e2', streamId: 'pod-b' })
    const row = { id: m.key, collectKey: { kind: 'episode' as const, streamId: m.streamId!, itemId: m.itemId! } }
    // 当前 scope 挂在 pod-a 下,但这个成员真身份在 pod-b——不能被 streamId 参数(当前 sel)污染。
    expect(collectedItemKey(rowCollectKey(row, 'pod-a')!)).toBe(m.key)
    expect(rowCollectKey(row, 'pod-a')).toEqual({ kind: 'episode', streamId: 'pod-b', itemId: 'e2' })
  })
  it('track member round-trips regardless of streamId param', () => {
    const m = member({ key: 'track:netease:9', kind: 'track', platform: 'netease', trackId: '9' })
    const row = { id: m.key, collectKey: { kind: 'track' as const, platform: m.platform!, trackId: m.trackId! } }
    expect(collectedItemKey(rowCollectKey(row, 'pod-a')!)).toBe(m.key)
  })
})

describe('planScopeResolution', () => {
  it('splits members into live/cross-stream/track buckets (spec §3)', () => {
    const members = [
      member({ key: 'episode:pod-a:e1', itemId: 'e1', streamId: 'pod-a' }),
      member({ key: 'episode:pod-b:e2', itemId: 'e2', streamId: 'pod-b' }),
      member({ key: 'episode:pod-b:e3', itemId: 'e3', streamId: 'pod-b' }),
      member({ key: 'track:netease:9', kind: 'track', platform: 'netease', trackId: '9' }),
    ]
    const plan = planScopeResolution(members, 'pod-a')
    expect(plan.liveItemIds).toEqual(['e1'])
    expect([...plan.fetchStreams.entries()]).toEqual([['pod-b', ['e2', 'e3']]])
    expect(plan.trackMembers.map((m) => m.key)).toEqual(['track:netease:9'])
  })
})

const audioItem = (id: string, url: string): Item => ({
  id, title: `T-${id}`, url: 'https://x/' + id,
  content: { media: [{ kind: 'audio', url }] },
} as unknown as Item)

describe('buildMemberRows', () => {
  it('builds playable rows whose playIndex indexes into its OWN tracks array', () => {
    const members = [
      member({ key: 'episode:s1:e1', kind: 'episode', streamId: 's1', itemId: 'e1', title: 'E1' }),
      member({ key: 'episode:s1:e2', kind: 'episode', streamId: 's1', itemId: 'e2', title: 'E2' }),
    ]
    const items = new Map([['e1', audioItem('e1', 'https://cdn/e1.mp3')], ['e2', audioItem('e2', 'https://cdn/e2.mp3')]])
    const { rows, tracks } = buildMemberRows(members, (id) => items.get(id), 'http://b')
    expect(tracks).toHaveLength(2)
    expect(rows.map((r) => r.playIndex)).toEqual([0, 1])
    expect(tracks[rows[1].playIndex].id).toBe(rows[1].track!.id)
  })

  it('grays out a member whose live item is missing (kept, not dropped)', () => {
    const members = [
      member({ key: 'episode:s1:gone', kind: 'episode', streamId: 's1', itemId: 'gone', title: '失联集', poster: '/p.jpg' }),
      member({ key: 'episode:s1:e1', kind: 'episode', streamId: 's1', itemId: 'e1', title: 'E1' }),
    ]
    const items = new Map([['e1', audioItem('e1', 'https://cdn/e1.mp3')]])
    const { rows, tracks } = buildMemberRows(members, (id) => items.get(id), 'http://b')
    expect(rows).toHaveLength(2)                    // 不丢行
    expect(rows[0]).toMatchObject({ muted: true, playIndex: -1, title: '失联集', poster: '/p.jpg' })
    expect(rows[0].track).toBeUndefined()
    expect(tracks).toHaveLength(1)                  // 只有可播的进队列
    expect(rows[1].playIndex).toBe(0)
  })

  it('track members resolve via audioResolveUrl and carry a track collectKey', () => {
    const members = [member({ key: 'track:netease:9', kind: 'track', platform: 'netease', trackId: '9', title: 'Song' })]
    const { rows, tracks } = buildMemberRows(members, () => undefined, 'http://b')
    expect(rows[0].collectKey).toEqual({ kind: 'track', platform: 'netease', trackId: '9' })
    expect(rows[0].muted).toBeFalsy()
    expect(tracks[0].url).toContain('netease')
  })

  // AudioTrack.poster 是展示就绪的（见 audioStage.ts 的契约）：它要穿过一串拿不到 baseUrl 的
  // 消费端。行上的 poster 是另一回事——表格行自己在渲染时包，所以保持源站原样。
  it('track 成员：进队列的封面过图片代理，行上的保持原样', () => {
    const cover = 'https://p2.music.126.net/c.jpg'
    const members = [member({ key: 'track:netease:9', kind: 'track', platform: 'netease', trackId: '9', title: 'Song', poster: cover })]
    const { rows, tracks } = buildMemberRows(members, () => undefined, 'http://b')
    expect(tracks[0].poster).toBe(`http://b/api/media/image?url=${encodeURIComponent(cover)}`)
    expect(rows[0].poster).toBe(cover)
  })

  it('episode collectKey carries the MEMBER own streamId (cross-stream safe)', () => {
    const members = [member({ key: 'episode:s2:e9', kind: 'episode', streamId: 's2', itemId: 'e9', title: 'X' })]
    const { rows } = buildMemberRows(members, () => undefined, 'http://b')
    expect(rows[0].collectKey).toEqual({ kind: 'episode', streamId: 's2', itemId: 'e9' })
  })
})

describe('myPlaylistCards', () => {
  const labels = new Map([['pod-a', '怡乐播客']])
  it('drops system collections, keeps user ones', () => {
    const out = myPlaylistCards(
      [{ id: 'col_liked', label: '我的喜欢', system: 'liked' }, { id: 'col_1', label: '某系列', itemCount: 3 }],
      labels,
    )
    expect(out).toEqual([{ id: 'col_1', label: '某系列', subtitle: undefined, itemCount: 3 }])
  })
  it('labels an anchored playlist with its podcast; global has no subtitle', () => {
    const out = myPlaylistCards(
      [{ id: 'a', label: '系列A', anchorStreamId: 'pod-a', itemCount: 2 }, { id: 'b', label: '全局单' }],
      labels,
    )
    expect(out[0].subtitle).toBe('来自「怡乐播客」')
    expect(out[1].subtitle).toBeUndefined()
    expect(out[1].itemCount).toBe(0)
  })
  it('anchored to a stream that no longer exists shows no subtitle (不瞎标)', () => {
    expect(myPlaylistCards([{ id: 'x', label: '孤儿单', anchorStreamId: 'gone' }], labels)[0].subtitle).toBeUndefined()
  })
  it('system 播单(如「正在追的」)被过滤掉,不进片单卡列表;剩下的无 anchor → 无副标(streamLabelById 传空 Map)', () => {
    const out = myPlaylistCards(
      [{ id: 'col_v1', label: '想看的科幻', itemCount: 4 }, { id: 'col_video_following', label: '正在追的', system: 'following' }],
      new Map(),
    )
    expect(out).toEqual([{ id: 'col_v1', label: '想看的科幻', subtitle: undefined, itemCount: 4 }])
  })
})

describe('shouldBounceCollection — 深链到不存在的播单 id 才退回 L1(上一轮 Critical race 的回归钉子)', () => {
  it('valid empty playlist: members loaded, meta loaded, meta found → does not bounce', () => {
    expect(shouldBounceCollection({ selCollection: 'col-1', membersLoaded: true, metaLoaded: true, meta: { id: 'col-1', label: 'X' } })).toBe(false)
  })
  it('meta fetch failed (metaLoaded stays false) → never bounce on a network error, even with members already loaded', () => {
    expect(shouldBounceCollection({ selCollection: 'col-1', membersLoaded: true, metaLoaded: false, meta: null })).toBe(false)
  })
  it('genuinely-absent id: both loaded, meta resolved to null → bounce', () => {
    expect(shouldBounceCollection({ selCollection: 'col-1', membersLoaded: true, metaLoaded: true, meta: null })).toBe(true)
  })
  it('nothing selected (selCollection null) → never bounce', () => {
    expect(shouldBounceCollection({ selCollection: null, membersLoaded: true, metaLoaded: true, meta: null })).toBe(false)
  })
  it('members still in flight (membersLoaded false) → does not bounce even if meta already resolved to null', () => {
    expect(shouldBounceCollection({ selCollection: 'col-1', membersLoaded: false, metaLoaded: true, meta: null })).toBe(false)
  })
})

describe('moveInOrder — 拖拽落点的纯算式', () => {
  const l = ['a', 'b', 'c', 'd']
  it('往后拖:目标位置是"松手时它该站的地方",被越过的整体前移一格', () => {
    expect(moveInOrder(l, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
  })
  it('往前拖', () => {
    expect(moveInOrder(l, 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })
  it('拖到原地 = 原样(不能因此发一次多余的写请求)', () => {
    expect(moveInOrder(l, 2, 2)).toEqual(l)
  })
  it('拖到首尾', () => {
    expect(moveInOrder(l, 2, 0)).toEqual(['c', 'a', 'b', 'd'])
    expect(moveInOrder(l, 0, 3)).toEqual(['b', 'c', 'd', 'a'])
  })
  it('越界下标一律原样返回——宁可什么都不做,也不要把名单弄成别的样子', () => {
    expect(moveInOrder(l, -1, 2)).toEqual(l)
    expect(moveInOrder(l, 0, 9)).toEqual(l)
    expect(moveInOrder(l, 9, 0)).toEqual(l)
  })
  it('不改原数组(调用方还拿着它做乐观更新的回滚底本)', () => {
    const src = ['a', 'b', 'c']
    moveInOrder(src, 0, 2)
    expect(src).toEqual(['a', 'b', 'c'])
  })
  it('任何一次移动都是全排列——元素不增不减不重复', () => {
    for (let from = 0; from < l.length; from++) {
      for (let to = 0; to < l.length; to++) {
        expect([...moveInOrder(l, from, to)].sort()).toEqual([...l].sort())
      }
    }
  })
})
