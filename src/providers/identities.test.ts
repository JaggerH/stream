import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserStore } from '../store/user-store.ts'
import { SYSTEM_IDENTITIES } from './system/index.ts'
import { ensureSystemRows } from './seed.ts'
import { allIdentities, identityOf, packageCallsiteDefaults, setPackageIdentities } from './identities.ts'
import { PROVIDER_CALLSITES } from './callsites.ts'

const row = (over: Record<string, unknown> = {}) => ({
  facility: 'pkg',
  declaration: {
    id: 'pkg-track', category: 'resolve' as const, serveKeys: ['pkg', 'pkg.com'],
    strategy: 'sequential' as const, label: 'PKG 取歌', description: 'd',
    members: [{ mode: 'auto' as const, matches: 'pkg.com/song' }],
    callsites: ['music.track.resolve', 'music.track.download'],
    ...over,
  },
})

afterEach(() => setPackageIdentities([]))

describe('合并身份表', () => {
  it('没有包声明时 = 宿主静态表本身', () => {
    expect([...allIdentities().keys()]).toEqual([...SYSTEM_IDENTITIES.keys()])
  })
  it('包行并进来，形状是 SystemIdentity（default* 前缀已盖上）', () => {
    expect(setPackageIdentities([row()])).toEqual([])
    const got = identityOf('pkg-track')!
    expect(got).toMatchObject({
      id: 'pkg-track', category: 'resolve', serveKeys: ['pkg', 'pkg.com'], fallback: false,
      strategy: 'sequential', contract: null,
      defaultLabel: 'PKG 取歌', defaultDescription: 'd',
      defaultMembers: [{ mode: 'auto', matches: 'pkg.com/song' }],
    })
    expect(allIdentities().size).toBe(SYSTEM_IDENTITIES.size + 1)
  })
  it('expand 组合体的配置与 provides 能力标签照搬进身份（缺席就是没有这个键）', () => {
    const expand = { map: { detailUrl: '$item.detailUrl' }, assemble: { url: '$item.link', type: 'pathClassify', desc: '$item.title' } }
    setPackageIdentities([row({ id: 'pkg-combo', category: 'search', serveKeys: ['pkg-combo'], strategy: 'expand', expand, provides: ['search-download'], callsites: undefined })])
    expect(identityOf('pkg-combo')).toMatchObject({ strategy: 'expand', expand, provides: ['search-download'] })
    setPackageIdentities([row()])
    expect(identityOf('pkg-track')).not.toHaveProperty('expand')
    expect(identityOf('pkg-track')).not.toHaveProperty('provides')
  })
  it('callsites 并成「调用点 → 行 id」表，声明序', () => {
    setPackageIdentities([row()])
    expect(packageCallsiteDefaults().get('music.track.resolve')).toEqual(['pkg-track'])
    expect(packageCallsiteDefaults().get('music.track.download')).toEqual(['pkg-track'])
  })
  it('id 撞宿主行 → 拒这一条、不覆盖，其余照进', () => {
    const rejected = setPackageIdentities([row({ id: 'llm' }), row()])
    expect(rejected).toEqual([{ id: 'llm', facility: 'pkg', reason: 'id 已被现有 Provider 行占用' }])
    expect(identityOf('llm')).toBe(SYSTEM_IDENTITIES.get('llm'))
    expect(identityOf('pkg-track')).toBeDefined()
  })
  it('serveKeys 撞同 category 的现有行 → 拒', () => {
    const rejected = setPackageIdentities([row({ id: 'other', serveKeys: ['lyrics'] })])
    expect(rejected[0]).toMatchObject({ id: 'other', facility: 'pkg' })
    expect(rejected[0].reason).toMatch(/lyrics/)
    expect(identityOf('other')).toBeUndefined()
  })
  it('两个包声明同一个 serveKey → 后到的被拒（先到先得，且说清撞了谁）', () => {
    const rejected = setPackageIdentities([row(), { facility: 'other', declaration: { ...row().declaration, id: 'other-track' } }])
    expect(identityOf('pkg-track')).toBeDefined()
    expect(identityOf('other-track')).toBeUndefined()
    expect(rejected[0].facility).toBe('other')
  })
  it('不同 category 的同名 serveKey 不算撞（分发按 category 分表）', () => {
    expect(setPackageIdentities([row({ category: 'search', serveKeys: ['lyrics'] })])).toEqual([])
    expect(identityOf('pkg-track')).toBeDefined()
  })
  it('fallback 撞同 category 的现有兜底行 → 拒（否则静默多一条 catch-all）', () => {
    const rejected = setPackageIdentities([row({ id: 'pkg-llm', category: 'llm', serveKeys: [], fallback: true })])
    expect(rejected[0]).toMatchObject({ id: 'pkg-llm', facility: 'pkg' })
    expect(rejected[0].reason).toMatch(/llm/)
    expect(identityOf('pkg-llm')).toBeUndefined()
  })
  it('该 category 本来没有兜底 → 头一条包行可以当兜底，第二条被拒', () => {
    const rejected = setPackageIdentities([
      row({ id: 'first', fallback: true }),
      row({ id: 'second', serveKeys: ['other'], fallback: true }),
    ])
    expect(identityOf('first')!.fallback).toBe(true)
    expect(identityOf('second')).toBeUndefined()
    expect(rejected[0]).toMatchObject({ id: 'second' })
    expect(rejected[0].reason).toMatch(/first/)
  })
  it('callsites 指向一个不是 dispatch 调用点的 id → 拒这一条并说清原因', () => {
    for (const bad of ['search.music', 'nope.not.a.callsite']) {
      const rejected = setPackageIdentities([row({ callsites: [bad] })])
      expect(rejected[0]).toMatchObject({ id: 'pkg-track', facility: 'pkg' })
      expect(rejected[0].reason).toContain(bad)
      expect(identityOf('pkg-track')).toBeUndefined()
    }
  })
  it('dispatch 调用点的名单派生自 PROVIDER_CALLSITES，不是写死的两个', () => {
    const dispatchIds = PROVIDER_CALLSITES.filter((c) => c.mode === 'dispatch').map((c) => c.id)
    expect(setPackageIdentities([row({ callsites: dispatchIds })])).toEqual([])
  })
  it('setPackageIdentities([]) 把表清回宿主静态表（测试之间不串味）', () => {
    setPackageIdentities([row()])
    setPackageIdentities([])
    expect(identityOf('pkg-track')).toBeUndefined()
    expect(packageCallsiteDefaults().size).toBe(0)
  })
})

/**
 * **消费方现取**——本任务真正要钉住的那条性质：`UserStore` / `ensureSystemRows` 在包行挂上
 * **之前**就已经存在（store 的构造早于包装配），所以它们读身份表必须是调用时现取。任一处在
 * 模块加载或构造期抓一份快照，症状都是"用户装了包，那条行既不建、也不收窄"，而且一声不吭。
 */
describe('消费方读的是合并表，且是调用时现取', () => {
  const fresh = () => {
    const dir = mkdtempSync(join(tmpdir(), 'identities-'))
    const store = new UserStore(join(dir, 'stream.db'))
    return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
  }

  it('store 先建、包行后挂 → ensureSystemRows 照样把它建成系统行，putProvider 照样按它收窄', () => {
    const { store, cleanup } = fresh()
    try {
      // store 早于包装配——这个顺序就是活体的顺序，不是为了好看。
      expect(store.getProvider('pkg-track')).toBeNull()
      setPackageIdentities([row()])

      expect(ensureSystemRows(store).retired).toEqual([])
      const seeded = store.getProvider('pkg-track')!
      expect(seeded).toMatchObject({
        system: true, category: 'resolve', serves: ['pkg', 'pkg.com'],
        strategy: 'sequential', label: 'PKG 取歌',
      })

      // 写侧收窄：身份字段一律取代码身份，调用方传什么都不作数。
      const written = store.putProvider({
        ...seeded, category: 'search', serves: ['bogus'], strategy: 'concurrent', label: '用户改的名字',
      })
      expect(written).toMatchObject({ category: 'resolve', serves: ['pkg', 'pkg.com'], strategy: 'sequential' })
      expect(written.label).toBe('用户改的名字')   // 编排/文案照常归用户
    } finally { cleanup() }
  })

  it('包出的 expand 组合体行建成系统行时带上 expand 配置（缺了它就是一条取不到东西的顺序梯子）', () => {
    const { store, cleanup } = fresh()
    try {
      const expand = { map: { detailUrl: '$item.detailUrl' }, assemble: { url: '$item.link', type: 'pathClassify', desc: '$item.title' } }
      setPackageIdentities([row({ id: 'pkg-combo', category: 'search', serveKeys: ['pkg-combo'], strategy: 'expand', expand, provides: ['search-download'], callsites: undefined })])
      ensureSystemRows(store)
      expect(store.getProvider('pkg-combo')).toMatchObject({ system: true, strategy: 'expand', expand })
    } finally { cleanup() }
  })

  it('包行卸掉之后那条行被清退（清退判据同样现取）', () => {
    const { store, cleanup } = fresh()
    try {
      setPackageIdentities([row()])
      ensureSystemRows(store)
      expect(store.getProvider('pkg-track')).not.toBeNull()

      setPackageIdentities([])
      expect(ensureSystemRows(store).retired.map((r) => r.id)).toEqual(['pkg-track'])
      expect(store.getProvider('pkg-track')).toBeNull()
    } finally { cleanup() }
  })
})

describe('声明行里的裸名成员自动加包名', () => {
  const qrow = (members: unknown[]) => ({
    facility: 'x', packageName: '@t/x',
    declaration: {
      id: 'x-resolve', category: 'resolve', serveKeys: ['x-video'], strategy: 'sequential',
      label: 'X', description: 'D', members,
    },
  }) as never

  it('{source:"local"} → {source:"@t/x/local"}', () => {
    expect(setPackageIdentities([qrow([{ source: 'local-src' }])])).toEqual([])
    expect(identityOf('x-resolve')?.defaultMembers).toEqual([{ source: '@t/x/local-src' }])
  })
  it('已经是全名的不动', () => {
    setPackageIdentities([qrow([{ source: '@other/pkg/src' }])])
    expect(identityOf('x-resolve')?.defaultMembers).toEqual([{ source: '@other/pkg/src' }])
  })
  it('rsshub: 目录路由不动（它不归任何包）', () => {
    setPackageIdentities([qrow([{ source: 'rsshub:ns/route/:p' }])])
    expect(identityOf('x-resolve')?.defaultMembers).toEqual([{ source: 'rsshub:ns/route/:p' }])
  })
  it('{mode:"auto"} 之类的扩展式原样留着', () => {
    setPackageIdentities([qrow([{ mode: 'auto', provides: 'search-content' }])])
    expect(identityOf('x-resolve')?.defaultMembers).toEqual([{ mode: 'auto', provides: 'search-content' }])
  })
  it('包没有 npm 名（packageName 缺席）→ 裸名原样留着，不瞎拼', () => {
    const { packageName: _omit, ...noName } = qrow([{ source: 'local-src' }]) as { packageName?: string; facility: string; declaration: unknown }
    setPackageIdentities([noName as never])
    expect(identityOf('x-resolve')?.defaultMembers).toEqual([{ source: 'local-src' }])
  })
})
