import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { WebSocket } from 'ws'
import { EventSourceRelay, attachEventSourceRelay, EVENT_SOURCE_PROTOCOL } from './relay.ts'
import { encodeFrame, decodeFrame, type Frame } from './protocol.ts'
import { makeDrain } from './drain.ts'
import { wireCookiesFeed } from './cookies-feed.ts'
import type { EventSourceSocket } from './drain.ts'

// 这条测试钉的是 serve.ts 装配后 `/api/event-source` 端点的**握手门**：装配就是把
// `attachEventSourceRelay(server, relay, { token: extToken })` 挂到 HTTP server 的 upgrade 上
// （见 serve.ts 里 attachExtRelay/attachHostRelay 两块旁边的第三块）。serve.ts 那条真实路径
// 会把整个后端（kernel / scheduler / 数据目录 / 端口副作用）都拉起来，单测里没有能起这套 live
// WS server 的既有夹具（src/http/app.*.test.ts 全走 hono 的 app.request，根本不做 WS upgrade）。
// 所以这里用**最忠实的可断言替代**：把 serve.ts 调的那个 `attachEventSourceRelay` 原样挂到一个
// 裸 http.Server 上，发起**真实的 WS upgrade**，断言 token 对→101 握手成功、token 错→401。
// 走的是同一个 attach 函数、同一个 `verifyHostUpgrade` 门，只是省掉了后端 bootstrap 的重壳。

const TOKEN = 'test-es-token'
const started: Server[] = []

afterEach(() => {
  while (started.length) started.pop()?.close()
})

function startServer(token: string): Promise<number> {
  const relay = new EventSourceRelay(
    () => {},
    undefined,
    () => {},
  )
  const server = createServer()
  attachEventSourceRelay(server, relay, { token, log: () => {} })
  started.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })
}

type UpgradeResult = { ok: true } | { ok: false; status: number }

function tryUpgrade(port: number, subprotocols: string[]): Promise<UpgradeResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (r: UpgradeResult | { err: Error }) => {
      if (settled) return
      settled = true
      if ('err' in r) reject(r.err)
      else resolve(r)
    }
    // ws 客户端默认不带 Origin 头 → verifyHostUpgrade 视为原生（非 web）来源，只看 token。
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/event-source`, subprotocols)
    ws.on('open', () => {
      ws.close()
      done({ ok: true })
    })
    ws.on('unexpected-response', (_req, res) => {
      res.resume()
      done({ ok: false, status: res.statusCode ?? 0 })
    })
    ws.on('error', (err) => done({ err }))
  })
}

describe('serve 装配：/api/event-source WS 握手门', () => {
  it('token 对 + 正确子协议 + 无 Origin → 握手成功（101）', async () => {
    const port = await startServer(TOKEN)
    const res = await tryUpgrade(port, [EVENT_SOURCE_PROTOCOL, TOKEN])
    expect(res).toEqual({ ok: true })
  })

  it('token 错 → 拒绝（401），不建立连接', async () => {
    const port = await startServer(TOKEN)
    const res = await tryUpgrade(port, [EVENT_SOURCE_PROTOCOL, 'wrong-token'])
    expect(res).toEqual({ ok: false, status: 401 })
  })
})

// 下面两条钉的是 serve.ts 真实装的那套接线（onEvent → drain、onHello → cookiesFeed.onHello），
// 不是 attachEventSourceRelay 的握手门。原样照搬 serve.ts 里的对象图（Spec 1：
// EVENT_SOURCE_TASK_MAP 是空表，所以每个 event 帧都 mapToTask=null），直接调
// `relay.handleMessage`（纯方法，不需要真实 WebSocket/网络），用一个假 EventSourceSocket 接住
// relay 往外 send 的帧。
describe('serve 装配：接线行为（onEvent→drain、onHello→cookiesFeed）', () => {
  function buildWiring() {
    const sent: string[] = []
    const fakeSock: EventSourceSocket = { send: (raw) => void sent.push(raw) }
    const runTaskNow = vi.fn<(id: string) => Promise<boolean>>().mockResolvedValue(true)
    const cookiesFor = vi.fn(async (d: string) => (d === 'goofish.com' ? [{ name: 'a', value: '1' }] : []))
    const EVENT_SOURCE_TASK_MAP: Record<string, string> = {}
    let cookiesFeed: ReturnType<typeof wireCookiesFeed>
    const relay = new EventSourceRelay(
      (frame, sock) => void drain(frame, sock),
      (hello, _sock) => void cookiesFeed.onHello(hello.domains),
      () => {},
    )
    const drain = makeDrain({
      mapToTask: (ev) => EVENT_SOURCE_TASK_MAP[ev.source] ?? null,
      runTaskNow,
      log: () => {},
    })
    cookiesFeed = wireCookiesFeed(relay, { cookiesFor })
    return { relay, fakeSock, sent, runTaskNow, cookiesFor }
  }

  it('event 帧、source 未映射 → 照 ack，不调 runTaskNow', async () => {
    const { relay, fakeSock, sent, runTaskNow } = buildWiring()
    relay.handleMessage(
      encodeFrame({ t: 'event', id: 'o1', source: 'x', receivedAt: 1, payload: '{}' }),
      fakeSock,
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(runTaskNow).not.toHaveBeenCalled()
    const frames = sent.map((raw) => decodeFrame(raw))
    expect(frames).toContainEqual({ t: 'ack', ids: ['o1'] } satisfies Frame)
  })

  it('hello 帧 → 触发 cookiesFor 并推回 cookies 帧', async () => {
    const { relay, fakeSock, sent, cookiesFor } = buildWiring()
    // sendCookies 走 relay 内部记的 `this.socket`（真实场景由 WS 'connection' 时的 relay.connect()
    // 设置），handleMessage 本身不建立这层关联，所以这里先手动 connect 一次，模拟同一条连接。
    relay.connect(fakeSock)
    relay.handleMessage(encodeFrame({ t: 'hello', source: 'x', domains: ['goofish.com'] }), fakeSock)
    await Promise.resolve()
    await Promise.resolve()
    expect(cookiesFor).toHaveBeenCalledWith('goofish.com')
    const frames = sent.map((raw) => decodeFrame(raw))
    expect(frames).toContainEqual({ t: 'cookies', pairs: 'a=1' } satisfies Frame)
  })
})
