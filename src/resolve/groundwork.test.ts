import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ResolveEngine } from './engine.ts'
import { Registry } from '../registry/registry.ts'
import { SourceHealthStore } from '../source-health-store.ts'
import type { Adapter } from '../adapters/types.ts'
import type { SourceManifest } from '../manifest/types.ts'

function mk(id: string, provides?: string[]): SourceManifest {
  return {
    schema_version: 1, id, adapter: 'fake', type: 'post', description: id,
    topics: [], example_queries: [], capabilities: ['timeline'],
    auth: { type: 'none' }, params_schema: {}, cadence_hint_seconds: 1800, discoverable: true,
    provides, key_param: 'key',
  }
}

describe('resolve groundwork (params + self-provide)', () => {
  let dir: string, health: SourceHealthStore
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gw-')); health = new SourceHealthStore(join(dir, 'h.json')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a source is addressable by its own id (implicit self-provide)', async () => {
    const registry = new Registry([mk('hn-best')]) // declares no provides
    expect(registry.providersOf('hn-best').map((m) => m.id)).toEqual(['hn-best'])
    expect(registry.providersOf('nope')).toEqual([])
  })

  it('resolve merges extra params into the fetch', async () => {
    let seen: Record<string, unknown> = {}
    const fake: Adapter = { id: 'fake', init: async () => {}, fetch: async (p) => { seen = p; return [{ ok: 1 }] } }
    const engine = new ResolveEngine({
      registry: new Registry([mk('hn-best')]),
      adapters: new Map([['fake', fake]]),
      health, resolveCreds: async () => ({}), buildParams: (_m, key) => ({ key }),
    })
    await engine.resolve('hn-best', 'k', { mode: 'user', count: 5 })
    expect(seen).toEqual({ key: 'k', mode: 'user', count: 5 })
  })
})
