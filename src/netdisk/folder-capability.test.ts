import { describe, it, expect, vi } from 'vitest'
import { NetdiskFolderCapability } from './folder-capability.ts'
import type { ProviderExecutor } from '../providers/executor.ts'
import { ProviderDirectory } from '../providers/directory.ts'
import { ProviderBindings } from '../providers/bindings.ts'
import { SYSTEM_IDENTITIES } from '../providers/system/index.ts'
import { UserStore } from '../store/user-store.ts'

const row = (id: string, serves: string[]) => ({ id, serves }) as any
/** 守门测的是选行判据本身，所以给**真的** directory（stub 一漂移，用例就在错的东西上变绿）。 */
const directoryOf = (rows: any[]): ProviderDirectory => {
  const store = new UserStore(':memory:')
  for (const r of rows) store.putProvider({ id: r.id, label: r.id, description: '', category: 'resolve', serves: r.serves, strategy: 'sequential', members: [], contract: null, options: {} })
  return new ProviderDirectory(store, SYSTEM_IDENTITIES)
}
const cap = (rows: any[], invoke = vi.fn(async () => null as any)) =>
  new NetdiskFolderCapability({ executor: { invoke } as unknown as ProviderExecutor, directory: directoryOf(rows) })
const seq = (value: unknown) => ({ strategy: 'sequential', provider: 'p', value, via: 'm', misses: [], timings: [] }) as any

describe('NetdiskFolderCapability', () => {
  it('refuses the wildcard fallback: a netdisk without a folder provider is null', async () => {
    const invoke = vi.fn(async () => seq({ url: 'http://x' }))
    const c = cap([row('fetch-url', ['*'])], invoke)
    expect(c.supports('baidu')).toBe(false)
    expect(await c.folderUrl('baidu', ['a'])).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('supports a netdisk whose row serves <netdisk>-folder', () => {
    expect(cap([row('netdisk-folder-quark', ['quark-folder'])]).supports('quark')).toBe(true)
  })

  it('resolves the folder url (passes segments as the raw invoke input)', async () => {
    const invoke = vi.fn(async () => seq({ url: 'https://pan.quark.cn/list#/list/all/fidB', fid: 'fidB' }))
    const c = cap([row('netdisk-folder-quark', ['quark-folder'])], invoke)
    expect(await c.folderUrl('quark', ['From Stream', 'X'])).toEqual({ url: 'https://pan.quark.cn/list#/list/all/fidB', fid: 'fidB' })
    expect(invoke).toHaveBeenCalledWith('netdisk-folder-quark', ['From Stream', 'X'])
  })

  it('returns null when the provider declines (value null)', async () => {
    const c = cap([row('netdisk-folder-quark', ['quark-folder'])], vi.fn(async () => ({ strategy: 'sequential', provider: 'p', value: null, via: null, misses: [], timings: [] }) as any))
    expect(await c.folderUrl('quark', ['a'])).toBeNull()
  })

  // binding 那一路以前不挡兜底行——绑一条兜底行进来，不支持的网盘就成了「支持」。
  it('绑定里只有兜底行 → 仍然不支持（binding 那一路也挡兜底）', () => {
    const store = new UserStore(':memory:')
    store.putProvider({ id: 'fetch-url', label: '', description: '', category: 'resolve', serves: ['*'], strategy: 'sequential', members: [], contract: null, options: {} })
    store.putProviderBinding({ callsiteId: 'netdisk.folder', providerIds: ['fetch-url'] })
    const directory = new ProviderDirectory(store, SYSTEM_IDENTITIES)
    const c = new NetdiskFolderCapability({
      executor: { invoke: vi.fn() } as unknown as ProviderExecutor,
      directory,
      bindings: new ProviderBindings(store, directory),
    })
    expect(c.supports('baidu')).toBe(false)
    store.close()
  })
})
