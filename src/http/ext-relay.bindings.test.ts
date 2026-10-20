// `/api/ext` 认绑定（design D7）：本机 token → `local`，配对 token → 那条绑定，其余一律 401。
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { EXT_RELAY_PROTOCOL, ExtRelay, attachExtRelay, resolveExtUpgrade } from './ext-relay.ts'
import { ExtRelayRegistry } from './ext-relay-registry.ts'

const LOCAL_TOKEN = 'l'.repeat(64)
const PAIRED_TOKEN = 'p'.repeat(64)
const ORIGIN = 'chrome-extension://abcdefghijklmnop'
const hdr = (...ps: string[]) => ps.join(', ')
const resolveToken = (t: string) => (t === LOCAL_TOKEN ? 'local' : t === PAIRED_TOKEN ? 'ext:a' : null)

describe('resolveExtUpgrade', () => {
  it('maps the local token to local and a paired token to its binding', () => {
    expect(resolveExtUpgrade({ origin: ORIGIN, protocolHeader: hdr(EXT_RELAY_PROTOCOL, LOCAL_TOKEN) }, resolveToken)).toBe('local')
    expect(resolveExtUpgrade({ protocolHeader: hdr(EXT_RELAY_PROTOCOL, PAIRED_TOKEN) }, resolveToken)).toBe('ext:a')
  })

  it('an unknown token resolves to nothing', () => {
    expect(resolveExtUpgrade({ protocolHeader: hdr(EXT_RELAY_PROTOCOL, 'x'.repeat(64)) }, resolveToken)).toBeNull()
  })

  it('a web page origin is refused even with a valid token', () => {
    for (const origin of ['https://evil.example', 'http://127.0.0.1:5273']) {
      expect(resolveExtUpgrade({ origin, protocolHeader: hdr(EXT_RELAY_PROTOCOL, PAIRED_TOKEN) }, resolveToken)).toBeNull()
    }
  })

  it('offering two tokens is refused, so one cannot be tried alongside a guess', () => {
    expect(resolveExtUpgrade({ protocolHeader: hdr(EXT_RELAY_PROTOCOL, PAIRED_TOKEN, LOCAL_TOKEN) }, resolveToken)).toBeNull()
  })
})

describe('attachExtRelay with a binding registry', () => {
  it('a paired token connects as its binding; closing disconnects that binding only', async () => {
    const reg = new ExtRelayRegistry({
      local: new ExtRelay(),
      makeRelay: () => new ExtRelay(),
      deviceOf: (id) => (id === 'ext:a' ? 'linux:nas' : undefined),
      bindingsOf: (dev) => (dev === 'linux:nas' ? ['ext:a'] : []),
    })
    const lines: string[] = []
    const server = createServer()
    attachExtRelay(server, reg, { resolveToken, log: (l) => lines.push(l) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ext`, [EXT_RELAY_PROTOCOL, PAIRED_TOKEN], { origin: ORIGIN })
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve())
        ws.on('error', reject)
      })
      expect(reg.isOnline('ext:a')).toBe(true)
      expect(reg.local.connected).toBe(false)
      expect(lines.some((l) => l.includes('binding=ext:a'))).toBe(true)
      ws.close()
      await vi.waitFor(() => expect(reg.isOnline('ext:a')).toBe(false))
    } finally {
      ws.terminate()
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('an unknown token is refused with 401', async () => {
    const server = createServer()
    attachExtRelay(server, new ExtRelay(), { resolveToken, log: () => {} })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ext`, [EXT_RELAY_PROTOCOL, 'x'.repeat(64)], { origin: ORIGIN })
    try {
      const status = await new Promise<number>((resolve) => {
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
        ws.on('error', () => resolve(-1))
      })
      expect(status).toBe(401)
    } finally {
      ws.terminate()
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
