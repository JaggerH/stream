import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { mountLiveRoutes } from './live-routes.ts'

const app = (items: () => Promise<unknown>) => {
  const a = new Hono()
  mountLiveRoutes(a, { live: { items } as never })
  return a
}

describe('GET /api/live/streams/:streamId/items', () => {
  it('正常返回 { items }', async () => {
    const res = await app(async () => [{ id: 'x' }]).request('/api/live/streams/s1/items')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [{ id: 'x' }] })
  })

  it('unknown_stream → 404 带原文', async () => {
    const res = await app(async () => { throw Object.assign(new Error('no stream "s9"'), { code: 'unknown_stream' }) })
      .request('/api/live/streams/s9/items')
    expect(res.status).toBe(404)
    expect((await res.json() as { error: string }).error).toMatch(/no stream/)
  })

  it('源执行失败 → 502 带原文,不返回空列表', async () => {
    const res = await app(async () => { throw new Error('artifactsDir 未配置') })
      .request('/api/live/streams/s1/items')
    expect(res.status).toBe(502)
    expect((await res.json() as { error: string }).error).toMatch(/artifactsDir 未配置/)
  })
})
