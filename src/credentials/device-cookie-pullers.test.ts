// 每台设备的登录态经它自己的扩展绑定取、写它自己的快照（design D4、D7）。
import { describe, expect, it, vi } from 'vitest'
import { makeDeviceCookiePullers } from './device-cookie-pullers.ts'
import { runOnDevice } from '../devices/run-context.ts'
import { pickBrowser } from '../devices/placement.ts'
import { DeviceOffline } from '../devices/errors.ts'
import type { CookieSnapshot } from './cookie-puller.ts'

const cookie = (name: string) => ({ name, value: name, domain: '.eastmoneysec.com', path: '/' })

function world(online: Record<string, boolean> = { 'ext:a': true, 'ext:b': true }) {
  const stores = new Map<string, Record<string, unknown[]>>()
  const storeFor = (dev: string): CookieSnapshot => ({
    replace: (c) => { stores.set(dev, c) },
    status: () => ({ domains: Object.keys(stores.get(dev) ?? {}), updatedAt: stores.has(dev) ? 1 : null }),
  })
  const pulled: string[] = []
  const relayFor = (id: string) => ({
    cookiePull: vi.fn(async (domains: string[]) => {
      pulled.push(id)
      return { cookies: { [domains[0]!]: [cookie(id)] }, refused: [] }
    }),
  })
  const relays = { 'ext:a': relayFor('ext:a'), 'ext:b': relayFor('ext:b') } as Record<string, ReturnType<typeof relayFor>>
  let picks = ['ext:a', 'ext:b']
  const browsers = {
    pick: (dev: string) => {
      if (dev !== 'linux:nas') throw new Error('unknown device')
      const live = picks.filter((b) => online[b])
      if (!live.length) throw new DeviceOffline(dev)
      return live[0]!
    },
    hasBrowser: (dev: string) => dev === 'linux:nas' && Object.values(online).some(Boolean),
    relay: (id: string) => relays[id]!,
  }
  const local = { connected: true, cookiePull: vi.fn(async () => ({ cookies: { 'eastmoneysec.com': [cookie('local')] }, refused: [] })) }
  const pullerFor = makeDeviceCookiePullers({
    local,
    browsers,
    storeFor,
    requiredDomainsFor: (dev) => (dev === 'linux:nas' ? ['eastmoneysec.com'] : ['eastmoneysec.com', 'xiaohongshu.com']),
    log: () => {},
  })
  return { pullerFor, stores, pulled, local, browsers, setPicks: (p: string[]) => { picks = p } }
}

describe('makeDeviceCookiePullers', () => {
  it('NAS 的登录态经 NAS 上的绑定取、写 NAS 的快照；本机中继一次都没被问', async () => {
    const w = world()
    const out = await w.pullerFor('linux:nas').pull('test')
    expect(out.ok).toBe(true)
    expect(w.pulled).toEqual(['ext:a'])
    expect(w.stores.get('linux:nas')).toEqual({ 'eastmoneysec.com': [cookie('ext:a')] })
    expect(w.stores.has('local')).toBe(false)
    expect(w.local.cookiePull).not.toHaveBeenCalled()
  })

  it('本机照旧走本机中继', async () => {
    const w = world()
    await w.pullerFor('local').pull('test')
    expect(w.local.cookiePull).toHaveBeenCalledWith(['eastmoneysec.com', 'xiaohongshu.com'])
    expect(w.pulled).toEqual([])
  })

  it('在一次执行里取的是这次执行选定的那个 Chrome——登完取回的就是刚登上的那份', async () => {
    const w = world()
    await runOnDevice({ deviceId: 'linux:nas', allowHosts: [] }, async () => {
      expect(pickBrowser(w.browsers)).toBe('ext:a')
      w.setPicks(['ext:b', 'ext:a'])                 // 中途另一个 Chrome 成了「最合适」的
      await w.pullerFor('linux:nas').pull('facility-login')
    })
    expect(w.pulled).toEqual(['ext:a'])
  })

  it('设备上没有在线的 Chrome：跳过这一轮，不碰快照', async () => {
    const w = world({ 'ext:a': false, 'ext:b': false })
    const out = await w.pullerFor('linux:nas').pull('test')
    expect(out).toMatchObject({ ok: false, reason: 'relay-down' })
    expect(w.stores.has('linux:nas')).toBe(false)
  })

  it('同一台设备复用同一个 puller（并发去重靠它）', () => {
    const w = world()
    expect(w.pullerFor('linux:nas')).toBe(w.pullerFor('linux:nas'))
  })
})
