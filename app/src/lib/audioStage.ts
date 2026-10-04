import { createContext, useContext } from 'react'

/** Two distinct listening modes, each with its own play queue: music (歌单) and podcasts.
 *  Only one drives the single <audio> element at a time (the active kind), but both queues
 *  persist so you can switch back and forth without losing position. */
export type AudioKind = 'music' | 'podcast'

/** A playable audio track. `id` is the source item id, so a card can tell whether it is the
 *  one currently playing. `kind` routes it to the music or podcast queue. */
export interface AudioTrack {
  id: string
  url: string
  kind: AudioKind
  title?: string
  author?: string
  /** **展示就绪的封面地址**——已经过 `imgUrl`（图片代理），可以直接塞进 `<img src>`。
   *  和 `url` 已经过 `backendUrl` 是同一条契约：这个对象要穿过一串**拿不到 baseUrl** 的
   *  消费端（QueueSheet / Navbar 迷你条 / SidebarNowPlaying / acrylic 的 audio-player 与
   *  audio-player-stage），在那儿再想起来补代理是补不上的。**每个产出 AudioTrack 的地方
   *  自己负责过一遍 `imgUrl`**（toTrack / likedAudioTracks / searchTracks / buildMemberRows）；
   *  漏掉的症状是防盗链图床返回一张空白图，不报错、不降级、没有任何一处会喊。 */
  poster?: string
  durationS?: number
  /** the platform's own track id when this track came from a platform reference — undefined
   *  for a direct-url track (a podcast episode with no platform ref). Used to build an exact
   *  lyrics lookup key ("<platform>:<trackId>") instead of a fuzzy title+artist search —
   *  see NowPlayingBar's lyricsKey(). */
  platform?: string
  trackId?: string
}

/** Coordinates a single global <audio> element + the persistent now-playing bar. Unlike
 *  video (visual → moved between card/modal via portal), audio is invisible, so one
 *  shared element driven by this context is enough — playback survives the card scrolling
 *  away or a channel switch. Cards drive/reflect this; the bottom bar is the global control.
 *
 *  Music and podcasts are SEPARATE queues (different listening forms). Starting either kind
 *  replaces that kind's queue and makes it active; the other kind keeps its place. */
export interface AudioStage {
  current: AudioTrack | null
  playing: boolean
  /** NOTE: the playback POSITION is deliberately absent — it ticks ~4x/sec and would re-render
   *  every consumer of this context that many times a second. It rides its own subscription
   *  channel instead: `useAudioTime()` in lib/audioTime.ts (same reasoning as `getVolume` below). */
  duration: number
  /** which kind's queue is currently driving playback (= current?.kind, or the last active) */
  activeKind: AudioKind
  /** both saved queues, so the queue Sheet can show each on its own tab */
  queues: Record<AudioKind, AudioTrack[]>
  /** the active kind's queue (convenience = queues[activeKind]) */
  queue: AudioTrack[]
  /** load + play a single track (resume if it's already current). Replaces its kind's queue
   *  with just this track (nothing to auto-advance to). */
  play: (track: AudioTrack) => void
  /** load + play a whole list as `kind`'s queue, REPLACING it, starting at startIndex and
   *  making that kind active. Auto-advances to the next within this queue when a track ends. */
  playQueue: (tracks: AudioTrack[], startIndex: number, kind: AudioKind) => void
  /** play/pause the current track */
  toggle: () => void
  seek: (seconds: number) => void
  /** 起播 `track` 并在它**可以定位之后**落到 `seconds`。
   *
   *  和 `seek` 是两件事，别合并：`seek` 拨的是**当前轨**的进度，对一条还没装上的轨写下去
   *  搓的是别人的进度。这条把「换轨」和「落点」之间那次异步加载接上（落点先记下，音轨
   *  `loadedmetadata` 之后才兑现；中途换播了别的就作废）。队列语义与 `play` 一致：单条。
   *  实现见 App.tsx 的接线 + lib/pendingSeek.ts。
   *
   *  **当前没有消费方**：唯一那个（详情页转写档「点一段从那儿听起」）2026-08-12 已撤销。
   *  留着的理由和 `VideoStage.seek` 一样——「换轨 + 落点」这件事没有第二个实现，而它踩过的
   *  那个坑（过期落点写到别人的进度上）由 pendingSeek 的测试守着。 */
  playAt: (track: AudioTrack, seconds: number) => void
  stop: () => void
  /** current output volume seed (0..1). Read once to seed a local slider — volume is kept in a
   *  ref (not state) so dragging doesn't re-render every consumer; this won't update on change. */
  getVolume: () => number
  /** set output volume (0..1): updates the <audio> element + persists. Does not trigger a render. */
  setVolume: (volume: number) => void
}

export const AudioStageContext = createContext<AudioStage | null>(null)

export function useAudioStage(): AudioStage {
  const v = useContext(AudioStageContext)
  if (!v) throw new Error('useAudioStage must be used inside <AudioStageContext.Provider>')
  return v
}

/** Nullable variant for components that ALSO mount outside the provider — PreviewModal reuses
 *  the timeline's PostItemRow out there (see the videoStage warning in App.tsx). Absent stage
 *  = render without the play affordance instead of throwing and blanking the app. */
export function useAudioStageOptional(): AudioStage | null {
  return useContext(AudioStageContext)
}

/** The track to auto-advance to when the current one ends: the next item in the queue,
 *  or undefined at the end of the queue (playback stops — no loop) or when the current
 *  track isn't part of the queue (a one-off play). Pure, so the advance rule is testable. */
export function nextTrack(queue: AudioTrack[], currentId: string | undefined): AudioTrack | undefined {
  if (!currentId || queue.length === 0) return undefined
  const idx = queue.findIndex((t) => t.id === currentId)
  return idx >= 0 ? queue[idx + 1] : undefined
}

/** m:ss clock for a seconds value (NaN/negative → 0:00). */
export function fmtClock(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}
