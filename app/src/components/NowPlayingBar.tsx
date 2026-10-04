import { useEffect, useMemo, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { useAudioStage, type AudioTrack } from '../lib/audioStage.ts'
import { useAudioTime } from '../lib/audioTime.ts'
import { AudioPlayer } from './acrylic/audio-player.tsx'
import { AudioPlayerStage, type AudioPlayerLyric, type AudioPlayerStageTrack } from './acrylic/audio-player-stage.tsx'
import { AUDIO_PLAYER_LABELS_ZH, AUDIO_PLAYER_STAGE_LABELS_ZH } from './audioPlayerLabels.ts'
import { QueueSheet } from './QueueSheet.tsx'
import { api, type Connection } from '../lib/api.ts'
import { parseLrc } from '../lib/parseLrc.ts'

const TOOL =
  'flex size-9 shrink-0 items-center justify-center rounded-full text-foreground/70 transition-colors hover:bg-[var(--acr-hover)] hover:text-foreground disabled:pointer-events-none disabled:opacity-30'

/**
 * 这首歌要按哪几个 key 依次去查歌词（文法见 docs/API.md `/api/resolutions?type=lyrics`）：
 * 精确的 `<platform>:<id>` 在前，模糊的 `<title>::<artist>` 兜底，都没有就一个都不发。
 *
 * **不判具体平台**——哪些平台有歌词源取决于装了谁的包，前端不该知道；别家平台的前缀由歌词源
 * 自己 decline。
 *
 * **为什么要有第二个**：一个平台可以有 `trackUrl`（于是曲目带上了 `platform:id`）却**没有
 * 任何歌词源**——那时精确 key 会被每一条歌词源 decline，而这首歌的名字和歌手明明查得到。
 * 只发第一个 key 的话表现是"这首歌没有歌词"，没有一处会喊。两个 key 相同就只发一个。
 */
export function lyricsKeys(t: AudioTrack): string[] {
  const exact = t.platform && t.trackId ? `${t.platform}:${t.trackId}` : undefined
  const fuzzy = t.title && t.author ? `${t.title}::${t.author}` : undefined
  return [...new Set([exact, fuzzy].filter((k): k is string => !!k))]
}

/** Fetch + parse lyrics for the current track. Resets to undefined on every track change; any
 *  failure (network, no match, unparseable LRC) is swallowed — lyrics are a pure enhancement,
 *  never worth interrupting playback over (design §5). */
function useLyrics(conn: Connection, track: AudioTrack | null): AudioPlayerLyric[] | undefined {
  const [lyrics, setLyrics] = useState<AudioPlayerLyric[] | undefined>(undefined)
  useEffect(() => {
    setLyrics(undefined)
    const keys = track ? lyricsKeys(track) : []
    if (!keys.length) return
    let cancelled = false
    // 梯子在这儿而不在 lyricsKeys 里：要不要试下一个 key 取决于**这一次查的回执**
    // （没有结果 / 结果说没匹配上），那是 fetch 才知道的事。
    void (async () => {
      for (const key of keys) {
        try {
          const res = await api.lyrics(conn, key)
          if (cancelled) return
          const hit = res.result?.items[0]
          if (hit?.matched && hit.lrc) {
            const parsed = parseLrc(hit.lrc)
            if (parsed.length) { setLyrics(parsed); return }
          }
        } catch { if (cancelled) return }
      }
    })()
    return () => { cancelled = true }
  }, [conn, track?.id])
  return lyrics
}

/** AudioTrack → the acrylic stage's track shape. lyrics is only attached when non-empty so an
 *  in-flight/failed lookup doesn't flash an empty lyrics pane (AudioPlayerStage hides on []
 *  the same as on undefined, but omitting the key entirely keeps the props minimal). */
export function toStageTrack(t: AudioTrack, lyrics?: AudioPlayerLyric[]): AudioPlayerStageTrack {
  return { title: t.title || '播放中', artist: t.author, cover: t.poster, ...(lyrics?.length ? { lyrics } : {}) }
}

/** Stream's now-playing footer — a thin wrapper that wires the global audioStage to the
 *  acrylic <NowPlayingBar> (ported from acrylic-ui). The 播放组件 (transport) stays visible
 *  the whole time you're in the music page; the 歌曲信息组件 (cover + title + artist + seek)
 *  only appears while a track is loaded. Prev/Next derive from the active queue; volume drives
 *  a vertical Slider on hover; 队列 is a separate sheet; the Now Playing button (⤢) opens the
 *  full-screen AudioPlayerStage, which shows synced lyrics via useLyrics when a match is found. */
export function NowPlayingBar({ conn }: { conn: Connection }) {
  const stage = useAudioStage()
  // The one place playback position is read — subscribing here (rather than taking it off the
  // stage context) keeps the ~1Hz re-render inside this bar instead of the whole app tree.
  const currentTime = useAudioTime()
  const { current, queue } = stage
  const idx = current ? queue.findIndex((t) => t.id === current.id) : -1
  const hasPrev = idx > 0
  const hasNext = idx >= 0 && idx < queue.length - 1
  // live slider value kept LOCAL so dragging only re-renders this bar (not the whole app) —
  // seeded from the persisted volume; setVolume writes the <audio> element + localStorage.
  const [volume, setVolume] = useState(() => stage.getVolume())
  const [stageOpen, setStageOpen] = useState(false)
  const lyrics = useLyrics(conn, current)
  // Memoized so identity is stable across the re-renders each published time tick causes here.
  // AudioPlayerStage keys its internal karaoke-clock-reset effect on `[track]` BY
  // REFERENCE to detect "a new song started" (audio-player-stage.tsx:294-299) — a fresh object
  // on every tick made that effect fire continuously, stomping its smoothly-interpolated
  // displayTime back to the (lower-frequency, jumpier) currentTime prop every render and
  // breaking lyric line tracking (root cause of the "跟随有问题" bug).
  const barTrack = useMemo(() => (current ? toStageTrack(current) : null), [current])
  const stageTrack = useMemo(() => (current ? toStageTrack(current, lyrics) : null), [current, lyrics])

  return (
    <>
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4">
      <AudioPlayer
        className="pointer-events-auto"
        labels={AUDIO_PLAYER_LABELS_ZH}
        track={barTrack}
        playing={stage.playing}
        currentTime={currentTime}
        duration={stage.duration}
        volume={volume}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onPrev={() => hasPrev && stage.playQueue(queue, idx - 1, stage.activeKind)}
        onNext={() => hasNext && stage.playQueue(queue, idx + 1, stage.activeKind)}
        onToggle={stage.toggle}
        onSeek={stage.seek}
        onVolumeChange={(v) => { setVolume(v); stage.setVolume(v) }}
        actions={
          <>
            <QueueSheet />
            <button
              onClick={() => setStageOpen(true)}
              disabled={!current}
              aria-label="Now Playing"
              title="Now Playing"
              className={TOOL}
            >
              <Maximize2 className="size-4" />
            </button>
          </>
        }
      />
    </div>
    {stageOpen && current && stageTrack && (
      <AudioPlayerStage
        labels={AUDIO_PLAYER_STAGE_LABELS_ZH}
        track={stageTrack}
        playing={stage.playing}
        currentTime={currentTime}
        duration={stage.duration}
        volume={volume}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onToggle={stage.toggle}
        onPrev={() => hasPrev && stage.playQueue(queue, idx - 1, stage.activeKind)}
        onNext={() => hasNext && stage.playQueue(queue, idx + 1, stage.activeKind)}
        onSeek={stage.seek}
        onVolumeChange={(v) => { setVolume(v); stage.setVolume(v) }}
        onClose={() => setStageOpen(false)}
      />
    )}
    </>
  )
}
