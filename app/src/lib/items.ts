import type { Item, ChannelStream, CollectedItem } from './types.ts'

/** Virtual channel id for the ads/promotions view (not a backend stream). */
export const ADS_CHANNEL = '__ads__'

/** Virtual channel id for the aggregated video/torrent search surface — a built-in
 *  keyword search across RSSHub film/anime download sources. Ephemeral, not a
 *  backend stream; results carry magnet links. */
export const VIDEO_CHANNEL = '__video__'

/** Virtual channel id for the 歌单 (Audio Channel) view — a music-player surface over
 *  audio-role streams. Handled by a dedicated component, not the inbox ItemList. */
export const MUSIC_CHANNEL = '__music__'

/** Split a video channel's streams into followed shows (正在追的) and ranking shelves.
 *  A stream is "followed" iff the API attached a `newCount` (done only for non-ranking video
 *  members) — so the frontend needs no ranking-id list; the backend is the single source. */
export function partitionFollowing(
  streams: ChannelStream[],
): { following: ChannelStream[]; rankings: ChannelStream[] } {
  const following: ChannelStream[] = []
  const rankings: ChannelStream[] = []
  for (const s of streams) (typeof s.newCount === 'number' ? following : rankings).push(s)
  return { following, rankings }
}

/** One tile of the「正在追的」grid — a followed Stream (renders WorkCard, needs the live
 *  ChannelStream for newCount/image) or a tmdb-only collection (renders TmdbWorkCard off
 *  the stored snapshot). */
export type FollowingEntry =
  | { kind: 'stream'; stream: ChannelStream }
  | { kind: 'tmdb'; item: CollectedItem }

/** 「正在追的」统一时间线。`collected` =「正在追」系统列表的条目(服务端已按 added_at 新→旧),
 *  是唯一的排序权威——stream 关注与 tmdb 收藏在同一条时间轴上交错,不再是两段各自排序后拼接。
 *  - collected 里的 stream 条目要在 `following`(频道里活着的、已判定为关注的 Stream)找到实体
 *    才渲染(找不到 = 流已被删/不在任何频道,快照没法撑起一张 WorkCard);
 *  - `following` 里有、collected 里没有的(拉列表失败,或本地刚收藏还没同步)按旧规则
 *    (数组序反转 = 新→旧)垫在时间线末尾——网格永不因收藏接口失败而整个空掉。 */
export function mergeFollowingTimeline(
  collected: CollectedItem[],
  following: ChannelStream[],
): FollowingEntry[] {
  const byStreamId = new Map(following.map((s) => [s.id, s]))
  const entries: FollowingEntry[] = []
  const seenStreams = new Set<string>()
  for (const item of collected) {
    if (item.kind === 'stream' && item.streamId) {
      const stream = byStreamId.get(item.streamId)
      if (!stream || seenStreams.has(stream.id)) continue
      seenStreams.add(stream.id)
      entries.push({ kind: 'stream', stream })
    } else if (item.kind === 'tmdb') {
      entries.push({ kind: 'tmdb', item })
    }
  }
  for (let i = following.length - 1; i >= 0; i--) {
    const stream = following[i]
    if (!seenStreams.has(stream.id)) entries.push({ kind: 'stream', stream })
  }
  return entries
}

/**
 * Route items for the current sidebar selection. Ad-filtered (muted) items are
 * collected into the dedicated Ads channel and kept out of every other view —
 * folded, never dropped. Audio (歌单) streams' items live only in the music view,
 * so they are excluded from the timeline / all-latest / channel views here.
 * `selected` is a real stream id, null (All Latest), or a virtual channel id.
 */
export function partitionForView(
  items: Item[],
  selected: string | null,
  audioStreamIds: Set<string> = new Set()
): Item[] {
  if (selected === ADS_CHANNEL) return items.filter((i) => i.muted)
  return items.filter((i) => !i.muted && !audioStreamIds.has(i.stream_id))
}
