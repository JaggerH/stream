import { WebSocketServer } from 'ws'
import type { Server, IncomingMessage } from 'node:http'

/** Minimal client interface so the hub is testable without a real socket. */
export interface WsClient {
  send(data: string): void
}

/** Fan-out hub: the scheduler's onItem broadcasts to every connected frontend. */
export class WsHub {
  private readonly clients = new Set<WsClient>()
  private readonly commandListeners = new Set<(client: WsClient, message: unknown) => void>()

  register(client: WsClient): () => void {
    this.clients.add(client)
    return () => {
      this.clients.delete(client)
    }
  }

  broadcast(message: unknown): void {
    const payload = JSON.stringify(message)
    for (const c of this.clients) {
      try {
        c.send(payload)
      } catch {
        this.clients.delete(c)
      }
    }
  }

  send(client: WsClient, message: unknown): void {
    try {
      client.send(JSON.stringify(message))
    } catch {
      this.clients.delete(client)
    }
  }

  onCommand(listener: (client: WsClient, message: unknown) => void): () => void {
    this.commandListeners.add(listener)
    return () => this.commandListeners.delete(listener)
  }

  receive(client: WsClient, raw: string): void {
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    for (const listener of this.commandListeners) listener(client, message)
  }

  get size(): number {
    return this.clients.size
  }
}

/**
 * Attach a `/ws` endpoint on an existing node http server, feeding the hub.
 * noServer + 自路由：`{ server, path }` 模式下 ws 会对路径不匹配的 upgrade 直接回 400，
 * 同一 server 挂第二个 WSS（/api/ext）时会被本实例抢先拒掉；改为只认领自己的路径，
 * 其余 upgrade 留给其他监听器。
 */
export function attachWs(
  server: Server,
  hub: WsHub,
  /** 与 `/api/*` 同一道门（本机免密、外来要 token）。不传 = 不设门（进程内测试）。
   *  浏览器的 WebSocket 没法自设请求头，所以 token 只能走 `?token=`——前端就是这么带的。 */
  authorize?: (req: IncomingMessage, url: URL) => boolean,
  path = '/ws'
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (url.pathname !== path) return // 不是自己的路径：留给其他 WSS 的 upgrade 监听器
    // fail-closed：这条通道能下发 `login-start` / `enrich.open`（骑着采集会话开标签页），
    // 还会把全部广播（含登录二维码）推给连上来的人。它一直是全场唯一没有门的口。
    if (authorize && !authorize(req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  wss.on('connection', (socket) => {
    const off = hub.register(socket)
    socket.on('message', (data) => hub.receive(socket, data.toString()))
    socket.on('close', off)
    socket.on('error', off)
  })
  return wss
}
