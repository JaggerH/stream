import { describe, it, expect, vi, afterEach } from 'vitest'
import { expectedProof, proofEqual, freshNonce, verifyBackend, VERIFY_PREFIX, BackendNotTrusted } from './backend-identity.ts'
import { createHmac } from 'node:crypto'

const TOKEN = 'e'.repeat(64)
const NONCE = 'a'.repeat(64)
/** 后端那半（src/http/ext-verify.ts）算出来的应答。**用 node:crypto 独立算，不 import 后端代码**
 *  —— 两边对着同一个式子各自实现才叫互验，import 过来就成了自己验自己。 */
const backendProof = (token: string, nonce: string) =>
  createHmac('sha256', token).update(`${VERIFY_PREFIX}${nonce}`).digest('hex')

afterEach(() => { vi.unstubAllGlobals() })

describe('expectedProof', () => {
  it('和后端逐字节一致（协议对齐的那颗钉子）', async () => {
    expect(await expectedProof(TOKEN, NONCE)).toBe(backendProof(TOKEN, NONCE))
  })

  it('token 不同 → proof 不同（冒充者算不出来的根据）', async () => {
    expect(await expectedProof(TOKEN, NONCE)).not.toBe(await expectedProof('f'.repeat(64), NONCE))
  })
})

describe('freshNonce', () => {
  it('每次都不一样——重放防线全靠它', () => {
    expect(freshNonce()).not.toBe(freshNonce())
  })

  it('是 64 位十六进制（32 字节熵）', () => {
    expect(freshNonce()).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('proofEqual', () => {
  it('等长相同为真，任一位不同为假，长度不同为假', () => {
    expect(proofEqual('abc', 'abc')).toBe(true)
    expect(proofEqual('abc', 'abd')).toBe(false)
    expect(proofEqual('abc', 'abcd')).toBe(false)
  })
})

describe('verifyBackend', () => {
  const stubFetch = (impl: (url: string, init: RequestInit) => unknown) => {
    const fn = vi.fn(async (url: string, init: RequestInit) => impl(url, init))
    vi.stubGlobal('fetch', fn)
    return fn
  }
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

  it('对端算得出 proof → 通过', async () => {
    stubFetch((_u, init) => {
      const { nonce } = JSON.parse(String(init.body)) as { nonce: string }
      return ok({ proof: backendProof(TOKEN, nonce) })
    })
    await expect(verifyBackend('http://127.0.0.1:8900', TOKEN)).resolves.toBeUndefined()
  })

  // 这就是整件事要挡的那一幕：某个进程抢到了 8900，但它没有 data/ext-relay-token。
  it('冒充者（不知道 token）算不出 proof → 拒', async () => {
    stubFetch((_u, init) => {
      const { nonce } = JSON.parse(String(init.body)) as { nonce: string }
      return ok({ proof: backendProof('imposter-guess', nonce) })
    })
    await expect(verifyBackend('http://127.0.0.1:8900', TOKEN)).rejects.toBeInstanceOf(BackendNotTrusted)
  })

  it('每次带一个新 nonce（录了上一次的应答也重放不了）', async () => {
    const fn = stubFetch((_u, init) => {
      const { nonce } = JSON.parse(String(init.body)) as { nonce: string }
      return ok({ proof: backendProof(TOKEN, nonce) })
    })
    await verifyBackend('http://127.0.0.1:8900', TOKEN)
    await verifyBackend('http://127.0.0.1:8900', TOKEN)
    const nonces = fn.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).nonce)
    expect(nonces[0]).not.toBe(nonces[1])
  })

  it('应答缺 proof / 非 JSON / HTTP 错 —— 一律拒，不放行', async () => {
    stubFetch(() => ok({}))
    await expect(verifyBackend('http://x', TOKEN)).rejects.toBeInstanceOf(BackendNotTrusted)
    stubFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error('not json') } }))
    await expect(verifyBackend('http://x', TOKEN)).rejects.toBeInstanceOf(BackendNotTrusted)
    stubFetch(() => ({ ok: false, status: 404, json: async () => ({}) }))
    await expect(verifyBackend('http://x', TOKEN)).rejects.toBeInstanceOf(BackendNotTrusted)
  })

  // 连不上不能等于"验过了"——fail-open 会让这道锁在后端没起时自动消失。
  it('请求发不出去也是拒，不是通过', async () => {
    stubFetch(() => { throw new Error('ECONNREFUSED') })
    await expect(verifyBackend('http://x', TOKEN)).rejects.toBeInstanceOf(BackendNotTrusted)
  })

  it('打的是 /api/ext/verify，且 baseUrl 末尾斜杠不会拼出双斜杠', async () => {
    const fn = stubFetch((_u, init) => {
      const { nonce } = JSON.parse(String(init.body)) as { nonce: string }
      return ok({ proof: backendProof(TOKEN, nonce) })
    })
    await verifyBackend('http://127.0.0.1:8900/', TOKEN)
    expect(fn.mock.calls[0][0]).toBe('http://127.0.0.1:8900/api/ext/verify')
  })
})
