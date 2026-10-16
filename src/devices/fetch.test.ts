import { describe, it, expect, vi } from 'vitest'
import { makeFetchFor, fetchFor, MAX_DEVICE_BODY } from './fetch.ts'
import { runOnDevice } from './run-context.ts'
import { DeviceIncapable, DeviceLost, DeviceOffline, DeviceRefused, HostNotAllowed } from './errors.ts'
import { HostAbortedByUser, HostOpError, HostRelayDisconnected, type HttpFetchArgs } from '../http/host-relay.ts'

const NAS = { deviceId: 'linux:nas', allowHosts: ['eastmoneysec.com'] }
const b64 = (s: string) => Buffer.from(s).toString('base64')

function setup(over: { online?: boolean; ops?: string[]; reply?: (a: HttpFetchArgs) => Promise<unknown> } = {}) {
  const calls: HttpFetchArgs[] = []
  const local = vi.fn(async () => new Response('local'))
  const debug = vi.fn()
  const relay = {
    connected: true,
    fetchOp: async (a: HttpFetchArgs) => { calls.push(a); return (over.reply ?? (async () => ({ status: 200, headers: [['content-type', 'text/plain']], body: b64('nas'), url: a.url })))(a) as never },
  }
  const online = over.online ?? true
  const ops = new Set(over.ops ?? ['http.fetch'])
  const f = makeFetchFor({
    local,
    debug,
    directory: {
      isOnline: () => online,
      hasOp: (_id, op) => ops.has(op),
      fetchRelay: () => (online && ops.has('http.fetch') ? relay : undefined),
    },
  })
  return { f, calls, local, debug }
}

describe('fetchFor', () => {
  it('local 走本机通道', async () => {
    const { f, local, calls } = setup()
    expect(await (await f('https://example.com/')).text()).toBe('local')
    expect(local).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(0)
  })

  it('远程设备：请求经 relay，响应还原成标准 Response', async () => {
    const { f, calls, local } = setup()
    const res = await runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/Trade/Buy', {
      method: 'POST', headers: { cookie: 'a=1', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ x: '1' }), redirect: 'manual',
    }))
    expect(await res.text()).toBe('nas')
    expect(res.headers.get('content-type')).toBe('text/plain')
    expect(res.url).toBe('https://jywg.eastmoneysec.com/Trade/Buy')
    expect(local).not.toHaveBeenCalled()
    expect(calls[0]).toMatchObject({ method: 'POST', redirect: 'manual', allowHosts: ['eastmoneysec.com'] })
    expect(calls[0].headers).toContainEqual(['cookie', 'a=1'])
    expect(Buffer.from(calls[0].body!, 'base64').toString()).toBe('x=1')
  })

  it('302 原样回传', async () => {
    const { f } = setup({ reply: async (a) => ({ status: 302, headers: [['location', '/Login']], body: '', url: a.url }) })
    const res = await runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/Trade/Buy', { redirect: 'manual' }))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/Login')
  })

  it('多值 set-cookie 都在', async () => {
    const { f } = setup({ reply: async (a) => ({ status: 200, headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']], body: '', url: a.url }) })
    const res = await runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/'))
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
  })

  it('主机不在声明里：HostNotAllowed，不发帧', async () => {
    const { f, calls } = setup()
    await expect(runOnDevice(NAS, () => f('https://example.com/'))).rejects.toBeInstanceOf(HostNotAllowed)
    expect(calls).toHaveLength(0)
  })

  it('设备离线：DeviceOffline，本机通道一次都没被调', async () => {
    const { f, local } = setup({ online: false })
    await expect(runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/'))).rejects.toBeInstanceOf(DeviceOffline)
    expect(local).not.toHaveBeenCalled()
  })

  it('设备没有 http.fetch：DeviceIncapable', async () => {
    const { f } = setup({ ops: ['click'] })
    await expect(runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/'))).rejects.toBeInstanceOf(DeviceIncapable)
  })

  it('途中断连：DeviceLost', async () => {
    const { f, local } = setup({ reply: async () => { throw new HostRelayDisconnected() } })
    await expect(runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/'))).rejects.toBeInstanceOf(DeviceLost)
    expect(local).not.toHaveBeenCalled()
  })

  it('agent 拒绝：DeviceRefused 带 code', async () => {
    const { f } = setup({ reply: async () => { throw new HostOpError('resolved to 10.0.0.5', 'private-target') } })
    const e = await runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/')).catch((x) => x)
    expect(e).toBeInstanceOf(DeviceRefused)
    expect(e.code).toBe('private-target')
  })

  it('用户中止（HostAbortedByUser）原样透传，不包成 DeviceLost/DeviceRefused，也不碰本机通道', async () => {
    const aborted = new HostAbortedByUser()
    const { f, local } = setup({ reply: async () => { throw aborted } })
    const e = await runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/')).catch((x) => x)
    expect(e).toBe(aborted)
    expect(local).not.toHaveBeenCalled()
  })

  it('设备回了 Response 构造不出的状态码：DeviceRefused network，不是裸 RangeError', async () => {
    const { f, local } = setup({ reply: async (a) => ({ status: 99, headers: [], body: '', url: a.url }) })
    const e = await runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/')).catch((x) => x)
    expect(e).toBeInstanceOf(DeviceRefused)
    expect(e.code).toBe('network')
    expect(local).not.toHaveBeenCalled()
  })

  it('调用方的 signal：剩余时间作为 timeoutMs 下发；已中止则不发', async () => {
    const { f, calls } = setup()
    await runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/', { signal: AbortSignal.timeout(15_000) }))
    expect(calls[0].timeoutMs).toBeGreaterThan(0)
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(30_000)
    const ac = new AbortController(); ac.abort()
    await expect(runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/', { signal: ac.signal }))).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('调用方中止时不等设备回复', async () => {
    const { f } = setup({ reply: () => new Promise(() => {}) })
    const ac = new AbortController()
    const p = runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/', { signal: ac.signal }))
    ac.abort()
    await expect(p).rejects.toThrow()
  })

  it('响应体超限：DeviceRefused too-large', async () => {
    const big = Buffer.alloc(MAX_DEVICE_BODY + 1).toString('base64')
    const { f } = setup({ reply: async (a) => ({ status: 200, headers: [], body: big, url: a.url }) })
    const e = await runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/')).catch((x) => x)
    expect(e.code).toBe('too-large')
  })

  it('debug 记录不含 header 与 body', async () => {
    const { f, debug } = setup()
    await runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/x', { headers: { cookie: 'secret=1' }, method: 'POST', body: 'pw=hunter2' }))
    const entry = JSON.stringify(debug.mock.calls[0][0])
    expect(entry).toContain('linux:nas')
    expect(entry).toContain('jywg.eastmoneysec.com')
    expect(entry).not.toContain('secret')
    expect(entry).not.toContain('hunter2')
  })

  it('未接线的模块级 fetchFor：非 local 一律 DeviceOffline（fail-closed）', async () => {
    await expect(runOnDevice(NAS, () => fetchFor('https://jywg.eastmoneysec.com/'))).rejects.toBeInstanceOf(DeviceOffline)
  })
})
