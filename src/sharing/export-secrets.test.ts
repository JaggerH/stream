import { describe, it, expect } from 'vitest'
import { scanSecrets, translateRequirements, buildDependencyCatalog, exportBundle } from './export-closure.ts'
import { UserStore } from '../store/user-store.ts'

describe('导出脱密', () => {
  it('scanSecrets 命中 params 里的疑似密钥', () => {
    const hits = scanSecrets([
      { plugin: 'p', source: 's', params: { apiKey: 'sk-live-123', page: 2 } },
      { plugin: 'p', source: 's2', params: { keyword: '正常' } },
    ])
    expect(hits.map((h) => h.field)).toContain('apiKey')
    expect(hits.map((h) => h.field)).not.toContain('keyword')
  })

  it('translateRequirements 只出 schema：域 + ref/fields，无值', () => {
    const catalog = buildDependencyCatalog({
      plugins: [], recipePackages: [],
      readManifest: (id) => id === 'x' ? ({ id: 'x', title: 'X', auth: { type: 'cookie', domain: 'xhs.com', inject: {} }, runtime_config: { ref: 'tmdb', fields: { apiKey: { type: 'secret', label: 'K' } } } } as never) : undefined,
      readEmbedded: () => undefined,
    })
    const req = translateRequirements([{ plugin: 'p', source: 'x', params: {} }], catalog)
    expect(req.credentials).toEqual([{ domain: 'xhs.com', reason: expect.any(String) }])
    expect(req.runtimeConfig).toEqual([{ ref: 'tmdb', fields: ['apiKey'] }])
    // 值绝不出现
    expect(JSON.stringify(req)).not.toContain('sk-')
  })

  it('勾选的 Provider 成员 params 藏密钥 → 拒绝导出（scanSecrets 覆盖 providers 块）', () => {
    const s = new UserStore(':memory:')
    s.putChannel({ id: 'c', label: 'C', present: 'timeline', stream_ids: [], options: {} })
    s.putProvider({ id: 'leaky', label: 'L', description: '', category: 'resolve', serves: ['x'], strategy: 'sequential',
      members: [{ source: 'q', params: { apiKey: 'sk-live-should-not-ship' } }], contract: null, options: {} })
    const cat = buildDependencyCatalog({ plugins: [], recipePackages: [], readManifest: () => undefined, readEmbedded: () => undefined })
    expect(() => exportBundle({ kind: 'channel', id: 'c' }, s, cat, { title: 'C', created: '2026-07-19', revision: '1.0.0' }, { providerIds: ['leaky'] }))
      .toThrow(/拒绝导出|secret|敏感/i)
    s.close()
  })
})
