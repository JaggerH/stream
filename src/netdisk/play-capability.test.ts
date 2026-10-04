import { describe, it, expect, vi } from 'vitest'
import { NetdiskPlayCapability } from './play-capability.ts'
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
  new NetdiskPlayCapability({ executor: { invoke } as unknown as ProviderExecutor, directory: directoryOf(rows) })
const seq = (value: unknown) => ({ strategy: 'sequential', provider: 'p', value, via: 'm', misses: [], timings: [] }) as any

describe('NetdiskPlayCapability', () => {
  it('refuses the wildcard fallback row: a netdisk without a play provider is null, not a fallback', async () => {
    const invoke = vi.fn(async () => seq({ url: 'http://x/y.mp4' }))
    const c = cap([row('fetch-url', ['*'])], invoke)
    expect(c.supports('baidu')).toBe(false)
    expect(await c.stream('baidu', 'fid')).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('supports a netdisk whose row explicitly serves <netdisk>-play', () => {
    expect(cap([row('netdisk-play-quark', ['quark-play'])]).supports('quark')).toBe(true)
  })

  it('resolves the transcoded stream (unpacks {url, resolution})', async () => {
    const invoke = vi.fn(async () => seq({ url: 'https://cdn/4k.mp4', resolution: '4k', width: 3840, audioCodec: 'aac' }))
    const c = cap([row('netdisk-play-quark', ['quark-play'])], invoke)
    const s = await c.stream('quark', '6a04')
    expect(s).toEqual({ url: 'https://cdn/4k.mp4', resolution: '4k', width: 3840, audioCodec: 'aac', videoCodec: undefined })
    expect(invoke).toHaveBeenCalledWith('netdisk-play-quark', '6a04')
  })

  it('returns null when the provider declines (no login / no transcode → value null)', async () => {
    const c = cap([row('netdisk-play-quark', ['quark-play'])], vi.fn(async () => ({ strategy: 'sequential', provider: 'p', value: null, via: null, misses: [], timings: [] }) as any))
    expect(await c.stream('quark', 'fid')).toBeNull()
  })

  it('returns null when the resolved object lacks a url', async () => {
    const c = cap([row('netdisk-play-quark', ['quark-play'])], vi.fn(async () => seq({ resolution: '4k' })))
    expect(await c.stream('quark', 'fid')).toBeNull()
  })

  it('prefers an explicit user binding over match()', async () => {
    const invoke = vi.fn(async () => seq({ url: 'https://cdn/x.mp4' }))
    const c = new NetdiskPlayCapability({
      executor: { invoke } as unknown as ProviderExecutor,
      directory: directoryOf([row('netdisk-play-quark', ['quark-play'])]),
      bindings: { dispatch: () => 'user-picked-row' } as any,
    })
    await c.stream('quark', 'fid')
    expect(invoke).toHaveBeenCalledWith('user-picked-row', 'fid')
  })

  // binding 那一路以前不挡兜底行——绑一条兜底行进来，不支持的网盘就成了「支持」。
  it('绑定里只有兜底行 → 仍然不支持（binding 那一路也挡兜底）', () => {
    const store = new UserStore(':memory:')
    store.putProvider({ id: 'fetch-url', label: '', description: '', category: 'resolve', serves: ['*'], strategy: 'sequential', members: [], contract: null, options: {} })
    store.putProviderBinding({ callsiteId: 'netdisk.play', providerIds: ['fetch-url'] })
    const directory = new ProviderDirectory(store, SYSTEM_IDENTITIES)
    const c = new NetdiskPlayCapability({
      executor: { invoke: vi.fn() } as unknown as ProviderExecutor,
      directory,
      bindings: new ProviderBindings(store, directory),
    })
    expect(c.supports('baidu')).toBe(false)
    store.close()
  })
})
