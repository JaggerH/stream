import { describe, it, expect } from 'vitest'
import { UserStore } from '../store/user-store.ts'
import { ProviderExecutor } from './executor.ts'
import { ProviderBindings } from './bindings.ts'
import { Registry } from '../registry/registry.ts'
import { isParked } from './parked.ts'
import { ProviderDirectory } from './directory.ts'
import { SYSTEM_IDENTITIES } from './system/index.ts'

const mkDirectory = (store: UserStore) => new ProviderDirectory(store, SYSTEM_IDENTITIES)

function mkExecutor(store: UserStore) {
  return new ProviderExecutor({ directory: mkDirectory(store), registry: new Registry([]), stats: { record() {} } as never, fetchSource: async () => null as never })
}

describe('parked provider 不参与 dispatch', () => {
  it('isParked 判据', () => {
    expect(isParked({ options: { parked: true } } as never)).toBe(true)
    expect(isParked({ options: {} } as never)).toBe(false)
    expect(isParked({ options: { parked: false } } as never)).toBe(false)
  })

  it('match() 排除 parked 行', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'live', label: 'L', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.putProvider({ id: 'parked', label: 'P', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: { parked: true } })
    const ex = mkExecutor(s)
    expect(ex.match('resolve', 'quark-verify').map((r) => r.id)).toEqual(['live'])
    expect(s.listActiveProviders().map((p) => p.id)).toEqual(['live'])
    s.close()
  })

  it('dispatch() 排除 parked 行（即便被塞进 binding 也不选）', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'parked', label: 'P', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: { parked: true } })
    s.putProviderBinding({ callsiteId: 'netdisk.share.verify', providerIds: ['parked'] })
    const b = new ProviderBindings(s, mkDirectory(s))
    expect(b.dispatch('netdisk.share.verify', 'quark-verify', undefined, { fallback: false })).toBeNull()
    s.close()
  })

  it('组合 {provider} 子若 parked → 不被调用（composition 路径也过滤 parked）', async () => {
    const s = new UserStore(':memory:')
    // A 活跃、组合引用 B；B parked
    s.putProvider({ id: 'A', label: 'A', description: '', category: 'resolve', serves: ['k'], strategy: 'sequential', members: [{ provider: 'B' }], contract: null, options: {} })
    s.putProvider({ id: 'B', label: 'B', description: '', category: 'resolve', serves: ['k'], strategy: 'sequential', members: [{ source: 'b-src' }], contract: null, options: { parked: true } })
    const fetched: string[] = []
    const ex = new ProviderExecutor({ directory: mkDirectory(s), registry: new Registry([]), stats: { record() {} } as never, fetchSource: async (id) => { fetched.push(id); return null as never } })
    await ex.invoke('A', 'input')
    expect(fetched).not.toContain('b-src') // parked B 未被组合调用
    s.close()
  })

  it('netdisk share capability：parked 的 quark-verify 行不算 supported（transitive）', async () => {
    const { NetdiskShareCapability } = await import('../netdisk/share-capability.ts')
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'quark-verify', label: 'QV', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: { parked: true } })
    const cap = new NetdiskShareCapability({ executor: mkExecutor(s), directory: mkDirectory(s) })
    expect(cap.supports('quark', 'verify')).toBe(false) // 选行已滤掉 parked → rowFor 返回 null
    s.close()
  })
})
