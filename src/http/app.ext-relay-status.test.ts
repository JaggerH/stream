// GET /api/ext/relay-status —— 只读诊断探针：「扩展现在连着吗」。
// 存在的理由（docs/TODO.md，2026-07-27）：relay 以前日志和 API 双盲，误诊一次耗了四轮排查，
// 只能靠让用户点浏览器来猜。诊断第一步应该是打这个口。

import { describe, it, expect } from 'vitest'
import { createHttpApp } from './app.ts'

const stubs = {
  service: { streamsResource: () => [] },
  itemStore: { get: () => undefined },
  health: async () => ({ cookies: { domains: [], updatedAt: null }, manifests: 0, streams: 0 }),
} as never

describe('GET /api/ext/relay-status', () => {
  it('未连接 → {connected:false, since:null}', async () => {
    const app = createHttpApp({ ...(stubs as object), extRelayStatus: () => ({ connected: false, since: null }) } as never)
    const res = await app.request('/api/ext/relay-status')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ connected: false, since: null })
  })

  it('已连接 → {connected:true, since:<建立时刻>}', async () => {
    const since = '2026-07-27T10:00:00.000Z'
    const app = createHttpApp({ ...(stubs as object), extRelayStatus: () => ({ connected: true, since }) } as never)
    const res = await app.request('/api/ext/relay-status')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ connected: true, since })
  })

  it('配了 api_token 也不要求凭证 —— 诊断口必须在门之前（连不上时正是要用它）', async () => {
    const app = createHttpApp({
      ...(stubs as object),
      token: 'secret-token',
      extRelayStatus: () => ({ connected: true, since: '2026-07-27T10:00:00.000Z' }),
    } as never)
    const res = await app.request('/api/ext/relay-status')
    expect(res.status).toBe(200)
    expect((await res.json() as { connected: boolean }).connected).toBe(true)
  })

  it('后端根本没接 relay（dep 缺失）→ 404，别伪装成「扩展没连」', async () => {
    const app = createHttpApp(stubs)
    const res = await app.request('/api/ext/relay-status')
    expect(res.status).toBe(404)
  })
})
