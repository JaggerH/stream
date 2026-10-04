import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHttpApp, type HealthInfo } from './app.ts'
import { StreamService } from '../mcp/tools.ts'
import { Registry } from '../registry/registry.ts'
import { Scheduler } from '../scheduler.ts'
import { DedupStore } from '../dedup-store.ts'
import { ItemStore } from '../item-store.ts'
import { UserStore } from '../store/user-store.ts'

describe('HTTP op-track 中间件', () => {
  let dir: string
  let dedup: DedupStore
  let itemStore: ItemStore
  let userStores: UserStore[]
  const health: () => Promise<HealthInfo> = async () => ({
    cookies: { domains: [], updatedAt: null },
    manifests: 0,
    streams: 0,
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'app-optrack-'))
    dedup = new DedupStore(join(dir, 'dedup.db'))
    itemStore = new ItemStore(join(dir, 'items.db'))
    userStores = []
  })
  afterEach(() => {
    for (const s of userStores) s.close()
    dedup.close()
    itemStore.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeApp(track: <T>(name: string, fn: () => Promise<T>) => Promise<T>) {
    const scheduler = new Scheduler({
      registry: new Registry([]),
      streams: [],
      adapters: new Map(),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
    })
    const channels = new UserStore(join(dir, 'stream.db'))
    userStores.push(channels)
    const service = new StreamService({
      registry: new Registry([]),
      scheduler,
      channels,
    })
    return createHttpApp({ service, itemStore, health, track })
  }

  it('每个请求包裹为 http:<METHOD> <path>,响应原样穿过', async () => {
    const tracked: string[] = []
    const app = makeApp(async (name, fn) => {
      tracked.push(name)
      return fn()
    })
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(tracked).toEqual(['http:GET /api/health'])
  })

  it('用的是真实请求路径而非路由模板,连未匹配任何路由的路径也照埋', async () => {
    // /api/health's real path and matched route template are identical, so that assertion alone
    // cannot distinguish c.req.path from the route pattern. A path matching NO route still passes
    // through app.use('*'), so it pins down both "real path" and "unmatched routes are tracked too".
    const tracked: string[] = []
    const app = makeApp(async (name, fn) => {
      tracked.push(name)
      return fn()
    })
    await app.request('/api/nope')
    expect(tracked).toContain('http:GET /api/nope')
  })

  it('不传 track → 一切照旧', async () => {
    const scheduler = new Scheduler({
      registry: new Registry([]),
      streams: [],
      adapters: new Map(),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
    })
    const channels = new UserStore(join(dir, 'stream-2.db'))
    userStores.push(channels)
    const service = new StreamService({
      registry: new Registry([]),
      scheduler,
      channels,
    })
    const app = createHttpApp({ service, itemStore, health })
    expect((await app.request('/api/health')).status).toBe(200)
  })
})
