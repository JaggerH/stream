import { describe, it, expect, vi, afterEach } from 'vitest'
import { installGlobalFetchTrap, makeGlobalFetchTrap } from './global-fetch-trap.ts'
import { runOnDevice } from './run-context.ts'
import { DeviceIncapable } from './errors.ts'

const NAS = { deviceId: 'linux:nas', allowHosts: ['example.com'] }

describe('全局 fetch 陷阱（ctx.fetch 守卫之外的运行时兜底）', () => {
  it('远程 placement 下直接调全局 fetch：DeviceIncapable(http.fetch)，底层一次都不调', async () => {
    const prev = vi.fn(async () => new Response('local'))
    const trap = makeGlobalFetchTrap(prev as unknown as typeof fetch)
    const e = await runOnDevice(NAS, () => trap('https://example.com/x')).catch((x) => x)
    expect(e).toBeInstanceOf(DeviceIncapable)
    expect((e as DeviceIncapable).need).toBe('http.fetch')
    expect((e as Error).message).toContain('包直接调用了全局 fetch——在远程设备上执行时必须用 ctx.fetch')
    expect(prev).not.toHaveBeenCalled()
  })

  it('local（含无上下文）：原样委托给之前的全局 fetch', async () => {
    const prev = vi.fn(async () => new Response('local'))
    const trap = makeGlobalFetchTrap(prev as unknown as typeof fetch)
    expect(await (await trap('https://example.com/x', { method: 'POST' })).text()).toBe('local')
    expect(await (await runOnDevice({ deviceId: 'local', allowHosts: [] }, () => trap('https://example.com/y'))).text()).toBe('local')
    expect(prev).toHaveBeenNthCalledWith(1, 'https://example.com/x', { method: 'POST' })
  })

  describe('installGlobalFetchTrap', () => {
    const original = globalThis.fetch
    afterEach(() => { globalThis.fetch = original })

    it('装上之后 globalThis.fetch 在远程 placement 下抛；卸载还原', async () => {
      const prev = vi.fn(async () => new Response('local'))
      globalThis.fetch = prev as unknown as typeof fetch
      const uninstall = installGlobalFetchTrap()
      await expect(runOnDevice(NAS, () => fetch('https://example.com/x'))).rejects.toBeInstanceOf(DeviceIncapable)
      expect(await (await fetch('https://example.com/x')).text()).toBe('local')
      uninstall()
      expect(globalThis.fetch).toBe(prev)
    })
  })
})
