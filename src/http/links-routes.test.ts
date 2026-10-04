import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { registerLinkRoutes } from './links-routes.ts'
import { setLinkDeclarationSource } from '../links/recognize.ts'

afterEach(() => setLinkDeclarationSource(() => []))

function app() {
  const a = new Hono()
  registerLinkRoutes(a)
  return a
}

describe('GET /api/links/recognize', () => {
  it('被认领 → LinkRef', async () => {
    setLinkDeclarationSource(() => [{
      package: '@x/pkg', hosts: [{ host: 'pkgsite.com', platform: 'pkg' }], shortHosts: [],
      patterns: [{ kind: 'track', platform: 'pkg', pattern: '^https://pkgsite\\.com/song/(?<id>\\d+)' }],
    }])
    const res = await app().request(`/api/links/recognize?url=${encodeURIComponent('https://pkgsite.com/song/7')}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: 'https://pkgsite.com/song/7', package: '@x/pkg', platform: 'pkg', kind: 'track', id: '7' })
  })

  it('没人认领 → null（200，不是 404：「没有包认领」是一个答案）', async () => {
    const res = await app().request(`/api/links/recognize?url=${encodeURIComponent('https://example.com/')}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
  })

  it('缺 url → 400 validation_error', async () => {
    const res = await app().request('/api/links/recognize')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'validation_error' } })
  })
})
