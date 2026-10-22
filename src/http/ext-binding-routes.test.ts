import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountExtBindingRoutes } from './ext-binding-routes.ts'
import { ExtBindingStore } from '../devices/ext-binding-store.ts'

const EXT_ID = 'dmhlfkdjljnilhnfajjpaobehenbokij'
let store: ExtBindingStore
let local: boolean
let kicked: Array<[string, number]>
let app: Hono

beforeEach(() => {
  store = new ExtBindingStore(join(mkdtempSync(join(tmpdir(), 'extroutes-')), 'ext-bindings.json'))
  local = true
  kicked = []
  app = new Hono()
  mountExtBindingRoutes(app, {
    store,
    registry: { isOnline: (id) => id.endsWith('online'), kick: vi.fn((id: string, code: number) => { kicked.push([id, code]); return true }) },
    devices: { name: (id) => (id === 'linux:nas' ? 'NAS' : undefined) },
    isLocal: () => local,
    backendUrls: () => ['http://192.168.1.5:8900'],
    extId: EXT_ID,
  })
})

const mint = (id: string) => app.request(`/api/devices/${id}/ext-pairing-code`, { method: 'POST' })
const pair = (body: unknown, origin = `chrome-extension://${EXT_ID}`) =>
  app.request('/api/ext/pair', { method: 'POST', headers: { 'content-type': 'application/json', Origin: origin }, body: JSON.stringify(body) })

describe('extension binding routes', () => {
  it('签码：只对本机；local 不签；不认识的设备 404', async () => {
    local = false
    expect((await mint('linux:nas')).status).toBe(403)
    local = true
    expect((await mint('local')).status).toBe(400)
    expect((await mint('linux:nope')).status).toBe(404)
    const res = await mint('linux:nas')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ code: expect.stringMatching(/^\d{6}$/), backends: ['http://192.168.1.5:8900'] })
  })

  it('配对：只认扩展 Origin；错码 403；对码换回 token 与设备名', async () => {
    const { code } = (await (await mint('linux:nas')).json()) as { code: string }
    expect((await pair({ code }, 'https://evil.example')).status).toBe(403)
    expect((await pair({ code: code === '000000' ? '111111' : '000000' })).status).toBe(403)
    const res = await pair({ code, name: 'NAS Chrome', browser: 'chrome', platform: 'linux' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { bindingId: string; token: string; deviceId: string; deviceName: string }
    expect(body).toMatchObject({ deviceId: 'linux:nas', deviceName: 'NAS' })
    expect(store.bindingForToken(body.token)?.bindingId).toBe(body.bindingId)
  })

  it('列表带在线状态，不带 token 哈希', async () => {
    const { code } = (await (await mint('linux:nas')).json()) as { code: string }
    await pair({ code })
    const { bindings } = (await (await app.request('/api/ext/bindings')).json()) as { bindings: Array<Record<string, unknown>> }
    expect(bindings).toHaveLength(1)
    expect(bindings[0]).toMatchObject({ deviceId: 'linux:nas', online: false, default: false })
    expect(bindings[0]).not.toHaveProperty('tokenHash')
  })

  it('撤销：204 并以 4003 断开；再删 404', async () => {
    const { code } = (await (await mint('linux:nas')).json()) as { code: string }
    const { bindingId } = (await (await pair({ code })).json()) as { bindingId: string }
    expect((await app.request(`/api/ext/bindings/${bindingId}`, { method: 'DELETE' })).status).toBe(204)
    expect(kicked).toEqual([[bindingId, 4003]])
    expect((await app.request(`/api/ext/bindings/${bindingId}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('默认：PUT 设、DELETE 清，列表跟着变；不认识的绑定 404', async () => {
    const { code } = (await (await mint('linux:nas')).json()) as { code: string }
    const { bindingId } = (await (await pair({ code })).json()) as { bindingId: string }
    const list = async () => ((await (await app.request('/api/ext/bindings')).json()) as { bindings: Array<{ default: boolean }> }).bindings
    expect((await app.request(`/api/ext/bindings/${bindingId}/default`, { method: 'PUT' })).status).toBe(204)
    expect((await list())[0].default).toBe(true)
    expect(store.defaultOf('linux:nas')).toBe(bindingId)
    expect((await app.request(`/api/ext/bindings/${bindingId}/default`, { method: 'DELETE' })).status).toBe(204)
    expect((await list())[0].default).toBe(false)
    expect((await app.request('/api/ext/bindings/ext:nope/default', { method: 'PUT' })).status).toBe(404)
    expect((await app.request('/api/ext/bindings/ext:nope/default', { method: 'DELETE' })).status).toBe(404)
  })
})
