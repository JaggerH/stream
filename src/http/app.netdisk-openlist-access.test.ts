/**
 * 网盘插件 external 档的配置来源（spec 2026-09-05 §5.3）：Stream 在场时那份 OpenList 的
 * 网关路径 + 永久 token。过去由托管层在生成 profile 时直接递给插件行；现在插件装在用户
 * 自己的 DSH 里，只能来问。
 */
import { describe, expect, it } from 'vitest'
import { createHttpApp } from './app.ts'

const stubs = {
  service: { streamsResource: () => [] },
  itemStore: { get: () => undefined },
  health: async () => ({ cookies: { domains: [], updatedAt: null }, manifests: 0, streams: 0 }),
} as never

describe('GET /api/netdisk/openlist-access', () => {
  it('alist 不在场 → 404 unavailable', async () => {
    const app = createHttpApp(stubs)
    const res = await app.request('/api/netdisk/openlist-access')
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('unavailable')
  })

  it('有永久 token → 回网关路径 + token', async () => {
    const app = createHttpApp({
      ...(stubs as object),
      alist: { status: () => ({ url: '', hasToken: true, configured: true }), set: async () => ({ url: '', hasToken: true, configured: true }), test: async () => ({ ok: true }), permanentToken: async () => 'tok-perm' },
    } as never)
    const res = await app.request('http://127.0.0.1:8900/api/netdisk/openlist-access')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: 'http://127.0.0.1:8900/_p/alist', token: 'tok-perm' })
  })

  it('alist 在场但还没铸出永久 token → 404，说清是 token 没好', async () => {
    const app = createHttpApp({
      ...(stubs as object),
      alist: { status: () => ({ url: '', hasToken: false, configured: false }), set: async () => ({ url: '', hasToken: false, configured: false }), test: async () => ({ ok: false }), permanentToken: async () => undefined },
    } as never)
    const res = await app.request('/api/netdisk/openlist-access')
    expect(res.status).toBe(404)
    expect((await res.json()).error.message).toContain('token')
  })
})
