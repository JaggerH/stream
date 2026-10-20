import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountDeviceRoutes } from './device-routes.ts'
import { DeviceStore } from '../devices/device-store.ts'
import { FacilityDeviceStore } from '../devices/facility-devices.ts'
import { HostRelayRegistry } from './host-registry.ts'

let store: DeviceStore
let registry: HostRelayRegistry
let local: boolean
let app: Hono

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'devroutes-'))
  store = new DeviceStore(join(dir, 'devices.json'))
  registry = new HostRelayRegistry()
  local = true
  app = new Hono()
  mountDeviceRoutes(app, {
    store, registry,
    bindings: new FacilityDeviceStore(join(dir, 'stream.db')),
    knownFacility: (f) => f === 'eastmoney',
    isLocal: () => local,
    backendUrls: () => ['http://10.9.8.21:8900', 'http://100.70.0.5:8900'],
  })
})

const post = (path: string, body?: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

describe('device routes', () => {
  it('facility 绑定：PUT / GET / DELETE；未知设备 400；local 等于清除', async () => {
    const put = (f: string, deviceId: string) =>
      app.request(`/api/devices/bindings/${f}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId }) })
    expect((await put('eastmoney', 'linux:nope')).status).toBe(400)
    const { code } = await (await post('/api/devices/pairing-code')).json() as { code: string }
    const { deviceId } = await (await post('/api/devices/pair', { code, name: 'NAS', platform: 'linux' })).json() as { deviceId: string }
    expect((await put('eastmoney', deviceId)).status).toBe(200)
    expect(await (await app.request('/api/devices/bindings')).json()).toEqual({ bindings: [{ facility: 'eastmoney', deviceId }] })
    expect((await put('eastmoney', 'local')).status).toBe(200)
    expect(await (await app.request('/api/devices/bindings')).json()).toEqual({ bindings: [] })
    await put('eastmoney', deviceId)
    expect((await app.request('/api/devices/bindings/eastmoney', { method: 'DELETE' })).status).toBe(204)
  })

  // 打错一个 facility 名（`eastmony`）存进去不报错，真正的东财执行照旧在本机跑——用户以为绑好了。
  it('facility 绑定：不认识的 facility 400，参数去首尾空白', async () => {
    const { code } = await (await post('/api/devices/pairing-code')).json() as { code: string }
    const { deviceId } = await (await post('/api/devices/pair', { code, name: 'NAS', platform: 'linux' })).json() as { deviceId: string }
    const put = (f: string) =>
      app.request(`/api/devices/bindings/${encodeURIComponent(f)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId }) })
    const bad = await put('eastmony')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: '没有这个账号（facility）：eastmony' })
    const ok = await put(' eastmoney ')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ facility: 'eastmoney', deviceId })
    expect(await (await app.request('/api/devices/bindings')).json()).toEqual({ bindings: [{ facility: 'eastmoney', deviceId }] })
  })

  it('pair accepts platform linux and rejects unknown platforms', async () => {
    const { code } = await (await post('/api/devices/pairing-code')).json() as { code: string }
    const bad = await post('/api/devices/pair', { code, name: 'x', platform: 'windows' })
    expect(bad.status).toBe(400)
    const ok = await post('/api/devices/pair', { code, name: 'NAS', platform: 'linux' })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { deviceId: string }).deviceId).toMatch(/^linux:/)
  })

  it('only this machine can mint a pairing code; one QR names every address and the code', async () => {
    local = false
    expect((await post('/api/devices/pairing-code')).status).toBe(403)
    local = true
    const res = await post('/api/devices/pairing-code')
    expect(res.status).toBe(200)
    const body = await res.json() as { code: string; qr: string[] }
    // One code to scan; the phone lets the user pick the address (LAN at home, Tailscale away).
    // Still v1 with `backend` = the first address, so an app that predates `backends` pairs too.
    expect(body.qr).toHaveLength(1)
    expect(JSON.parse(body.qr[0])).toEqual({
      stream: 'pair', v: 1, backend: 'http://10.9.8.21:8900', backends: ['http://10.9.8.21:8900', 'http://100.70.0.5:8900'], code: body.code,
    })
  })

  it('pairing with the code returns a token; a wrong code is 403 invalid-code', async () => {
    const { code } = await (await post('/api/devices/pairing-code')).json() as { code: string }
    local = false // the phone is not this machine
    const bad = await post('/api/devices/pair', { code: code === '000000' ? '111111' : '000000' })
    expect(bad.status).toBe(403)
    expect(await bad.json()).toEqual({ error: 'invalid-code' })
    const ok = await post('/api/devices/pair', { code, name: 'K80' })
    expect(ok.status).toBe(200)
    const { deviceId, deviceToken } = await ok.json() as { deviceId: string; deviceToken: string }
    expect(store.deviceForToken(deviceToken)).toBe(deviceId)
  })

  it('a malformed pair body is 400', async () => {
    expect((await post('/api/devices/pair', { code: 123 })).status).toBe(400)
    expect((await app.request('/api/devices/pair', { method: 'POST', body: 'nope' })).status).toBe(400)
  })

  it('lists paired phones merged with online devices', async () => {
    const r = store.pair(store.createPairingCode().code, 'K80')
    if (!r.ok) throw new Error('expected ok')
    registry.connect({ send: () => {} }, { deviceId: 'desktop:pc', platform: 'windows', name: 'PC', agentVersion: '0.1.0', ops: [] })
    const { devices } = await (await app.request('/api/devices')).json() as { devices: Array<Record<string, unknown>> }
    expect(devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: r.deviceId, name: 'K80', platform: 'android', paired: true, online: false }),
      expect.objectContaining({ deviceId: 'desktop:pc', platform: 'windows', paired: false, online: true, agentVersion: '0.1.0' }),
    ]))
  })

  it('lists the live state of an online device', async () => {
    const r = store.pair(store.createPairingCode().code, 'K80')
    if (!r.ok) throw new Error('expected ok')
    registry.connect({ send: () => {} }, { deviceId: r.deviceId, platform: 'android', name: 'K80', agentVersion: '0.1.0', ops: [] })
    const state = { a11yEnabled: false, screenOn: true, keyguardLocked: false, battery: 40, charging: false }
    registry.setState(r.deviceId, state)
    const body = await (await app.request('/api/devices')).json() as { devices: Array<{ state?: unknown }> }
    expect(body.devices[0].state).toEqual(state)
  })

  describe('POST /api/devices/:id/ops', () => {
    const opPost = (id: string, body: string) =>
      app.request(`/api/devices/${encodeURIComponent(id)}/ops`, { method: 'POST', body })
    const sent: string[] = []
    let phoneId: string
    beforeEach(() => {
      sent.length = 0
      phoneId = 'android:1'
      registry.connect({ send: (d) => void sent.push(d) }, { deviceId: phoneId, platform: 'android', name: 'K80', agentVersion: '0.1.0', ops: ['find'] })
    })

    it('runs one op on a device, loopback only', async () => {
      const p = opPost(phoneId, JSON.stringify({ op: 'find', args: { query: { role: 'Button' } } }))
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      const frame = JSON.parse(sent[0])
      expect(frame).toEqual({ id: frame.id, op: 'find', args: { query: { role: 'Button' } }, abortEpoch: 0 })
      registry.devices()[0].relay.handleMessage(JSON.stringify({ id: frame.id, result: { elements: [] } }))
      const ok = await p
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ result: { elements: [] } })
    })

    it('reports an agent error as 502 with the message', async () => {
      const p = opPost(phoneId, JSON.stringify({ op: 'invoke', args: { ref: 'n3' } }))
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      registry.devices()[0].relay.handleMessage(JSON.stringify({ id: JSON.parse(sent[0]).id, error: 'stale-ref: n3 belongs to an older tree' }))
      const r = await p
      expect(r.status).toBe(502)
      expect(await r.json()).toEqual({ error: 'stale-ref: n3 belongs to an older tree' })
    })

    it('refuses the op route off-box, for an offline device and for a bad body', async () => {
      local = false
      expect((await opPost(phoneId, '{"op":"url"}')).status).toBe(403)
      local = true
      expect((await opPost('android:nope', '{"op":"url"}')).status).toBe(404)
      expect((await opPost(phoneId, '{"args":{}}')).status).toBe(400)
      expect((await opPost(phoneId, 'null')).status).toBe(400)
      expect((await opPost(phoneId, '{"op":"url","args":[1]}')).status).toBe(400)
      expect(sent).toEqual([])
    })
  })

  it('revoking drops the live socket and forgets the token', async () => {
    const r = store.pair(store.createPairingCode().code, 'K80')
    if (!r.ok) throw new Error('expected ok')
    const closed: number[] = []
    registry.connect({ send: () => {}, close: (c) => void closed.push(c ?? 0) },
      { deviceId: r.deviceId, platform: 'android', name: 'K80', agentVersion: '0.1.0', ops: [] })
    const res = await app.request(`/api/devices/${encodeURIComponent(r.deviceId)}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(closed).toEqual([4003])
    expect(registry.devices()).toHaveLength(0)
    expect(store.deviceForToken(r.deviceToken)).toBeUndefined()
    expect((await app.request(`/api/devices/${encodeURIComponent(r.deviceId)}`, { method: 'DELETE' })).status).toBe(404)
  })

  // design D7：挂在这台设备上的扩展绑定随之撤销——由 onRevoked 接（serve.ts 里撤绑定并断开）。
  it('revoking a device tells onRevoked which device went', async () => {
    const revoked: string[] = []
    const app2 = new Hono()
    mountDeviceRoutes(app2, { store, registry, isLocal: () => true, backendUrls: () => [], onRevoked: (id) => revoked.push(id) })
    const r = store.pair(store.createPairingCode().code, 'NAS', 'linux')
    if (!r.ok) throw new Error('expected ok')
    expect((await app2.request(`/api/devices/${encodeURIComponent(r.deviceId)}`, { method: 'DELETE' })).status).toBe(204)
    expect(revoked).toEqual([r.deviceId])
  })
})
