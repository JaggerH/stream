// Item → AudioTrack mapping: the single place that turns a stored feed item into something the
// global audio stage can play. Lives in lib/ (not MusicChannel) because it has two consumers with
// different queues: the Music channel (kind 'music') and the timeline's podcast branch
// (kind 'podcast'), which builds its play queue from the visible feed via toTracks().
import { backendUrl } from './backendUrl.ts'
import { imgUrl } from './imageUrl.ts'
import type { AudioKind, AudioTrack } from './audioStage.ts'
import type { Item } from './types.ts'
// 判据本身住 shared/——后端转写取字节时要下同一个判断（见那份的头注）。
import { originFallback } from '@music/origin-fallback.ts'

/** Map an item to a play-queue track. Two media shapes play:
 *  - platform audio (FREE song) / link (VIP song) carrying (platform, track_id) → we BUILD the
 *    /api/media/tracks/resolve route here from live code (archive-first, then the platform-
 *    dispatched track-fetching Provider, VIP too); the route is never read back from the item
 *    (see audioResolveUrl);
 *  - direct-url audio (a podcast episode from an RSS feed) with no platform ref → the media url IS
 *    the playable stream, played as-is with no resolve.
 *  Returns null only for items with neither a track ref nor a direct audio url.
 *  `kind` picks the play queue the track lands in: 'music' (default, the Music channel) or
 *  'podcast' (the timeline's episodic listening form). */
export function toTrack(it: Item, baseUrl: string, kind: AudioKind = 'music'): AudioTrack | null {
  let platform: string | undefined
  let trackId: string | undefined
  let poster: string | undefined
  let durationS: number | undefined
  let directUrl: string | undefined
  let resolveUrl: string | undefined // the normalizer's own resolve url for a platform track
  for (const m of it.content?.media ?? []) {
    if (m.kind === 'audio' && m.platform && m.track_id) {
      platform = m.platform; trackId = m.track_id; resolveUrl = m.url; poster = m.poster; durationS = m.duration_s; break
    }
    if (m.kind === 'audio' && m.url && !directUrl) {
      directUrl = m.url; poster = poster ?? m.poster; durationS = durationS ?? m.duration_s
    }
    if (m.kind === 'link' && m.platform && m.track_id && !platform) {
      platform = m.platform; trackId = m.track_id; poster = m.image; durationS = m.duration_s
    }
  }
  // Platform tracks resolve through the backend. We REBUILD the resolve route from (platform,
  // track_id) with CURRENT code rather than trusting the route baked into the stored item — a
  // stored route is data that rots the moment the endpoint is renamed (that is exactly how 07-05's
  // items on one platform ended up pointing at the retired /api/audio/resolve → 404). The only genuinely
  // non-derivable bit is a free podcast's origin enclosure, which the normalizer smuggles into the
  // stored url as `?fallback=…`; we salvage just that and re-attach it. A direct-url podcast (no
  // platform ref) plays its url as-is.
  // A direct url is usually an absolute external enclosure (podcast), played as-is. But a
  // root-relative one (e.g. netdisk-play's /api/media/netdisk-play?path=…) IS a backend route —
  // same as a resolved platform track — and needs the baseUrl prefix for the same reason
  // audioResolveUrl gets one. 判据本身在 `api.backendUrl`（页面的源不一定是后端的源：工作台
  // 面板是 DSH 那一页）——**别在这里内联第二份**，那正是影视侧
  // 播不了的来源。
  const url = platform && trackId
    ? audioResolveUrl(baseUrl, { platform, trackId, fallback: originFallback(resolveUrl) })
    : directUrl
      ? backendUrl(baseUrl, directUrl)
      : directUrl
  if (!url) return null
  const author = typeof it.author === 'string' ? it.author : undefined
  return {
    id: it.id,
    kind,
    url,
    title: songTitle(it), // strip the redundant " - 歌手" suffix (author shown separately)
    author,
    // 封面在这里就过图片代理，理由和上面 url 过 backendUrl 一样：AudioTrack 的消费端
    // （队列面板 / 顶栏迷你条 / 侧栏 / 全屏播放台里那两个 acrylic 组件）全都拿不到 baseUrl，
    // 也不该知道后端在哪。见 `AudioTrack.poster` 上的契约注释。
    poster: poster ? imgUrl(baseUrl, poster) : undefined,
    durationS,
    ...(platform && trackId ? { platform, trackId } : {}),
  }
}

/** The play-queue producer over a feed item list: every playable item in feed order, each stamped
 *  with `kind`. The timeline hands its visible items here to make the podcast queue — auto-advance
 *  (audioStage's nextTrack) then walks episodes the way the feed shows them. */
export function toTracks(items: Item[], baseUrl: string, kind: AudioKind): AudioTrack[] {
  const tracks: AudioTrack[] = []
  for (const it of items) {
    const t = toTrack(it, baseUrl, kind)
    if (t) tracks.push(t)
  }
  return tracks
}

// The frontend names only the track (platform + id); the backend's 按平台派发的取歌 Provider owns
// resolution — source selection + fallback ladder. No client-side provider/hint logic remains.
// The resolve ROUTE is a program concern built here from live code — never persisted — so renaming
// the endpoint can never rot stored items. `fallback` (a free podcast's origin enclosure) is the
// only real datum carried through; it round-trips as a query param.
export function audioResolveUrl(baseUrl: string, ref: { platform: string; trackId: string; fallback?: string }): string {
  const q = new URLSearchParams({ platform: ref.platform, id: ref.trackId })
  if (ref.fallback) q.set('fallback', ref.fallback)
  return `${baseUrl}/api/media/tracks/resolve?${q.toString()}`
}

export { originFallback }

/** 有的音乐源的 title 是 "曲名 - 歌手"；歌手已在下方单独显示，标题里去掉末尾的 " - 歌手" 只留曲名。 */
export function songTitle(it: Item): string {
  const t = it.title || it.id
  const a = typeof it.author === 'string' ? it.author : ''
  return a && t.endsWith(` - ${a}`) ? t.slice(0, -(a.length + 3)).trim() : t
}
