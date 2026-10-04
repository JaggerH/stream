/**
 * host-agent 子进程的生命周期：起、崩了退避重启、dispose 收掉。
 *
 * 这套逻辑原本住在 Tauri 桌面壳里（`app/src-tauri/src/lib.rs` 的 `spawn_host_agent`），
 * 搬过来时保持行为逐字一致——退避的数、三个环境变量、以及「本进程没了 agent 自己退」。
 *
 * 全部依赖经 `AgentDeps` 注入，所以退避与重启能在没有真进程、没有真时钟的情况下被测到。
 */

/** 本次要起的那个 agent。 */
export interface AgentProcess {
  kill(): void
  /** 子进程退出时回调（正常退出与崩溃不分——两者的处置一样：重来）。 */
  onExit(cb: () => void): void
}

export interface AgentDeps {
  spawn(bin: string, env: Record<string, string>): AgentProcess
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** 单调时钟（毫秒）——只用于判断「这次实例活了多久」。 */
  now(): number
  log(msg: string): void
}

export interface AgentOptions {
  /** host-agent 可执行文件的绝对路径。 */
  binPath: string
  /** relay 的 ws 地址。 */
  wsUrl: string
  /** Stream 的 data 目录；agent 据此自己读 relay token（token 不经我们的手）。 */
  dataDir: string
}

/** 活多久算「跑起来过」——超过它再崩，退避从头算。 */
const HEALTHY_UPTIME_MS = 30_000

/** stderr 转发的行数上限。**实话**：`index.ts` 的 `defaultDeps()` 每次 `spawn` 都会
 *  `stderrLineCapper()` 一个新实例，所以这条帽子封的是「每次重启 20 行」，不是「总量 20 行」。
 *  一次崩溃循环会不断触发帽子被重置，但退避（见 {@link backoffMs}）把重启频率兜在最坏约
 *  2 行/秒（500ms 一次 × 每次至多 1-3 行诊断），日志量在可接受范围——只是别信这条注释以外
 *  「防止灌爆」四个字的字面意思。20 行足够看清一次诊断（`datadir.rs` 那句「找不到
 *  ext-relay-token」通常 1-3 行）。 */
const STDERR_LOG_CAP = 20

/** 半行缓冲（还没等到换行的那一截）的长度上限。永不换行的畸形/异常输出（例如 agent 把
 *  二进制垃圾错当 stderr 文本吐出来）本可以让这个缓冲无界增长——超过上限就只留末尾一段，
 *  代价是丢一点前文，换来的是内存有界。 */
const MAX_PARTIAL_LINE_LEN = 8192

/**
 * 累积 stderr 的原始 chunk、按行拆分、超过 {@link STDERR_LOG_CAP} 行后不再产出新行。
 *
 * 唯一说得出真因的那句诊断（agent 读不到 relay token时）写在 stderr 上，过去被
 * `stdio: 'ignore'` 整段丢弃——这个函数是把它接回来的那一半，纯状态机、不碰真实的流，
 * 所以「封顶」这条不变量能在没有真进程的情况下被测到。真正接到 `child.stderr` 上的那半
 * 在 `index.ts` 的 `defaultDeps()` 里。
 */
export function stderrLineCapper(maxLines: number = STDERR_LOG_CAP) {
  let emitted = 0
  let buf = ''
  return {
    /** 喂一段 chunk，返回这次新拆出的、还没超帽的完整行（不含尾部不完整的半行）。 */
    push(chunk: string): string[] {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop() ?? '' // 最后一段可能是还没收全的半行，留到下次
      if (buf.length > MAX_PARTIAL_LINE_LEN) buf = buf.slice(-MAX_PARTIAL_LINE_LEN)
      const out: string[] = []
      for (const line of lines) {
        if (emitted >= maxLines) break
        if (line.trim() === '') continue
        out.push(line)
        emitted += 1
      }
      return out
    },
  }
}

/**
 * 把 Stream 后端那扇门的 http(s) 地址换算成 relay 的 ws(s) 地址。
 * @param streamBaseUrl - 例如 `http://127.0.0.1:8900`。
 * @returns 例如 `ws://127.0.0.1:8900/api/host`。
 */
export function hostWsUrl(streamBaseUrl: string): string {
  const u = new URL('/api/host', streamBaseUrl)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  return u.toString()
}

/**
 * 有界指数退避：500ms 起倍增、封顶 10s。`attempt` 先夹到 5 防溢出（2^5*500 已经过顶，
 * 夹不夹结果一样，只是防呆）。
 * @param attempt - 从 0 开始的重启次数。
 * @returns 毫秒。
 */
export function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** Math.min(attempt, 5), 10_000)
}

/**
 * 起 agent 并一直看着它。
 * @param deps - 注入的进程 / 定时器 / 时钟 / 日志。
 * @param opts - 二进制路径 + 连哪 + data 目录。
 * @returns dispose：杀子进程、取消待跑的重启，且此后不再 spawn。
 */
export function startAgent(deps: AgentDeps, opts: AgentOptions): () => void {
  let disposed = false
  let attempt = 0
  let current: AgentProcess | undefined
  let timer: unknown

  const launch = (): void => {
    if (disposed) return
    const startedAt = deps.now()
    // token 刻意不传：agent 自己从 STREAM_DATA_DIR 读，少一个持有秘密的中间人。
    // PARENT_WATCH 让 agent 在本进程消失时自己退——没有它，强杀/崩溃留下的孤儿会在
    // 下次启动时变成两个 agent 抢同一条中继（活体撞到过）。
    current = deps.spawn(opts.binPath, {
      STREAM_HOST_URL: opts.wsUrl,
      STREAM_DATA_DIR: opts.dataDir,
      STREAM_HOST_PARENT_WATCH: '1',
    })
    current.onExit(() => {
      current = undefined
      if (disposed) return
      // 跑够久再崩，说明上一次是起来过的，退避从头算——否则一个健康跑了很久的 agent
      // 崩一次就要等封顶的 10s。
      if (deps.now() - startedAt >= HEALTHY_UPTIME_MS) attempt = 0
      const wait = backoffMs(attempt)
      attempt += 1
      deps.log(`host-agent 退出了，${wait}ms 后重试（第 ${attempt} 次）`)
      timer = deps.setTimer(launch, wait)
    })
  }

  launch()

  return () => {
    disposed = true
    if (timer !== undefined) deps.clearTimer(timer)
    current?.kill()
    current = undefined
  }
}
