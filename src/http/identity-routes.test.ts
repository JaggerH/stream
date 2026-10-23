import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { mountIdentityRoutes } from './identity-routes.ts'
import type { IdentityService } from '../identity/identity-service.ts'

function app(svc: Partial<IdentityService> | undefined) {
  const a = new Hono()
  mountIdentityRoutes(a, { identities: () => svc as IdentityService | undefined })
  return a
}

describe('identity routes', () => {
  it('GET 按 facility / nodeId 收窄', async () => {
    const list = vi.fn(() => [{ facility: 'xhs', nodeId: 'node_a', accountId: 'A', state: 'signed-in' as const, verifiedAt: 1, online: true }])
    const res = await app({ list }).request('/api/identities?facility=xhs')
    expect(res.status).toBe(200)
    expect(list).toHaveBeenCalledWith({ facility: 'xhs' })
    expect(((await res.json()) as { identities: unknown[] }).identities).toHaveLength(1)
  })

  it('POST refresh：body 可空、可带收窄条件；坏 JSON 400', async () => {
    const refresh = vi.fn(async () => [{ facility: 'xhs', nodeId: 'node_a', result: { state: 'unknown' as const, reason: 'x' } }])
    const a = app({ refresh, list: () => [] })
    expect((await a.request('/api/identities/refresh', { method: 'POST' })).status).toBe(200)
    expect(refresh).toHaveBeenLastCalledWith({})
    const res = await a.request('/api/identities/refresh', { method: 'POST', body: JSON.stringify({ nodeId: 'node_a', facility: 'xhs' }) })
    expect(refresh).toHaveBeenLastCalledWith({ facility: 'xhs', nodeId: 'node_a' })
    expect(await res.json()).toMatchObject({ results: [{ result: { state: 'unknown' } }], identities: [] })
    expect((await a.request('/api/identities/refresh', { method: 'POST', body: '{' })).status).toBe(400)
  })

  it('表不可用 → 503', async () => {
    expect((await app(undefined).request('/api/identities')).status).toBe(503)
  })
})
