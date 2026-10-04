import type { DiagnosticsRepo } from './repository.ts'
import type { DiagEventKind, Sample } from './types.ts'

/** spec：默认每 10 秒采集一次。 */
export const VISIBLE_INTERVAL_MS = 10_000
/** spec：页面隐藏时降为每 60 秒。 */
export const HIDDEN_INTERVAL_MS = 60_000

export function intervalFor(visibility: 'visible' | 'hidden'): number {
  return visibility === 'hidden' ? HIDDEN_INTERVAL_MS : VISIBLE_INTERVAL_MS
}

/** 会话 id：时间戳 + 随机尾。只要在本机内不撞即可，不需要全局唯一。 */
export function newSessionId(now: number, rand: () => number): string {
  return `${now.toString(36)}-${Math.floor(rand() * 0xffffff).toString(36)}`
}

/**
 * 精简 UA：只留浏览器名/大版本 + 平台。完整 UA 串是指纹，诊断文件不需要它。
 */
export function trimUa(ua: string): string {
  const browser = /(Chrome|Firefox|Safari|Edg)\/(\d+)/.exec(ua)
  const platform = /\(([^;)]+)/.exec(ua)
  if (!browser) return ua.slice(0, 40)
  return `${browser[1]}/${browser[2]}${platform ? ` ${platform[1].trim()}` : ''}`.slice(0, 60)
}

export interface RecorderDeps {
  repo: DiagnosticsRepo
  now: () => number
  appVersion: string
  ua: string
  rand: () => number
  /** 造一条样本（Task 4 的 buildSample 绑好 deps 后传进来） */
  sample: (sessionId: string, at: number) => Sample
  visibility: () => 'visible' | 'hidden'
}

export interface Recorder {
  start(): Promise<void>
  stop(reason: 'unload' | 'disabled'): Promise<void>
  mark(kind: DiagEventKind, detail?: string): Promise<void>
  sessionId(): string
}

/**
 * 采样调度器。它不拥有 <audio>，也不碰播放：只按节拍向 repo 追加只读快照。
 *
 * 用 setTimeout 自续（而非 setInterval）：可见性一变，下一拍就换节奏，无需重挂定时器。
 * 每一拍都整个包在 try/catch 里 —— 诊断绝不能反过来把页面搞崩。
 */
export function createRecorder(deps: RecorderDeps): Recorder {
  let id = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false

  const tick = async () => {
    if (!running) return
    try {
      await deps.repo.addSample(deps.sample(id, deps.now()))
    } catch {
      // 一次采样失败（配额满、事务被中止、快照抛错）不该让记录器整个停摆 ——
      // 下一拍照常。诊断是旁路，永远不能反噬页面。
    }
    schedule()
  }

  const schedule = () => {
    if (!running) return
    timer = setTimeout(() => void tick(), intervalFor(deps.visibility()))
  }

  return {
    sessionId: () => id,

    async start() {
      if (running) return
      const at = deps.now()
      id = newSessionId(at, deps.rand)
      // 会话一开始就写 running：这是「上次没能收尾」推断的锚点。renderer 被 OOM
      // 杀掉之后没有代码能跑，所以标记必须提前写，不能等到出事再写。
      await deps.repo.startSession({
        id,
        startedAt: at,
        lastWriteAt: at,
        appVersion: deps.appVersion,
        ua: trimUa(deps.ua),
        status: 'running',
      })
      running = true
      schedule()
    },

    async stop(_reason) {
      if (!running) return
      running = false
      if (timer) clearTimeout(timer)
      timer = null
      try {
        await deps.repo.markEnded(id)
      } catch {
        // 卸载途中写不进去也无妨：那只会让这个会话下次被读成 suspected-abnormal，
        // 属于误报方向 —— spec 早就说了 ended 信号不作为异常与否的唯一依据。
      }
    },

    async mark(kind, detail) {
      if (!id) return
      try {
        await deps.repo.addEvent({ sessionId: id, at: deps.now(), kind, detail, media: null })
      } catch {
        // 同 tick：事件写失败不升级。
      }
    },
  }
}
