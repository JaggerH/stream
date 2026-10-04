import { describe, it, expect } from 'vitest'
import { UserStore } from '../store/user-store.ts'
import { exportBundle, buildDependencyCatalog } from './export-closure.ts'

function storeWithChannel(): UserStore {
  const s = new UserStore(':memory:')
  s.putStream({ id: 's1', label: 'S1', strategy: 'fanout', cadence_seconds: 3600, members: [{ plugin: 'xhs', source: 'xhs-home', params: {} }], options: {} })
  s.putChannel({ id: 'mine', label: 'Mine', present: 'timeline', stream_ids: ['s1'], options: {} })
  return s
}
const catalog = buildDependencyCatalog({
  plugins: [{ id: 'Douyin_TikTok_Download_API', homepage: 'https://d' } as never],
  recipePackages: [{ facility: 'xhs', schemaVersion: 1, dir: '/r/xhs', sources: [{ id: 'xhs-home' } as never] } as never],
  readManifest: (id) => id === 'xhs-home' ? ({ id, title: 'XHS', auth: { type: 'cookie', domain: 'xhs.com', inject: {} } } as never) : undefined,
  readEmbedded: (f) => f === 'xhs' ? { facility: 'xhs', author: 'alice', version: '2.1.3', packageJson: JSON.stringify({ name: '@streamapp/xhs', version: '2.1.3', author: 'alice', stream: { type: 'recipe', facility: 'xhs', schemaVersion: 1 } }), recipeFiles: { 'xhs-home.recipe.json': '{"sourceId":"xhs-home"}' } } : undefined,
})
const meta = { title: 'Mine', created: '2026-07-18', revision: '1.0.0' }

describe('exportBundle', () => {
  it('Channel 根：配置行 + recipe 内嵌 + credentials 声明', () => {
    const s = storeWithChannel()
    const { bundle } = exportBundle({ kind: 'channel', id: 'mine' }, s, catalog, meta)
    expect(bundle.channels[0].id).toBe('mine')
    expect(bundle.streams[0].id).toBe('s1')
    expect(bundle.embedded.recipes['xhs'].version).toBe('2.1.3')
    expect(bundle.requires.credentials).toEqual([{ domain: 'xhs.com', reason: expect.any(String) }])
    s.close()
  })

  // §7.3：导出端把成员 id 解析成**全名**再写进 bundle —— bundle 自带命名空间，对面机器上零歧义、
  // 也不依赖它装了什么。裸名解析在那边退化成只对旧 bundle 的兜底。
  it('成员 id 写全名（库里存的是裸名，导出时解析一次）', () => {
    const s = new UserStore(':memory:')
    s.putStream({
      id: 's1', label: 'S1', strategy: 'fanout', cadence_seconds: 3600,
      members: [{ plugin: 'xhs', source: 'xhs-home', params: {} }], options: {},
    })
    s.putChannel({ id: 'mine', label: 'Mine', present: 'timeline', stream_ids: ['s1'], options: {} })
    const ns = buildDependencyCatalog({
      plugins: [],
      recipePackages: [{ facility: 'xhs', schemaVersion: 1, dir: '/r/xhs', sources: [{ id: '@streamapp/xhs/xhs-home' } as never] } as never],
      // registry 按裸名解析得到全名（第 3 级），manifest 自报的 id 就是全名。
      readManifest: (id) => (id === 'xhs-home' || id === 'xhs:xhs-home' || id === '@streamapp/xhs/xhs-home')
        ? ({ id: '@streamapp/xhs/xhs-home', title: 'XHS', auth: { type: 'none' } } as never) : undefined,
      readEmbedded: () => undefined,
    })
    const { bundle } = exportBundle({ kind: 'channel', id: 'mine' }, s, ns, meta)
    expect(bundle.streams[0].members[0].source).toBe('@streamapp/xhs/xhs-home')
    expect(bundle.streams[0].members[0].plugin).toBe('xhs') // plugin 那一格不动，它是另一个字段
    s.close()
  })

  it('解析不到的成员原样保留（catalog id / 已卸载的源，不能凭空改写）', () => {
    const s = new UserStore(':memory:')
    s.putStream({
      id: 's1', label: 'S1', strategy: 'fanout', cadence_seconds: 3600,
      members: [{ plugin: 'rsshub', source: 'nyaa/search/:query?', params: {} }], options: {},
    })
    s.putChannel({ id: 'mine', label: 'Mine', present: 'timeline', stream_ids: ['s1'], options: {} })
    const none = buildDependencyCatalog({ plugins: [], recipePackages: [], readManifest: () => undefined, readEmbedded: () => undefined })
    const { bundle } = exportBundle({ kind: 'channel', id: 'mine' }, s, none, meta)
    expect(bundle.streams[0].members[0].source).toBe('nyaa/search/:query?')
    s.close()
  })

  it('无密钥值快照：全包文本不含任何凭证/密钥的实际值', () => {
    const s = storeWithChannel()
    const { bundle } = exportBundle({ kind: 'channel', id: 'mine' }, s, catalog, meta)
    const text = JSON.stringify(bundle)
    expect(text).not.toMatch(/sk-|Bearer |__pus|cookie=/i)
    expect(text).toContain('xhs.com') // 声明在，值不在
    s.close()
  })

  it('params 藏密钥 → 拒绝导出', () => {
    const s = new UserStore(':memory:')
    s.putStream({ id: 's9', label: 'S', strategy: 'fanout', cadence_seconds: 3600, members: [{ plugin: 'p', source: 'q', params: { apiKey: 'sk-live-xxx' } }], options: {} })
    s.putChannel({ id: 'c9', label: 'C', present: 'timeline', stream_ids: ['s9'], options: {} })
    expect(() => exportBundle({ kind: 'channel', id: 'c9' }, s, catalog, meta)).toThrow(/拒绝导出|secret|敏感/i)
    s.close()
  })

  it('超阈值给体积警告', () => {
    const s = storeWithChannel()
    const { warnings } = exportBundle({ kind: 'channel', id: 'mine' }, s, catalog, { ...meta }, { sizeWarnBytes: 10 })
    expect(warnings.some((w) => /体积|size/i.test(w))).toBe(true)
    s.close()
  })

  it('勾选：带上非系统 Provider + binding 覆盖，系统行不进包', () => {
    const s = storeWithChannel()
    s.putProvider({ id: 'mine-quark', label: '我的夸克', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} })
    // 系统行按**代码身份表**认（不看行上的 `system` 位），所以这里得用一个真实的系统 id。
    // （网盘行归包之后宿主表里没有它们，这里用宿主自己的 download-resolve；包行进合并身份表后同样被剔除。）
    s.putProvider({ id: 'download-resolve', label: '系统行', description: '', category: 'resolve', serves: ['download'], strategy: 'sequential', members: [], contract: null, options: {}, system: true })
    s.putProviderBinding({ callsiteId: 'netdisk.share.verify', providerIds: ['mine-quark'] })

    const { bundle } = exportBundle(
      { kind: 'channel', id: 'mine' }, s, catalog, meta,
      { providerIds: ['mine-quark', 'download-resolve'], bindingCallsiteIds: ['netdisk.share.verify'] },
    )
    expect(bundle.providers?.map((p) => p.id)).toContain('mine-quark')
    expect(bundle.providers?.map((p) => p.id)).not.toContain('download-resolve') // 系统行剔除
    expect(bundle.providerBindings?.[0]).toMatchObject({ callsiteId: 'netdisk.share.verify', providerIds: ['mine-quark'] })
    s.close()
  })

  it('不勾选：即便频道运行时会用到 Provider，包内 providers/providerBindings 也为空', () => {
    const s = storeWithChannel()
    const { bundle } = exportBundle({ kind: 'channel', id: 'mine' }, s, catalog, meta)
    expect(bundle.providers ?? []).toHaveLength(0)
    expect(bundle.providerBindings ?? []).toHaveLength(0)
    s.close()
  })
})

describe('exportBundle × netdiskBindings', () => {
  it('scanSecrets 覆盖 netdiskBindings：matchSpec 里混入疑似密钥 → 拒导出', () => {
    const s = storeWithChannel()
    const poisoned = [{ left: { kind: 'tmdb', id: '1', media: 'movie', title: 'X' }, matchSpec: { version: 1, apiKey: 'sk-leak' } as never }]
    expect(() => exportBundle({ kind: 'channel', id: 'mine' }, s, catalog, meta, { netdiskBindings: poisoned as never }))
      .toThrow(/拒绝导出|密钥|secret|敏感/i)
    s.close()
  })

  it('stream-left binding 的 stream 未随包 → 告缺 warning，不静默', () => {
    const s = storeWithChannel()
    const nb = [{ left: { kind: 'stream', streamId: 's-missing', title: '某剧' } }]
    const { bundle, warnings } = exportBundle({ kind: 'channel', id: 'mine' }, s, catalog, meta, { netdiskBindings: nb as never })
    expect(warnings.some((w) => w.includes('s-missing'))).toBe(true)
    expect(bundle.netdiskBindings).toHaveLength(1)
    s.close()
  })

  it('tmdb-left binding 直接写进包，无需任何 stream', () => {
    const s = storeWithChannel()
    const nb = [{ left: { kind: 'tmdb', id: '1399', media: 'tv', title: '权游' }, matchSpec: { version: 2 } as never }]
    const { bundle, warnings } = exportBundle({ kind: 'channel', id: 'mine' }, s, catalog, meta, { netdiskBindings: nb as never })
    expect(bundle.netdiskBindings?.[0].left).toMatchObject({ kind: 'tmdb', id: '1399' })
    expect(warnings.filter((w) => w.includes('未随包'))).toHaveLength(0)
    s.close()
  })
})
