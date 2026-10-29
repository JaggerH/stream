/**
 * CDP 绑定的生命周期：配对 → verify → 连中继 → 收命令 / 发事件，断了按各自的规矩重连。
 *
 * 这里**不碰真浏览器**：CDP 那一侧是一个只认 `Target.*` 几条命令的假 WS 服务，中继那一侧是一个
 * 按真实规则签 proof 的假服务端。这样每条失联路径（中继断、CDP 断、撤销、token 被拷走、对端
 * 冻住）都能单独、确定地走到——真浏览器那几条在 `ops.test.ts` 与 `e2e.test.ts` 里。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { startCdpBinding, type CdpBinding } from './binding.ts'
import { RELAY_PROTOCOL, EXT_ORIGIN } from './pairing.ts'
import { readCdpBindingState, writeCdpBindingState } from './state.ts'
import { VERIFY_PREFIX } from '../../shared/browser-relay/wire.ts'

const TOKEN = 'b'.repeat(64)
const BINDING = 'ext:binding-test'
const expectedProof = (token: string, nonce: string) =>
  createHmac('sha256', createHash('sha256').update(token).digest('hex')).update(`${VERIFY_PREFIX}${nonce}`).digest('hex')

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 假的 Chromium：发现端点 + 浏览器级 WS，只答 `Target.*` 的几条。 */
async function fakeCdp() {
  let wss!: WebSocketServer
  const conns = new Set<WebSocket>()
  const server: Server = createServer((req, res) => {
    if (req.url === '/json/version') {
      const port = (server.address() as AddressInfo).port
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  wss = new WebSocketServer({ server, path: '/devtools/browser/fake' })
  wss.on('connection', (ws) => {
    conns.add(ws)
    ws.on('close', () => conns.delete(ws))
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { id?: number; method?: string }
      if (typeof msg.id !== 'number') return
      const result = msg.method === 'Target.getTargets' ? { targetInfos: [] } : {}
      ws.send(JSON.stringify({ id: msg.id, result }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    connections: () => conns.size,
    /** 模拟浏览器退出：所有 CDP 连接一起断掉。 */
    drop: () => {
      for (const ws of conns) ws.terminate()
    },
    close: async () => {
      for (const ws of conns) ws.terminate()
      wss.close()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}

/** 假的 Stream：配对 / verify 按真实规则办事，`/api/ext` 收命令回回执。 */
async function fakeRelay(opts: { freeze?: boolean } = {}) {
  const pairs: Array<{ origin?: string; code?: unknown }> = []
  const verifies: Array<{ origin?: string; binding?: unknown }> = []
  const conns: WebSocket[] = []
  const tokens: Array<string | undefined> = []
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {}
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    // 与服务端同一道门：只认扩展的 Origin
    if (req.headers.origin !== EXT_ORIGIN) return json(403, { error: 'forbidden origin' })
    if (req.url === '/api/ext/pair') {
      pairs.push({ origin: req.headers.origin, code: body.code })
      if (body.code !== '123456') return json(403, { error: 'bad code' })
      return json(200, { bindingId: BINDING, token: TOKEN, deviceId: 'dev_1' })
    }
    if (req.url === '/api/ext/verify') {
      verifies.push({ origin: req.headers.origin, binding: body.binding })
      if (body.binding !== BINDING) return json(403, { error: 'unknown binding' })
      return json(200, { proof: expectedProof(TOKEN, String(body.nonce)), protocol: RELAY_PROTOCOL })
    }
    json(404, {})
  })
  const wss = new WebSocketServer({ server, path: '/api/ext' })
  wss.on('connection', (ws, req) => {
    conns.push(ws)
    tokens.push(req.headers['sec-websocket-protocol']?.split(',')[1]?.trim())
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { id?: number }
      if (typeof msg.id !== 'number') return
      ws.send(JSON.stringify({ id: msg.id, result: { tabs: [] }, swMs: 1 }))
    })
    if (opts.freeze) (ws as unknown as { _socket: { pause(): void } })._socket.pause()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    pairs,
    verifies,
    tokens,
    connections: () => conns.length,
    last: () => conns[conns.length - 1],
    closeWith: (code: number) => conns[conns.length - 1]?.close(code),
    close: async () => {
      for (const ws of conns) ws.terminate()
      wss.close()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}

const bindings: CdpBinding[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const b of bindings.splice(0)) await b.close().catch(() => {})
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function stateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stream-cdp-binding-'))
  dirs.push(dir)
  return join(dir, 'state.json')
}

describe('CDP 绑定的生命周期', () => {
  it('首次：用一次性码配对 → 写状态文件 → verify → 连中继 → 命令往返', async () => {
    const cdp = await fakeCdp()
    const relay = await fakeRelay()
    try {
      const file = stateFile()
      const b = await startCdpBinding({
        cdpUrl: cdp.url,
        serverUrl: relay.url,
        stateFile: file,
        readPairingCode: async () => '123456',
        log: () => {},
        reconnectMs: 20,
        cdpRetryMs: 20,
      })
      bindings.push(b)
      expect(b.bindingId).toBe(BINDING)

      // 配对：带的是扩展 Origin（服务端那两口只认它）
      expect(relay.pairs).toEqual([{ origin: EXT_ORIGIN, code: '123456' }])
      // 状态文件：token 与 nodeId（+ 非机密的 bindingId），0600
      const state = readCdpBindingState(file)!
      expect(state.token).toBe(TOKEN)
      expect(state.nodeId).toMatch(/^node_/)
      // 中继连上了，握手子协议是 [协议名, token]
      await vi.waitFor(() => expect(relay.connections()).toBe(1))
      expect(relay.tokens[0]).toBe(TOKEN)
      expect(b.online).toBe(true)

      // 中继推一条命令：绑定的 ops 收到、处理、把回执发回来
      const reply = await new Promise<Record<string, unknown>>((resolve) => {
        relay.last()!.once('message', (d) => resolve(JSON.parse(String(d)) as Record<string, unknown>))
        relay.last()!.send(JSON.stringify({ id: 7, op: 'list' }))
      })
      expect(reply).toMatchObject({ id: 7, result: { tabs: [] } })

      // 对端自证用的是状态文件里那把 token 对应的绑定
      expect(relay.verifies.at(-1)?.binding).toBe(BINDING)
    } finally {
      await relay.close()
      await cdp.close()
    }
  })

  it('重启：有状态文件就不再要配对码（一次都不问），照样先 verify', async () => {
    const cdp = await fakeCdp()
    const relay = await fakeRelay()
    try {
      const file = stateFile()
      writeCdpBindingState(file, { token: TOKEN, nodeId: 'node_11111111-2222-4333-8444-555555555555', bindingId: BINDING })
      const ask = vi.fn(async () => {
        throw new Error('不该问配对码')
      })
      const b = await startCdpBinding({
        cdpUrl: cdp.url,
        serverUrl: relay.url,
        stateFile: file,
        readPairingCode: ask,
        log: () => {},
        reconnectMs: 20,
        cdpRetryMs: 20,
      })
      bindings.push(b)
      await vi.waitFor(() => expect(relay.connections()).toBe(1))
      expect(ask).not.toHaveBeenCalled()
      expect(relay.pairs).toHaveLength(0)
      expect(relay.verifies).toHaveLength(1)
    } finally {
      await relay.close()
      await cdp.close()
    }
  })

  it('没有状态文件又没给配对码读取方式 → 起不来（不是悄悄连一个没配对的 token）', async () => {
    await expect(
      startCdpBinding({ serverUrl: 'http://127.0.0.1:1', stateFile: stateFile(), log: () => {} }),
    ).rejects.toThrow(/没有可用的状态文件/)
    await expect(
      startCdpBinding({ serverUrl: 'http://127.0.0.1:1', stateFile: stateFile(), readPairingCode: async () => '  ', log: () => {} }),
    ).rejects.toThrow(/没有读到配对码/)
  })

  it('非回环的 CDP 地址 → 拒绝启动', async () => {
    await expect(
      startCdpBinding({
        cdpUrl: 'http://192.168.1.9:9222',
        serverUrl: 'http://127.0.0.1:1',
        stateFile: stateFile(),
        readPairingCode: async () => '123456',
        log: () => {},
      }),
    ).rejects.toThrow(/只许回环/)
  })

  it('被撤销（4003）：终态，不再重连，done 兑现', async () => {
    const cdp = await fakeCdp()
    const relay = await fakeRelay()
    try {
      const file = stateFile()
      writeCdpBindingState(file, { token: TOKEN, nodeId: 'node_11111111-2222-4333-8444-555555555555', bindingId: BINDING })
      const b = await startCdpBinding({ cdpUrl: cdp.url, serverUrl: relay.url, stateFile: file, log: () => {}, reconnectMs: 20, cdpRetryMs: 20 })
      bindings.push(b)
      await vi.waitFor(() => expect(relay.connections()).toBe(1))
      relay.closeWith(4003)
      await Promise.race([b.done, sleep(2_000).then(() => Promise.reject(new Error('done 没有兑现')))])
      expect(b.online).toBe(false)
      await sleep(200)
      expect(relay.connections()).toBe(1) // 没有第二次连接
    } finally {
      await relay.close()
      await cdp.close()
    }
  })

  it('token 被拷到别的节点（4004）：同样终态', async () => {
    const cdp = await fakeCdp()
    const relay = await fakeRelay()
    try {
      const file = stateFile()
      writeCdpBindingState(file, { token: TOKEN, nodeId: 'node_11111111-2222-4333-8444-555555555555', bindingId: BINDING })
      const b = await startCdpBinding({ cdpUrl: cdp.url, serverUrl: relay.url, stateFile: file, log: () => {}, reconnectMs: 20, cdpRetryMs: 20 })
      bindings.push(b)
      await vi.waitFor(() => expect(relay.connections()).toBe(1))
      relay.closeWith(4004)
      await Promise.race([b.done, sleep(2_000).then(() => Promise.reject(new Error('done 没有兑现')))])
      await sleep(200)
      expect(relay.connections()).toBe(1)
    } finally {
      await relay.close()
      await cdp.close()
    }
  })

  it('中继普通断线 → 退避重连（每次都重新 verify）', async () => {
    const cdp = await fakeCdp()
    const relay = await fakeRelay()
    try {
      const file = stateFile()
      writeCdpBindingState(file, { token: TOKEN, nodeId: 'node_11111111-2222-4333-8444-555555555555', bindingId: BINDING })
      const b = await startCdpBinding({ cdpUrl: cdp.url, serverUrl: relay.url, stateFile: file, log: () => {}, reconnectMs: 20, maxReconnectMs: 100, cdpRetryMs: 20 })
      bindings.push(b)
      await vi.waitFor(() => expect(relay.connections()).toBe(1))
      relay.last()!.terminate() // 服务端毫无征兆地消失（客户端看到 1006）
      await vi.waitFor(() => expect(relay.connections()).toBe(2))
      expect(relay.verifies.length).toBe(2)
      expect(b.online).toBe(true)
    } finally {
      await relay.close()
      await cdp.close()
    }
  })

  it('对端冻住（不回 pong）→ 按心跳判死，断开重连', async () => {
    const cdp = await fakeCdp()
    const relay = await fakeRelay({ freeze: true })
    try {
      const file = stateFile()
      writeCdpBindingState(file, { token: TOKEN, nodeId: 'node_11111111-2222-4333-8444-555555555555', bindingId: BINDING })
      const b = await startCdpBinding({
        cdpUrl: cdp.url,
        serverUrl: relay.url,
        stateFile: file,
        log: () => {},
        reconnectMs: 20,
        maxReconnectMs: 100,
        cdpRetryMs: 20,
        pingIntervalMs: 40,
      })
      bindings.push(b)
      // 冻住的连接不回 pong，也没有任何帧：两个心跳周期内判死 → 再连一次（新连接同样冻住）
      await vi.waitFor(() => expect(relay.connections()).toBeGreaterThanOrEqual(2), { timeout: 3_000 })
    } finally {
      await relay.close()
      await cdp.close()
    }
  })

  it('浏览器没了（CDP 断）→ 中继一并断开（服务端据此判离线）；CDP 回来就重新连上', async () => {
    const cdp = await fakeCdp()
    const relay = await fakeRelay()
    try {
      const file = stateFile()
      writeCdpBindingState(file, { token: TOKEN, nodeId: 'node_11111111-2222-4333-8444-555555555555', bindingId: BINDING })
      const b = await startCdpBinding({ cdpUrl: cdp.url, serverUrl: relay.url, stateFile: file, log: () => {}, reconnectMs: 20, cdpRetryMs: 300 })
      bindings.push(b)
      await vi.waitFor(() => expect(relay.connections()).toBe(1))
      const first = relay.last()!
      // 浏览器退出：CDP 连接断掉，绑定必须主动断开中继（而不是留一条对着死浏览器的连接）
      cdp.drop()
      await vi.waitFor(() => expect(first.readyState).toBe(WebSocket.CLOSED))
      expect(b.online).toBe(false)
      // 浏览器回来（假 CDP 还在听）→ 重新连 CDP、verify、连中继
      await vi.waitFor(() => expect(relay.connections()).toBe(2), { timeout: 5_000 })
      expect(cdp.connections()).toBe(1)
      expect(b.online).toBe(true)
    } finally {
      await relay.close()
      await cdp.close()
    }
  })

  it('close()：断中继、断 CDP、done 兑现；重复调用不炸', async () => {
    const cdp = await fakeCdp()
    const relay = await fakeRelay()
    try {
      const file = stateFile()
      writeCdpBindingState(file, { token: TOKEN, nodeId: 'node_11111111-2222-4333-8444-555555555555', bindingId: BINDING })
      const b = await startCdpBinding({ cdpUrl: cdp.url, serverUrl: relay.url, stateFile: file, log: () => {}, reconnectMs: 20, cdpRetryMs: 20 })
      await vi.waitFor(() => expect(relay.connections()).toBe(1))
      await b.close()
      await b.close()
      expect(b.online).toBe(false)
      await vi.waitFor(() => expect(relay.last()!.readyState).toBe(WebSocket.CLOSED))
      // CDP 那一侧的关闭事件是异步的：等它落地再断言，别和全量并行下的调度抢时间
      await vi.waitFor(() => expect(cdp.connections()).toBe(0))
    } finally {
      await relay.close()
      await cdp.close()
    }
  })

  it('日志里没有 token 与配对码', async () => {
    const cdp = await fakeCdp()
    const relay = await fakeRelay()
    try {
      const lines: string[] = []
      const b = await startCdpBinding({
        cdpUrl: cdp.url,
        serverUrl: relay.url,
        stateFile: stateFile(),
        readPairingCode: async () => '123456',
        log: (l) => lines.push(l),
        reconnectMs: 20,
        cdpRetryMs: 20,
      })
      await vi.waitFor(() => expect(relay.connections()).toBe(1))
      await b.close()
      const all = lines.join('\n')
      expect(all).not.toContain(TOKEN)
      expect(all).not.toContain('123456')
      // 但生命周期看得见（排查时要能知道它走到哪一步了）
      expect(all).toContain('配对完成')
      expect(all).toContain('中继已连上')
    } finally {
      await relay.close()
      await cdp.close()
    }
  })
})
