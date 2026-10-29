/**
 * 一条到 Chromium 的 CDP 连接（浏览器级 WebSocket）。
 *
 * 只做三件事：**发命令、收事件、断线说一声**。标签、会话、认领集合这些语义住在 `ops.ts`——
 * 把 CDP 的形状（`{id, method, params}` / `{id, result|error}` / `{method, params, sessionId}`）
 * 关在这一层里，上面那层才照着扩展中继的命令来写，而不是照着 CDP 的。
 *
 * 地址从 HTTP 发现端点取：`GET <cdp>/json/version` → `webSocketDebuggerUrl`。这是 Chrome 的
 * 标准发现口，`--remote-debugging-port=0` 时端口也在这里报出来（浏览器把实际端口写进
 * `DevToolsActivePort`，HTTP 口上问得到的就是它）。
 */
import WebSocket from 'ws'

export interface CdpEvent {
  /** 有值 = 来自某个 page 会话（flatten 模式）；浏览器级事件没有。 */
  sessionId?: string
  method: string
  params: unknown
}

/** 命令没回执。**不继承任何"环境不可用"类型**：这是 CDP 自己挂了，调用方要如实报失败。 */
export class CdpTimeout extends Error {
  constructor(method: string, ms: number) {
    super(`CDP 命令 ${method} 等满 ${ms}ms 没有回执`)
    this.name = 'CdpTimeout'
  }
}

export class CdpDisconnected extends Error {
  constructor() {
    super('CDP 连接已断开')
    this.name = 'CdpDisconnected'
  }
}

interface Pending {
  method: string
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

export interface CdpConnectOptions {
  /** 单条命令的上界，缺省 30s（与中继那道闸同一个数，免得一侧先死另一侧还等着）。 */
  commandTimeoutMs?: number
  /** 发现端点 + WS 握手的总上界，缺省 5s。 */
  connectTimeoutMs?: number
  /** 测试缝。 */
  fetchImpl?: typeof fetch
  WebSocketImpl?: typeof WebSocket
}

export class CdpConnection {
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private readonly eventListeners = new Set<(e: CdpEvent) => void>()
  private readonly closeListeners = new Set<() => void>()
  private closedFlag = false
  private readonly commandTimeoutMs: number

  private constructor(
    private readonly ws: WebSocket,
    opts: CdpConnectOptions,
  ) {
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 30_000
    ws.on('message', (data) => this.handleMessage(String(data)))
    ws.on('close', () => this.markClosed())
    ws.on('error', () => this.markClosed())
  }

  static async connect(httpUrl: string, opts: CdpConnectOptions = {}): Promise<CdpConnection> {
    const f = opts.fetchImpl ?? fetch
    const wsUrl = await discover(httpUrl, f, opts.connectTimeoutMs ?? 5_000)
    const Impl = opts.WebSocketImpl ?? WebSocket
    const ws = new Impl(wsUrl)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        try {
          ws.terminate()
        } catch {
          /* 已经死了 */
        }
        reject(new Error(`连不上 CDP：${wsUrl} 在 ${opts.connectTimeoutMs ?? 5_000}ms 内没有完成握手`))
      }, opts.connectTimeoutMs ?? 5_000)
      const cleanup = () => {
        clearTimeout(timer)
        ws.off('open', onOpen)
        ws.off('error', onError)
      }
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = (e: Error) => {
        cleanup()
        reject(new Error(`连不上 CDP：${wsUrl} —— ${e.message}`))
      }
      ws.once('open', onOpen)
      ws.once('error', onError)
    })
    return new CdpConnection(ws, opts)
  }

  get closed(): boolean {
    return this.closedFlag
  }

  /** 发一条命令。`sessionId` 有值 = 打给某个 page / OOPIF 会话。 */
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any> {
    if (this.closedFlag) return Promise.reject(new CdpDisconnected())
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpTimeout(method, this.commandTimeoutMs))
      }, this.commandTimeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}), ...(sessionId ? { sessionId } : {}) }))
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new CdpDisconnected())
        void e
      }
    })
  }

  onEvent(fn: (e: CdpEvent) => void): () => void {
    this.eventListeners.add(fn)
    return () => this.eventListeners.delete(fn)
  }

  /** 连接断了（浏览器退出 / 被杀 / 网络断）时叫一次。 */
  onClose(fn: () => void): () => void {
    this.closeListeners.add(fn)
    return () => this.closeListeners.delete(fn)
  }

  close(): void {
    if (this.closedFlag) return
    try {
      this.ws.terminate()
    } catch {
      /* 已经死了 */
    }
    this.markClosed()
  }

  private handleMessage(raw: string): void {
    let msg: { id?: number; method?: string; params?: unknown; sessionId?: string; result?: unknown; error?: { message?: string } }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'))
      else p.resolve(msg.result)
      return
    }
    if (typeof msg.method === 'string') {
      const event: CdpEvent = {
        method: msg.method,
        params: msg.params,
        ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
      }
      for (const fn of this.eventListeners) {
        try {
          fn(event)
        } catch {
          /* 听众的问题不是连接的问题 */
        }
      }
    }
  }

  private markClosed(): void {
    if (this.closedFlag) return
    this.closedFlag = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new CdpDisconnected())
    }
    this.pending.clear()
    for (const fn of this.closeListeners) {
      try {
        fn()
      } catch {
        /* 同上 */
      }
    }
  }
}

/** `GET <cdp>/json/version` → 浏览器级 WS 地址。端口 0 时浏览器实际用的端口也在这里。 */
async function discover(httpUrl: string, f: typeof fetch, timeoutMs: number): Promise<string> {
  const url = new URL(httpUrl)
  const path = url.pathname.replace(/\/+$/, '')
  const endpoint = `${url.origin}${path}/json/version`
  let res: Response
  try {
    res = await f(endpoint, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw new Error(`CDP 发现端点连不上（${endpoint}）：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) throw new Error(`CDP 发现端点回了 HTTP ${res.status}（${endpoint}）`)
  const body = (await res.json().catch(() => null)) as { webSocketDebuggerUrl?: unknown } | null
  if (!body || typeof body.webSocketDebuggerUrl !== 'string') {
    throw new Error(`CDP 发现端点的应答里没有 webSocketDebuggerUrl（${endpoint}）`)
  }
  return body.webSocketDebuggerUrl
}
