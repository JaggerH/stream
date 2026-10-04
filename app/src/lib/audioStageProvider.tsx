/**
 * 音频舞台的**唯一实现**：一个全局 `<audio>` 元素 + 驱动它的那套队列状态。
 *
 * 抽出来的理由和 `videoStageProvider.tsx` 一样：工作台面板是另一个浏览器页面（另一棵 React
 * 树），要播放就得自己有一份实例；两份**实现**会静默漂移，所以只共用一份代码。
 *
 * 舞台不认识应用外壳。两件外壳自己的事靠两个显式出口留在挂载方那边，别往舞台里塞：
 *
 *  - `elementRef` —— 诊断飞行记录器（`App.tsx` 的 recorder）要**只读地旁观**这个 `<audio>`
 *    采样 buffered/readyState。它不属于播放语义，所以不进舞台；舞台只是把元素借出去。
 *  - `stageRef` —— 队列的**生产者**（"播这条 + 把当前列表排在它后面"）住在页面里，因为
 *    "当前列表是哪一批"只有页面知道。生产者写在挂载方的组件体里（= 在 Provider 外面），
 *    读不到 context，所以由 Provider 把当前 stage 回填进这个 ref 供它调用。
 *
 * 音乐/播客是两条独立队列（见 `audioStage.ts` 的接口注释），这里只实现，不重述语义。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'

import { toast } from '../components/acrylic/sonner.tsx'
import {
  AudioStageContext,
  nextTrack,
  type AudioKind,
  type AudioStage,
  type AudioTrack,
} from './audioStage.ts'
import { AudioTimeContext, createAudioTimeStore } from './audioTime.ts'
import { applyPendingSeek, createPendingSeek } from './pendingSeek.ts'

/** 舞台会转发出去的媒体元素事件（`DiagEventKind` 的子集，见 onMediaEvent）。 */
export type AudioMediaEvent =
  | 'loadstart'
  | 'loadedmetadata'
  | 'playing'
  | 'waiting'
  | 'stalled'
  | 'suspend'
  | 'error'

export function AudioStageProvider({
  elementRef,
  stageRef,
  onMediaEvent,
  children,
}: {
  /** 借出 `<audio>` 元素（见文件头注）。不给 = 舞台自己拿着，没人旁观。 */
  elementRef?: RefObject<HTMLAudioElement | null>
  /** 回填当前 stage，给住在 Provider 外面的队列生产者用（见文件头注）。 */
  stageRef?: RefObject<AudioStage | null>
  /** 媒体元素事件的旁路（诊断打点）。**只记录，不参与播放决策**——没有它时播放行为一字不差。
   *  名字写成一个闭合的联合而不是 `string`：它要喂给诊断记录器的 `DiagEventKind`，写宽了
   *  就得在调用点上补一次类型断言，那正是"断言把接错的线遮住"的地方。 */
  onMediaEvent?: (name: AudioMediaEvent, detail?: string) => void
  children: ReactNode
}) {
  const ownElRef = useRef<HTMLAudioElement>(null)
  const audioElRef = elementRef ?? ownElRef

  const [audioTrack, setAudioTrack] = useState<AudioTrack | null>(null)
  const [audioQueues, setAudioQueues] = useState<Record<AudioKind, AudioTrack[]>>({ music: [], podcast: [] })
  const [activeKind, setActiveKind] = useState<AudioKind>('music')
  const [audioPlaying, setAudioPlaying] = useState(false)
  // Playback POSITION is not state here on purpose — it ticks ~4x/sec and would re-render the
  // whole tree under AudioStageContext that often. It lives in its own store; only the bar
  // subscribes (lib/audioTime.ts).
  const audioTimeStore = useMemo(() => createAudioTimeStore(), [])
  const [audioDuration, setAudioDuration] = useState(0)
  const audioVolumeRef = useRef<number>((() => {
    if (typeof window === 'undefined') return 1
    const v = Number(window.localStorage.getItem('audioVolume'))
    return Number.isFinite(v) && v > 0 ? Math.min(1, v) : 1
  })())

  // 「点转写里的一段 → 起播这条 + 落到那一秒」的落点暂存。**住在这里**：`<audio>` 实例和
  // 「当前是哪一轨」都只有舞台有，别处另起一份改的是第二份副本、播放器不看它。
  // 不是 state：它不参与渲染，改它不该触发一次全树重渲染（同 audioVolumeRef 的理由）。
  const pendingSeek = useMemo(() => createPendingSeek(), [])

  useEffect(() => {
    // The position/duration are driven by the <audio> element's own onTimeUpdate/
    // onDurationChange (below) — those only fire once the browser actually has playback data
    // for the NEW src, which lags a beat behind this synchronous track-id switch. Without this
    // reset, the published time briefly still reports the PREVIOUS track's leftover position
    // for the new track's card/NowPlayingBar/AudioPlayerStage — which is exactly what seeded
    // AudioPlayerStage's karaoke clock to a random mid-song line on every song switch.
    audioTimeStore.set(0)
    setAudioDuration(0)
    // 换轨即作废：等着落点的那条轨不再是当前轨时，这条 pending 过期。**不丢就会把 A 的落点
    // 写到 B 的进度上**，而且不报错——这正是转写档原先不敢在未播态画按钮的那个风险。
    pendingSeek.retarget(audioTrack?.id)
    if (audioTrack) void playCurrentAudio()
  }, [audioTrack?.id])

  useEffect(() => {
    if (audioElRef.current) audioElRef.current.volume = audioVolumeRef.current
  }, [audioTrack?.id])

  const playCurrentAudio = () => {
    const audio = audioElRef.current
    if (!audio) return Promise.resolve()
    return audio.play().catch((error: unknown) => {
      // Load/resolve failures surface exactly once via the <audio> onError handler below (with the
      // real upstream reason + a copy button). Here we only swallow the benign interrupted-play
      // AbortError, so we never double-toast.
      if ((error as DOMException)?.name === 'AbortError') return
    })
  }

  // Single source of truth for play errors. The browser's own MediaError is the authoritative
  // reason (NETWORK / DECODE / SRC_NOT_SUPPORTED + message); we surface that first. Only when the
  // browser blames network/source do we re-query the backend for the upstream detail — a re-resolve
  // on a decode error would just mislead (the bytes already arrived).
  const reportPlayFailure = async (track: { url?: string; title?: string }, mediaError?: MediaError | null) => {
    const codeName = ['', 'ABORTED', 'NETWORK', 'DECODE', 'SRC_NOT_SUPPORTED'][mediaError?.code ?? 0] || 'UNKNOWN'
    let detail = mediaError
      ? `MEDIA_ERR_${codeName}${mediaError.message ? ` — ${mediaError.message}` : ''}`
      : '无法播放'
    if (track.url && (mediaError?.code === 2 || mediaError?.code === 4)) {
      try {
        const res = await fetch(track.url)
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null
          detail += ` | 上游：${body?.detail || body?.error || `HTTP ${res.status}`}`
        }
      } catch (e) {
        detail += ` | 网络：${(e as Error)?.message || '请求失败'}`
      }
    }
    const description = `${track.title || '音频'}：${detail}`
    toast.error('播放失败', {
      description,
      action: { label: '复制错误', onClick: () => void navigator.clipboard?.writeText(description) },
    })
  }

  // 装配期取的值 = 冻住的答案（见 AGENTS.md 同名一节）：stage 是渲染期算出来的，"它以后
  // 会不会变"答案是会——每次依赖变都是一份新的。回填给 stageRef 因此不能拖到 effect
  // 里再补（那是"前向 let + 回填"的具体病灶：住在 Provider 外面的消费方若在自己的挂载
  // effect 里就去读 stageRef，挂载 effect 排在这次渲染的所有 effect 之前吗？不——同层
  // effect 按声明顺序跑，消费方的挂载 effect 完全可能排在这个回填 effect 前面，读到的是
  // 上一次渲染（甚至 null）。改成渲染期直接写：写 ref 不参与本次计算、不触发新渲染，
  // 消费方能读到的最早时刻就提前到了"它自己的挂载 effect 执行时"。
  const audioStage: AudioStage = useMemo(() => {
    const stage: AudioStage = {
      current: audioTrack,
      playing: audioPlaying,
      duration: audioDuration || audioTrack?.durationS || 0,
      activeKind,
      queues: audioQueues,
      queue: audioQueues[activeKind],
      play: (track) => {
        setAudioQueues((q) => ({ ...q, [track.kind]: [track] }))
        setActiveKind(track.kind)
        if (track.id === audioTrack?.id) void playCurrentAudio()
        else setAudioTrack(track)
      },
      playQueue: (tracks, startIndex, kind) => {
        const start = tracks[Math.max(0, Math.min(startIndex, tracks.length - 1))]
        if (!start) return
        setAudioQueues((q) => ({ ...q, [kind]: tracks }))
        setActiveKind(kind)
        if (start.id === audioTrack?.id) void playCurrentAudio()
        else setAudioTrack(start)
      },
      toggle: () => {
        const audio = audioElRef.current
        if (!audio) return
        if (audio.paused) void playCurrentAudio()
        else audio.pause()
      },
      seek: (seconds) => {
        if (audioElRef.current) audioElRef.current.currentTime = seconds
      },
      playAt: (track, seconds) => {
        // 已经是当前轨：元素上装的就是它，直接落点 + （重新）起播，不必等加载。
        if (track.id === audioTrack?.id) {
          if (audioElRef.current) audioElRef.current.currentTime = seconds
          void playCurrentAudio()
          return
        }
        // 还不是：先记下落点，装上这条轨；`loadedmetadata` 那里才兑现（那时才有 seekable）。
        pendingSeek.arm(track.id, seconds)
        setAudioQueues((q) => ({ ...q, [track.kind]: [track] }))
        setActiveKind(track.kind)
        setAudioTrack(track)
      },
      stop: () => {
        audioElRef.current?.pause()
        pendingSeek.clear()
        setAudioTrack(null)
      },
      getVolume: () => audioVolumeRef.current,
      setVolume: (volume) => {
        const clamped = Math.max(0, Math.min(1, volume))
        audioVolumeRef.current = clamped
        if (audioElRef.current) audioElRef.current.volume = clamped
        window.localStorage.setItem('audioVolume', String(clamped))
      },
    }
    // 回填给住在 Provider 外面的队列生产者（见文件头注）：渲染期直接写，别拖到 effect
    // （见上面这段头注）。
    if (stageRef) stageRef.current = stage
    return stage
  }, [audioTrack, audioPlaying, audioDuration, audioQueues, activeKind, stageRef])

  const onAudioEnded = () => {
    setAudioPlaying(false)
    const kind = audioTrack?.kind ?? activeKind
    const next = nextTrack(audioQueues[kind], audioTrack?.id)
    if (next) setAudioTrack(next)
  }

  return (
    <AudioStageContext.Provider value={audioStage}>
      <AudioTimeContext.Provider value={audioTimeStore}>
        {children}
      </AudioTimeContext.Provider>
      <audio
        ref={audioElRef}
        src={audioTrack?.url}
        onPlay={() => setAudioPlaying(true)}
        onPause={() => setAudioPlaying(false)}
        onTimeUpdate={(event) => audioTimeStore.set(event.currentTarget.currentTime)}
        onDurationChange={(event) => setAudioDuration(event.currentTarget.duration || 0)}
        onError={(event) => {
          // 这条轨加载失败 → 等着它的落点没有归宿了，别留着（留着会在下一次装上它时冒出一次
          // 用户早就忘了的跳转）。
          pendingSeek.clear()
          if (audioTrack) void reportPlayFailure(audioTrack, event.currentTarget.error)
          onMediaEvent?.('error', `code=${event.currentTarget.error?.code ?? 0}`)
        }}
        onEnded={onAudioEnded}
        // 诊断旁路：只记录，不参与播放决策。waiting/stalled 是长播客排查的关键信号
        // （媒体管线在等数据 vs JS 在漏）。没有 onMediaEvent（开关关闭/面板）时全是 no-op。
        onLoadStart={() => onMediaEvent?.('loadstart')}
        onLoadedMetadata={() => {
          // pending-seek 就在这里兑现：`readyState >= HAVE_METADATA` 才有 seekable，更早写
          // currentTime 会被丢掉。落点只在「目标轨就是当前轨」时才算数（applyPendingSeek）。
          applyPendingSeek(pendingSeek, audioElRef.current, audioTrack?.id)
          onMediaEvent?.('loadedmetadata')
        }}
        onPlaying={() => onMediaEvent?.('playing')}
        onWaiting={() => onMediaEvent?.('waiting')}
        onStalled={() => onMediaEvent?.('stalled')}
        onSuspend={() => onMediaEvent?.('suspend')}
        hidden
      />
    </AudioStageContext.Provider>
  )
}
