/**
 * Pairing and managing phones (design D4).
 *
 * `pairing-code` answers **this machine only**. A code lets a device in, so minting one needs
 * someone in front of the machine, the same rule as `/api/access-token`. `pair` is the one route
 * the API token does not guard (see `TOKEN_EXEMPT_ROUTES`): the phone has no token yet, and the
 * code itself is the credential. Host and Origin checks still apply to it.
 */
import type { Context, Hono } from 'hono'
import type { DeviceStore } from '../devices/device-store.ts'
import type { HostRelayRegistry } from './host-registry.ts'

export const TOKEN_EXEMPT_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: '/api/devices/pair' },
]

export interface DeviceRoutesDeps {
  store: DeviceStore
  registry: Pick<HostRelayRegistry, 'devices' | 'kick'>
  isLocal: (c: Context) => boolean
  /** Base URLs where a phone on the LAN can reach this backend (`http://<ip>:<port>`). */
  backendUrls: (c: Context) => string[]
}

export function mountDeviceRoutes(app: Hono, deps: DeviceRoutesDeps): void {
  app.post('/api/devices/pairing-code', (c) => {
    if (!deps.isLocal(c)) return c.json({ error: '配对码只能在运行 Stream 的那台机器上生成' }, 403)
    const { code, expiresAt } = deps.store.createPairingCode()
    const qr = deps.backendUrls(c).map((backend) => JSON.stringify({ stream: 'pair', v: 1, backend, code }))
    return c.json({ code, expiresAt, qr })
  })

  app.post('/api/devices/pair', async (c) => {
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'body 不是合法 JSON' }, 400) }
    const { code, name } = (body ?? {}) as { code?: unknown; name?: unknown }
    if (typeof code !== 'string' || (name !== undefined && typeof name !== 'string')) {
      return c.json({ error: 'code 必须是字符串，name 可选且必须是字符串' }, 400)
    }
    const r = deps.store.pair(code, name ?? '')
    if (!r.ok) return c.json({ error: r.reason }, 403)
    return c.json({ deviceId: r.deviceId, deviceToken: r.deviceToken })
  })

  app.get('/api/devices', (c) => {
    const online = new Map(deps.registry.devices().map((d) => [d.hello.deviceId, d]))
    const paired = deps.store.list().map((d) => {
      const live = online.get(d.deviceId)
      return {
        ...d, paired: true, online: !!live,
        ...(live ? { agentVersion: live.hello.agentVersion } : {}),
        ...(live?.state ? { state: live.state } : {}),
      }
    })
    const pairedIds = new Set(paired.map((d) => d.deviceId))
    const others = [...online.values()]
      .filter((d) => !pairedIds.has(d.hello.deviceId))
      .map((d) => ({
        deviceId: d.hello.deviceId, name: d.hello.name, platform: d.hello.platform,
        paired: false, online: true, agentVersion: d.hello.agentVersion,
        ...(d.state ? { state: d.state } : {}),
      }))
    return c.json({ devices: [...paired, ...others] })
  })

  /**
   * Run one host op on one device and return what the agent answered. **This machine only**:
   * it actuates a phone, so it needs someone at the machine, the same rule as `pairing-code`.
   * It exists for live checks and for measuring a new app before writing its recipe; recipes
   * never go through it.
   */
  app.post('/api/devices/:id/ops', async (c) => {
    if (!deps.isLocal(c)) return c.json({ error: '只能在运行 Stream 的那台机器上调用' }, 403)
    const id = c.req.param('id')
    let body: { op?: unknown; args?: unknown }
    try { body = await c.req.json() } catch { return c.json({ error: 'body 不是合法 JSON' }, 400) }
    if (typeof body.op !== 'string' || (body.args !== undefined && (typeof body.args !== 'object' || body.args === null))) {
      return c.json({ error: 'op 必须是字符串，args 可选且必须是对象' }, 400)
    }
    const device = deps.registry.devices().find((d) => d.hello.deviceId === id)
    if (!device) return c.json({ error: '这台设备不在线' }, 404)
    try {
      const result = await device.relay.send({ op: body.op, ...(body.args ? { args: body.args as Record<string, unknown> } : {}) })
      return c.json({ result: result ?? null })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502)
    }
  })

  app.delete('/api/devices/:id', (c) => {
    const id = c.req.param('id')
    if (!deps.store.revoke(id)) return c.json({ error: '没有这台设备' }, 404)
    deps.registry.kick(id, 4003, 'revoked')
    return c.body(null, 204)
  })
}
