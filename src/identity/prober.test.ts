import { describe, expect, it, vi } from 'vitest'
import { makeIdentityProber, makeNodeProbeIO, type ProbeIO } from './prober.ts'
import { currentPlacement } from '../devices/run-context.ts'
import type { WhoamiSpec } from '../manifest/types.ts'

const NODE = { nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a' }
const BILI: WhoamiSpec = { kind: 'http', url: 'https://api.bilibili.com/x/web-interface/nav', id: 'data.mid', name: 'data.uname' }
const XHS: WhoamiSpec = { kind: 'page', url: 'https://www.xiaohongshu.com/explore', id: '__INITIAL_STATE__.user.userInfo.userId', signedIn: '__INITIAL_STATE__.user.loggedIn' }

const io = (over: Partial<ProbeIO>): ProbeIO => ({
  httpGet: async () => null,
  evalInPage: async () => undefined,
  ...over,
})

describe('makeIdentityProber', () => {
  it('http：带 cookie 域与允许主机去问，结果三态', async () => {
    const httpGet = vi.fn(async () => ({ status: 200, body: JSON.stringify({ data: { mid: 123, uname: '某某' } }) }))
    const p = makeIdentityProber(io({ httpGet }))
    expect(await p.probe(NODE, BILI, ['bilibili.com'])).toEqual({ state: 'signed-in', accountId: '123', name: '某某' })
    expect(httpGet).toHaveBeenCalledWith(NODE, BILI.kind === 'http' ? BILI.url : '', { cookieDomain: 'bilibili.com', allowHosts: ['bilibili.com'] })
  })

  it('快照里没有这个域 → unknown（没同步过不是登出）', async () => {
    expect((await makeIdentityProber(io({})).probe(NODE, BILI, ['bilibili.com'])).state).toBe('unknown')
  })

  it('page：节点中途断开 → unknown', async () => {
    const p = makeIdentityProber(io({ evalInPage: async () => { throw new Error('extension relay disconnected') } }))
    expect(await p.probe(NODE, XHS, ['xiaohongshu.com'])).toEqual({ state: 'unknown', reason: 'extension relay disconnected' })
  })

  it('超时 → unknown', async () => {
    const p = makeIdentityProber(io({ evalInPage: () => new Promise(() => {}) }), { timeoutMs: 10 })
    expect((await p.probe(NODE, XHS, ['xiaohongshu.com'])).state).toBe('unknown')
  })

  it('login 形状不探测', async () => {
    expect((await makeIdentityProber(io({})).probe(NODE, { kind: 'login', param: 'zjzh' }, [])).state).toBe('unknown')
  })

  it('同一节点串行，不同节点并行', async () => {
    let active = 0
    let peak = 0
    const order: string[] = []
    const evalInPage = async (n: { nodeId: string }) => {
      active++
      peak = Math.max(peak, active)
      order.push(`start ${n.nodeId}`)
      await new Promise((r) => setTimeout(r, 15))
      order.push(`end ${n.nodeId}`)
      active--
      return { root: true, values: ['u', undefined, true] }
    }
    const p = makeIdentityProber(io({ evalInPage }))
    await Promise.all([p.probe(NODE, XHS, []), p.probe(NODE, XHS, [])])
    expect(peak).toBe(1)
    expect(order).toEqual(['start node_a', 'end node_a', 'start node_a', 'end node_a'])
    peak = 0
    await Promise.all([p.probe(NODE, XHS, []), p.probe({ ...NODE, nodeId: 'node_b', bindingId: 'local:node_b' }, XHS, [])])
    expect(peak).toBe(2)
  })
})

describe('makeNodeProbeIO', () => {
  it('http 钉在该节点上：拉快照、取 cookie、带 Cookie 头发出', async () => {
    const seen: Array<string | undefined> = []
    const fetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      seen.push(currentPlacement().browser?.bindingId)
      expect(new Headers(init?.headers).get('cookie')).toBe('SESSDATA=x')
      return new Response('{"data":{"mid":1}}', { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const refreshCookies = vi.fn(async () => { seen.push(currentPlacement().browser?.bindingId) })
    const pio = makeNodeProbeIO({
      relay: () => { throw new Error('no tab for http') },
      fetch,
      refreshCookies,
      cookieString: async (d) => (d === 'bilibili.com' ? 'SESSDATA=x' : null),
    })
    expect(await pio.httpGet(NODE, 'https://api.bilibili.com/nav', { cookieDomain: 'bilibili.com', allowHosts: ['bilibili.com'] }))
      .toEqual({ status: 200, body: '{"data":{"mid":1}}' })
    expect(seen).toEqual(['local:node_a', 'local:node_a'])
  })

  it('page 开后台标签、读完关掉；读失败也关', async () => {
    const closed: number[] = []
    const relay = {
      newTab: vi.fn(async (_url: string, _w?: string, background?: boolean) => { expect(background).toBe(true); return 7 }),
      closeTab: vi.fn(async (id: number) => { closed.push(id) }),
      sendCommand: vi.fn(async (_t: number, method: string) => (method === 'Runtime.evaluate' ? { result: { value: 'v' } } : {})),
      list: async () => [],
    }
    const pio = makeNodeProbeIO({ relay: () => relay, fetch: globalThis.fetch, refreshCookies: async () => {}, cookieString: async () => null })
    expect(await pio.evalInPage(NODE, 'https://www.xiaohongshu.com/explore', '1')).toBe('v')
    expect(closed).toEqual([7])
    relay.sendCommand.mockImplementation(async (_t: number, method: string) => {
      if (method === 'Runtime.evaluate') throw new Error('disconnected')
      return {}
    })
    await expect(pio.evalInPage(NODE, 'https://www.xiaohongshu.com/explore', '1')).rejects.toThrow('disconnected')
    expect(closed).toEqual([7, 7])
  })
})
