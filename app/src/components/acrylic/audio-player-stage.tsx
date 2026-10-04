"use client"

import * as React from "react"
import {
  ChevronDown,
  ListMusic,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Silk } from "./silk"
import { type AudioPlayerTrack, ScrollingText, fmtClock } from "./audio-player"
import { Slider } from "./slider"

// AudioPlayerStage — the full-screen "now playing" face of the Audio Player family. It
// shares AudioPlayer's controlled track/playback API and adds an immersive presentation:
// the flowing Silk background (color pulled from the cover), a big cover, marquee title,
// and time-synced lyrics. Kept in its own file so the lean bar/mini transport
// (audio-player.tsx) never has to pull in the Silk WebGL shader.
//
// Copy: like AudioPlayer, every string the stage renders or hands to assistive tech lives in
// `AudioPlayerStageLabels` and defaults to English. Pass a partial `labels` to translate — it's
// merged over the defaults, so you override only what you translate:
//   <AudioPlayerStage labels={{ play: "播放", pause: "暂停", collapse: "收起" }} … />
// `labels` and `nowPlayingLabel` are NOT interchangeable: `labels` is the component's own UI
// copy (fixed strings that change only with locale), `nowPlayingLabel` is caller content — an
// optional eyebrow caption above the cover ("FROM YOUR LIBRARY", "正在播放"), per instance. It
// is deliberately not a fallback for a missing track title (`labels.unknownTrack` is), so one
// string can never end up doing both jobs.

export interface AudioPlayerLyric {
  /** start time of this line, in seconds */
  time: number
  text: string
}

/** an AudioPlayer track plus optional timed lyrics for the stage's lyrics pane */
export interface AudioPlayerStageTrack extends AudioPlayerTrack {
  /** LRC-style timed lines; omit/empty → the lyrics pane is hidden (no-lyrics fallback) */
  lyrics?: AudioPlayerLyric[]
}

/**
 * Every user-facing string the stage renders or exposes to assistive technology.
 * Defaults are English (see `DEFAULT_AUDIO_PLAYER_STAGE_LABELS`); pass a partial
 * `labels` prop to translate — it is merged over the defaults per render.
 */
export interface AudioPlayerStageLabels {
  /** the ▾ button that closes the stage */
  collapse: string
  /** the ⤢ button while windowed */
  enterFullscreen: string
  /** the ⤢ button while fullscreen */
  exitFullscreen: string
  /** previous-track button */
  previous: string
  /** play/pause button while paused */
  play: string
  /** play/pause button while playing */
  pause: string
  /** next-track button */
  next: string
  /** the seek slider */
  progress: string
  /** the volume slider */
  volume: string
  /** visible stand-in for an empty `track.title` */
  unknownTrack: string
}

const DEFAULT_AUDIO_PLAYER_STAGE_LABELS: AudioPlayerStageLabels = {
  collapse: "Collapse",
  enterFullscreen: "Enter full screen",
  exitFullscreen: "Exit full screen",
  previous: "Previous track",
  play: "Play",
  pause: "Pause",
  next: "Next track",
  progress: "Progress",
  volume: "Volume",
  unknownTrack: "Unknown track",
}

const DEFAULT_ACCENT = "#5E3AA8"

// ---- cover → dominant vivid color (same-origin / CORS-enabled covers only) ----------
function rgbToHex(r: number, g: number, b: number) {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")
}
function extractDominant(img: HTMLImageElement): [number, number, number] | null {
  const s = 24
  const c = document.createElement("canvas")
  c.width = s
  c.height = s
  const cx = c.getContext("2d", { willReadFrequently: true })!
  cx.drawImage(img, 0, 0, s, s)
  let data: Uint8ClampedArray
  try {
    data = cx.getImageData(0, 0, s, s).data
  } catch {
    return null // tainted canvas (cross-origin without CORS)
  }
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], al = data[i + 3]
    if (al < 8) continue
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    const lum = (r + g + b) / 3
    const sat = max === 0 ? 0 : (max - min) / max
    if (lum < 25 || lum > 235 || sat < 0.15) continue
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 }
    e.n++; e.r += r; e.g += g; e.b += b
    buckets.set(key, e)
  }
  let best: { n: number; r: number; g: number; b: number } | null = null
  for (const e of buckets.values()) if (!best || e.n > best.n) best = e
  if (!best) return null
  return [best.r / best.n, best.g / best.n, best.b / best.n]
}
// keep the silk vivid: scale a too-dark color up to a floor brightness (hue preserved).
function vivify([r, g, b]: [number, number, number]): string {
  const max = Math.max(r, g, b)
  if (max < 150) {
    const k = 150 / Math.max(max, 1)
    r = Math.min(255, r * k); g = Math.min(255, g * k); b = Math.min(255, b * k)
  }
  return rgbToHex(r, g, b)
}

function useCoverColor(cover: string | undefined, enabled: boolean) {
  const [color, setColor] = React.useState<string | undefined>()
  React.useEffect(() => {
    if (!enabled || !cover) {
      setColor(undefined)
      return
    }
    let cancelled = false
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onload = () => {
      if (cancelled) return
      const rgb = extractDominant(img)
      setColor(rgb ? vivify(rgb) : undefined)
    }
    img.onerror = () => !cancelled && setColor(undefined)
    img.src = cover
    return () => {
      cancelled = true
    }
  }, [cover, enabled])
  return color
}

export interface AudioPlayerStageProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onVolumeChange"> {
  track: AudioPlayerStageTrack
  playing?: boolean
  /** elapsed seconds; the component runs its own smooth clock between updates */
  currentTime?: number
  duration?: number
  volume?: number
  hasPrev?: boolean
  hasNext?: boolean
  /** force a background color; when set, cover extraction is skipped */
  accentColor?: string
  /** pull the background color from the cover art (needs a same-origin / CORS cover) */
  extractFromCover?: boolean
  /** ms to crossfade the background between tracks (0 = snap) */
  colorTransitionMs?: number
  /** optional eyebrow caption above the cover (e.g. "FROM YOUR LIBRARY"); off when unset.
   *  Caller content, not UI copy — it never stands in for a missing title (that's
   *  `labels.unknownTrack`). */
  nowPlayingLabel?: string
  /** override any of the built-in English strings (button labels, empty-title fallback) */
  labels?: Partial<AudioPlayerStageLabels>
  /** request the Fullscreen API on mount (call from a user gesture, e.g. a button) */
  autoFullscreen?: boolean
  onToggle?: () => void
  onPrev?: () => void
  onNext?: () => void
  onSeek?: (seconds: number) => void
  onVolumeChange?: (volume: number) => void
  onClose?: () => void
}

function AudioPlayerStage({
  track,
  playing = false,
  currentTime = 0,
  duration = 0,
  volume,
  hasPrev = true,
  hasNext = true,
  accentColor,
  extractFromCover = true,
  colorTransitionMs = 400,
  nowPlayingLabel,
  labels,
  autoFullscreen = false,
  onToggle,
  onPrev,
  onNext,
  onSeek,
  onVolumeChange,
  onClose,
  className,
  ...props
}: AudioPlayerStageProps) {
  const l = { ...DEFAULT_AUDIO_PLAYER_STAGE_LABELS, ...labels }
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [coverFailed, setCoverFailed] = React.useState(false)
  const lyrics = track.lyrics ?? []
  const hasLyrics = lyrics.length > 0

  // background color: explicit accent wins, else extract from cover, else default
  const extracted = useCoverColor(track.cover, extractFromCover && !accentColor && !coverFailed)
  const silkColor = accentColor ?? extracted ?? DEFAULT_ACCENT

  // ---- smooth internal clock (so line changes stay fluid between 1 Hz time updates) ----
  const clockRef = React.useRef(currentTime)
  const [displayTime, setDisplayTime] = React.useState(currentTime)
  React.useEffect(() => {
    // resync only on real jumps (seek), not on our own echoed updates
    if (Math.abs(currentTime - clockRef.current) > 0.75) {
      clockRef.current = currentTime
      setDisplayTime(currentTime)
    }
  }, [currentTime])
  // a new track always restarts the clock, even if `currentTime` didn't change value
  React.useEffect(() => {
    clockRef.current = currentTime
    setDisplayTime(currentTime)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track])
  React.useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = 0
    let acc = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = last ? (now - last) / 1000 : 0
      last = now
      clockRef.current = Math.min(duration || Infinity, clockRef.current + dt)
      acc += dt
      if (acc >= 0.08) {
        acc = 0
        setDisplayTime(clockRef.current)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, duration])

  const seekTo = (t: number) => {
    clockRef.current = t
    setDisplayTime(t)
    onSeek?.(t)
  }

  // ---- active lyric line + auto-scroll ----
  const active = React.useMemo(() => {
    let idx = 0
    for (let i = 0; i < lyrics.length; i++) {
      if (lyrics[i].time <= displayTime) idx = i
      else break
    }
    return idx
  }, [lyrics, displayTime])
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const lineRefs = React.useRef<(HTMLParagraphElement | null)[]>([])
  // Auto-follow keeps the active line centered — but a real user scroll (wheel/touch) pauses
  // that for 5s of inactivity, then snaps back to whichever line is active by then. Detecting
  // "user scrolled" via input events (not the `scroll` event) sidesteps having to tell our own
  // smooth-scroll animation's scroll events apart from a genuine new user scroll mid-animation.
  const userScrollingRef = React.useRef(false)
  const resumeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const centerActiveLine = React.useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = lineRefs.current[active]
    const box = scrollRef.current
    if (el && box) box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior })
  }, [active])
  React.useEffect(() => {
    if (userScrollingRef.current) return
    // Debounced: `active` can flicker back and forth by one line right at a boundary (the
    // jump-resync clock is allowed to step backward for seek handling), and re-firing a
    // `smooth` scrollTo on every flicker looks like a jerky little tug rather than one settled
    // move. Only the value `active` settles on after 220ms of quiet triggers a real scroll.
    const id = setTimeout(() => centerActiveLine(), 220)
    return () => clearTimeout(id)
  }, [active, track, centerActiveLine])
  React.useEffect(() => () => { if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current) }, [])
  const handleUserScroll = () => {
    userScrollingRef.current = true
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
    resumeTimerRef.current = setTimeout(() => {
      userScrollingRef.current = false
      centerActiveLine()
    }, 5000)
  }

  // ---- fullscreen ----
  const [isFs, setIsFs] = React.useState(false)
  React.useEffect(() => {
    const onChange = () => setIsFs(!!document.fullscreenElement)
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])
  const toggleFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void rootRef.current?.requestFullscreen?.()
  }
  // enter fullscreen on mount when asked — relies on the user gesture that mounted us
  // (transient activation is still valid a few ms later, in the effect).
  React.useEffect(() => {
    if (autoFullscreen && !document.fullscreenElement) {
      rootRef.current?.requestFullscreen?.().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.fullscreenElement && onClose?.()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const showVolume = typeof volume === "number" && !!onVolumeChange
  const cover = track.cover && !coverFailed

  return (
    <div
      ref={rootRef}
      data-slot="audio-player-stage"
      className={cn("fixed inset-0 z-[60] overflow-hidden", className)}
      {...props}
    >
      <Silk className="!absolute inset-0" color={silkColor} colorTransitionMs={colorTransitionMs} speed={4} scale={0.8} noiseIntensity={1} rotation={0.05} />
      <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-black/40 to-black/70" />

      {/* Side gutter scales with the viewport but never collapses on a phone: max(1.5rem, 9.5vw)
          → 24px at 320w, ~160px at a 1680 desktop. Both the top chrome and the player column
          hang off this one edge, so they stay on a single line. */}
      <div className="relative flex h-full flex-col px-[max(1.5rem,9.5vw)] pb-8 pt-5 text-white">
        {/* top chrome */}
        <div className="flex items-center justify-between">
          <button
            onClick={onClose}
            aria-label={l.collapse}
            // -ml-2 cancels the 8px the 20px glyph sits inset inside its 36px hit area, so what
            // lines up with the gutter is the glyph's INK, not the invisible box around it.
            // Without it the title/cover read as sitting further left than the ▾ above them.
            className={cn("-ml-2 flex size-9 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white", !onClose && "invisible")}
          >
            <ChevronDown className="size-5" />
          </button>
          {nowPlayingLabel ? (
            <span className="text-[11px] font-medium uppercase tracking-widest text-white/60">{nowPlayingLabel}</span>
          ) : (
            <span aria-hidden />
          )}
          <button
            onClick={toggleFs}
            aria-label={isFs ? l.exitFullscreen : l.enterFullscreen}
            // mirror of the ▾ button's -ml-2 (see there)
            className="-mr-2 flex size-9 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            {isFs ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
        </div>

        {/* body: two columns when lyrics exist, otherwise a centered player */}
        {/* The body deliberately does NOT sit on the chrome's edge: it is inset a further 50px
            so the cover/title read as their own block rather than as a continuation of the ▾
            button's column. Only in the two-column (lyrics) layout — the no-lyrics layout is
            centered, and below `md` the column is centered too, so the inset would fight it. */}
        <div className={cn("flex min-h-0 flex-1 items-center gap-[6vw]", hasLyrics ? "justify-start md:pl-[50px]" : "justify-center")}>
          {/* player */}
          {/* ONE measure for the whole column: the cover's width. The title, the seek bar and
              the transport all inherit it, so the play button is concentric with the cover.
              (It used to be `max-w-sm`/`40%` while the cover was min(60vw,280px) — two
              different measures, which read as "the cover is off to one side".) */}
          <div className={cn("mx-auto flex w-full max-w-[min(60vw,280px)] flex-col gap-7", hasLyrics && "shrink-0 md:mx-0")}>
            <div className={cn("aspect-square w-full overflow-hidden rounded-3xl shadow-2xl ring-1 ring-white/10 transition-transform duration-500 ease-out", playing ? "scale-100" : "scale-95")}>
              {cover ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={track.cover} alt="" onError={() => setCoverFailed(true)} className="size-full object-cover" />
              ) : (
                <div className="flex size-full items-center justify-center bg-white/10"><ListMusic className="size-16 text-white/50" /></div>
              )}
            </div>

            <div className={cn("min-w-0", !hasLyrics && "text-center")}>
              <ScrollingText className="text-2xl font-bold leading-tight [text-shadow:0_1px_12px_rgba(0,0,0,0.4)]">{track.title || l.unknownTrack}</ScrollingText>
              {track.artist && (
                <ScrollingText className="mt-1 text-base leading-tight text-white/70 [text-shadow:0_1px_10px_rgba(0,0,0,0.5)]">{track.artist}</ScrollingText>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Slider value={[Math.min(displayTime, duration)]} min={0} max={duration || 1} step={1} onValueChange={(v) => seekTo(v[0])} aria-label={l.progress} />
              <div className="flex justify-between font-mono text-[11px] tabular-nums text-white/50">
                <span>{fmtClock(displayTime)}</span>
                <span>-{fmtClock(Math.max(0, duration - displayTime))}</span>
              </div>
            </div>

            <div className="flex items-center justify-center gap-8">
              <button onClick={onPrev} disabled={!hasPrev} aria-label={l.previous} className="flex size-12 items-center justify-center rounded-full text-white/80 transition-transform hover:scale-105 hover:text-white disabled:pointer-events-none disabled:opacity-30"><SkipBack className="size-7 fill-current" /></button>
              <button onClick={onToggle} aria-label={playing ? l.pause : l.play} className="flex size-16 items-center justify-center rounded-full bg-white text-black shadow-lg transition-transform hover:scale-105">
                {playing ? <Pause className="size-7 fill-current" /> : <Play className="size-7 translate-x-0.5 fill-current" />}
              </button>
              <button onClick={onNext} disabled={!hasNext} aria-label={l.next} className="flex size-12 items-center justify-center rounded-full text-white/80 transition-transform hover:scale-105 hover:text-white disabled:pointer-events-none disabled:opacity-30"><SkipForward className="size-7 fill-current" /></button>
            </div>

            {showVolume && (
              <div className="flex items-center gap-3 text-white/60">
                <Volume2 className="size-4 shrink-0" />
                <Slider value={[Math.round((volume ?? 0) * 100)]} min={0} max={100} onValueChange={(v) => onVolumeChange?.(v[0] / 100)} aria-label={l.volume} className="flex-1" />
              </div>
            )}
          </div>

          {/* lyrics — hidden entirely when the track has none.
              `self-stretch` below is load-bearing: the row is `items-center`, so without it this
              pane shrink-wraps its content instead of taking the row's height — its
              `overflow-y-auto` then has nothing to overflow and the lyrics never scroll. */}
          {hasLyrics && (
            <div
              ref={scrollRef}
              onWheel={handleUserScroll}
              onTouchStart={handleUserScroll}
              onTouchMove={handleUserScroll}
              className="relative hidden min-h-0 flex-1 self-stretch overflow-y-auto py-[38vh] [scrollbar-width:none] md:block [&::-webkit-scrollbar]:hidden"
            >
              {lyrics.map((ln, i) => (
                <p
                  key={i}
                  ref={(el) => { lineRefs.current[i] = el }}
                  onClick={() => seekTo(ln.time)}
                  className={cn("max-w-2xl cursor-pointer px-2 py-2.5 text-2xl font-semibold leading-snug transition-colors duration-300 lg:text-3xl", i !== active && "text-white/30 hover:text-white/55")}
                >
                  {ln.text}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export { AudioPlayerStage, DEFAULT_AUDIO_PLAYER_STAGE_LABELS }
