import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHttpApiFixture, type HttpApiFixture } from './__fixtures__/app-harness.ts'
import type { PackageSummary } from '../packages/inventory.ts'

let fixture: HttpApiFixture
beforeEach(() => { fixture = createHttpApiFixture() })
afterEach(() => { fixture.close() })

const hosted: PackageSummary = {
  id: 'voiceprint', name: '声纹', description: '说话人分离与声纹比对', layer: 'builtin',
  slots: { backend: true }, hosted: true, enabled: true,
  runtime: { state: 'unknown', image: 'sherpa:latest' },
}
const plain: PackageSummary = {
  id: 'imdb', name: 'IMDb', layer: 'builtin', slots: { recipes: 1 }, hosted: false,
}

describe('GET /api/packages', () => {
  it('列出两层全部包，形状原样透出', async () => {
    const app = fixture.build(undefined, { packageInventory: () => [hosted, plain] })
    const res = await app.request('/api/packages')
    expect(res.status).toBe(200)
    const body = await res.json() as { packages: PackageSummary[] }
    expect(body.packages.map((p) => p.id)).toEqual(['voiceprint', 'imdb'])
    expect(body.packages[1]).toEqual(plain)
  })

  it('runtime 状态来自已有的 pluginStatus —— 不新起一套探活', async () => {
    const pluginStatus = vi.fn(async () => [
      { id: 'voiceprint', configured: true, health: 'unknown', standby: { state: 'idle', lastUsed: 1700, lastWakeMs: null } },
    ])
    const app = fixture.build(undefined, { packageInventory: () => [hosted, plain], pluginStatus })
    const body = await (await app.request('/api/packages')).json() as { packages: PackageSummary[] }
    expect(body.packages[0].runtime).toEqual({ state: 'idle', image: 'sherpa:latest', lastUsed: 1700 })
    expect(body.packages[1]).not.toHaveProperty('runtime')
    expect(pluginStatus).toHaveBeenCalledTimes(1)
  })

  it('没接 pluginStatus 时照常返回，只是状态留在 unknown（目录不该被状态拖垮）', async () => {
    const app = fixture.build(undefined, { packageInventory: () => [hosted] })
    const body = await (await app.request('/api/packages')).json() as { packages: PackageSummary[] }
    expect(body.packages[0].runtime?.state).toBe('unknown')
  })

  it('后端没接 packageInventory → 503（不是空数组：空数组等于说"你什么都没装"）', async () => {
    const app = fixture.build(undefined, {})
    const res = await app.request('/api/packages')
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('unavailable')
  })
})

describe('GET /api/packages/:id/logs', () => {
  it('拿到行；tail 缺省 200', async () => {
    const logs = vi.fn(async () => ({ ok: true as const, value: { lines: ['a'], truncated: false } }))
    const app = fixture.build(undefined, { containerOps: { logs, restart: vi.fn() } as never })
    const res = await app.request('/api/packages/voiceprint/logs')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ lines: ['a'], truncated: false })
    expect(logs).toHaveBeenCalledWith('voiceprint', 200)
  })

  it('tail 夹在 [1,1000]，垃圾值回落 200 而不是 0', async () => {
    const logs = vi.fn(async (_id: string, _tail: number) => ({ ok: true as const, value: { lines: [], truncated: false } }))
    const app = fixture.build(undefined, { containerOps: { logs, restart: vi.fn() } as never })
    await app.request('/api/packages/x/logs?tail=99999')
    await app.request('/api/packages/x/logs?tail=abc')
    // tail=0 在 docker 那边是「一行都不要」，表现是面板空着、看起来像「这个容器没有日志」。
    await app.request('/api/packages/x/logs?tail=0')
    expect(logs.mock.calls.map((c) => c[1])).toEqual([1000, 200, 200])
  })

  it('三种失败映射成三个状态码 —— 合成一个 500 等于把人支去查错的地方', async () => {
    const cases = [
      ['no_container', 404, 'not_found'],
      ['unavailable', 503, 'unavailable'],
      ['not_managed', 409, 'conflict'],
    ] as const
    for (const [code, status, apiCode] of cases) {
      const app = fixture.build(undefined, {
        containerOps: { logs: async () => ({ ok: false, code }), restart: vi.fn() } as never,
      })
      const res = await app.request('/api/packages/x/logs')
      expect(res.status, code).toBe(status)
      expect((await res.json()).error.code, code).toBe(apiCode)
    }
  })

  it('ops 层给了 message 就用它的原话（笼统文案会把唯一有用的信息盖掉）', async () => {
    const app = fixture.build(undefined, {
      containerOps: { logs: async () => ({ ok: false, code: 'unavailable', message: 'socket hangup' }), restart: vi.fn() } as never,
    })
    expect((await (await app.request('/api/packages/x/logs')).json()).error.message).toBe('socket hangup')
  })

  it('没接 containerOps → 503', async () => {
    const app = fixture.build(undefined, {})
    expect((await app.request('/api/packages/x/logs')).status).toBe(503)
  })
})

describe('POST /api/packages/:id/restart', () => {
  it('重启成功 → 200 running', async () => {
    const restart = vi.fn(async () => ({ ok: true as const, value: { state: 'running' as const } }))
    const app = fixture.build(undefined, { containerOps: { logs: vi.fn(), restart } as never })
    const res = await app.request('/api/packages/voiceprint/restart', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ state: 'running' })
    expect(restart).toHaveBeenCalledWith('voiceprint')
  })

  // 容器没起来是 200 + state:'error'，不是 5xx：请求本身成功了（我们确实试过了），失败的是那个
  // 容器。用 5xx 表达它，前端就分不清「没连上后端」和「容器没起来」——那是两种完全不同的处置。
  it('容器起不来仍是 200，state:error 带原话', async () => {
    const app = fixture.build(undefined, {
      containerOps: { logs: vi.fn(), restart: async () => ({ ok: true, value: { state: 'error', error: 'port in use' } }) } as never,
    })
    const res = await app.request('/api/packages/x/restart', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ state: 'error', error: 'port in use' })
  })

  it('没授权替你建容器 → 409，并把出路说出来', async () => {
    const app = fixture.build(undefined, {
      containerOps: { logs: vi.fn(), restart: async () => ({ ok: false, code: 'not_managed', message: '用 docker compose up -d 起它' }) } as never,
    })
    const res = await app.request('/api/packages/x/restart', { method: 'POST' })
    expect(res.status).toBe(409)
    expect((await res.json()).error.message).toMatch(/docker compose/)
  })

  it('没接 containerOps → 503', async () => {
    const app = fixture.build(undefined, {})
    expect((await app.request('/api/packages/x/restart', { method: 'POST' })).status).toBe(503)
  })
})

// 待生效清单（启动快照 vs 盘上现扫）在三处露面：独立端点、包目录每项、liveness 探针的计数。
describe('待生效清单', () => {
  const change = { name: '@streamapp/mineru', kind: 'updated' as const, from: '1.0.0', to: '1.0.1', needsRestart: true, why: '容器要重启后按 x:1.0.1 重建' }

  it('GET /api/packages/pending 回清单；没接 → 503', async () => {
    const app = fixture.build(undefined, { packagePending: () => [change] })
    expect(await (await app.request('/api/packages/pending')).json()).toEqual({ pending: [change] })
    expect((await fixture.build(undefined, {}).request('/api/packages/pending')).status).toBe(503)
  })

  it('/api/packages 每项按 pkgName 挂上 pending', async () => {
    const mineru: PackageSummary = { id: 'mineru', name: 'MinerU', layer: 'user', pkgName: '@streamapp/mineru', version: '1.0.1', slots: { backend: true }, hosted: true }
    const app = fixture.build(undefined, { packageInventory: () => [mineru, plain], packagePending: () => [change] })
    const body = await (await app.request('/api/packages')).json() as { packages: (PackageSummary & { pending?: unknown })[] }
    expect(body.packages[0].pending).toEqual(change)
    expect(body.packages[1]).not.toHaveProperty('pending')
  })

  it('/api/health 报 pending_restart 条数；没接就没有这一格', async () => {
    const app = fixture.build(undefined, { packagePending: () => [change, { ...change, name: 'x', needsRestart: false }] })
    expect((await (await app.request('/api/health')).json()).pending_restart).toBe(1)
    expect(await (await fixture.build(undefined, {}).request('/api/health')).json()).not.toHaveProperty('pending_restart')
  })

  // 探针必须活着：清单那一侧炸了（盘扫到一半 / 目录被删）只掉这一格，不能把 liveness 拖成 500。
  it('/api/health：pending 抛了 → 200 且没有这一格', async () => {
    const app = fixture.build(undefined, { packagePending: () => { throw new Error('boom') } })
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).not.toHaveProperty('pending_restart')
  })
})
