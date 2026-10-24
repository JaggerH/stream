import { describe, expect, it, vi } from 'vitest'
import { PluginTargets, resolvePluginTarget, pluginNetMode } from './plugin-target.ts'
import { StandbyHooks } from './standby/hook.ts'
import type { PluginDescriptor } from './types.ts'

const descs: PluginDescriptor[] = [
  { id: 'pansou', backend: { image: 'x', service: 'pansou', port: 8888 } } as PluginDescriptor,
  { id: 'alist', backend: { image: 'x', port: 5244 } } as PluginDescriptor, // service 缺省 → 用 id
  { id: 'builtin' } as PluginDescriptor, // 无 backend
]

describe('resolvePluginTarget', () => {
  it('compose 形态：有 backend → http://<service>:<port>', () => {
    expect(resolvePluginTarget('pansou', { descriptors: descs, mode: 'compose' })).toBe('http://pansou:8888')
  })
  it('service 缺省用包 id', () => {
    expect(resolvePluginTarget('alist', { descriptors: descs, mode: 'compose' })).toBe('http://alist:5244')
  })
  it('无 backend 的包 / 不认识的 service → null（none 形态一律 null）', () => {
    expect(resolvePluginTarget('builtin', { descriptors: descs, mode: 'compose' })).toBeNull()
    expect(resolvePluginTarget('nope', { descriptors: descs, mode: 'compose' })).toBeNull()
    expect(resolvePluginTarget('pansou', { descriptors: descs, mode: 'none' })).toBeNull()
    expect(resolvePluginTarget('pansou', { descriptors: descs, mode: 'host' })).toBeNull()
  })
})

describe('pluginNetMode', () => {
  it('STREAM_PLUGIN_NETWORK 的三档', () => {
    expect(pluginNetMode({ STREAM_PLUGIN_NETWORK: 'compose' } as NodeJS.ProcessEnv)).toBe('compose')
    expect(pluginNetMode({ STREAM_PLUGIN_NETWORK: 'host' } as NodeJS.ProcessEnv)).toBe('host')
    expect(pluginNetMode({} as NodeJS.ProcessEnv)).toBe('none')
  })
})

describe('PluginTargets（实例）', () => {
  it('未接线 → 一律 null（等价 mode=none），peek 与否都一样', () => {
    const t = new PluginTargets(new StandbyHooks())
    expect(t.target('pansou')).toBeNull()
    expect(t.target('pansou', { peek: true })).toBeNull()
  })

  it('接线后 resolver 生效；答空时喊一声（非 peek）', () => {
    const t = new PluginTargets(new StandbyHooks())
    const miss = vi.fn()
    t.bind(() => null, miss)
    expect(t.target('nope')).toBeNull()
    expect(miss).toHaveBeenCalledWith('nope')
  })

  it('peek 只掐喊声，答什么不变；reporter 抛错不影响返回', () => {
    const t = new PluginTargets(new StandbyHooks())
    const miss = vi.fn(() => { throw new Error('reporter crashed') })
    t.bind(() => null, miss)
    expect(t.target('nope', { peek: true })).toBeNull()
    expect(miss).not.toHaveBeenCalled()
    expect(t.target('nope')).toBeNull() // reporter 抛了也不影响
    expect(miss).toHaveBeenCalledTimes(1)
  })

  it('复位（内核 dispose）→ 回到未接线', () => {
    const t = new PluginTargets(new StandbyHooks())
    t.bind((s) => (s === 'pansou' ? 'http://pansou:8888' : null), null)
    expect(t.bound).toBe(true)
    expect(t.target('pansou')).toBe('http://pansou:8888')
    t.bind(null, null)
    expect(t.bound).toBe(false)
    expect(t.target('pansou')).toBeNull()
  })

  it('一个实例一份：A 接了 resolver，B 读不到（答空也不喊 A 的 reporter）', () => {
    const a = new PluginTargets(new StandbyHooks())
    const b = new PluginTargets(new StandbyHooks())
    const missA = vi.fn()
    a.bind((s) => (s === 'pansou' ? 'http://a:8888' : null), missA)
    expect(a.target('pansou')).toBe('http://a:8888')
    expect(b.target('pansou')).toBeNull()
    expect(missA).not.toHaveBeenCalled() // B 的答空不经过 A 的 reporter
  })
})

describe('StandbyHooks（实例）', () => {
  it('未接线：withAwake 直跑、origin/managed/diagnose 全空、inertReason 可读', async () => {
    const h = new StandbyHooks()
    h.setInertReason({ kind: 'no-docker' } as never)
    expect(await h.withAwake('x', async () => 7)).toBe(7)
    expect(h.origin('x')).toBeNull()
    expect(h.managed('x')).toBe(false)
    expect(await h.diagnose('x')).toBeNull()
    expect(h.inertReason()).toEqual({ kind: 'no-docker' })
    expect(h.bound).toBe(false)
  })

  it('接线后 manager 生效、inertReason 归 null；复位又回来', async () => {
    const h = new StandbyHooks()
    h.setInertReason({ kind: 'no-docker' } as never)
    const woken: string[] = []
    const fake = {
      withAwake: async (s: string, fn: () => Promise<number>) => { woken.push(s); return fn() },
      ensureAwake: async () => {},
      origin: (s: string) => `http://awake:${s}`,
      managed: (s: string) => s === 'mineru',
      snapshot: () => [],
      diagnose: async (s: string) => ({ service: s }) as never,
    } as never
    h.bind(fake)
    expect(h.bound).toBe(true)
    expect(h.inertReason()).toBeNull()
    expect(await h.withAwake('mineru', async () => 1)).toBe(1)
    expect(woken).toEqual(['mineru'])
    expect(h.origin('mineru')).toBe('http://awake:mineru')
    expect(h.managed('mineru')).toBe(true)
    h.bind(null)
    expect(h.bound).toBe(false)
    expect(h.inertReason()).toEqual({ kind: 'no-docker' })
  })

  it('一个实例一份：A 的 manager B 看不见', () => {
    const a = new StandbyHooks()
    const b = new StandbyHooks()
    a.bind({ managed: () => true, origin: () => 'http://a', snapshot: () => [] } as never)
    expect(a.managed('x')).toBe(true)
    expect(b.managed('x')).toBe(false)
    expect(b.origin('x')).toBeNull()
  })
})
