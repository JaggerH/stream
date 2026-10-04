import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { UserStore } from '../store/user-store.ts'
import { exportBundle, buildDependencyCatalog } from './export-closure.ts'
import { importBundle } from './import-bundle.ts'

describe('export→import round-trip 等价', () => {
  it('导出再导入到干净库，重建等价编排', () => {
    const src = new UserStore(':memory:')
    src.putStream({ id: 's1', label: 'S1', strategy: 'fanout', cadence_seconds: 3600, members: [{ plugin: 'rsshub', source: 'a', params: { page: 1 } }], options: { vault_subdir: 'x' } })
    src.putStream({ id: 's2', label: 'S2', strategy: 'exclusive', cadence_seconds: 1800, members: [{ plugin: 'rsshub', source: 'b', params: {} }], options: {} })
    src.putChannel({ id: 'mine', label: 'Mine', present: 'timeline', stream_ids: ['s1', 's2'], options: {} })

    const catalog = buildDependencyCatalog({ plugins: [{ id: 'rsshub', homepage: 'https://r' } as never], recipePackages: [], readManifest: () => undefined, readEmbedded: () => undefined })
    const { bundle } = exportBundle({ kind: 'channel', id: 'mine' }, src, catalog, { title: 'Mine', created: '2026-07-18', revision: '1.0.0' })

    const dst = new UserStore(':memory:')
    importBundle(bundle, {
      store: dst, installedPlugins: new Set(['rsshub']), installedRecipes: new Map(),
      installRecipePackage: vi.fn(),
    })

    expect(dst.getChannel('mine')?.stream_ids.sort()).toEqual(['s1', 's2'])
    expect(dst.getStream('s1')?.members).toEqual([{ plugin: 'rsshub', source: 'a', params: { page: 1 } }])
    expect(dst.getStream('s2')?.strategy).toBe('exclusive')
    src.close(); dst.close()
  })
})
