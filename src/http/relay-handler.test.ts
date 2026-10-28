// 两条中继的握手抽成 handler（openspec embeddable-device-gateway 计划 1）：
// `handle(req, socket, head)` 对自己的路径完成握手并返回 true，别人的路径返回 false 且不碰 socket——
// 这样网关才能把它当「可组合的认领函数」用，而 attach* 的原签名（自挂 server）原样保留。
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { EXT_RELAY_PROTOCOL, ExtRelay, extRelayHandler } from './ext-relay.ts'
import { HOST_RELAY_PROTOCOL, hostRelayHandler } from './host-relay.ts'
import { HostRelayRegistry } from './host-registry.ts'

const TOKEN = 't'.repeat(64)
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop'

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

/** 把 handler 挂成 server 的 upgrade 监听器，回它的 handle 以便直接断言返回值。 */
function serveUpgrade<T>(server: Server, handler: { handle: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean }) {
  const verdicts: boolean[] = []
  server.on('upgrade', (req, socket, head) => { verdicts.push(handler.handle(req, socket, head)) })
  return verdicts
}

const wsOpen = (url: string, protocols?: string[], origin?: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, protocols, origin ? { origin } : undefined)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })

describe('extRelayHandler', () => {
  it('own path completes the handshake and returns true; a foreign path returns false and leaves the socket alone', async () => {
    const server = createServer()
    const h = extRelayHandler(new ExtRelay(), { token: TOKEN, log: () => {} })
    expect(h.path).toBe('/api/ext')
    const verdicts = serveUpgrade(server, h)
    // 兜底监听器排在后面：handler 不认领的路径由它收——若 handler 碰了 socket，这里就收不到了。
    server.on('upgrade', (req, socket) => {
      if (new URL(req.url ?? '', 'http://localhost').pathname !== '/api/ext') {
        socket.write('HTTP/1.1 599 Gone Elsewhere\r\nConnection: close\r\n\r\n')
        socket.destroy()
      }
    })
    const port = await listen(server)
    const ws = await wsOpen(`ws://127.0.0.1:${port}/api/ext`, [EXT_RELAY_PROTOCOL, TOKEN], EXT_ORIGIN)
    expect(verdicts).toEqual([true])
    ws.close()
    // 别人的路径：真的发一个 upgrade 过去。handle 返回 false，socket 落到兜底监听器拿到 599。
    const status = await new Promise<number>((resolve, reject) => {
      const bad = new WebSocket(`ws://127.0.0.1:${port}/other`)
      bad.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      bad.on('error', () => resolve(-1))
      setTimeout(() => reject(new Error('foreign upgrade was not left for the next listener')), 2000)
    })
    expect(status).toBe(599)
    expect(verdicts).toEqual([true, false])
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('a custom path changes what handle claims', async () => {
    const server = createServer()
    const h = extRelayHandler(new ExtRelay(), { token: TOKEN, path: '/api/stream/ext', log: () => {} })
    expect(h.path).toBe('/api/stream/ext')
    serveUpgrade(server, h)
    const port = await listen(server)
    const ws = await wsOpen(`ws://127.0.0.1:${port}/api/stream/ext`, [EXT_RELAY_PROTOCOL, TOKEN], EXT_ORIGIN)
    ws.close()
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})

describe('hostRelayHandler', () => {
  it('own path completes the handshake and returns true; a foreign path returns false and leaves the socket alone', async () => {
    const server = createServer()
    const h = hostRelayHandler(new HostRelayRegistry(), { token: TOKEN, log: () => {} })
    expect(h.path).toBe('/api/host')
    const verdicts = serveUpgrade(server, h)
    server.on('upgrade', (req, socket) => {
      if (new URL(req.url ?? '', 'http://localhost').pathname !== '/api/host') {
        socket.write('HTTP/1.1 599 Gone Elsewhere\r\nConnection: close\r\n\r\n')
        socket.destroy()
      }
    })
    const port = await listen(server)
    const ws = await wsOpen(`ws://127.0.0.1:${port}/api/host`, [HOST_RELAY_PROTOCOL, TOKEN])
    expect(verdicts).toEqual([true])
    ws.close()
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})
