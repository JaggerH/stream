import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountDeviceRoutes } from './device-routes.ts'
import { DeviceStore } from '../devices/device-store.ts'
import { HostRelayRegistry } from './host-registry.ts'

let store: DeviceStore
let registry: HostRelayRegistry
let local: boolean
let app: Hono

beforeEach(() => {
  store = new DeviceStore(join(mkdtempSync(join(tmpdir(), 'devroutes-')), 'devices.json'))
  registry = new HostRelayRegistry()
  local = true
  app = new Hono()
  mountDeviceRoutes(app, {
    store, registry,
    isLocal: () => local,
    backendUrls: () => ['http://10.9.8.21:8900'],
  })
})

const post = (path: string, body?: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

describe('device routes', () => {
  it('only this machine can mint a pairing code; the QR payload names backend and code', async () => {
    local = false
    expect((await post('/api/devices/pairing-code')).status).toBe(403)
    local = true
    const res = await post('/api/devices/pairing-code')
    expect(res.status).toBe(200)
    const body = await res.json() as { code: string; qr: string[] }
    expect(JSON.parse(body.qr[0])).toEqual({ stream: 'pair', v: 1, backend: 'http://10.9.8.21:8900', code: body.code })
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

  it('revoking drops the live socket and forgets the token', async () => {
    const r = store.pair(store.createPairingCode().code, 'K80')
    if (!r.ok) throw new Error('expected ok')
    const closed: number[] = []
    registry.connect({ send: () => {}, close: (c) => void closed.push(c ?? 0) },
      { deviceId: r.deviceId, platform: 'android', name: 'K80', agentVersion: '0.1.0', ops: [] })
    const res = await app.request(`/api/devices/${encodeURIComponent(r.deviceId)}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(closed).toEqual([4003])
    expect(store.deviceForToken(r.deviceToken)).toBeUndefined()
    expect((await app.request(`/api/devices/${encodeURIComponent(r.deviceId)}`, { method: 'DELETE' })).status).toBe(404)
  })
})
