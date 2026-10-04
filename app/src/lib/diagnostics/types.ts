/** 诊断飞行记录器的数据模型。只有诊断元数据 —— 绝不含音频二进制、页面正文、
 *  Cookie、请求头或完整带签名 URL。参见 docs/superpowers/specs/2026-07-13-web-oom-diagnostics-design.md */

export type SessionStatus = 'running' | 'ended' | 'suspected-abnormal'

/** 一个页面会话。`running` 在开始时即写入：下次启动仍看到 `running` 就说明上次没能
 *  正常收尾（疑似异常终止）。这是推断，不是 OOM 的确证 —— renderer 被杀后没有代码能跑。 */
export interface DiagnosticSession {
  id: string
  startedAt: number
  lastWriteAt: number
  appVersion: string
  /** 精简 UA（浏览器 + 大版本 + 平台），不是完整 UA 串 */
  ua: string
  status: SessionStatus
}

/** 脱敏后的播放上下文。query/fragment 已丢弃，pathname 只留稳定 hash。 */
export interface MediaContext {
  /** origin host（blob:/data: 则记协议本身） */
  host: string
  /** pathname 的稳定 hash —— 用于把同一条音轨的样本分到一组，不可反解出原路径 */
  pathHash: string
  sameOrigin: boolean
}

export interface TimeRange {
  start: number
  end: number
}

/** `performance.memory`：Chromium 专有的趋势指标。不等于 renderer 总内存，
 *  不得单独用于归因 —— 只看曲线是否单调上涨。缺失时为 null（其它浏览器）。 */
export interface MemorySnapshot {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

export interface DomSnapshot {
  nodes: number
  img: number
  video: number
  audio: number
}

/** 全局 <audio> 的只读快照。由 App.tsx 提供 —— recorder 不拥有该元素。 */
export interface AudioSnapshot {
  playing: boolean
  currentTime: number
  duration: number
  readyState: number
  networkState: number
  /** 缓冲区间：媒体管线是否在无界堆积，看这里 */
  buffered: TimeRange[]
  media: MediaContext | null
}

export interface Sample {
  sessionId: string
  at: number
  memory: MemorySnapshot | null
  dom: DomSnapshot
  route: string
  visibility: 'visible' | 'hidden'
  online: boolean
  audio: AudioSnapshot | null
  /** 只记聚合计数，绝不记 URL */
  resourceEntries: number
  /** 只记聚合计数与时长，绝不记 URL。
   *  null = **未测量**（本期未接 PerformanceObserver），不是「实测为 0」——
   *  这两者在读曲线时含义相反，诊断数据宁可缺失也不能造零。 */
  longTasks: { count: number; totalMs: number } | null
}

export type DiagEventKind =
  | 'loadstart'
  | 'loadedmetadata'
  | 'playing'
  | 'waiting'
  | 'stalled'
  | 'suspend'
  | 'error'
  | 'ended'
  | 'window-error'
  | 'unhandledrejection'
  | 'user-mark'

export interface DiagEvent {
  sessionId: string
  at: number
  kind: DiagEventKind
  /** 简短原因（如 MediaError code 名）。绝不放正文/URL/堆栈原文中的敏感串。 */
  detail?: string
  media: MediaContext | null
}

/** 导出物：一个会话 + 它的时间线。用户主动下载，不自动上传。 */
export interface ExportBundle {
  session: DiagnosticSession
  samples: Sample[]
  events: DiagEvent[]
  exportedAt: number
  /** 提醒读者 memory 字段的边界，避免把趋势读成归因 */
  notes: string[]
}
