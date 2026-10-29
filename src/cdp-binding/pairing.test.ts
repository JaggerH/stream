/**
 * 配对与「对端自证」——与扩展同一套（`extension/src/lib/backend-identity.ts`）。
 *
 * 两条都要钉住：
 *
 * 1. **顺序**：先用一次性码换 token，再让对端用这把 token 签一条挑战应答，验过了才把 token
 *    放进 WS 握手。跳过中间那步 = 把 token 白送给任何抢到这个口的进程。
 * 2. **Origin**：服务端这两口只认 `chrome-extension://<固定 id>`（挡网页，不挡本机进程）。
 *    这里用一个按真实规则办事的假服务端，验它收到的正是这个头。
 */
import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, createHmac } from 'node:crypto'
import { EXT_ORIGIN, PairingFailed, RELAY_PROTOCOL, ServerNotTrusted, bindingProof, pairWithCode, verifyServer } from './pairing.ts'
import { STREAM_EXTENSION_ID } from '../ext-id.ts'
import { VERIFY_PREFIX } from '../../shared/browser-relay/wire.ts'

const TOKEN = 'a'.repeat(64)
const BINDING = 'ext:test'

/** 服务端那一侧算 proof 的公式（**独立实现**，不 import 被测函数）：sha256hex 当 HMAC key。 */
const expectedProof = (token: string, nonce: string) =>
  createHmac('sha256', createHash('sha256').update(token).digest('hex')).update(`${VERIFY_PREFIX}${nonce}`).digest('hex')

interface Recorded {
  path: string
  origin?: string
  body: Record<string, unknown>
}

/** 按服务端真实规则办事的假服务端：Origin 不对一律 403。 */
async function fakeServer(respond: (path: string, body: Record<string, unknown>) => { status: number; body?: unknown }) {
  const calls: Recorded[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {}
    const origin = req.headers.origin
    calls.push({ path: req.url ?? '', ...(origin ? { origin } : {}), body })
    if (origin !== EXT_ORIGIN) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end('{"error":"forbidden origin"}')
      return
    }
    const r = respond(req.url ?? '', body)
    res.writeHead(r.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(r.body ?? {}))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('pairWithCode：一次性码换 token', () => {
  it('打的是 /api/ext/pair，带扩展 Origin 与码；回执里的 token / bindingId / deviceId 原样交出', async () => {
    const s = await fakeServer((path) => {
      if (path === '/api/ext/pair') return { status: 200, body: { bindingId: BINDING, token: TOKEN, deviceId: 'dev_1' } }
      return { status: 404 }
    })
    try {
      const r = await pairWithCode({ serverUrl: `${s.url}/`, code: ' 123456 ', name: 'CDP 绑定' })
      expect(r).toEqual({ bindingId: BINDING, token: TOKEN, deviceId: 'dev_1' })
      expect(s.calls).toHaveLength(1)
      expect(s.calls[0]!.path).toBe('/api/ext/pair')
      expect(s.calls[0]!.origin).toBe(`chrome-extension://${STREAM_EXTENSION_ID}`)
      expect(s.calls[0]!.body).toMatchObject({ code: '123456', name: 'CDP 绑定' })
    } finally {
      await s.close()
    }
  })

  it('码不对 / 过期（403）→ PairingFailed，并告诉用户去哪重新生成', async () => {
    const s = await fakeServer(() => ({ status: 403 }))
    try {
      await expect(pairWithCode({ serverUrl: s.url, code: '000000' })).rejects.toThrow(PairingFailed)
      await expect(pairWithCode({ serverUrl: s.url, code: '000000' })).rejects.toThrow(/配对码不对或已过期/)
    } finally {
      await s.close()
    }
  })

  it('服务端连不上 → PairingFailed（不是裸的 fetch 异常）', async () => {
    const s = await fakeServer(() => ({ status: 200 }))
    const url = s.url
    await s.close()
    await expect(pairWithCode({ serverUrl: url, code: '123456' })).rejects.toThrow(PairingFailed)
  })

  it('回执不完整（不是 Stream / 版本太旧）→ PairingFailed', async () => {
    const s = await fakeServer(() => ({ status: 200, body: { ok: true } }))
    try {
      await expect(pairWithCode({ serverUrl: s.url, code: '123456' })).rejects.toThrow(/回复不完整/)
    } finally {
      await s.close()
    }
  })
})

describe('verifyServer：让对端用这把 token 自证', () => {
  it('proof 对得上才通过；请求带 {nonce, binding} 与扩展 Origin', async () => {
    const s = await fakeServer((path, body) => {
      if (path === '/api/ext/verify') {
        return { status: 200, body: { proof: expectedProof(TOKEN, String(body.nonce)), protocol: RELAY_PROTOCOL } }
      }
      return { status: 404 }
    })
    try {
      await expect(verifyServer({ serverUrl: s.url, token: TOKEN, bindingId: BINDING })).resolves.toBeUndefined()
      expect(s.calls[0]!.path).toBe('/api/ext/verify')
      expect(s.calls[0]!.origin).toBe(EXT_ORIGIN)
      expect(s.calls[0]!.body.binding).toBe(BINDING)
      expect(String(s.calls[0]!.body.nonce)).toMatch(/^[0-9a-f]{64}$/) // 每次都是新的 32 字节
    } finally {
      await s.close()
    }
  })

  it('nonce 每次都不同（重放一次没用）', async () => {
    const s = await fakeServer((_p, body) => ({ status: 200, body: { proof: expectedProof(TOKEN, String(body.nonce)) } }))
    try {
      await verifyServer({ serverUrl: s.url, token: TOKEN, bindingId: BINDING })
      await verifyServer({ serverUrl: s.url, token: TOKEN, bindingId: BINDING })
      expect(s.calls[0]!.body.nonce).not.toBe(s.calls[1]!.body.nonce)
    } finally {
      await s.close()
    }
  })

  it('proof 算错 → ServerNotTrusted（对端不是我们配对的那台）', async () => {
    const s = await fakeServer(() => ({ status: 200, body: { proof: 'f'.repeat(64) } }))
    try {
      await expect(verifyServer({ serverUrl: s.url, token: TOKEN, bindingId: BINDING })).rejects.toThrow(ServerNotTrusted)
    } finally {
      await s.close()
    }
  })

  it('被拒 / 没有 proof → ServerNotTrusted', async () => {
    const denied = await fakeServer(() => ({ status: 403 }))
    try {
      await expect(verifyServer({ serverUrl: denied.url, token: TOKEN, bindingId: BINDING })).rejects.toThrow(ServerNotTrusted)
    } finally {
      await denied.close()
    }
    const empty = await fakeServer(() => ({ status: 200, body: {} }))
    try {
      await expect(verifyServer({ serverUrl: empty.url, token: TOKEN, bindingId: BINDING })).rejects.toThrow(/没有 proof/)
    } finally {
      await empty.close()
    }
  })

  it('bindingProof 与服务端那份公式逐字节一致', () => {
    const nonce = 'deadbeef'.repeat(8)
    expect(bindingProof(TOKEN, nonce)).toBe(expectedProof(TOKEN, nonce))
  })
})
