// POST /api/ext/verify —— 后端自证「我也知道 ext-relay 那把 secret」。
// 它取代的是 POST /api/ext/token（后端把 secret 直接发给对方）；那条路的方向是反的。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHttpApiFixture, type HttpApiFixture } from './__fixtures__/app-harness.ts'
import { extVerifyProof, EXT_VERIFY_PREFIX } from './ext-verify.ts'
import { createHmac } from 'node:crypto'

const EXT_ID = 'dmhlfkdjljnilhnfajjpaobehenbokij'
const EXT_TOKEN = 'e'.repeat(64)
const NONCE = 'a'.repeat(64)

let fixture: HttpApiFixture
beforeEach(() => { fixture = createHttpApiFixture() })
afterEach(() => { fixture.close() })

const build = () => fixture.build(undefined, { extRelayAuth: { token: EXT_TOKEN, extId: EXT_ID } })

const verify = (
  app: ReturnType<typeof build>,
  body: unknown,
  o: { origin?: string } = {},
) =>
  app.request('/api/ext/verify', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: o.origin ?? `chrome-extension://${EXT_ID}`,
    },
    body: JSON.stringify(body),
  })

describe('POST /api/ext/verify', () => {
  it('回 nonce 的 proof', async () => {
    const res = await verify(build(), { nonce: NONCE })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ proof: extVerifyProof(EXT_TOKEN, NONCE) })
  })

  // 这一条是整条链路的意义所在：应答里出现 token 就等于这次改动白做。
  it('**绝不**把 token 本身回出去', async () => {
    const res = await verify(build(), { nonce: NONCE })
    expect(JSON.stringify(await res.json())).not.toContain(EXT_TOKEN)
  })

  it('proof 随 nonce 变——录下来的应答重放不了', async () => {
    const a = await (await verify(build(), { nonce: NONCE })).json()
    const b = await (await verify(build(), { nonce: 'b'.repeat(64) })).json()
    expect((a as { proof: string }).proof).not.toBe((b as { proof: string }).proof)
  })

  it('别的扩展拿不到 proof（Origin 精确匹配）', async () => {
    const res = await verify(build(), { nonce: NONCE }, { origin: `chrome-extension://${'b'.repeat(32)}` })
    expect(res.status).toBe(403)
  })

  it('网页来源拒（浏览器强制 Origin，伪造不了 chrome-extension://）', async () => {
    const res = await verify(build(), { nonce: NONCE }, { origin: 'https://evil.example' })
    expect(res.status).toBe(403)
  })

  // 服务端绝不给一个可预测的挑战签名——否则攻击者可以离线备好应答。
  it('缺 nonce / nonce 太短一律 400，不用默认值兜底', async () => {
    const app = build()
    expect((await verify(app, {})).status).toBe(400)
    expect((await verify(app, { nonce: 'short' })).status).toBe(400)
    expect((await verify(app, { nonce: 123 })).status).toBe(400)
  })

  it('没接 relay 就 404，不假装成 403', async () => {
    const res = await fixture.build(undefined, {}).request('/api/ext/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: `chrome-extension://${EXT_ID}` },
      body: JSON.stringify({ nonce: NONCE }),
    })
    expect(res.status).toBe(404)
  })
})

describe('extVerifyProof', () => {
  // 扩展侧用 WebCrypto 独立实现同一个式子（backend-identity.ts）。两边都对着这条**手写的**
  // 期望值，而不是互相对着对方的实现——同源比对验不出任何东西。
  it('是 HMAC-SHA256(token, 前缀+nonce) 的小写 hex', () => {
    const expected = createHmac('sha256', EXT_TOKEN).update(`${EXT_VERIFY_PREFIX}${NONCE}`).digest('hex')
    expect(extVerifyProof(EXT_TOKEN, NONCE)).toBe(expected)
    expect(extVerifyProof(EXT_TOKEN, NONCE)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('前缀参与签名——去掉它结果就不同（域分隔真的生效）', () => {
    const withoutPrefix = createHmac('sha256', EXT_TOKEN).update(NONCE).digest('hex')
    expect(extVerifyProof(EXT_TOKEN, NONCE)).not.toBe(withoutPrefix)
  })
})

describe('POST /api/ext/token（已撤销）', () => {
  // 它曾经把 ext-relay secret 直接发给对端。别加回来——本机任何进程抢到 8900 就拿到了
  // 这条通道的全部能力。这条测试是那个决定的看门狗。
  it('404——后端不再把 secret 发出去', async () => {
    const res = await build().request('/api/ext/token', {
      method: 'POST',
      headers: { Origin: `chrome-extension://${EXT_ID}` },
    })
    expect(res.status).toBe(404)
  })
})
