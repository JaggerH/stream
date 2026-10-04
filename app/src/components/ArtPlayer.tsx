import { useEffect, useMemo, useRef, useState } from 'react'
import Artplayer from 'artplayer'
import { toast } from './acrylic/sonner.tsx'
import { BlurbOverlay } from './BlurbOverlay.tsx'
import { planVideo, type VideoMedia } from '../lib/videoPlan.ts'
import { clearProgress, getProgress, saveProgress } from '../lib/videoProgress.ts'
import { nameableMarks, skipTarget, timelineStrips } from '../lib/speaker-timeline.ts'
import { api, type Connection } from '../lib/api.ts'
import { backendUrl } from '../lib/backendUrl.ts'
import { cn } from '../lib/utils.ts'

/** Presence is the switch: when set, this instance reports/resumes playback position via the
 *  server (`/api/watch-progress`) instead of the localStorage-backed `videoProgress.ts` path.
 *  Only the video channel (MovieChannel.tsx) wires this — the Timeline (Detail.tsx / App.tsx)
 *  never passes it and keeps its existing localStorage behavior byte-for-byte. */
export interface ServerProgressConfig {
  /** the playback key (an episode/movie's leftKey, or an inbox item id) */
  key: string
  workKey: string
  workTitle: string
  workPoster?: string
  epLabel?: string
  /** 播放发生在哪个视频频道 —— 「继续观看」按频道分栏靠它(见 src/watch-progress-store.ts 的
   *  channelId)。聚合入口(`/video`)下没有唯一答案，留空即可：未归属的进度只在聚合视图和影视
   *  频道出现，不会漏进儿童频道。 */
  channelId?: string
  conn: Connection
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

// Cap Artplayer's built-in auto-reconnect (default 5) at 1. This now only governs DASH sources —
// file/hls sources take over video:error entirely below — but the same logic holds: a src that keeps
// erroring should retry once, not storm the resolve endpoint (and DebugBox) 6× for one click.
Artplayer.RECONNECT_TIME_MAX = 1

// 与 Artplayer 内部 `isMobile` 同一份判定（库没导出）。只有桌面端那条分支会「单击即切播放」，
// 移动端本来就不切（`MOBILE_CLICK_PLAY` 默认 false），所以只在桌面端接管点击语义（见 build()）。
const IS_MOBILE =
  typeof navigator !== 'undefined' &&
  (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints >= 1))

/** 与 components/acrylic/spinner.tsx 同形的加载指示（Artplayer 的 `loading` 只接受 HTML 字符串，
 *  没法直接塞 React 组件）。改这里 = 所有播放场景一起改：ArtPlayer 是全站唯一的播放器封装。 */
const LOADING_HTML =
  '<svg width="28" height="28" viewBox="0 0 24 24" ' +
  // fill/stroke 必须走**内联 style**，不能用 fill="none" 这种 presentation attribute：
  // artplayer 的 .art-icon svg 规则 (fill: currentColor) 优先级高于 presentation attribute，
  // 会把这条弧线路径填成实心 —— 看起来就是"一坨缺一块的圆"而不是 spinner。实测确认：
  // attrFill=none 但 getComputedStyle().fill 仍是 rgb(255,255,255)。
  'style="fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;' +
  'animation:art-spin 1s linear infinite">' +
  '<path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>' +
  '<style>@keyframes art-spin{to{transform:rotate(360deg)}}</style>' 

// accent for Artplayer's controls + loading spinner — matches the app's --primary,
// so there's one themed loader and no dark native <video> spinner underneath.
const THEME =
  (typeof document !== 'undefined'
    ? getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
    : '') || '#facc15'

/** DASH (a video site's 1080p split audio/video tracks) via dash.js as an Artplayer customType, falling back to the
 *  progressive ≤720p mp4 when dash can't play (missing codec, region-locked, expired
 *  CDN url, network blip). Guards against the player being torn down before the async
 *  dashjs import resolves — otherwise (StrictMode double-mount) an orphan MediaSource
 *  keeps feeding audio with no instance to stop it. */
function mpdHandler(progressiveUrl: string) {
  return (video: HTMLVideoElement, url: string, art: Any) => {
    let destroyed = false
    let fellBack = false
    art.once('destroy', () => {
      destroyed = true
    })
    const fallback = () => {
      if (fellBack || destroyed) return
      fellBack = true
      // Preserve position + play state across the source swap. dash.js can throw a transient
      // PLAYBACK_ERROR when seeking into an unbuffered region on a flaky 1080p node; without
      // this, the progressive reload restarts from 0 — which reads as "left/right jumps the
      // video back to the start". Resume where the user actually was.
      const resumeAt = video.currentTime
      const wasPlaying = !video.paused
      try {
        art.dash?.reset()
      } catch {
        /* ignore */
      }
      art.dash = null
      const onReady = () => {
        video.removeEventListener('loadedmetadata', onReady)
        if (resumeAt > 0 && Number.isFinite(resumeAt)) {
          try {
            video.currentTime = resumeAt
          } catch {
            /* ignore */
          }
        }
        if (wasPlaying) void video.play().catch(() => {})
      }
      video.addEventListener('loadedmetadata', onReady)
      video.src = progressiveUrl
    }
    import('dashjs')
      .then((mod: Any) => {
        if (destroyed) return // player gone before dashjs loaded — don't start a ghost stream
        const MediaPlayer = mod.MediaPlayer ?? mod.default?.MediaPlayer
        if (!MediaPlayer) return fallback()
        const d = MediaPlayer().create()
        // ABR through the seg proxy under-estimates bandwidth and parks on a low
        // rep → never reaches the 1080p the MPD already offers. Pin the top rep
        // (the backend already caps the MPD at ~1080p avc, so this can't overshoot).
        d.updateSettings({
          streaming: {
            abr: { autoSwitchBitrate: { video: false } },
            buffer: { fastSwitchEnabled: true, bufferTimeAtTopQuality: 30, bufferTimeAtTopQualityLongForm: 30 },
          },
        })
        const score = (r: Any) => (r.height || 0) * 1e7 + (r.bandwidth || 0)
        const pickHighest = (reps: Any[]) => reps.reduce((a, b) => (score(b) > score(a) ? b : a), reps[0])
        const pin = (r: Any, reps: Any[]) =>
          d.setRepresentationForTypeByIndex('video', r.index ?? reps.indexOf(r), true)
        d.on(MediaPlayer.events.STREAM_INITIALIZED, () => {
          try {
            const reps: Any[] = d.getRepresentationsByType('video') || []
            if (!reps.length) return
            pin(pickHighest(reps), reps) // prefer the top rep (usually 1080p)
            // …but the top rep can stall — a flaky 1080p mcdn node, or a quality this
            // account isn't entitled to (non-VIP). If playback hasn't started within 5s,
            // drop to the best ≤720p rep (reliable / always entitled) so it just plays.
            const t = setTimeout(() => {
              if (video.readyState >= 3) return // HAVE_FUTURE_DATA → 1080p is fine, keep it
              const lower = reps.filter((r) => (r.height || 0) > 0 && (r.height || 0) <= 720)
              if (lower.length) pin(pickHighest(lower), reps)
            }, 5000)
            art.once('destroy', () => clearTimeout(t))
          } catch {
            /* ignore — leave ABR's choice */
          }
        })
        d.on(MediaPlayer.events.ERROR, fallback)
        d.on(MediaPlayer.events.PLAYBACK_ERROR, fallback)
        d.initialize(video, url, true)
        art.dash = d
        art.once('destroy', () => {
          try {
            d.reset()
          } catch {
            /* ignore */
          }
        })
      })
      .catch(fallback)
  }
}

/** HLS (netdisk transcode streams — quark serves its H.264+AAC playback as m3u8) via hls.js as an
 *  Artplayer customType. Native <video> can't play m3u8 except on Safari/iOS, which we let through
 *  directly. Guards teardown like mpdHandler so a StrictMode double-mount can't leave an orphan
 *  hls.js instance pumping segments with no player to stop it. */
function m3u8Handler(video: HTMLVideoElement, url: string, art: Any) {
  let destroyed = false
  art.once('destroy', () => {
    destroyed = true
  })
  // Safari / iOS play HLS natively — skip hls.js (MSE) entirely.
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url
    return
  }
  import('hls.js')
    .then((mod: Any) => {
      if (destroyed) return // player gone before hls.js loaded — don't start a ghost stream
      const Hls = mod.default ?? mod
      if (!Hls?.isSupported?.()) {
        video.src = url // no MSE support — last-ditch native attempt
        return
      }
      const hls = new Hls()
      hls.loadSource(url)
      hls.attachMedia(video)
      art.hls = hls
      art.once('destroy', () => {
        try {
          hls.destroy()
        } catch {
          /* ignore */
        }
      })
    })
    .catch(() => {
      video.src = url
    })
}

/** Artplayer-backed video for playable streams (DASH + progressive). Themed controls +
 *  loading (no native spinner), danmaku-ready, with watch-progress resume. iframe /
 *  poster / none are not Artplayer's job — the caller handles those. */
/** A named person's continuous speech span (already merged + >=60s-filtered upstream — see
 *  GET /api/voiceprint/item/:itemId/blocks). `speakerBlocks` carries ALL speakers' blocks (not
 *  one person's) — drives the progress-bar highlight markers, the chips row + colored timeline
 *  strip overlay, and (via `activeSpeakers`) the multi-select skip-ahead logic. */
export interface SpeakerBlock {
  start: number
  end: number
  label: string
}

/** A subtitle track of a netdisk-managed file (see plan.subtitleListUrl / plan.subtitleUrlBase) —
 *  embedded stream (`embed:<ffmpeg index>`) or a sibling external file (`file:<relPath>`). `id`
 *  is threaded into the fetch url OPAQUELY (url-encoded): the backend owns the prefix namespace.
 *  The ONE sanctioned peek is pickDefaultSubtitle's `file:` startsWith (external-track
 *  preference); nothing else may branch on the id's shape. `index` only survives on embedded
 *  tracks, as display fallback. */
interface SubtitleTrack {
  id: string
  index?: number
  lang?: string
  title?: string
}

/** Which track (if any) to turn ON automatically. Only tracks that actually ship WITH the file —
 *  an embedded stream (`embed:`) or a sibling file (`file:`) — are auto-enable candidates: those
 *  are high-confidence, this-exact-video subtitles. Online-scraped tracks (`scrape:`, a loose
 *  迅雷/射手 name/hash match) are frequently the wrong episode/version and render as full-screen
 *  综艺花字 noise that looks like 弹幕 — they are OFFERED in the menu but never turned on by default;
 *  the user opts in. Returns undefined (→ start with subtitles off) when only scraped tracks exist.
 *
 *  Preference among confident tracks: 简体中文 first, then an external sibling file (in a
 *  Chinese-market release the added-on sub IS the Chinese one — live sample tmdb:286709 embeds only
 *  ita/eng while the ass sibling carries 中文), else whichever comes first. Some releases title
 *  tracks in Chinese ("简体中文"), others in English ("Simplified") — found live against a real
 *  sample (tmdb:296286:S01E01) where matching only '简' silently fell back to an unrelated English
 *  track. The `scrape:`/`file:` peeks read the backend's OWN prefix namespace (see SubtitleTrack),
 *  which is the sanctioned way to tell where a track came from — not a parse of opaque id contents. */
function pickDefaultSubtitle(tracks: SubtitleTrack[]): SubtitleTrack | undefined {
  const confident = tracks.filter((t) => !t.id.startsWith('scrape:'))
  return (
    confident.find((t) => /简|simplified/i.test(t.title ?? '')) ??
    confident.find((t) => t.id.startsWith('file:')) ??
    confident[0]
  )
}

export function ArtPlayer({
  media,
  baseUrl,
  onExpand,
  onVideoSize,
  seekRef,
  variant = 'default',
  autoFullscreen = false,
  onFullscreenExit,
  speakerBlocks,
  activeSpeakers,
  speakerNames,
  onTime,
  serverProgress,
  blurb,
  autoplay = true,
}: {
  media: VideoMedia
  baseUrl: string
  /** open the playing video's detail modal (bound to the H shortcut) */
  onExpand?: () => void
  /** the stream's real pixel dimensions, once metadata loads (cover ≠ stream ratio) */
  onVideoSize?: (w: number, h: number) => void
  /** App-owned handle: set to a seek(seconds) fn once ready, so the transcript can drive
   *  the player ("click a segment → jump to its time"). Cleared on destroy. */
  seekRef?: { current: ((seconds: number) => void) | null }
  /** inline feed playback uses a compact control layout that stays scoped to the player */
  variant?: 'default' | 'thumb'
  /** enter native fullscreen as soon as the player is ready — "click episode → fullscreen".
   *  Browsers gate fullscreen on the click's transient activation (~5s), so this can be
   *  refused on a slow load; the caller must keep a visible player as the fallback. */
  autoFullscreen?: boolean
  /** fired when the user leaves a fullscreen that autoFullscreen opened — lets the caller
   *  drop back to the grid instead of stranding them on an inline player. */
  onFullscreenExit?: () => void
  /** ALL speakers' >=60s speech blocks — rendered as Artplayer progress-bar `highlight` markers
   *  (hover shows the label) plus a chips row + colored timeline strip overlay. Read fresh from a
   *  ref at construction time, so passing a new array doesn't force a player rebuild (see
   *  speakerBlocksRef below). */
  speakerBlocks?: SpeakerBlock[]
  /** the currently-checked subset of speaker labels to "only watch": while playing, jump past any
   *  gap between their blocks straight to the next block's start; pause once the last block ends.
   *  null/undefined = show the chips/strip map but don't skip (no filter active). Requires
   *  speakerBlocks. State ownership lives in the caller (App) — toggled via onToggleSpeaker. */
  activeSpeakers?: string[] | null
  /** fired when a chip is clicked — the caller flips that label in/out of activeSpeakers. */
  /** label → 人看的名字，来自 `useSpeakerMap().names`。进度条上的说话人标记靠它在圆点后面写出
   *  名字；缺省就退回原始标签。**必须和右侧面板同源**，否则同一个人在两处叫不同名字。 */
  speakerNames?: Record<string, string>
  /** playback clock for surfaces rendered OUTSIDE the player (the 「谁在说话」panel highlights
   *  whoever's block covers `t`, and draws each row's mini timeline against `duration`).
   *  Throttled to ~4/s — it drives React state, and a raw timeupdate (≈4–66/s, source-dependent)
   *  would re-render the panel far more often than a human can see. */
  onTime?: (t: number, duration: number) => void
  /** presence = server-backed progress (see ServerProgressConfig); absent = existing localStorage path. */
  serverProgress?: ServerProgressConfig
  /** 压在画面底部的简介条（`overlayBlurb()` 的结果）。空/缺省 = 不画。
   *  和 speaker-marks 同一套显隐：跟着控制条一起来一起走（`data-controls`，源头是播放器自己的
   *  `control` 事件——不是 CSS `:hover`，理由见 build() 里 markControls 的注释）。
   *  已知边界：这里只吃 item 自己存着的正文（`content.text`），吃不到详情页富化后的 `art.text`——
   *  播放器实例活在 App 里，富化状态活在 Detail 里，两者互不可见。 */
  blurb?: string
  /** 挂载即开播。默认 true——「点了一部片/一集」的入口（影视频道、内联播放）都是冲着看来的。
   *  详情页那条路要按**用户这一下点的是媒体还是正文**来定（见 lib/openDetail.ts），所以它
   *  显式传值。构造选项只在 build() 时读一次，改这个 prop 不会重建实例（也不该重建）。 */
  autoplay?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const artRef = useRef<Any>(null)
  /** 外层那个盒子——`data-controls` 挂在它身上，两层底部浮层照它显隐（见 build() 里的 markControls）。 */
  const wrapRef = useRef<HTMLDivElement>(null)
  // Read fresh inside listeners bound once per build() (mirrors onExpandRef etc. below) — a prop
  // change alone (e.g. conn.token refresh) shouldn't require a full player rebuild to take effect.
  const serverProgressRef = useRef(serverProgress)
  serverProgressRef.current = serverProgress
  const onExpandRef = useRef(onExpand)
  onExpandRef.current = onExpand
  const onVideoSizeRef = useRef(onVideoSize)
  onVideoSizeRef.current = onVideoSize
  const onFullscreenExitRef = useRef(onFullscreenExit)
  onFullscreenExitRef.current = onFullscreenExit
  const autoFullscreenRef = useRef(autoFullscreen)
  autoFullscreenRef.current = autoFullscreen
  const autoplayRef = useRef(autoplay)
  autoplayRef.current = autoplay
  // Mirrors the file's existing ref pattern (see onExpandRef above): timeupdate listeners are
  // bound once per player build, so they must read these fresh off a ref rather than close over
  // the prop value from whichever build() call happened to be running when they were attached.
  const speakerBlocksRef = useRef<SpeakerBlock[]>([])
  speakerBlocksRef.current = speakerBlocks && speakerBlocks.length ? [...speakerBlocks].sort((a, b) => a.start - b.start) : []
  const activeRef = useRef<Set<string> | null>(null)
  activeRef.current = activeSpeakers ? new Set(activeSpeakers) : null
  const onTimeRef = useRef(onTime)
  onTimeRef.current = onTime
  // Real duration, once the video reports it — needed to turn the timeline strip's blocks into
  // percentages (timelineStrips). Held in state (not just read off `art` inside the effect)
  // because the chips/strip overlay renders from React, outside the Artplayer-owned DOM.
  const [duration, setDuration] = useState(0)
  const plan = planVideo(media, baseUrl)
  const url = plan.kind === 'dash' ? plan.dashUrl : plan.kind === 'file' ? plan.src : ''
  const isMpd = plan.kind === 'dash'
  const progressiveUrl = plan.kind === 'dash' ? plan.progressiveUrl : ''
  const poster = plan.kind === 'dash' || plan.kind === 'file' ? (plan.poster ?? '') : ''
  const progressKey =
    (plan.kind === 'dash' ? plan.progressKey : plan.kind === 'file' ? plan.progressKey : '') || ''
  const subtitleListUrl = plan.kind === 'file' ? plan.subtitleListUrl : undefined
  const subtitleUrlBase = plan.kind === 'file' ? plan.subtitleUrlBase : undefined

  useEffect(() => {
    const container = ref.current
    if (!container || !url) return
    let cancelled = false
    let art: Any = null
    // Netdisk subtitle tracks from the parallel netdisk-subtitle-list preflight (empty unless the
    // file has embedded subtitle streams — see plan.subtitleListUrl).
    let subtitleTracks: SubtitleTrack[] = []

    // Server-mode progress report — a bare PUT, fire-and-forget (failures are silent; the shelf
    // just won't reflect this tick, no user-facing error). `opts.keepalive` is for the unmount
    // report below, so it can outlive the component that issued it.
    // `position <= 5` mirrors the *read* side's resume-seek threshold above (`t > 5`) — without
    // it, opening the wrong episode and closing it a second later (or React StrictMode's dev
    // double-mount) writes a 0:00/0% row that pins a permanent, only-removable-by-hand card at
    // the top of the shelf.
    const reportServerProgress = (position: number, duration: number, opts?: { keepalive?: boolean }) => {
      const sp = serverProgressRef.current
      if (!sp || !Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0 || position <= 5) return
      void api
        .watchProgressPut(sp.conn, sp.key, { position, duration, workKey: sp.workKey, workTitle: sp.workTitle, workPoster: sp.workPoster, epLabel: sp.epLabel, channelId: sp.channelId }, opts)
        .catch(() => {})
    }

    // Silence + tear an instance down hard: a half-stopped video (or a dash MediaSource / hls.js
    // instance) must not bleed audio into the next instance.
    const teardown = (instance: Any) => {
      try {
        const v = instance?.video as HTMLVideoElement | undefined
        if (v) {
          v.pause()
          v.muted = true
          v.removeAttribute('src')
          v.load()
        }
        instance?.dash?.reset?.()
        instance?.hls?.destroy?.()
      } catch {
        /* ignore */
      }
      try {
        instance?.destroy(false) // keep the React-owned container div
      } catch {
        /* ignore */
      }
    }

    const build = (playUrl: string, isHls: boolean) => {
      if (cancelled || !container) return
      // Tear down any outgoing instance first so the new one owns the container alone (StrictMode's
      // double-mount lands here). Destroying a fullscreen instance makes the browser exit fullscreen
      // as a side effect — via the native `fullscreenchange` event, which screenfull (Artplayer's
      // fullscreen dep) never unsubscribes on destroy, so it keeps firing on the OLD, already-
      // destroyed instance. That event is ASYNCHRONOUS, so the 'fullscreen' listener below compares
      // against artRef.current to tell a stale event from a real exit.
      if (art) {
        teardown(art)
        art = null
      }
      const defaultSubtitle = subtitleTracks.length ? pickDefaultSubtitle(subtitleTracks) : undefined
      art = new Artplayer({
        container,
        // 加载态换掉 Artplayer 自带的菊花,用与 app 的 Spinner 同形的指示。
        // **口子是 `icons.loading`,不是顶层 `loading`**——后者不是构造选项(它是运行时的
        // art.loading Component),写在这里会被静默忽略、typecheck 也拦不住(选项类型宽松)。
        icons: { loading: LOADING_HTML },
        url: playUrl,
        type: isMpd ? 'mpd' : isHls ? 'm3u8' : '',
        customType: isMpd ? { mpd: mpdHandler(progressiveUrl) } : isHls ? { m3u8: m3u8Handler } : {},
        poster,
        // Artplayer's real constructor rejects `subtitle: undefined` ("option.subtitle require
        // 'object' type, but got 'undefined'") — the key must be OMITTED, not set to undefined,
        // when there's no default track. The mocked Artplayer used in this file's own tests never
        // validates option shapes, so this only breaks against the real library (caught by
        // App.view.test.tsx, which renders ArtPlayer without mocking artplayer).
        ...(defaultSubtitle && subtitleUrlBase
          ? { subtitle: { url: `${subtitleUrlBase}&track=${encodeURIComponent(defaultSubtitle.id)}`, type: 'vtt' } }
          : {}),
        theme: THEME,
        volume: 0.7,
        autoplay: autoplayRef.current,
        setting: true,
        playbackRate: true,
        aspectRatio: true,
        pip: true,
        fullscreen: true,
        fullscreenWeb: false,
        miniProgressBar: true,
        hotkey: false, // handled by our global handler so the keys work off-player too
        lock: true,
        // progress-bar markers for a selected person's speech blocks. Read off the ref at
        // construction time (fresh as of the last render), not the `speakerBlocks` param
        // directly — this closure runs from build(), which the effect below only re-triggers
        // on url changes, so this is the value at the most recent render either way.
        highlight: speakerBlocksRef.current.map((b) => ({ time: b.start, text: b.label })),
      } as Any)
      artRef.current = art

      // Own the failure UX for terminal (file) / hls sources instead of Artplayer's generic
      // auto-reconnect. Artplayer retries EVERY <video> error the same way — including a definitive
      // 404 for a deleted clip (pointless: it will 404 again) — and emits its 'error' event on the
      // RETRY branch, so a listener that toasts there fires WHILE it's still retrying and then the
      // retry may recover: a false alarm. Drop Artplayer's built-in video:error handler and classify
      // each failure ourselves via a diag re-fetch (`diag=1` only marks it as a diagnostic re-read):
      //   • 4xx (deleted / 私密 / gone) → terminal: report once, NEVER retry.
      //   • anything else (network / 5xx / decode) → one SILENT retry; report only if that also fails.
      //   • a retry that recovers (video:playing) says nothing.
      // dash keeps Artplayer's own reconnect — its mpd handler already owns dash→progressive fallback.
      if (!isMpd) {
        art.off('video:error') // remove Artplayer's built-in reconnect + error mask for this instance
        let retried = false
        let busy = false // a classify fetch is in flight — ignore repeat errors until it settles
        let done = false
        const classify = async (): Promise<{ terminal: boolean; reason: string }> => {
          try {
            const sep = playUrl.includes('?') ? '&' : '?'
            const res = await fetch(`${playUrl}${sep}diag=1`)
            if (res.status >= 400 && res.status < 500) {
              const body = (await res.json().catch(() => null)) as { detail?: string; error?: string } | null
              return { terminal: true, reason: body?.detail || body?.error || `HTTP ${res.status}` }
            }
            await res.body?.cancel().catch(() => {}) // ok / 5xx — a retry may recover; don't hold the stream
            return { terminal: false, reason: '' }
          } catch {
            return { terminal: false, reason: '' } // network blip — retryable
          }
        }
        const fail = (msg: string) => {
          done = true
          art.loading.show = false // we removed the reconnect handler that would have hidden the spinner
          toast.error('播放失败', {
            description: msg,
            action: { label: '复制', onClick: () => void navigator.clipboard?.writeText(msg) },
          })
        }
        art.on('video:playing', () => { retried = false }) // recovered/playing — let a later mid-play blip retry again
        art.on('video:error', () => {
          if (done || busy || cancelled) return
          busy = true
          void (async () => {
            const { terminal, reason } = await classify()
            busy = false
            if (done || cancelled) return
            if (terminal) return fail(reason) // 404 / deleted — one report, zero retries
            if (!retried) { retried = true; art.url = playUrl; return } // exactly one silent retry
            fail('无法播放该视频（重试后仍失败）') // the retry errored too
          })()
        })
      }

      // report the stream's real dimensions (a cover poster can have a different ratio) so
      // the card/modal can size to what's actually playing — on metadata + once on ready.
      const reportSize = () => {
        const v = art.video as HTMLVideoElement | undefined
        if (v?.videoWidth && v.videoHeight) onVideoSizeRef.current?.(v.videoWidth, v.videoHeight)
        if (art.duration) setDuration(art.duration)
        // hand `duration` to out-of-player surfaces here too: the mini timelines need a runtime to
        // scale against, and waiting for the first throttled timeupdate leaves them blank.
        if (art.duration) onTimeRef.current?.(art.currentTime ?? 0, art.duration)
      }
      art.on('video:loadedmetadata', reportSize)

      // "click episode → fullscreen": go fullscreen the moment the player is ready. Kept in the
      // click's transient-activation window; if the browser refuses, the caller's inline player
      // stays visible as the fallback. Track that WE opened it so leaving fullscreen closes back
      // to the grid (below) — but only when it was actually entered, never on a refused request.
      let openedFullscreen = false
      // Captured so a stale event from THIS instance — fired asynchronously after a later build()
      // already superseded it (see build()'s teardown comment) — can be told apart from a real exit
      // on the currently-active instance. artRef.current is reassigned to the new instance
      // synchronously within build(), strictly before any async event can fire, so this check is
      // race-free regardless of exactly when the browser fires fullscreenchange.
      const builtArt = art
      // 画面底部那两层浮层（简介 / 说话人跳转点）**跟控制条同生共死**，判据只能是播放器自己
      // 那个 `control` 事件，不能是外层的 CSS `:hover`。两者会分家，而且分得很安静：
      // 这两层是 `[data-slot=art-player]` 的**兄弟**、不在 `$player` 子树里，鼠标停在简介上
      // 时 `$player` 收到的是 mouseleave（isHover=false），播放中数秒后控制条自动收起，而外层
      // `:hover` 仍为真——控制条没了、简介还悬在离底 56px 的位置，下面空一条。
      // 事件驱动的是一个 data 属性而不是 React state：这条一秒能翻好几次，没必要为它重渲染。
      const markControls = (shown: boolean) => {
        if (artRef.current !== builtArt) return
        wrapRef.current?.setAttribute('data-controls', shown ? 'on' : 'off')
      }
      art.on('control', markControls)
      // 建好这一刻控制条是显示的，但 `control` 只在**变化**时发——不铺这个初值，第一次自动
      // 收起之前两层浮层都不会出现。
      markControls(true)
      art.on('fullscreen', (state: boolean) => {
        if (artRef.current !== builtArt) return
        if (state) openedFullscreen = true
        else if (openedFullscreen && autoFullscreenRef.current) onFullscreenExitRef.current?.()
      })

      // 双击 = 只切全屏，别顺手把片子暂停了。
      // Artplayer 桌面端的 clickInit 对视频面上的**每一次**单击都无条件 `art.toggle()`，双击的
      // 第一下因此先翻一次播放态、第二下才切全屏 —— 用户看到的就是「双击全屏顺带暂停」。库里没有
      // 开关（`MOBILE_CLICK_PLAY` 只管移动端），`art.toggle` 又是 `Object.defineProperty` 定死的
      // 不可写属性、覆盖不掉；事后再 toggle 回来也不行 —— 那是真的发一轮 pause/play：会触发进度
      // 上报、把续播定位判成「用户已操作」而放弃（见下面 ready 里的 userInteracted）、角标闪一下。
      // 所以在事件走到 $video 之前就截住：capture 阶段挂在 $player 上，命中视频面就
      // stopPropagation，库挂在 $video 上的那个（唯一的）click 监听器收不到事件，单击/双击语义
      // 改由这里定义：单击等满一个双击窗口再切播放，窗口内来了第二下就撤掉、只切全屏。
      // 代价是单击暂停晚 300ms 生效（与 B 站等同款做法）；控制条的播放键和 Space 热键不受影响。
      const $player = (art as Any).template?.$player as HTMLElement | undefined
      const $video = (art as Any).template?.$video as HTMLElement | undefined
      if (!IS_MOBILE && $player && $video) {
        const dbclickMs = ((Artplayer as Any).DBCLICK_TIME as number | undefined) ?? 300
        let pending: ReturnType<typeof setTimeout> | null = null
        const onVideoClick = (e: Event) => {
          if (e.target !== $video) return // 控制条/设置面板/右键菜单等照常走库自己的处理
          e.stopPropagation()
          // stopPropagation 顺带掐掉了 $player 上「点一下关掉右键菜单」那个监听器 —— 补上。
          if ((art as Any).contextmenu) (art as Any).contextmenu.show = false
          if (pending) {
            clearTimeout(pending)
            pending = null
            art.emit('dblclick', e)
            art.fullscreen = !art.fullscreen
            return
          }
          art.emit('click', e)
          pending = setTimeout(() => {
            pending = null
            art.toggle()
          }, dbclickMs)
        }
        $player.addEventListener('click', onVideoClick, true)
        art.on('destroy', () => {
          if (pending) clearTimeout(pending)
          $player.removeEventListener('click', onVideoClick, true)
        })
      }

      let lastSave = 0
      art.on('ready', () => {
        reportSize()
        if (autoFullscreenRef.current) art.fullscreen = true
        if (seekRef) {
          seekRef.current = (s: number) => {
            art.currentTime = Math.max(0, s)
            art.play()
          }
          art.once('destroy', () => {
            if (seekRef.current) seekRef.current = null
          })
        }
        const sp = serverProgressRef.current
        if (sp) {
          // The GET is a real network round-trip (unlike localStorage's synchronous read) — the
          // user can seek/play/pause while it's in flight. Mark that and skip applying the
          // resumed position if it lands after they've already acted; otherwise a slow response
          // silently snaps them back to wherever they were before they touched anything.
          let userInteracted = false
          art.once('seek', () => { userInteracted = true })
          art.once('play', () => { userInteracted = true })
          art.once('pause', () => { userInteracted = true })
          void api
            .watchProgressGet(sp.conn, sp.key)
            .then((row) => row?.position ?? 0)
            .catch(() => 0)
            .then((t) => {
              // stale response after teardown/rebuild (quality switch, unmount) — don't touch a
              // dead or superseded instance; nor one the user has already moved on from.
              if (cancelled || artRef.current !== builtArt || userInteracted) return
              if (t > 5 && (!art.duration || t < art.duration - 10)) art.currentTime = t
            })
          return
        }
        if (!progressKey) return
        const t = getProgress(progressKey)
        if (t > 5 && (!art.duration || t < art.duration - 10)) art.currentTime = t
      })
      art.on('video:timeupdate', () => {
        const sp = serverProgressRef.current
        const t = art.currentTime
        if (sp) {
          // 15s throttle (vs 5s for localStorage) — server mode also reports on pause/ended/unmount,
          // so the tick-based report only needs to cover "still playing, uninterrupted" ticks.
          if (Math.abs(t - lastSave) >= 15) {
            lastSave = t
            reportServerProgress(t, art.duration)
          }
          return
        }
        if (!progressKey) return
        if (Math.abs(t - lastSave) >= 5) {
          lastSave = t
          saveProgress(progressKey, t)
        }
      })
      art.on('video:pause', () => {
        if (!serverProgressRef.current) return
        // advance the throttle marker too — otherwise a pause followed by resumed playback can
        // double-PUT nearly the same position again inside the same 15s timeupdate window.
        lastSave = art.currentTime
        reportServerProgress(art.currentTime, art.duration)
      })
      art.on('video:ended', () => {
        if (serverProgressRef.current) {
          // 服务端靠 isFinished 自己判定「看完」——记录要留着,重看时才能续播,不像 localStorage
          // 模式那样清掉。
          lastSave = art.currentTime
          reportServerProgress(art.currentTime, art.duration)
          return
        }
        if (progressKey) clearProgress(progressKey)
      })

      // Multi-select "只看这些人": while activeSpeakers is set, currentTime outside every checked
      // speaker's block means the user (or native playback) drifted into someone else's speech —
      // jump to the next checked block's start; past the last one, pause instead of playing into
      // the tail. Pure decision lives in skipTarget (Task 7) so it's unit-tested without a real
      // player; reads both refs fresh each tick so toggling activeSpeakers takes effect without
      // rebuilding the player (see speakerBlocksRef/activeRef above).
      art.on('video:timeupdate', () => {
        const action = skipTarget(speakerBlocksRef.current, activeRef.current, art.currentTime as number)
        if (!action) return
        if ('seek' in action) art.currentTime = action.seek
        else art.pause()
      })

      // Playback clock for out-of-player surfaces (see the `onTime` prop). Throttled to ~4/s:
      // `video:timeupdate` fires as often as the source decides, and every emit here lands in
      // React state one component up. Also emitted on seek/pause so a scrub or a paused frame
      // updates the panel immediately instead of waiting for the next playing tick.
      let lastEmit = 0
      const emitTime = (force = false) => {
        if (!onTimeRef.current) return
        const now = Date.now()
        if (!force && now - lastEmit < 250) return
        lastEmit = now
        onTimeRef.current(art.currentTime ?? 0, art.duration ?? 0)
      }
      art.on('video:timeupdate', () => emitTime())
      art.on('video:seeked', () => emitTime(true))
      art.on('video:pause', () => emitTime(true))

      // 字幕菜单：setting 菜单一项 + onSelect 触发副作用，换轨不用重建播放器实例——ArtPlayer
      // 原生 `subtitle.switch` 就地换轨即可。**永远带一个「关闭」项、且只要有
      // ≥1 条轨就出菜单**：否则自动挂上的那条（尤其搜刮来的错配花字）用户退不出去——真实事故是
      // 综艺纯享无内嵌轨，掉进在线搜刮兜底、挂上一条随机 .ass，旧代码只在 >1 轨时给切换、且无「关闭」，
      // 于是字幕关不掉。默认项：有高置信轨就选它，否则默认「关闭」（`defaultSubtitle` 见 pickDefaultSubtitle）。
      if (subtitleTracks.length >= 1 && subtitleUrlBase) {
        art.setting.add({
          html: '字幕',
          tooltip: defaultSubtitle?.title ?? defaultSubtitle?.lang ?? '关闭',
          selector: [
            { html: '关闭', default: !defaultSubtitle },
            ...subtitleTracks.map((t) => ({
              html: t.title ?? t.lang ?? `轨道 ${t.index ?? t.id}`,
              default: t.id === defaultSubtitle?.id,
              track: t,
            })),
          ],
          onSelect(item: Any) {
            const t = item.track as SubtitleTrack | undefined
            if (!t) {
              // 「关闭」项没有 track —— 隐藏当前字幕，不换轨。
              art.subtitle.show = false
              return item.html
            }
            if (!subtitleUrlBase) return item.html
            art.subtitle.switch(`${subtitleUrlBase}&track=${encodeURIComponent(t.id)}`, { type: 'vtt' })
            art.subtitle.show = true
            return t.title ?? t.lang ?? item.html
          },
        })
      }
    }

    // Netdisk movies/episodes go through /api/media/videos/resolve, which hides the final media
    // type behind a redirect: a quark-backed file transcodes to HLS (needs hls.js) while a
    // browser-native file (h264/aac mp4) is a plain progressive stream. <video src> follows the
    // redirect opaquely, so JS can't read the content-type — ask the resolver as JSON first, then
    // wire the right player. Non-netdisk sources ((provider, vid) dash, xhs progressive) skip it.
    if (/\/api\/media\/videos\/resolve/.test(url)) {
      const sep = url.includes('?') ? '&' : '?'
      // 解析结果常常是**根相对**的后端路由（网盘条目在 alist.ts 里就存成
      // `/api/media/netdisk-play?path=…`）。它必须吃 baseUrl——见 `lib/backendUrl.ts` 头注：
      // 此前这里把 `/` 也当成"已经绝对了"放行，于是在页面源 ≠ 后端源的两档（工作台面板、
      // 桌面端）里，`<video>` 去页面自己的源上要一条只有后端才有的路由，404 → error.code 4。
      const resolveUrl = (u: string | undefined) => (u ? backendUrl(baseUrl, u) : url)
      const fetchSubtitles: Promise<{ tracks: SubtitleTrack[] }> = subtitleListUrl
        ? fetch(subtitleListUrl)
            .then((r) => (r.ok ? (r.json() as Promise<{ tracks?: SubtitleTrack[] }>) : { tracks: [] }))
            .then((j) => ({ tracks: j.tracks ?? [] }))
            .catch(() => ({ tracks: [] }))
        : Promise.resolve({ tracks: [] })
      Promise.all([
        fetch(`${url}${sep}format=json`).then((r) =>
          r.ok
            ? (r.json() as Promise<{ mode?: string; url?: string }>)
            : Promise.reject(new Error(String(r.status))),
        ),
        fetchSubtitles,
      ])
        .then(([j, sub]) => {
          if (cancelled) return
          subtitleTracks = sub.tracks
          build(resolveUrl(j.url), j.mode === 'hls')
        })
        .catch(() => build(url, false)) // preflight failed → best-effort native playback
    } else {
      build(url, false)
    }

    return () => {
      cancelled = true
      // Report once more before tearing down — this is what makes progress survive an unexpected
      // exit (closing the tab, navigating away) instead of losing whatever ticked since the last
      // 15s-throttled report. `keepalive` lets the request outlive this component/page.
      if (serverProgressRef.current && art) reportServerProgress(art.currentTime, art.duration, { keepalive: true })
      // StrictMode recreates this, so a half-stopped video (or a dash MediaSource / hls.js
      // instance) must not bleed audio into the next instance. `art` stays null if we unmount
      // while the resolve preflight is still in flight.
      teardown(art)
      if (art && artRef.current === art) artRef.current = null
    }
    // re-create only when the source url changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  // Global shortcuts while a video is playing (inline or in the modal): Space = play/
  // pause, F = fullscreen, H = open the detail modal. Window-level so they work even
  // when the player isn't focused; skipped while typing in an input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const art = artRef.current
      if (!art) return
      switch (e.code) {
        case 'Space':
          e.preventDefault()
          art.toggle()
          break
        case 'KeyF':
          e.preventDefault()
          art.fullscreen = !art.fullscreen
          break
        case 'KeyH':
          e.preventDefault()
          onExpandRef.current?.()
          break
        case 'ArrowLeft':
          e.preventDefault()
          art.currentTime = Math.max(0, art.currentTime - 5)
          break
        case 'ArrowRight':
          e.preventDefault()
          art.currentTime = Math.min(art.duration || art.currentTime + 5, art.currentTime + 5)
          break
        case 'ArrowUp':
          e.preventDefault()
          art.volume = Math.min(1, art.volume + 0.1)
          break
        case 'ArrowDown':
          e.preventDefault()
          art.volume = Math.max(0, art.volume - 0.1)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Chips (one per speaker, aggregate seconds) + colored timeline strip — a React-owned overlay
  // sitting above the Artplayer-owned DOM (that library renders its own tree into `ref`'s
  // container, so this can't be one of its layers). Fades with the controls via CSS group-hover,
  // mirroring how Artplayer's own bottom bar behaves.
  // 只需要"每段起点在哪、什么颜色、属于谁"——点而非段。
  const marks = useMemo(
    () =>
      nameableMarks(
        timelineStrips(speakerBlocks ?? [], duration).map((s) => ({ leftPct: s.leftPct, color: s.color, label: s.label }))
      ),
    [speakerBlocks, duration]
  )
  const activeSet = activeSpeakers ? new Set(activeSpeakers) : null

  // 说话人标记那一层画不画。简介浮层要靠它决定自己的基线（两层都贴控制条上沿，同位就会
  // 叠字），所以先算出来，别在两处各判一次。
  const hasMarks = marks.length > 0 && duration > 0
  // 简介浮层**只画在详情页那台媒体上**。播放器实例是全局共享的（经 portal 也渲染进时间线
  // 卡片里，见 feed/PostItemRow 的 MediaBoxPlayer），而时间线卡片自己已经用 line-clamp-3
  // 画了同一段文字，内联播放器又矮——同一段话浮一遍会占掉画面很大一块。`thumb` 就是内联
  // 那一档（App 只在详情页打开这条时才给 'default'），判据用它。
  const showBlurb = !!blurb && variant !== 'thumb'

  // fills its mount point — the OutPortal wrapper sets the box (inline aspect-video
  // in the card, ~85vh in the modal); Artplayer's ResizeObserver follows the move.
  return (
    <div ref={wrapRef} data-slot="art-player" data-variant={variant} className="group/player relative h-full w-full">
      {variant === 'thumb' ? (
        <style>
          {`
            [data-slot="art-player"][data-variant="thumb"] .art-video-player:not(.art-fullscreen) {
              --art-control-height: 30px !important;
              --art-control-icon-size: 16px !important;
              --art-control-icon-scale: 1 !important;
              --art-settings-icon-size: 16px !important;
              --art-padding: 6px !important;
              --art-state-size: 44px !important;
              font-size: 13px !important;
            }
            [data-slot="art-player"][data-variant="thumb"] .art-video-player:not(.art-fullscreen) .art-bottom {
              overflow: visible !important;
              padding-left: 5px !important;
              padding-right: 10px !important;
              padding-bottom: 6px !important;
            }
            [data-slot="art-player"][data-variant="thumb"] .art-video-player:not(.art-fullscreen) .art-controls .art-control {
              min-width: 26px !important;
              margin: 0 1px !important;
            }
            [data-slot="art-player"][data-variant="thumb"] .art-video-player:not(.art-fullscreen) .art-controls-left {
              gap: 2px !important;
            }
            [data-slot="art-player"][data-variant="thumb"] .art-video-player:not(.art-fullscreen) .art-controls-right {
              gap: 2px !important;
            }
            [data-slot="art-player"][data-variant="thumb"] .art-video-player:not(.art-fullscreen) .art-current-time,
            [data-slot="art-player"][data-variant="thumb"] .art-video-player:not(.art-fullscreen) .art-duration {
              font-size: 13px !important;
            }
            [data-slot="art-player"][data-variant="thumb"] .art-video-player:not(.art-fullscreen) .art-layer-auto-playback,
            [data-slot="art-player"][data-variant="thumb"] .art-video-player:not(.art-fullscreen) .art-contextmenus,
            [data-slot="art-player"][data-variant="thumb"] .art-video-player:not(.art-fullscreen) .art-notice {
              display: none !important;
            }
          `}
        </style>
      ) : null}
      <div ref={ref} onClick={(e) => e.stopPropagation()} className="h-full w-full" />
      {showBlurb ? (
        // 显隐照 `data-controls`（播放器自己的 `control` 事件，见 build() 里的 markControls），
        // **不是**外层的 `:hover`——鼠标停在这一层上时 `$player` 已经 mouseleave 了，控制条会
        // 自己收起来，而 `:hover` 还是真：简介就悬在离底 56px 处、下面空一条。
        // opacity 和 pointer-events 是两个独立的轴——不可见时这层也必须不可点，
        // 否则鼠标划过画面底部那一条时看不见却能点到，会悄悄吞掉「点画面关详情页」的点击，
        // 且没有任何报错。
        //
        // **基线关系（再往这块地里加一层的人先读这句）**：画面底部这一叠自下而上是
        // 控制条 → speaker-marks（`bottom-14`，高 h-5=20px）→ 简介。所以有 marks 时简介
        // 让到 marks 之上（56+20=76px），没有 marks 时才落回 `bottom-14`。两层同位不会
        // 报错，只会让说话人圆点和名字压在简介最后一行上——而且只在「有说话人图谱 + 有
        // 简介」的视频上出现，jsdom 测不到。
        <div
          className={cn(
            'pointer-events-none absolute inset-x-0 z-10 opacity-0 transition-opacity duration-200 group-data-[controls=on]/player:pointer-events-auto group-data-[controls=on]/player:opacity-100',
            hasMarks ? 'bottom-[76px]' : 'bottom-14'
          )}
        >
          <BlurbOverlay text={blurb} />
        </div>
      ) : null}
      {hasMarks ? (
        // 跳转点：每个发言段的**起点**打一个点,不是画一整段——段落信息在右侧面板里,
        // 画面上只留"可以跳到哪儿"这一件事(删掉了原来的人名 badge 行,与右侧面板冗余)。
        <div
          data-slot="speaker-marks"
          className="pointer-events-none absolute inset-x-0 bottom-14 z-10 h-5 px-3 opacity-0 transition-opacity duration-200 group-data-[controls=on]/player:opacity-100"
        >
          <div className="relative h-full w-full">
            {marks.map((m, i) => {
              const name = speakerNames?.[m.label] ?? m.label
              // 靠右端的名字往左写，否则会顶出播放器右边缘被裁掉
              const flip = m.leftPct > 78
              return (
                <span
                  key={i}
                  title={name}
                  className="absolute top-1/2 flex -translate-y-1/2 items-center gap-1"
                  style={{
                    left: `${m.leftPct}%`,
                    transform: 'translateY(-50%)',
                    opacity: activeSet && !activeSet.has(m.label) ? 0.3 : 1,
                    flexDirection: flip ? 'row-reverse' : 'row',
                    translate: flip ? '-100% 0' : '-4px 0',
                  }}
                >
                  <span
                    data-slot="speaker-mark-dot"
                    className="size-2 shrink-0 rounded-full ring-1 ring-black/40"
                    style={{ background: m.color }}
                  />
                  {m.showName ? (
                    // 名字压在视频画面上，底色随画面变——给一层实底 scrim 保可读（Apple:
                    // 半透明表面上的文字要靠对比度，不能只靠字色）。
                    <span
                      data-slot="speaker-mark-name"
                      className="max-w-[9rem] truncate rounded bg-black/60 px-1 py-px text-[11px] font-medium leading-tight text-white backdrop-blur-sm"
                    >
                      {name}
                    </span>
                  ) : null}
                </span>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}
