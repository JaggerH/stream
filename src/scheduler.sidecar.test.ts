import { describe, it, expect, vi } from 'vitest'
import { Scheduler } from './scheduler.ts'
import type { Adapter } from './adapters/types.ts'
import type { SourceManifest } from './manifest/types.ts'
import { Registry } from './registry/registry.ts'
import { DedupStore } from './dedup-store.ts'

function manifest(over: Partial<SourceManifest> = {}): SourceManifest {
  return { schema_version: 1, id: 'fake-src', adapter: 'fake', type: 'post', description: 'x'.repeat(25),
    topics: ['t'], example_queries: [], capabilities: ['timeline'], auth: { type: 'none' },
    params_schema: {}, cadence_hint_seconds: 1800, discoverable: true, ...over }
}

function makeScheduler(adapter: Adapter, m: SourceManifest) {
  const registry = new Registry([m])
  return new Scheduler({ registry, streams: [], adapters: new Map([[adapter.id, adapter]]),
    resolveCreds: async () => ({ TOKEN: 'v' }), vaultRoot: '/tmp', vaultEnabled: false,
    dedup: new DedupStore(':memory:') })
}

describe('scheduler sidecar lifecycle', () => {
  it('starts + health-gates an adapter sidecar before fetch', async () => {
    const order: string[] = []
    const adapter: Adapter = {
      id: 'fake', init: async () => { order.push('init') },
      fetch: async () => { order.push('fetch'); return [] },
      sidecar: { start: async () => { order.push('start') }, health: async () => { order.push('health'); return true }, shutdown: async () => { order.push('shutdown') } },
    }
    const s = makeScheduler(adapter, manifest({ adapter: 'fake' }))
    await s.readSource('fake-src')
    expect(order).toEqual(['init', 'start', 'health', 'fetch'])
  })

  it('throws when the sidecar is unhealthy', async () => {
    const adapter: Adapter = { id: 'fake', init: async () => {}, fetch: async () => [],
      sidecar: { start: async () => {}, health: async () => false, shutdown: async () => {} } }
    const s = makeScheduler(adapter, manifest({ adapter: 'fake' }))
    await expect(s.readSource('fake-src')).rejects.toThrow(/unhealthy/)
  })

  it('shutdownAdapters() shuts every adapter sidecar down', async () => {
    const shutdown = vi.fn(async () => {})
    const adapter: Adapter = { id: 'fake', init: async () => {}, fetch: async () => [],
      sidecar: { start: async () => {}, health: async () => true, shutdown } }
    const s = makeScheduler(adapter, manifest({ adapter: 'fake' }))
    await s.shutdownAdapters()
    expect(shutdown).toHaveBeenCalledOnce()
  })
})
