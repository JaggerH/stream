// `POST /api/ext/cookies`（扩展定时把登录态推给后端）**已撤销** —— 方向反过来了，
// 现在是后端在需要的时刻去取（`ExtRelay.cookiePull` → `CookiePuller`，见 credentials/cookie-puller.ts）。
//
// 这条测试是那个决定的看门狗。加回一个"写全站登录态、还没有调用方"的口子，代价不是多几行
// 死代码：它会让下一个人以为推那条路还活着，于是在 pull 出问题时去修一条早就没人走的路。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHttpApiFixture, type HttpApiFixture } from './__fixtures__/app-harness.ts'

const EXT_ID = 'dmhlfkdjljnilhnfajjpaobehenbokij'
const EXT_TOKEN = 'e'.repeat(64)

let fixture: HttpApiFixture
beforeEach(() => { fixture = createHttpApiFixture() })
afterEach(() => { fixture.close() })

describe('POST /api/ext/cookies（已撤销）', () => {
  it('404 —— 后端不再收推来的 cookie，它自己去取', async () => {
    const received: unknown[] = []
    const app = fixture.build(undefined, {
      extRelayAuth: { token: EXT_TOKEN, extId: EXT_ID },
      pushedCookies: { replace: (c) => { received.push(c) } },
    })
    const res = await app.request('/api/ext/cookies', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Host: '127.0.0.1:8900',
        Origin: `chrome-extension://${EXT_ID}`,
        Authorization: `Bearer ${EXT_TOKEN}`,
      },
      body: JSON.stringify({ cookies: { '.quark.cn': [{ name: '__pus', value: 'v' }] } }),
    })
    expect(res.status).toBe(404)
    // 更要紧的是它没有偷偷写进去——404 但照样落盘会是最坏的那种
    expect(received).toEqual([])
  })
})
