import { describe, it, expect, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { UserStore } from '../store/user-store.ts'
import { exportBundle, buildDependencyCatalog, scanSecrets } from './export-closure.ts'
import { writeEmbeddedToDir, isSafeSegment } from './recipe-embed.ts'
import { importBundle } from './import-bundle.ts'
import { STREAM_BUNDLE_FORMAT, type StreamBundleV1 } from './bundle-format.ts'

const catalog = buildDependencyCatalog({ plugins: [], recipePackages: [], readManifest: () => undefined, readEmbedded: () => undefined })
const meta = { title: 'M', created: '2026-07-18', revision: '1.0.0' }

describe('C2/I1/I2 — 密钥扫描覆盖 provider 成员、camelCase、options', () => {
  it('scanSecrets 深扫命中 camelCase 键（xsecToken/accessToken）', () => {
    const hits = scanSecrets([{ params: { xsecToken: 'real', accessToken: 'x', keyword: '正常' } }])
    const fields = hits.map((h) => h.field)
    expect(fields).toContain('xsecToken')
    expect(fields).toContain('accessToken')
    expect(fields).not.toContain('keyword')
  })

  it('stream.options 里的密钥被拦（拒绝导出）', () => {
    const s = new UserStore(':memory:')
    s.putStream({ id: 's1', label: 'S', strategy: 'fanout', cadence_seconds: 3600, members: [{ plugin: 'p', source: 'q', params: {} }], options: { apiKey: 'sk-live-in-options' } })
    s.putChannel({ id: 'c', label: 'C', present: 'timeline', stream_ids: ['s1'], options: {} })
    expect(() => exportBundle({ kind: 'channel', id: 'c' }, s, catalog, meta)).toThrow(/拒绝导出|敏感|secret/i)
    s.close()
  })

  it('provider 成员 params 里的密钥被拦（provider 根导出）', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'pv', label: 'PV', description: 'd', category: 'search', serves: ['*'], strategy: 'concurrent', members: [{ source: 'x', params: { sessionToken: 'sk-secret' } }], options: {} })
    expect(() => exportBundle({ kind: 'provider', id: 'pv' }, s, catalog, meta)).toThrow(/拒绝导出|敏感|secret/i)
    s.close()
  })
})

describe('C1 — writeEmbeddedToDir 防目录穿越', () => {
  it('facility 含 .. → 抛，不在目标根外写文件', () => {
    expect(isSafeSegment('xhs')).toBe(true)
    expect(isSafeSegment('../evil')).toBe(false)
    expect(isSafeSegment('a/b')).toBe(false)
    const root = join(tmpdir(), `rw-${randomUUID()}`)
    expect(() => writeEmbeddedToDir({ facility: '../evil', packageJson: 'x', recipeFiles: {} }, root)).toThrow()
  })
})

describe('C1 — importBundle 恶意 facility 落 corrupt 台账、不装、不崩', () => {
  it('embedded facility 含 .. → 记 corrupt、跳过安装', () => {
    const s = new UserStore(':memory:')
    const bundle: StreamBundleV1 = {
      format: STREAM_BUNDLE_FORMAT, meta: { title: 'M', created: '2026-07-18', revision: '1.0.0' },
      channels: [], streams: [{ id: 's', label: 'S', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {} }], providers: [],
      requires: { plugins: [], recipes: [], credentials: [], runtimeConfig: [] },
      embedded: { recipes: { evil: { facility: '../../evil', packageJson: 'x', recipeFiles: {} } } },
    }
    const install = vi.fn()
    const r = importBundle(bundle, { store: s, installedPlugins: new Set(), installedRecipes: new Map(), installRecipePackage: install })
    expect(install).not.toHaveBeenCalled()
    expect(r.items.some((i) => i.kind === 'notice' && (i.subject as { reason?: string }).reason === 'corrupt')).toBe(true)
    s.close()
  })
})

describe('M1 — remap 目标不撞另一个包内 id', () => {
  it('包内 s1(撞车) 与 s1-imported(不撞) 各得不同 id', () => {
    const s = new UserStore(':memory:')
    // 本机 s1 与包内 s1 members 不同 → 是「异流撞 id」，必须 fork（同源会走复用，不触发 M1）
    s.putStream({ id: 's1', label: 'LOCAL', strategy: 'fanout', cadence_seconds: 3600, members: [{ plugin: 'p', source: 'local', params: {} }], options: {} })
    const bundle: StreamBundleV1 = {
      format: STREAM_BUNDLE_FORMAT, meta: { title: 'M', created: '2026-07-18', revision: '1.0.0' },
      channels: [],
      streams: [
        { id: 's1', label: 'A', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {} },
        { id: 's1-imported', label: 'B', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {} },
      ],
      providers: [], requires: { plugins: [], recipes: [], credentials: [], runtimeConfig: [] }, embedded: { recipes: {} },
    }
    const r = importBundle(bundle, { store: s, installedPlugins: new Set(), installedRecipes: new Map(), installRecipePackage: vi.fn() })
    // s1 撞本机 → remap；s1-imported 不撞本机但不能等于 s1 的 remap 目标
    const s1New = r.remaps['s1']
    expect(s1New).toBeTruthy()
    expect(s1New).not.toBe('s1-imported')
    expect(s.getStream('s1')?.label).toBe('LOCAL')       // 本机原行不动
    expect(s.getStream('s1-imported')?.label).toBe('B')  // 第二行落在 s1-imported
    expect(s.getStream(s1New!)?.label).toBe('A')         // 第一行落在新 id
    s.close()
  })
})
