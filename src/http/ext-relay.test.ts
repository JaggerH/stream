import { describe, it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { ExtRelay, ExtRelayDisconnected, ExtRelayTimeout, attachExtRelay, verifyExtUpgrade, EXT_RELAY_PROTOCOL, type ExtSocket } from './ext-relay.ts'

function fakeSocket() {
  const sent: any[] = []
  const sock: ExtSocket = { send: (d) => sent.push(JSON.parse(d)) }
  return { sock, sent }
}

describe('ExtRelay connection state', () => {
  it('connected reflects the live socket lifecycle', () => {
    const relay = new ExtRelay()
    const { sock } = fakeSocket()
    expect(relay.connected).toBe(false)
    relay.connect(sock)
    expect(relay.connected).toBe(true)
    relay.disconnect(sock)
    expect(relay.connected).toBe(false)
  })

  it('status() 未连时 {connected:false, since:null}，连上后 since 是建立时刻', () => {
    const relay = new ExtRelay()
    const { sock } = fakeSocket()
    expect(relay.status()).toEqual({ connected: false, since: null })
    const before = Date.now()
    relay.connect(sock)
    const s = relay.status()
    expect(s.connected).toBe(true)
    expect(s.since).not.toBeNull()
    const since = Date.parse(s.since as string)
    expect(since).toBeGreaterThanOrEqual(before - 1000)
    expect(since).toBeLessThanOrEqual(Date.now() + 1000)
    relay.disconnect(sock)
    expect(relay.status()).toEqual({ connected: false, since: null })
  })

  it('新连接顶替旧连接时 since 跟着刷新（报的是当前这条连接的年龄）', async () => {
    const relay = new ExtRelay()
    const a: ExtSocket = { send: () => {} }
    const b: ExtSocket = { send: () => {} }
    relay.connect(a)
    const first = relay.status().since
    await new Promise((r) => setTimeout(r, 5))
    relay.connect(b)
    const second = relay.status().since
    expect(second).not.toBeNull()
    expect(Date.parse(second as string)).toBeGreaterThanOrEqual(Date.parse(first as string))
    // 被顶替的旧 socket 关闭不能把现状抹成未连
    relay.disconnect(a)
    expect(relay.status()).toMatchObject({ connected: true, since: second })
  })
})

describe('attachExtRelay 连接可观测性', () => {
  const TOKEN = 'c'.repeat(64)
  const ORIGIN = 'chrome-extension://abcdefghijklmnop'

  it('连接建立和断开各打一行日志（含 origin）', async () => {
    const lines: string[] = []
    const relay = new ExtRelay()
    const server = createServer()
    attachExtRelay(server, relay, { token: TOKEN, log: (l) => lines.push(l) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ext`, [EXT_RELAY_PROTOCOL, TOKEN], { origin: ORIGIN })
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve())
        ws.on('error', reject)
      })
      expect(relay.connected).toBe(true)
      const connectLine = lines.find((l) => /connected/i.test(l) && !/disconnected/i.test(l))
      expect(connectLine, `connect log missing, got ${JSON.stringify(lines)}`).toBeDefined()
      expect(connectLine).toContain('[ext-relay]')
      expect(connectLine).toContain(ORIGIN)

      ws.close()
      await vi.waitFor(() => expect(relay.connected).toBe(false))
      await vi.waitFor(() => {
        const closed = lines.filter((l) => /disconnected/i.test(l))
        expect(closed, `disconnect log missing, got ${JSON.stringify(lines)}`).toHaveLength(1)
        expect(closed[0]).toContain('[ext-relay]')
        expect(closed[0]).toContain(ORIGIN)
      })
    } finally {
      ws.terminate()
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('ExtRelay → 能力缓存', () => {
  function sink() {
    const seen: Array<Record<string, unknown> | undefined> = []
    return { seen, markSeen: (info?: Record<string, unknown>) => seen.push(info) }
  }

  it('connect() 是唯一写入点：连上记一笔，断开什么都不写（everSeen 不回退）', () => {
    const cap = sink()
    const relay = new ExtRelay({ capability: cap })
    const { sock } = fakeSocket()
    relay.connect(sock, { extVersion: '0.4.1' })
    expect(cap.seen).toEqual([{ extVersion: '0.4.1' }])
    relay.disconnect(sock)
    expect(cap.seen).toHaveLength(1)
  })

  it('老版本扩展不自报字段 → 照常记账，不报错', () => {
    const cap = sink()
    const relay = new ExtRelay({ capability: cap })
    const { sock } = fakeSocket()
    expect(() => relay.connect(sock)).not.toThrow()
    expect(cap.seen).toEqual([undefined])
    expect(relay.connected).toBe(true)
  })

  it('缓存写爆了也不影响 relay —— 诊断缓存没资格掀翻一条能用的连接', () => {
    const relay = new ExtRelay({
      capability: { markSeen: () => { throw new Error('disk full') } },
    })
    const { sock } = fakeSocket()
    expect(() => relay.connect(sock)).not.toThrow()
    expect(relay.connected).toBe(true)
  })

  it('attachExtRelay 把升级请求 query 里的自报字段喂进缓存', async () => {
    const TOKEN = 'd'.repeat(64)
    const cap = sink()
    const relay = new ExtRelay({ capability: cap })
    const server = createServer()
    attachExtRelay(server, relay, { token: TOKEN, log: () => {} })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/ext?extVersion=0.4.1&browser=Chrome%2F131&platform=win`,
      [EXT_RELAY_PROTOCOL, TOKEN],
      { origin: 'chrome-extension://abcdefghijklmnop' },
    )
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve())
        ws.on('error', reject)
      })
      expect(cap.seen).toEqual([{ extVersion: '0.4.1', browser: 'Chrome/131', platform: 'win' }])
    } finally {
      ws.terminate()
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('ExtRelay id pairing', () => {
  it('sendCommand resolves with the result matched by id', async () => {
    const relay = new ExtRelay()
    const { sock, sent } = fakeSocket()
    relay.connect(sock)
    const p = relay.sendCommand(7, 'Runtime.evaluate', { expression: '1' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ tabId: 7, method: 'Runtime.evaluate', params: { expression: '1' } })
    const id = sent[0].id
    relay.handleMessage(JSON.stringify({ id, result: { ok: true } }))
    await expect(p).resolves.toEqual({ ok: true })
  })

  it('subscribes to raw CDP domains and routes events without treating them as RPC replies', async () => {
    const relay = new ExtRelay()
    const { sock, sent } = fakeSocket()
    relay.connect(sock)
    const seen: unknown[] = []
    const off = relay.onEvent((event) => seen.push(event))
    const pending = relay.subscribe(7, ['Network'])
    expect(sent[0]).toMatchObject({ op: 'subscribe', tabId: 7, domains: ['Network'] })
    relay.handleMessage(JSON.stringify({ id: sent[0].id, result: { subscriptionId: 19 } }))
    await expect(pending).resolves.toBe(19)
    relay.handleMessage(JSON.stringify({
      type: 'cdp-event', subscriptionId: 19, tabId: 7,
      method: 'Network.responseReceived', params: { requestId: 'r1' },
    }))
    expect(seen).toEqual([{
      type: 'cdp-event', subscriptionId: 19, tabId: 7,
      method: 'Network.responseReceived', params: { requestId: 'r1' },
    }])
    off()
    relay.handleMessage(JSON.stringify({
      type: 'cdp-event', subscriptionId: 19, tabId: 7,
      method: 'Network.loadingFinished', params: { requestId: 'r1' },
    }))
    expect(seen).toHaveLength(1)
  })

  it('sends unsubscribe for a completed observer window', async () => {
    const relay = new ExtRelay()
    const { sock, sent } = fakeSocket()
    relay.connect(sock)
    const pending = relay.unsubscribe(23)
    expect(sent[0]).toMatchObject({ op: 'unsubscribe', subscriptionId: 23 })
    relay.handleMessage(JSON.stringify({ id: sent[0].id, result: {} }))
    await expect(pending).resolves.toBeUndefined()
  })

  it('newTab sends op:newTab and resolves with the tabId', async () => {
    const relay = new ExtRelay()
    const { sock, sent } = fakeSocket()
    relay.connect(sock)
    const p = relay.newTab('https://x.test', 'domcontentloaded', true)
    expect(sent[0]).toMatchObject({ op: 'newTab', url: 'https://x.test', waitUntil: 'domcontentloaded', background: true })
    relay.handleMessage(JSON.stringify({ id: sent[0].id, result: { tabId: 42 } }))
    await expect(p).resolves.toBe(42)
  })

  it('sendCommand carries expectDomain so the extension can refuse a mid-flight domain change', async () => {
    const relay = new ExtRelay()
    const { sock, sent } = fakeSocket()
    relay.connect(sock)
    const p = relay.sendCommand(5, 'Input.dispatchMouseEvent', { type: 'mousePressed' }, 'a.example')
    expect(sent[0]).toMatchObject({
      tabId: 5,
      method: 'Input.dispatchMouseEvent',
      expectDomain: 'a.example',
    })
    relay.handleMessage(JSON.stringify({ id: sent[0].id, result: {} }))
    await expect(p).resolves.toEqual({})
  })

  it('sendCommand without expectDomain omits it (read-only actions are not domain-gated)', async () => {
    const relay = new ExtRelay()
    const { sock, sent } = fakeSocket()
    relay.connect(sock)
    void relay.sendCommand(5, 'Runtime.evaluate', { expression: '1' })
    expect(sent[0]).not.toHaveProperty('expectDomain')
  })

  it('list sends op:list and resolves with the group tabs (how the AI identifies a target)', async () => {
    const relay = new ExtRelay()
    const { sock, sent } = fakeSocket()
    relay.connect(sock)
    const p = relay.list()
    expect(sent[0]).toMatchObject({ op: 'list' })
    const tabs = [
      { tabId: 5, url: 'https://a.test/1', title: 'A' },
      { tabId: 9, url: 'https://b.test/2', title: 'B' },
    ]
    relay.handleMessage(JSON.stringify({ id: sent[0].id, result: { tabs } }))
    await expect(p).resolves.toEqual(tabs)
  })

  it('{id,error} rejects the matching pending command', async () => {
    const relay = new ExtRelay()
    const { sock, sent } = fakeSocket()
    relay.connect(sock)
    const p = relay.sendCommand(1, 'Runtime.evaluate', {})
    relay.handleMessage(JSON.stringify({ id: sent[0].id, error: 'boom' }))
    await expect(p).rejects.toThrow('boom')
  })
})

describe('ExtRelay failure semantics', () => {
  it('rejects a command with ExtRelayTimeout after timeoutMs', async () => {
    vi.useFakeTimers()
    try {
      const relay = new ExtRelay({ timeoutMs: 1000 })
      relay.connect({ send: () => {} })
      const p = relay.sendCommand(1, 'Runtime.evaluate', {})
      const assertion = expect(p).rejects.toBeInstanceOf(ExtRelayTimeout)
      await vi.advanceTimersByTimeAsync(1000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('sendCommand with no socket rejects immediately (fail-fast, not hang)', async () => {
    const relay = new ExtRelay()
    await expect(relay.sendCommand(1, 'x', {})).rejects.toBeInstanceOf(ExtRelayDisconnected)
  })

  it('disconnect rejects all in-flight commands', async () => {
    const relay = new ExtRelay()
    const sock: ExtSocket = { send: () => {} }
    relay.connect(sock)
    const p1 = relay.sendCommand(1, 'a', {})
    const p2 = relay.sendCommand(2, 'b', {})
    relay.disconnect(sock)
    await expect(p1).rejects.toBeInstanceOf(ExtRelayDisconnected)
    await expect(p2).rejects.toBeInstanceOf(ExtRelayDisconnected)
  })

  it('a second connection takes over; the old connection in-flight commands reject', async () => {
    const relay = new ExtRelay()
    const a: ExtSocket = { send: () => {} }
    const b: ExtSocket = { send: () => {} }
    relay.connect(a)
    const pOld = relay.sendCommand(1, 'a', {})
    relay.connect(b) // 顶替
    await expect(pOld).rejects.toBeInstanceOf(ExtRelayDisconnected)
  })

  it('two tabs in flight: out-of-order results route by id, no cross-wiring', async () => {
    const relay = new ExtRelay()
    const sent: any[] = []
    relay.connect({ send: (d) => sent.push(JSON.parse(d)) })
    const pA = relay.sendCommand(100, 'Runtime.evaluate', { tag: 'A' })
    const pB = relay.sendCommand(200, 'Runtime.evaluate', { tag: 'B' })
    const idA = sent[0].id
    const idB = sent[1].id
    // B 先回、A 后回 —— 乱序也必须各归各
    relay.handleMessage(JSON.stringify({ id: idB, result: 'resB' }))
    relay.handleMessage(JSON.stringify({ id: idA, result: 'resA' }))
    await expect(pA).resolves.toBe('resA')
    await expect(pB).resolves.toBe('resB')
  })
})

describe('verifyExtUpgrade', () => {
  const TOKEN = 'a'.repeat(64)
  const hdr = (...ps: string[]) => ps.join(', ')

  it('accepts chrome-extension origin with protocol [browser-relay.v1, token]', () => {
    expect(
      verifyExtUpgrade(
        { origin: 'chrome-extension://abcdefghijklmnop', protocolHeader: hdr(EXT_RELAY_PROTOCOL, TOKEN) },
        TOKEN,
      ),
    ).toBe(true)
  })

  it('accepts missing origin (SW 环境可能为空) when token matches', () => {
    expect(verifyExtUpgrade({ protocolHeader: hdr(EXT_RELAY_PROTOCOL, TOKEN) }, TOKEN)).toBe(true)
  })

  it('rejects http(s) origins even with a valid token — 网页持有即泄露', () => {
    for (const origin of ['http://127.0.0.1:8900', 'https://evil.example', 'HTTPS://EVIL.EXAMPLE']) {
      expect(verifyExtUpgrade({ origin, protocolHeader: hdr(EXT_RELAY_PROTOCOL, TOKEN) }, TOKEN)).toBe(false)
    }
  })

  it('rejects wrong token / missing protocol header / bare protocol name', () => {
    expect(verifyExtUpgrade({ protocolHeader: hdr(EXT_RELAY_PROTOCOL, 'b'.repeat(64)) }, TOKEN)).toBe(false)
    expect(verifyExtUpgrade({}, TOKEN)).toBe(false)
    expect(verifyExtUpgrade({ protocolHeader: EXT_RELAY_PROTOCOL }, TOKEN)).toBe(false)
  })

  it('rejects when more than one candidate token offered (歧义拒绝)', () => {
    expect(
      verifyExtUpgrade({ protocolHeader: hdr(EXT_RELAY_PROTOCOL, TOKEN, 'x'.repeat(64)) }, TOKEN),
    ).toBe(false)
  })
})

describe('ExtRelay — 扩展报来的「开出了新标签」', () => {
  it('openedSince 只回这个开启者、这个时刻之后的；等的时候第一条一到就返回', async () => {
    const relay = new ExtRelay()
    relay.handleMessage(JSON.stringify({ type: 'tab-opened', tabId: 5, openerTabId: 1, url: 'https://old/' }))
    await new Promise((r) => setTimeout(r, 5))
    const since = Date.now()
    const waiting = relay.openedSince(1, since, 5_000)
    relay.handleMessage(JSON.stringify({ type: 'tab-opened', tabId: 6, openerTabId: 2, url: 'https://other/' }))
    relay.handleMessage(JSON.stringify({ type: 'tab-opened', tabId: 7, openerTabId: 1, url: 'https://new/' }))
    const t0 = Date.now()
    const got = await waiting
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(got.map((e) => e.tabId)).toEqual([7])
  })

  it('一张都没开 → 等满上界回空数组，不抛', async () => {
    const relay = new ExtRelay()
    expect(await relay.openedSince(1, Date.now(), 30)).toEqual([])
  })

  it('sendCommand 带 sessionId 就把它放上线；不带就不出现这个键', () => {
    const relay = new ExtRelay()
    const sent: string[] = []
    const sock = { send: (d: string) => void sent.push(d) }
    relay.connect(sock)
    void relay.sendCommand(1, 'Runtime.evaluate', {}, undefined, 'S1').catch(() => {})
    void relay.sendCommand(1, 'Runtime.evaluate', {}).catch(() => {})
    expect(JSON.parse(sent[0]!)).toMatchObject({ tabId: 1, sessionId: 'S1' })
    expect(JSON.parse(sent[1]!)).not.toHaveProperty('sessionId')
    relay.disconnect(sock)
  })
})
