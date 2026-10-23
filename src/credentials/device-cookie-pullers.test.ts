// 每个槽位（节点，或说不出节点时的设备）的登录态经它自己的扩展绑定取、写它自己的快照
// （device-execution D4/D7、browser-identity D10）。
import { describe, expect, it, vi } from 'vitest'
import { makeDeviceCookiePullers } from './device-cookie-pullers.ts'
import { runOnDevice } from '../devices/run-context.ts'
import type { CookieSnapshot } from './cookie-puller.ts'

const cookie = (name: string) => ({ name, value: name, domain: '.eastmoneysec.com', path: '/' })

/**
 * NAS 上两条老扩展的绑定（ext:a / ext:b，没有节点）、一条记着节点的（ext:n → node_n）；
 * 本机兼容槽 `local` 与两个本机节点。
 */
function world(online: Record<string, boolean> = { 'ext:a': true, 'ext:b': true, 'ext:n': true, local: true, 'local:node_w': true, 'local:node_p': true }) {
  const stores = new Map<string, Record<string, unknown[]>>()
  const storeFor = (slot: string): CookieSnapshot => ({
    replace: (c) => { stores.set(slot, c) },
    status: () => ({ domains: Object.keys(stores.get(slot) ?? {}), updatedAt: stores.has(slot) ? 1 : null }),
  })
  const pulled: string[] = []
  const relayFor = (id: string) => ({
    cookiePull: vi.fn(async (domains: string[]) => {
      pulled.push(id)
      return { cookies: { [domains[0]!]: [cookie(id)] }, refused: [] }
    }),
  })
  const ids = ['ext:a', 'ext:b', 'ext:n', 'local', 'local:node_w', 'local:node_p']
  const relays = Object.fromEntries(ids.map((id) => [id, relayFor(id)]))
  const nodeOf: Record<string, string> = { 'ext:n': 'node_n', 'local:node_w': 'node_w', 'local:node_p': 'node_p' }
  const browsers = {
    bindingsOf: (dev: string) => (dev === 'linux:nas' ? ['ext:a', 'ext:b', 'ext:n'] : dev === 'local' ? ['local', 'local:node_w', 'local:node_p'] : []),
    nodeOf: (id: string) => nodeOf[id],
    isOnline: (id: string) => online[id] === true,
    relay: (id: string) => relays[id]!,
  }
  const pullerFor = makeDeviceCookiePullers({
    browsers,
    storeFor,
    requiredDomainsFor: (dev) => (dev === 'linux:nas' ? ['eastmoneysec.com'] : ['eastmoneysec.com', 'xiaohongshu.com']),
    log: () => {},
  })
  return { pullerFor, stores, pulled, relays }
}

describe('makeDeviceCookiePullers', () => {
  it('节点的登录态经那个节点自己的绑定取、写它自己的快照', async () => {
    const w = world()
    const out = await w.pullerFor('linux:nas/node_n').pull('test')
    expect(out.ok).toBe(true)
    expect(w.pulled).toEqual(['ext:n'])
    expect(w.stores.get('linux:nas/node_n')).toEqual({ 'eastmoneysec.com': [cookie('ext:n')] })
    expect(w.stores.has('linux:nas')).toBe(false)
  })

  it('【核心】同一台电脑的两个 profile：各拉各的，快照互不覆盖', async () => {
    const w = world()
    await w.pullerFor('local/node_w').pull('test')
    await w.pullerFor('local/node_p').pull('test')
    expect(w.pulled).toEqual(['local:node_w', 'local:node_p'])
    expect(w.stores.get('local/node_w')).toEqual({ 'eastmoneysec.com': [cookie('local:node_w')] })
    expect(w.stores.get('local/node_p')).toEqual({ 'eastmoneysec.com': [cookie('local:node_p')] })
    expect(w.relays['local:node_w']!.cookiePull).toHaveBeenCalledWith(['eastmoneysec.com', 'xiaohongshu.com'])
  })

  it('本机设备槽位 = 兼容槽那条中继（老扩展），写 local 那份', async () => {
    const w = world()
    await w.pullerFor('local').pull('test')
    expect(w.pulled).toEqual(['local'])
    expect(w.stores.has('local')).toBe(true)
  })

  it('远程设备槽位只经没记过节点的绑定取；执行内取这次执行选定的那条', async () => {
    const w = world()
    await w.pullerFor('linux:nas').pull('test')
    expect(w.pulled).toEqual(['ext:a'])
    await runOnDevice({ deviceId: 'linux:nas', allowHosts: [], browser: { bindingId: 'ext:b' } }, async () => {
      await w.pullerFor('linux:nas').pull('facility-login')
    })
    expect(w.pulled).toEqual(['ext:a', 'ext:b'])
  })

  it('节点离线：跳过这一轮，不碰快照', async () => {
    const w = world({ 'local:node_w': false })
    const out = await w.pullerFor('local/node_w').pull('test')
    expect(out).toMatchObject({ ok: false, reason: 'relay-down' })
    expect(w.stores.has('local/node_w')).toBe(false)
  })

  it('同一个槽位复用同一个 puller（并发去重靠它）', () => {
    const w = world()
    expect(w.pullerFor('local/node_w')).toBe(w.pullerFor('local/node_w'))
    expect(w.pullerFor('local/node_w')).not.toBe(w.pullerFor('local/node_p'))
  })
})
