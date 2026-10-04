import type { Server } from 'node:http'
import { WebSocketServer } from 'ws'
import { verifyHostUpgrade } from '../http/host-relay.ts'
import { decodeFrame, encodeFrame, type EventFrame, type HelloFrame } from './protocol.ts'
import type { EventSourceSocket } from './drain.ts'

export const EVENT_SOURCE_PROTOCOL = 'event-source.v1'

export class EventSourceRelay {
  private socket: EventSourceSocket | undefined
  constructor(
    private onEvent: (f: EventFrame, s: EventSourceSocket) => void,
    private onHello?: (f: HelloFrame, s: EventSourceSocket) => void,
    private log: (l: string) => void = console.log,
  ) {}

  connect(s: EventSourceSocket): void {
    this.socket = s // 单连接：新连接顶掉旧的（子进程单例，见 Task 5 锁）
  }
  disconnect(s: EventSourceSocket): void {
    if (this.socket === s) this.socket = undefined
  }
  handleMessage(raw: string, s: EventSourceSocket): void {
    let f
    try {
      f = decodeFrame(raw)
    } catch (e) {
      this.log(`[event-source] 丢弃坏帧：${(e as Error).message}`)
      return
    }
    if (f.t === 'event') this.onEvent(f, s)
    else if (f.t === 'hello') this.onHello?.(f, s)
  }
  /** 后端主动把 cookie 快照推给子进程（Task 6 调）。 */
  sendCookies(pairs: string): void {
    this.socket?.send(encodeFrame({ t: 'cookies', pairs }))
  }
}

export function attachEventSourceRelay(
  server: Server,
  relay: EventSourceRelay,
  opts: { token: string; path?: string; log?: (line: string) => void },
): WebSocketServer {
  const { token, path = '/api/event-source', log = console.log } = opts
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols: Set<string>) =>
      protocols.has(EVENT_SOURCE_PROTOCOL) ? EVENT_SOURCE_PROTOCOL : false,
  })
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '', 'http://localhost').pathname
    if (pathname !== path) return
    const ok = verifyHostUpgrade(
      { origin: req.headers.origin, protocolHeader: req.headers['sec-websocket-protocol'] },
      token,
      EVENT_SOURCE_PROTOCOL,
    )
    if (!ok) {
      log(`[event-source] rejected upgrade (origin=${req.headers.origin ?? '<none>'})`)
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  wss.on('connection', (ws) => {
    const s: EventSourceSocket = { send: (raw) => ws.send(raw) }
    relay.connect(s)
    const ping = setInterval(() => {
      try {
        ws.ping()
      } catch {
        /* ping throws once closed; close handler cleans up */
      }
    }, 20_000)
    ws.on('message', (data: Buffer) => relay.handleMessage(data.toString(), s))
    const teardown = () => {
      clearInterval(ping)
      relay.disconnect(s)
    }
    ws.on('close', teardown)
    ws.on('error', teardown)
  })
  return wss
}
