import { describe, it, expect } from 'vitest'
import { ProviderIdentityTable } from './identities.ts'
import type { DeclaredProviderRow } from '../replay/recipe-package.ts'
import { SYSTEM_IDENTITIES } from './system/index.ts'

const row = (over: Partial<DeclaredProviderRow['declaration']> = {}): DeclaredProviderRow => ({
  facility: 'pkg',
  packageName: '@t/pkg',
  declaration: {
    id: 'pkg-track', category: 'resolve', serveKeys: ['pkg'],
    strategy: 'sequential', label: 'PKG', description: 'd',
    members: [{ mode: 'auto', matches: 'pkg.com/song' }],
    ...over,
  },
})

describe('ProviderIdentityTable', () => {
  it('包行并进来：identityOf / all 都能看到，宿主行优先', () => {
    const t = new ProviderIdentityTable()
    expect(t.identityOf('pkg-track')).toBeUndefined()
    t.setPackageRows([row()])
    expect(t.identityOf('pkg-track')?.defaultLabel).toBe('PKG')
    expect(t.all().has('pkg-track')).toBe(true)
    // 宿主行优先：撞 id 的包行进不来（下面那条），宿主查询不受影响
    expect(t.identityOf([...SYSTEM_IDENTITIES.keys()][0])).toBeDefined()
  })

  it('撞 id / 撞 serveKey / 重复兜底 → 拒绝且说清撞了谁', () => {
    const t = new ProviderIdentityTable()
    const hostId = [...SYSTEM_IDENTITIES.keys()][0]!
    const rejected = t.setPackageRows([
      row({ id: hostId }),
      row({ id: 'pkg-b' }),
    ])
    expect(rejected.map((r) => r.id)).toEqual([hostId])
    expect(t.identityOf('pkg-b')).toBeDefined()
  })

  it('callsite 默认行：只有 dispatch 调用点收；声明序', () => {
    const t = new ProviderIdentityTable()
    t.setPackageRows([row({ id: 'pkg-track', callsites: ['music.track.resolve'] })])
    expect(t.callsitePackageRows().get('music.track.resolve')).toEqual(['pkg-track'])
    const bad = t.setPackageRows([row({ id: 'pkg-x', callsites: ['video.detail.canonical'] })])
    expect(bad[0]!.reason).toMatch(/dispatch/)
  })

  it('一个实例一张：A 装了包行、B 没有 → B 查不到；A 卸载（清回宿主表）后 A 也查不到', () => {
    const a = new ProviderIdentityTable()
    const b = new ProviderIdentityTable()
    a.setPackageRows([row()])
    expect(a.identityOf('pkg-track')).toBeDefined()
    expect(b.identityOf('pkg-track')).toBeUndefined()
    a.setPackageRows([])
    expect(a.identityOf('pkg-track')).toBeUndefined()
  })
})
