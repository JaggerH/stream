"use client"

import * as React from "react"
import { HoverCard as HoverCardPrimitive } from "radix-ui"
import {
  ListMusic,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Slider } from "./slider"

// Audio Player — a floating capsule transport, Apple-Music "mini player" style, on
// the acrylic frosted material (the Card surface: `bg-[var(--acr-surface)] backdrop-blur-xl`).
// Fully presentational and controlled — wire it to your own audio engine via the callbacks.
//
// Anatomy (two groups):
//   • 播放组件 (transport) — Prev / Play-Pause / Next, plus any `actions` you pass on the
//     right (歌词/队列/more). Always visible, so the bar reads as a persistent control strip.
//   • 歌曲信息组件 (now-playing info) — cover + title + artist + a seek bar, as ONE unit that
//     only appears while a `track` is loaded. The progress/seek rail lives along the bottom
//     edge of THIS group (not the whole pill), matching the macOS now-playing card.
//
// The whole pill is a CAPSULE (rounded-full, radius = height/2). The optional volume control
// reveals a VERTICAL acrylic Slider on hover — drag up/down to set the level.
//
// Copy: every string the player renders or hands to assistive tech lives in `AudioPlayerLabels`
// and defaults to English. Localize by passing a partial `labels` — it's merged over the
// defaults, so you override only what you translate:
//   <AudioPlayer labels={{ play: "播放", pause: "暂停", previous: "上一首", next: "下一首" }} />
// Nothing user-facing is hard-coded in the markup; if you find a string that isn't in `labels`,
// that's a bug, not a styling choice.

/** mm:ss from seconds; clamps NaN/∞/negative to 0:00. */
function fmtClock(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const r = Math.floor(s % 60)
  return `${m}:${r.toString().padStart(2, "0")}`
}

/**
 * ScrollingText — a single line that marquee-scrolls ONLY when its content
 * overflows the available width (song title / artist that runs long). When the
 * text fits, it renders as a normal (truncating) line — no motion. Honors
 * `prefers-reduced-motion` (falls back to truncate) and re-measures on resize.
 *
 * Self-contained: uses the Web Animations API so it needs no global keyframes,
 * which keeps the component portable when copied out of the registry.
 */
const MARQUEE_GAP = 32 // px between the two copies (also the second copy's left pad)
const MARQUEE_SPEED = 40 // px / second

function ScrollingText({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const trackRef = React.useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = React.useState(false)

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current
    const track = trackRef.current
    if (!viewport || !track) return

    let anim: Animation | undefined
    const measure = () => {
      anim?.cancel()
      anim = undefined
      const copy = track.firstElementChild as HTMLElement | null
      const textWidth = copy?.scrollWidth ?? 0
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      const overflowing = !reduce && textWidth > viewport.clientWidth + 1
      setScroll(overflowing)
      if (!overflowing) return
      const shift = textWidth + MARQUEE_GAP
      anim = track.animate(
        [{ transform: "translateX(0)" }, { transform: `translateX(-${shift}px)` }],
        { duration: (shift / MARQUEE_SPEED) * 1000, iterations: Infinity, easing: "linear" }
      )
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(viewport)
    return () => {
      ro.disconnect()
      anim?.cancel()
    }
  }, [children])

  return (
    <div ref={viewportRef} className={cn("overflow-hidden", className)}>
      <div
        ref={trackRef}
        className={cn("flex whitespace-nowrap", scroll && "w-max will-change-transform")}
      >
        <span className={cn("min-w-0", !scroll && "truncate")}>{children}</span>
        {scroll && (
          <span aria-hidden className="shrink-0" style={{ paddingLeft: MARQUEE_GAP }}>
            {children}
          </span>
        )}
      </div>
    </div>
  )
}

export interface AudioPlayerTrack {
  title: string
  artist?: string
  /** cover art URL; a music glyph is shown when absent */
  cover?: string
}

/**
 * Every user-facing string the player renders or exposes to assistive technology.
 * Defaults are English (see `DEFAULT_AUDIO_PLAYER_LABELS`); pass a partial `labels`
 * prop to translate — it is merged over the defaults per render.
 */
export interface AudioPlayerLabels {
  /** previous-track button */
  previous: string
  /** play/pause button while paused */
  play: string
  /** play/pause button while playing */
  pause: string
  /** next-track button */
  next: string
  /** volume button and the vertical slider it reveals */
  volume: string
  /** visible stand-in for an empty `track.title` */
  nowPlaying: string
  /** `mini` only — label of the cover/title button that opens the full player.
   *  `{title}` is substituted with the track title (or `nowPlaying` when it is empty). */
  openNowPlaying: string
}

const DEFAULT_AUDIO_PLAYER_LABELS: AudioPlayerLabels = {
  previous: "Previous track",
  play: "Play",
  pause: "Pause",
  next: "Next track",
  volume: "Volume",
  nowPlaying: "Now playing",
  openNowPlaying: "Open now playing: {title}",
}

const TOOL =
  "flex size-9 shrink-0 items-center justify-center rounded-full text-foreground/70 transition-colors hover:bg-[var(--acr-hover)] hover:text-foreground disabled:pointer-events-none disabled:opacity-30"

export interface AudioPlayerProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onVolumeChange"> {
  /** layout: the full transport bar (default), or a compact `mini` chip for a sidebar / rail —
   *  cover + title/artist + play/pause + seek rail, no prev/next/volume/actions. */
  variant?: "bar" | "mini"
  /** `mini` only — open the full player (cover + title are a button for this) */
  onOpen?: () => void
  /** the loaded track; `null`/`undefined` = idle (bar: transport stays, info hides; mini: renders nothing) */
  track?: AudioPlayerTrack | null
  playing?: boolean
  /** elapsed / total seconds, for the time readout + seek rail */
  currentTime?: number
  duration?: number
  /** 0..1 — pass together with `onVolumeChange` to show the hover volume slider */
  volume?: number
  hasPrev?: boolean
  hasNext?: boolean
  onPrev?: () => void
  onNext?: () => void
  onToggle?: () => void
  /** seek to an absolute position in seconds */
  onSeek?: (seconds: number) => void
  onVolumeChange?: (volume: number) => void
  /** extra tool buttons rendered at the right end of the transport (歌词 / 队列 / more …) */
  actions?: React.ReactNode
  /** override any of the built-in English strings (button labels, empty-title fallback) */
  labels?: Partial<AudioPlayerLabels>
}

function AudioPlayer({
  variant = "bar",
  onOpen,
  track,
  playing = false,
  currentTime = 0,
  duration = 0,
  volume,
  hasPrev = false,
  hasNext = false,
  onPrev,
  onNext,
  onToggle,
  onSeek,
  onVolumeChange,
  actions,
  labels,
  className,
  ...props
}: AudioPlayerProps) {
  const l = { ...DEFAULT_AUDIO_PLAYER_LABELS, ...labels }
  const pct = track && duration ? (currentTime / duration) * 100 : 0
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!track || !duration || !onSeek) return
    const r = e.currentTarget.getBoundingClientRect()
    onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration)
  }

  // ===== mini variant — a compact chip for a sidebar/rail; renders nothing when idle =====
  if (variant === "mini") {
    if (!track) return null
    const cover = track.cover ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={track.cover} alt="" loading="lazy" decoding="async" className="size-8 shrink-0 rounded-md object-cover shadow-sm" />
    ) : (
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--acr-chip)] text-muted-foreground">
        <ListMusic className="size-3.5" />
      </span>
    )
    return (
      <div
        data-slot="audio-player"
        data-variant="mini"
        className={cn("relative flex min-w-0 items-center gap-2 rounded-xl bg-[var(--acr-chip)] px-2 pb-2.5 pt-1.5", className)}
        {...props}
      >
        <button onClick={onOpen} aria-label={l.openNowPlaying.replace("{title}", track.title || l.nowPlaying)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {cover}
          <span className="min-w-0 flex-1">
            <ScrollingText className="text-[12px] font-semibold leading-tight">{track.title || l.nowPlaying}</ScrollingText>
            {track.artist && <ScrollingText className="text-[10px] leading-tight text-muted-foreground">{track.artist}</ScrollingText>}
          </span>
        </button>
        <button
          onClick={onToggle}
          aria-label={playing ? l.pause : l.play}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--acr-chip-hover)] text-foreground transition-all hover:scale-105"
        >
          {playing ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 translate-x-px fill-current" />}
        </button>
        <div onClick={seek} className="absolute inset-x-2 bottom-1 h-[3px] cursor-pointer overflow-hidden rounded-full bg-foreground/15">
          <div className="h-full rounded-full bg-foreground/70" style={{ width: `${pct}%` }} />
        </div>
      </div>
    )
  }

  const showVolume = typeof volume === "number" && !!onVolumeChange
  const VolIcon = volume === 0 ? VolumeX : (volume ?? 1) < 0.5 ? Volume1 : Volume2

  return (
    <div
      data-slot="audio-player"
      className={cn(
        // capsule frosted pill — the HoverCard panel material (`--acr-panel`): a lighter
        // frosted glass that lifts off the backdrop (vs `--acr-surface`, which darkens and
        // blends on a dark page), with the same hairline ring + soft float shadow.
        "relative inline-flex w-full max-w-3xl items-center gap-1.5 rounded-full",
        "bg-[var(--acr-panel)] px-3 py-2 backdrop-blur-xl",
        "shadow-[0_0_0_1px_rgba(190,190,190,0.16),0_16px_48px_rgba(0,0,0,0.45)]",
        className
      )}
      {...props}
    >
      {/* ===== 播放组件 (transport) — always visible ===== */}
      <button onClick={onPrev} disabled={!hasPrev} aria-label={l.previous} className={TOOL}>
        <SkipBack className="size-4 fill-current" />
      </button>
      <button
        onClick={onToggle}
        disabled={!track}
        aria-label={playing ? l.pause : l.play}
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--acr-chip)] text-foreground transition-all hover:scale-105 hover:bg-[var(--acr-chip-hover)] disabled:pointer-events-none disabled:opacity-30"
      >
        {playing ? (
          <Pause className="size-5 fill-current" />
        ) : (
          <Play className="size-5 translate-x-px fill-current" />
        )}
      </button>
      <button onClick={onNext} disabled={!hasNext} aria-label={l.next} className={TOOL}>
        <SkipForward className="size-4 fill-current" />
      </button>

      {/* ===== 歌曲信息组件 — cover + title/artist + seek, as ONE group; hidden when idle ===== */}
      {track ? (
        <div className="relative mx-1.5 flex min-w-0 flex-1 items-center gap-2.5 rounded-2xl bg-[var(--acr-chip)] px-2 pb-2.5 pt-1.5">
          {track.cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={track.cover}
              alt=""
              className="size-9 shrink-0 rounded-md object-cover shadow-sm"
            />
          ) : (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[var(--acr-chip)] text-muted-foreground">
              <ListMusic className="size-4" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <ScrollingText className="text-[13px] font-semibold leading-tight">
              {track.title || l.nowPlaying}
            </ScrollingText>
            {track.artist && (
              <ScrollingText className="text-[11px] leading-tight text-muted-foreground">
                {track.artist}
              </ScrollingText>
            )}
          </div>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            {fmtClock(currentTime)}/{fmtClock(duration)}
          </span>
          {/* seek rail — part of THIS group, along its bottom edge */}
          <div
            onClick={seek}
            className="absolute inset-x-2 bottom-1 h-[3px] cursor-pointer overflow-hidden rounded-full bg-[var(--acr-chip)]"
          >
            <div
              className="h-full rounded-full bg-foreground/70"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="mx-1.5 flex-1" />
      )}

      {/* optional volume — vertical Slider revealed on hover. Uses the Radix HoverCard
          primitive so the panel renders through a Portal: it escapes any `overflow:hidden`
          / clipping ancestor (and isn't bounded by the bar's stacking context), the way a
          plain absolutely-positioned child never could. */}
      {showVolume && (
        <HoverCardPrimitive.Root openDelay={60} closeDelay={120}>
          <HoverCardPrimitive.Trigger asChild>
            <button aria-label={l.volume} className={TOOL}>
              <VolIcon className="size-4" />
            </button>
          </HoverCardPrimitive.Trigger>
          <HoverCardPrimitive.Portal>
            <HoverCardPrimitive.Content
              side="top"
              sideOffset={10}
              className="z-50 flex h-32 w-9 flex-col items-center rounded-2xl bg-[var(--acr-panel)] px-2 py-2.5 shadow-[0_0_0_1px_rgba(190,190,190,0.16),0_16px_48px_rgba(0,0,0,0.45)] outline-none backdrop-blur-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
            >
              <Slider
                orientation="vertical"
                size="small"
                min={0}
                max={100}
                value={[Math.round((volume ?? 0) * 100)]}
                onValueChange={(v) => onVolumeChange?.(v[0] / 100)}
                aria-label={l.volume}
                style={{ minHeight: 0 }}
                className="h-full"
              />
            </HoverCardPrimitive.Content>
          </HoverCardPrimitive.Portal>
        </HoverCardPrimitive.Root>
      )}

      {/* caller-supplied right-side tools (歌词 / 队列 / more …) */}
      {actions}
    </div>
  )
}

export { AudioPlayer, ScrollingText, fmtClock, DEFAULT_AUDIO_PLAYER_LABELS }
