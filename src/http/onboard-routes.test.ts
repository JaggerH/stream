import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WishlistStore } from '../onboard/wishlist-store.ts'
import { registerOnboardRoutes } from './onboard-routes.ts'

describe('onboard wishlist routes', () => {
  let dir: string
  let store: WishlistStore
  let app: Hono
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'onboard-routes-'))
    store = new WishlistStore(join(dir, 'w.json'))
    app = new Hono()
    registerOnboardRoutes(app, { wishlist: store })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('GET 列出全部，最新在前', async () => {
    store.add({ url: 'https://a.example', goal: '找 A' })
    store.add({ url: 'https://b.example', goal: '找 B' })
    const res = await app.request('/api/onboard/wishlist')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: { url: string }[] }
    expect(body.entries.map((e) => e.url)).toEqual(['https://b.example', 'https://a.example'])
  })

  it('DELETE 删掉一条', async () => {
    const e = store.add({ url: 'https://c.example', goal: '找 C' })
    const res = await app.request(`/api/onboard/wishlist/${e.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(store.list()).toEqual([])
  })

  it('DELETE 不存在的回 404', async () => {
    const res = await app.request('/api/onboard/wishlist/nope', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
