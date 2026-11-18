import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountDeviceRoutes } from './device-routes.ts'
import { DeviceStore } from '../devices/device-store.ts'
import { FacilityDeviceStore } from '../devices/facility-devices.ts'
import { HostRelayRegistry } from './host-registry.ts'
import { PairingGuard } from './rate-limit.ts'

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
    knownFacility: (f) => f === 'eastmoney' || f === 'bilibili',
    facilities: () => [{ facility: 'eastmoney', packageId: '@streamapp/eastmoney' }, { facility: 'bilibili', packageId: '@streamapp/bilibili' }],
    isAdmin: () => local,
    backendUrls: () => ['http://10.9.8.21:8900', 'http://100.70.0.5:8900'],
    knownIdentity: (f, a) => f === 'bilibili' && a === '123',
    knownEnvironment: (e) => e === '个人',
  })
})

const post = (path: string, body?: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

describe('device routes', () => {
  it('facility 绑定：PUT / GET / DELETE；未知设备 400；local 等于清除', async () => {
    const put = (f: string, deviceId: string) =>
      app.request(`/devices/bindings/${f}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId }) })
    expect((await put('eastmoney', 'linux:nope')).status).toBe(400)
    const { code } = await (await post('/devices/pairing-code')).json() as { code: string }
    const { deviceId } = await (await post('/devices/pair', { code, name: 'NAS', platform: 'linux' })).json() as { deviceId: string }
    expect((await put('eastmoney', deviceId)).status).toBe(200)
    expect(await (await app.request('/devices/bindings')).json()).toEqual({ bindings: [{ facility: 'eastmoney', deviceId }] })
    expect((await put('eastmoney', 'local')).status).toBe(200)
    expect(await (await app.request('/devices/bindings')).json()).toEqual({ bindings: [] })
    await put('eastmoney', deviceId)
    expect((await app.request('/devices/bindings/eastmoney', { method: 'DELETE' })).status).toBe(204)
  })

  // 打错一个 facility 名（`eastmony`）存进去不报错，真正的东财执行照旧在本机跑——用户以为绑好了。
  it('facility 绑定：不认识的 facility 400，参数去首尾空白', async () => {
    const { code } = await (await post('/devices/pairing-code')).json() as { code: string }
    const { deviceId } = await (await post('/devices/pair', { code, name: 'NAS', platform: 'linux' })).json() as { deviceId: string }
    const put = (f: string) =>
      app.request(`/devices/bindings/${encodeURIComponent(f)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId }) })
    const bad = await put('eastmony')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: '没有这个账号（facility）：eastmony' })
    const ok = await put(' eastmoney ')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ facility: 'eastmoney', deviceId })
    expect(await (await app.request('/devices/bindings')).json()).toEqual({ bindings: [{ facility: 'eastmoney', deviceId }] })
  })

  it('facility 列表：全部已知 facility 按名排序，绑了的带设备，没绑的是 local', async () => {
    const { code } = await (await post('/devices/pairing-code')).json() as { code: string }
    const { deviceId } = await (await post('/devices/pair', { code, name: 'NAS', platform: 'linux' })).json() as { deviceId: string }
    await app.request('/devices/bindings/eastmoney', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId }) })
    expect(await (await app.request('/devices/facilities')).json()).toEqual({ facilities: [
      { facility: 'bilibili', packageId: '@streamapp/bilibili', deviceId: 'local' },
      { facility: 'eastmoney', packageId: '@streamapp/eastmoney', deviceId },
    ] })
  })

  it('facility 目标：身份 / 环境（browser-identity D7）；只收见过的身份与标过的环境；恰好一个', async () => {
    const put = (f: string, body: unknown) =>
      app.request(`/devices/bindings/${f}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const id = await put('bilibili', { accountId: '123' })
    expect(id.status).toBe(200)
    expect(await id.json()).toEqual({ facility: 'bilibili', accountId: '123' })
    expect((await put('bilibili', { accountId: '999' })).status).toBe(400)
    expect((await put('eastmoney', { environment: '工作' })).status).toBe(400)
    expect((await put('eastmoney', { environment: '个人' })).status).toBe(200)
    const two = await put('eastmoney', { environment: '个人', accountId: '123' })
    expect(two.status).toBe(400)
    expect((await two.json()).error).toContain('只能给一个')
    expect((await put('eastmoney', {})).status).toBe(400)
    expect(await (await app.request('/devices/bindings')).json()).toEqual({ bindings: [
      { facility: 'bilibili', accountId: '123' },
      { facility: 'eastmoney', environment: '个人' },
    ] })
    // 身份 / 环境目标不带 deviceId——带个 local 就是在说它在本机跑
    expect(await (await app.request('/devices/facilities')).json()).toEqual({ facilities: [
      { facility: 'bilibili', packageId: '@streamapp/bilibili', accountId: '123' },
      { facility: 'eastmoney', packageId: '@streamapp/eastmoney', environment: '个人' },
    ] })
  })

  it('pair accepts platform linux and rejects unknown platforms', async () => {
    const { code } = await (await post('/devices/pairing-code')).json() as { code: string }
    const bad = await post('/devices/pair', { code, name: 'x', platform: 'windows' })
    expect(bad.status).toBe(400)
    const ok = await post('/devices/pair', { code, name: 'NAS', platform: 'linux' })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { deviceId: string }).deviceId).toMatch(/^linux:/)
  })

  it('only this machine can mint a pairing code; one QR names every address and the code', async () => {
    local = false
    expect((await post('/devices/pairing-code')).status).toBe(403)
    local = true
    const res = await post('/devices/pairing-code')
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
    const { code } = await (await post('/devices/pairing-code')).json() as { code: string }
    local = false // the phone is not this machine
    const bad = await post('/devices/pair', { code: code === '000000' ? '111111' : '000000' })
    expect(bad.status).toBe(403)
    expect(await bad.json()).toEqual({ error: 'invalid-code' })
    const ok = await post('/devices/pair', { code, name: 'K80' })
    expect(ok.status).toBe(200)
    const { deviceId, deviceToken } = await ok.json() as { deviceId: string; deviceToken: string }
    expect(store.deviceForToken(deviceToken)).toBe(deviceId)
  })

  it('a malformed pair body is 400', async () => {
    expect((await post('/devices/pair', { code: 123 })).status).toBe(400)
    expect((await app.request('/devices/pair', { method: 'POST', body: 'nope' })).status).toBe(400)
  })

  it('lists paired phones merged with online devices', async () => {
    const r = store.pair(store.createPairingCode().code, 'K80')
    if (!r.ok) throw new Error('expected ok')
    registry.connect({ send: () => {} }, { deviceId: 'desktop:pc', platform: 'windows', name: 'PC', agentVersion: '0.1.0', ops: [] })
    const { devices } = await (await app.request('/devices')).json() as { devices: Array<Record<string, unknown>> }
    expect(devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: r.deviceId, name: 'K80', platform: 'android', paired: true, online: false }),
      expect.objectContaining({ deviceId: 'desktop:pc', platform: 'windows', paired: false, online: true, agentVersion: '0.1.0' }),
    ]))
  })

  it('lists the live state of an online device', async () => {
    const r = store.pair(store.createPairingCode().code, 'K80')
    if (!r.ok) throw new Error('expected ok')
    registry.connect({ send: () => {} }, { deviceId: r.deviceId, platform: 'android', name: 'K80', agentVersion: '0.1.0', ops: [] })
    const state = { a11yEnabled: false, screenOn: true, keyguardLocked: false, battery: 40, charging: false, health: { networkOk: false, clockSkewMs: -124_937_630 } }
    registry.setState(r.deviceId, state)
    const body = await (await app.request('/devices')).json() as { devices: Array<{ state?: unknown }> }
    expect(body.devices[0].state).toEqual(state)
  })

  describe('POST /api/devices/:id/ops', () => {
    const opPost = (id: string, body: string) =>
      app.request(`/devices/${encodeURIComponent(id)}/ops`, { method: 'POST', body })
    const sent: string[] = []
    let phoneId: string
    let phoneSocket: { send: (d: string) => void }
    beforeEach(() => {
      sent.length = 0
      phoneId = 'android:1'
      phoneSocket = { send: (d) => void sent.push(d) }
      registry.connect(phoneSocket, { deviceId: phoneId, platform: 'android', name: 'K80', agentVersion: '0.1.0', ops: ['find'] })
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

    it('502 body carries the structured code and semantics when the device sent them', async () => {
      const p = opPost(phoneId, JSON.stringify({ op: 'click', args: { ref: 'n7' } }))
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      const semantics = {
        op: 'click',
        app: { id: 'com.bank.app', name: 'Bank', category: 'finance' },
        control: { role: 'Button', label: '立即支付' },
        reasons: ['payment-label'],
        bindingDigest: 'b-1',
        screenDigest: 's-1',
        snapshotRef: 'snap-9',
      }
      registry.devices()[0].relay.handleMessage(JSON.stringify({
        id: JSON.parse(sent[0]).id,
        error: 'approval-required: 该动作需要审批',
        code: 'approval-required',
        semantics,
      }))
      const r = await p
      expect(r.status).toBe(502)
      expect(await r.json()).toEqual({ error: 'approval-required: 该动作需要审批', code: 'approval-required', semantics })
    })

    it('the app-in-use receipt rides the same channel (code + semantics)', async () => {
      const p = opPost(phoneId, JSON.stringify({ op: 'focusApp', args: { match: { process: 'me.ele' } } }))
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      const semantics = { op: 'focusApp', app: { id: 'me.ele', name: '饿了么' } }
      registry.devices()[0].relay.handleMessage(JSON.stringify({
        id: JSON.parse(sent[0]).id,
        error: 'app-in-use: me.ele 正被用户在前台使用，Stream 不抢；等用户用完再试',
        code: 'app-in-use',
        semantics,
      }))
      const r = await p
      expect(r.status).toBe(502)
      expect(await r.json()).toEqual({
        error: 'app-in-use: me.ele 正被用户在前台使用，Stream 不抢；等用户用完再试',
        code: 'app-in-use',
        semantics,
      })
    })

    it('other device codes ride along in the 502 body (stale-ref)', async () => {
      const p = opPost(phoneId, JSON.stringify({ op: 'invoke', args: { ref: 'n3' } }))
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      registry.devices()[0].relay.handleMessage(JSON.stringify({
        id: JSON.parse(sent[0]).id,
        error: 'stale-ref: n3 belongs to an older tree',
        code: 'stale-ref',
      }))
      const r = await p
      expect(r.status).toBe(502)
      const body = await r.json() as { error: string; code?: string; semantics?: unknown }
      expect(body).toEqual({ error: 'stale-ref: n3 belongs to an older tree', code: 'stale-ref' })
      expect('semantics' in body).toBe(false)
    })

    it('the stale-ref kind receipt rides the same channel (code + semantics)', async () => {
      const p = opPost(phoneId, JSON.stringify({ op: 'invoke', args: { ref: 'r7' } }))
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      const semantics = { kind: 'element_moved', ref: 'r7' }
      registry.devices()[0].relay.handleMessage(JSON.stringify({
        id: JSON.parse(sent[0]).id,
        error: 'stale-ref: r7 no longer where it was found; find it again',
        code: 'stale-ref',
        semantics,
      }))
      const r = await p
      expect(r.status).toBe(502)
      expect(await r.json()).toEqual({
        error: 'stale-ref: r7 no longer where it was found; find it again',
        code: 'stale-ref',
        semantics,
      })
    })

    it('a backend-side failure (disconnect) keeps the old {error} shape with no code/semantics', async () => {
      const p = opPost(phoneId, JSON.stringify({ op: 'find', args: {} }))
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      registry.disconnect(phoneSocket, phoneId)
      const r = await p
      expect(r.status).toBe(502)
      const body = await r.json() as { error: string; code?: string; semantics?: unknown }
      expect(body.error).toBeTruthy()
      expect('code' in body).toBe(false)
      expect('semantics' in body).toBe(false)
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

  describe('POST /api/devices/:id/control', () => {
    const controlPost = (id: string, body: unknown) =>
      app.request(`/devices/${encodeURIComponent(id)}/control`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    const sent: string[] = []
    let phoneId: string
    beforeEach(() => {
      sent.length = 0
      phoneId = 'android:1'
      registry.connect({ send: (d) => void sent.push(d) }, { deviceId: phoneId, platform: 'android', name: 'K80', agentVersion: '0.1.0', ops: ['find'] })
    })
    /** 假设备按 SA3 的回执形状回一帧。 */
    const reply = (frame: string, body: Record<string, unknown>) =>
      registry.devices()[0].relay.handleMessage(JSON.stringify({ id: JSON.parse(frame).id, ...body }))

    it('setBusy：发出控制帧（后端分配 id），设备回执转 200', async () => {
      const p = controlPost(phoneId, { type: 'control', control: 'setBusy', busy: true, reason: '等待审批' })
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      const frame = JSON.parse(sent[0]!)
      expect(frame).toEqual({ type: 'control', control: 'setBusy', busy: true, reason: '等待审批', id: frame.id })
      reply(sent[0]!, { result: {} })
      const ok = await p
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ result: {} })
    })

    it('exemptions：ask / financeVisible 归一后发出，缺省为空数组（清空豁免集）', async () => {
      const p = controlPost(phoneId, {
        type: 'control', control: 'exemptions',
        ask: [{ app: 'com.bank.app', action: 'commit' }, { app: 'com.shop', action: 'send' }],
        financeVisible: ['com.bank.app'],
      })
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      const frame = JSON.parse(sent[0]!)
      expect(frame).toEqual({
        type: 'control', control: 'exemptions',
        ask: [{ app: 'com.bank.app', action: 'commit' }, { app: 'com.shop', action: 'send' }],
        financeVisible: ['com.bank.app'], id: frame.id,
      })
      reply(sent[0]!, { result: {} })
      expect((await p).status).toBe(200)

      // 两个字段都缺 = 空数组 = 整体撤销
      const p2 = controlPost(phoneId, { type: 'control', control: 'exemptions' })
      await vi.waitFor(() => expect(sent).toHaveLength(2))
      expect(JSON.parse(sent[1]!)).toEqual({ type: 'control', control: 'exemptions', ask: [], financeVisible: [], id: JSON.parse(sent[1]!).id })
      reply(sent[1]!, { result: {} })
      expect((await p2).status).toBe(200)
    })

    it('设备的错误回执转 502，错误码保留在 message 里', async () => {
      const p = controlPost(phoneId, { type: 'control', control: 'exemptions', financeVisible: ['com.bank.app'] })
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      reply(sent[0]!, { error: 'exemption-invalid: com.bank.app', code: 'exemption-invalid' })
      const r = await p
      expect(r.status).toBe(502)
      const body = await r.json() as { error: string; code?: string }
      expect(body.error).toContain('exemption-invalid')
    })

    it('设备的 502 回执透传 code（与 ops 路由同一契约）', async () => {
      const p = controlPost(phoneId, { type: 'control', control: 'exemptions', financeVisible: ['com.bank.app'] })
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      reply(sent[0]!, { error: 'exemption-invalid: com.bank.app', code: 'exemption-invalid' })
      const r = await p
      expect(r.status).toBe(502)
      expect(await r.json()).toEqual({ error: 'exemption-invalid: com.bank.app', code: 'exemption-invalid' })
    })

    it('格式不合法 400，设备上一帧都不发', async () => {
      expect((await controlPost(phoneId, { type: 'op', control: 'setBusy', busy: true })).status).toBe(400)
      expect((await controlPost(phoneId, { type: 'control', control: 'setBusy' })).status).toBe(400) // 缺 busy
      expect((await controlPost(phoneId, { type: 'control', control: 'setBusy', busy: 'yes' })).status).toBe(400)
      expect((await controlPost(phoneId, { type: 'control', control: 'setBusy', busy: true, reason: 3 })).status).toBe(400)
      expect((await controlPost(phoneId, { type: 'control', control: 'kick' })).status).toBe(400)
      expect((await controlPost(phoneId, { type: 'control', control: 'exemptions', ask: [{ app: 'x', action: 'pay' }] })).status).toBe(400)
      expect((await controlPost(phoneId, { type: 'control', control: 'exemptions', financeVisible: [42] })).status).toBe(400)
      expect((await controlPost(phoneId, 'null')).status).toBe(400)
      expect((await controlPost(phoneId, 'nope')).status).toBe(400)
      expect(sent).toEqual([])
    })

    it('非管理员 403；设备不在线 404 device-offline', async () => {
      local = false
      expect((await controlPost(phoneId, { type: 'control', control: 'setBusy', busy: true })).status).toBe(403)
      local = true
      const off = await controlPost('android:nope', { type: 'control', control: 'setBusy', busy: true })
      expect(off.status).toBe(404)
      expect(await off.json()).toEqual({ error: 'device-offline' })
      expect(sent).toEqual([])
    })

    it('op 在途时照样发：控制帧不等会话租约、不占单发尾锁', async () => {
      const relay = registry.devices()[0].relay
      const opP = relay.send({ op: 'find', args: {} })
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      const p = controlPost(phoneId, { type: 'control', control: 'setBusy', busy: false })
      // op 没回执、单发尾锁占着，控制帧仍已发出（排队等租约就会卡在这里）
      await vi.waitFor(() => expect(sent).toHaveLength(2))
      expect(JSON.parse(sent[1]!).type).toBe('control')
      relay.handleMessage(JSON.stringify({ id: JSON.parse(sent[1]!).id, result: {} }))
      expect((await p).status).toBe(200)
      relay.handleMessage(JSON.stringify({ id: JSON.parse(sent[0]!).id, result: {} }))
      await opP
    })
  })

  it('revoking drops the live socket and forgets the token', async () => {
    const r = store.pair(store.createPairingCode().code, 'K80')
    if (!r.ok) throw new Error('expected ok')
    const closed: number[] = []
    registry.connect({ send: () => {}, close: (c) => void closed.push(c ?? 0) },
      { deviceId: r.deviceId, platform: 'android', name: 'K80', agentVersion: '0.1.0', ops: [] })
    const res = await app.request(`/devices/${encodeURIComponent(r.deviceId)}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(closed).toEqual([4003])
    expect(registry.devices()).toHaveLength(0)
    expect(store.deviceForToken(r.deviceToken)).toBeUndefined()
    expect((await app.request(`/devices/${encodeURIComponent(r.deviceId)}`, { method: 'DELETE' })).status).toBe(404)
  })

  // design D7：挂在这台设备上的扩展绑定随之撤销——由 onRevoked 接（serve.ts 里撤绑定并断开）。
  it('revoking a device tells onRevoked which device went', async () => {
    const revoked: string[] = []
    const app2 = new Hono()
    mountDeviceRoutes(app2, { store, registry, isAdmin: () => true, backendUrls: () => [], onRevoked: (id) => revoked.push(id) })
    const r = store.pair(store.createPairingCode().code, 'NAS', 'linux')
    if (!r.ok) throw new Error('expected ok')
    expect((await app2.request(`/devices/${encodeURIComponent(r.deviceId)}`, { method: 'DELETE' })).status).toBe(204)
    expect(revoked).toEqual([r.deviceId])
  })
})

describe('配对码防爆破（公网入口）', () => {
  /** 可拨的钟 */
  function clock(start = 1_000_000) {
    let t = start
    return { now: () => t, advance: (ms: number) => (t += ms) }
  }

  const mountWithGuard = (src: () => string) => {
    const c = clock()
    const guard = new PairingGuard({ now: c.now, maxFailures: 3, failureWindowMs: 60_000, cooldownMs: 30_000, burst: 100, refillPerSecond: 0 })
    const app2 = new Hono()
    mountDeviceRoutes(app2, { store, registry, isAdmin: () => true, backendUrls: () => [], sourceIp: () => src(), pairingGuard: guard })
    return { app2, c }
  }

  it('同一来源连错到阈值 → 冷却期内 429，正确的码也换不到 token；别的来源不受影响', async () => {
    let src = '203.0.113.9'
    const { app2 } = mountWithGuard(() => src)
    const { code } = (await (await app2.request('/devices/pairing-code', { method: 'POST' })).json()) as { code: string }
    const wrong = code === '000000' ? '111111' : '000000'
    const pair = (body: unknown) =>
      app2.request('/devices/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    for (let i = 0; i < 3; i++) expect((await pair({ code: wrong })).status).toBe(403)
    const blocked = await pair({ code })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('30')

    // 冷却只针对这个来源：同一个码换一台机器（另一个来源）照样能换到 token
    src = '198.51.100.7'
    expect((await pair({ code })).status).toBe(200)
  })

  it('成功一次清掉失败计数；窗口外的失败不算数', async () => {
    let src = '203.0.113.9'
    const { app2, c } = mountWithGuard(() => src)
    const { code } = (await (await app2.request('/devices/pairing-code', { method: 'POST' })).json()) as { code: string }
    const wrong = code === '000000' ? '111111' : '000000'
    const pair = (body: unknown) =>
      app2.request('/devices/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    await pair({ code: wrong })
    await pair({ code: wrong })
    c.advance(61_000) // 前两次出窗
    await pair({ code: wrong })
    // 窗口里只剩 1 次，没到 3
    expect((await pair({ code })).status).toBe(200)
  })
})
