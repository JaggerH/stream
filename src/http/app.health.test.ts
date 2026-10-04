import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
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
import { readCommit, repoRoot } from './build-identity.ts'

/**
 * `/api/health` 带上「我跑的是哪一份代码」。它是免鉴权探针（MCP spawn 靠它判存活），
 * 所以这里钉两件事：字段确实回了，以及**取字段的过程炸了也不许影响探活**。
 */
describe('GET /api/health', () => {
  let dir: string
  let dedup: DedupStore
  let itemStore: ItemStore
  let channels: UserStore
  const health: () => Promise<HealthInfo> = async () => ({
    cookies: { domains: [], updatedAt: null },
    manifests: 0,
    streams: 0,
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'app-health-'))
    dedup = new DedupStore(join(dir, 'dedup.db'))
    itemStore = new ItemStore(join(dir, 'items.db'))
    channels = new UserStore(join(dir, 'stream.db'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    channels.close()
    dedup.close()
    itemStore.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeApp() {
    const scheduler = new Scheduler({
      registry: new Registry([]),
      streams: [],
      adapters: new Map(),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
    })
    const service = new StreamService({ registry: new Registry([]), scheduler, channels })
    return createHttpApp({ service, itemStore, health })
  }

  it('回 commit / started_at / dirty_since_start,好让人核对活体跑的是哪一份代码', async () => {
    const res = await makeApp().request('/api/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    // 发布归档没有 `.git`，健康检查应如实省略 commit，而不是把探针变成 500。
    expect(body.commit).toBe(readCommit(repoRoot))
    expect(typeof body.started_at).toBe('string')
    expect(Number.isFinite(body.dirty_since_start)).toBe(true)
  })

  it('取身份的那步整个抛了,探活仍然 200——只是少几个字段', async () => {
    const mod = await import('./build-identity.ts')
    vi.spyOn(mod, 'buildIdentity').mockImplementation(() => {
      throw new Error('boom')
    })
    const res = await makeApp().request('/api/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.commit).toBeUndefined()
  })
})
