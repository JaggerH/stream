import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ResolveEngine } from './engine.ts'
import { BREAKER_COOLDOWN_CAP_MS } from '../providers/breaker.ts'
import { Registry } from '../registry/registry.ts'
import { SourceHealthStore } from '../source-health-store.ts'
import type { Adapter } from '../adapters/types.ts'
import type { SourceManifest } from '../manifest/types.ts'

function mk(id: string, provides: string[], priority: number): SourceManifest {
  return {
    schema_version: 1, id, adapter: 'fake', type: 'post', description: id,
    topics: [], example_queries: [], capabilities: ['timeline'],
    auth: { type: 'none' }, params_schema: {}, cadence_hint_seconds: 1800, discoverable: true,
    provides, priority,
  }
}

function fake(behavior: Record<string, () => unknown[]>, calls: string[]): Adapter {
  return {
    id: 'fake', init: async () => {},
    fetch: async (_p, m) => { calls.push(m.id); const b = behavior[m.id]; return b ? b() : [] },
  }
}

describe('ResolveEngine.resolve', () => {
  let dir: string, health: SourceHealthStore
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'res-')); health = new SourceHealthStore(join(dir, 'h.json'), { errK: 2 }) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function engine(adapter: Adapter, manifests: SourceManifest[]) {
    return new ResolveEngine({
      registry: new Registry(manifests),
      adapters: new Map([['fake', adapter]]),
      health,
      resolveCreds: async () => ({}),
      buildParams: (_m, key) => ({ key }),
    })
  }

  const ladder = () => [mk('zuna', ['netease-track'], 1), mk('tobiec', ['netease-track'], 2)]

  it('returns the first rung that yields items (原序，不按健康度重排)', async () => {
    const calls: string[] = []
    const e = engine(fake({ zuna: () => [{ url: 'a' }], tobiec: () => [{ url: 'b' }] }, calls), ladder())
    const r = await e.resolve('netease-track', '123')
    expect(r?.source).toBe('zuna')
    expect(calls).toEqual(['zuna'])
  })

  it('falls through on hard error and records it', async () => {
    const calls: string[] = []
    const e = engine(fake({ zuna: () => { throw new Error('boom') }, tobiec: () => [{ url: 'b' }] }, calls), ladder())
    const r = await e.resolve('netease-track', '123')
    expect(r?.source).toBe('tobiec')
    expect(calls).toEqual(['zuna', 'tobiec'])
    expect(health.get('zuna')?.lastOutcome).toBe('error')
  })

  it('falls through on empty (this source could not answer the key)', async () => {
    const calls: string[] = []
    const e = engine(fake({ zuna: () => [], tobiec: () => [{ url: 'b' }] }, calls), ladder())
    const r = await e.resolve('netease-track', '123')
    expect(r?.source).toBe('tobiec')
  })

  // 旧语义是"从第一个健康档起跳"；现在是原序 + 熔断裁决——错源在冷却期内被跳过，
  // 下一档接住。断言不变（跳过 zuna、tobiec 接住），理由换成了冷却。
  it('刚错过的源在冷却期内被跳过，下一档接住', async () => {
    health.record('zuna', { kind: 'error', message: 'x' })
    health.record('zuna', { kind: 'error', message: 'x' }) // consecutiveError=2 → 冷却 120s
    const calls: string[] = []
    const e = engine(fake({ zuna: () => [{ url: 'a' }], tobiec: () => [{ url: 'b' }] }, calls), ladder())
    const r = await e.resolve('netease-track', '123')
    expect(r?.source).toBe('tobiec')
    expect(calls).toEqual(['tobiec'])
  })

  // 有牙的关键在夹具：剩余最短的那一档**不是原序第一档**。若兜底写成"取首个"，这条会红
  // （会去试 zuna、还要再等 600s 才轮到真正快到期的 tobiec）。
  it('全员冷却中：强行试冷却剩余最短的那个——不是原序第一个（一次调用至少真实试一档）', async () => {
    health.record('zuna', { kind: 'error', message: 'x' })
    health.record('zuna', { kind: 'error', message: 'x' })
    health.record('zuna', { kind: 'error', message: 'x' }) // 原序第一档，3 连败 → 冷却 600s
    health.record('tobiec', { kind: 'error', message: 'x' }) // 末档，1 连败 → 冷却 30s（剩余最短）
    const calls: string[] = []
    const e = engine(fake({ zuna: () => [{ url: 'a' }], tobiec: () => [{ url: 'b' }] }, calls), ladder())
    const r = await e.resolve('netease-track', '123')
    expect(calls).toEqual(['tobiec']) // 只有探针那一档被真实执行，且它不是首档
    expect(r?.source).toBe('tobiec')
    expect(health.stateOf('tobiec')).toBe('healthy') // 成功即复位
  })

  it('冷却封顶后必探：时钟拨过封顶，死源被真实试一次（不会永久降级）', async () => {
    for (let i = 0; i < 6; i++) health.record('zuna', { kind: 'error', message: 'x' }) // 远超阶梯 → 封顶 30min
    health.record('tobiec', { kind: 'error', message: 'x' })
    const calls: string[] = []
    const later = Date.now() + BREAKER_COOLDOWN_CAP_MS + 1000
    const e = new ResolveEngine({
      registry: new Registry(ladder()),
      adapters: new Map([['fake', fake({ zuna: () => [{ url: 'a' }], tobiec: () => [{ url: 'b' }] }, calls)]]),
      health, resolveCreds: async () => ({}), buildParams: (_m, key) => ({ key }),
      now: () => later,
    })
    const r = await e.resolve('netease-track', '123')
    expect(calls).toEqual(['zuna']) // 封顶到期 → 原序第一档直接放行
    expect(r?.source).toBe('zuna')
    expect(health.stateOf('zuna')).toBe('healthy')
  })

  it('空永不触发熔断：连空多次的源每次照样被试（"答不了这个 key" ≠ "源有病"）', async () => {
    const calls: string[] = []
    const e = engine(fake({ zuna: () => [], tobiec: () => [{ url: 'b' }] }, calls), ladder())
    for (let i = 0; i < 5; i++) expect((await e.resolve('netease-track', `k${i}`))?.source).toBe('tobiec')
    expect(calls.filter((c) => c === 'zuna')).toHaveLength(5)
  })

  it('manifest 自报超时生效：挂着不响的源被掐掉，梯子继续走', async () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const slow = { ...mk('zuna', ['netease-track'], 1), member_timeout_ms: 50 }
      const adapter: Adapter = {
        id: 'fake', init: async () => {},
        fetch: async (_p, m) => {
          calls.push(m.id)
          if (m.id === 'zuna') return new Promise<unknown[]>(() => {}) // 永不返回
          return [{ url: 'b' }]
        },
      }
      const e = engine(adapter, [slow, mk('tobiec', ['netease-track'], 2)])
      const p = e.resolve('netease-track', '123')
      await vi.advanceTimersByTimeAsync(60)
      expect((await p)?.source).toBe('tobiec')
      expect(calls).toEqual(['zuna', 'tobiec'])
      expect(health.get('zuna')?.lastErrorCategory).toBe('timeout')
    } finally { vi.useRealTimers() }
  })

  it('未自报 member_timeout_ms 就不设限——周期采集的慢源不会被全局闸掐死', async () => {
    vi.useFakeTimers()
    try {
      const adapter: Adapter = {
        id: 'fake', init: async () => {}, fetch: async () => new Promise<unknown[]>(() => {}),
      }
      const e = engine(adapter, ladder())
      let settled = false
      void e.resolve('netease-track', '123').then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(600_000)
      expect(settled).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('returns null when no source can answer', async () => {
    const e = engine(fake({ zuna: () => [], tobiec: () => [] }, []), ladder())
    expect(await e.resolve('netease-track', '123')).toBeNull()
  })

  it('returns null for an unknown target-type', async () => {
    const e = engine(fake({}, []), ladder())
    expect(await e.resolve('nope', 'x')).toBeNull()
  })

  it('provider row order overrides the derived ladder (reorder + exclude) and counts attempts', async () => {
    const calls: string[] = []
    const counted: string[] = []
    const e = new ResolveEngine({
      registry: new Registry(ladder()),
      adapters: new Map([['fake', fake({ zuna: () => [{ url: 'a' }], tobiec: () => [{ url: 'b' }] }, calls)]]),
      health,
      resolveCreds: async () => ({}),
      buildParams: (_m, key) => ({ key }),
      providerRows: {
        // 行序把 tobiec 提到首位并排除 zuna（exclude 语义 = 不在序里）
        order: (tt) => (tt === 'netease-track' ? [{ name: 'tobiec' }] : null),
        count: (tt, member) => counted.push(`${tt}:${member}`),
      },
    })
    const r = await e.resolve('netease-track', '123')
    expect(r?.source).toBe('tobiec')
    expect(calls).toEqual(['tobiec']) // zuna 被行定义排除，从未尝试
    expect(counted).toEqual(['netease-track:tobiec'])
  })

  it('builds the ladder from row members even when they do not declare provides, filling $input params', async () => {
    // catalog sources: no `provides`, discovered only via the row's expanded members; the route
    // needs :id / :level? which arrive as member params ($input filled from the key).
    const seenParams: Array<Record<string, unknown>> = []
    const adapter: Adapter = {
      id: 'fake', init: async () => {},
      fetch: async (p, m) => { seenParams.push(p); return m.id === 'zuna-dl' ? [{ url: 'ok' }] : [] },
    }
    const catalog = [
      { schema_version: 1, id: 'zuna-dl', adapter: 'fake', type: 'post' as const, description: 'z', topics: [], example_queries: [], capabilities: ['timeline' as const], auth: { type: 'none' as const }, params_schema: {}, cadence_hint_seconds: 1800, discoverable: true, matchers: ['music.163.com/song'] },
      { schema_version: 1, id: 'toubiec-dl', adapter: 'fake', type: 'post' as const, description: 't', topics: [], example_queries: [], capabilities: ['timeline' as const], auth: { type: 'none' as const }, params_schema: {}, cadence_hint_seconds: 1800, discoverable: true, matchers: ['music.163.com/song'] },
    ]
    const e = new ResolveEngine({
      registry: new Registry(catalog),
      adapters: new Map([['fake', adapter]]),
      health,
      resolveCreds: async () => ({}),
      buildParams: (_m, key) => ({ url: key }),
      providerRows: {
        order: (tt) => (tt === 'netease-track'
          ? [{ name: 'zuna-dl', params: { id: '$input', level: 'lossless' } }, { name: 'toubiec-dl', params: { id: '$input', level: 'lossless' } }]
          : null),
        count: () => {},
      },
    })
    const r = await e.resolve('netease-track', '186016')
    expect(r?.source).toBe('zuna-dl') // provides-less catalog source reachable via the row
    expect(seenParams[0]).toEqual({ url: '186016', id: '186016', level: 'lossless' }) // $input filled
  })
})
