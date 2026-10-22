/**
 * 扩展绑定的配对与撤销（design D7）。
 *
 * 签码只对本机请求开放，同设备配对码：码放谁进来，签它要有人站在机器前。码**记着目标设备**——
 * 扩展说不清自己和哪个 agent 在同一台机器上，这件事只有用户知道，签码那一刻说清楚。
 * `local` 不签：后端本机的浏览器就是本机扩展，走 native host 那条信任链，不需要配对。
 *
 * `/api/ext/pair` 免 API token（扩展还没有它），码本身就是凭据；仍收 Origin 门：只认扩展来源，
 * 网页伪造不了 `chrome-extension://` Origin。
 */
import type { Context, Hono } from 'hono'
import type { ExtBindingStore } from '../devices/ext-binding-store.ts'
import { LOCAL_DEVICE } from '../devices/run-context.ts'

/** 撤销时用的关闭码，与设备撤销同一个——扩展据此停止重连。 */
export const REVOKED_CLOSE_CODE = 4003

/** 请求来自 Stream 扩展：固定了扩展 id 就只认它，否则认任何扩展 id 形状。`/api/ext/verify` 也用它。 */
export function isExtensionOrigin(origin: string, extId?: string): boolean {
  return extId ? origin === `chrome-extension://${extId}` : /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
}

export interface ExtBindingRoutesDeps {
  store: ExtBindingStore
  registry: { isOnline(bindingId: string): boolean; kick(bindingId: string, code: number, reason: string): boolean }
  devices: { name(deviceId: string): string | undefined }
  isLocal: (c: Context) => boolean
  /** 扩展里该填的地址（同 `/api/devices/pairing-code` 的 `backendUrls`）：面板把它和码一起给用户。 */
  backendUrls?: (c: Context) => string[]
  extId?: string
}

export function mountExtBindingRoutes(app: Hono, deps: ExtBindingRoutesDeps): void {
  app.post('/api/devices/:id/ext-pairing-code', (c) => {
    if (!deps.isLocal(c)) return c.json({ error: '配对码只能在运行 Stream 的那台机器上生成' }, 403)
    const id = c.req.param('id')
    if (id === LOCAL_DEVICE) return c.json({ error: '本机的浏览器不需要配对——装上扩展就会自己连上' }, 400)
    if (deps.devices.name(id) === undefined) return c.json({ error: `没有这台设备：${id}` }, 404)
    return c.json({ ...deps.store.createPairingCode(id), backends: deps.backendUrls?.(c) ?? [] })
  })

  app.post('/api/ext/pair', async (c) => {
    if (!isExtensionOrigin(c.req.header('Origin') ?? '', deps.extId)) return c.json({ error: 'forbidden' }, 403)
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'body 不是合法 JSON' }, 400) }
    const { code, name, browser, platform } = (body ?? {}) as Record<string, unknown>
    if (typeof code !== 'string') return c.json({ error: 'code 必须是字符串' }, 400)
    const r = deps.store.pair(code, { name, browser, platform })
    if (!r.ok) return c.json({ error: r.reason }, 403)
    return c.json({ bindingId: r.bindingId, token: r.token, deviceId: r.deviceId, deviceName: deps.devices.name(r.deviceId) ?? r.deviceId })
  })

  app.get('/api/ext/bindings', (c) =>
    c.json({ bindings: deps.store.list().map((b) => ({ ...b, default: b.default === true, online: deps.registry.isOnline(b.bindingId) })) }),
  )

  // 设备的默认浏览器：执行选绑定时先看它（离线时退回最近连上的，见 `ExtRelayRegistry.pick`）。
  app.put('/api/ext/bindings/:id/default', (c) =>
    deps.store.setDefault(c.req.param('id')) ? c.body(null, 204) : c.json({ error: '没有这条扩展绑定' }, 404),
  )
  app.delete('/api/ext/bindings/:id/default', (c) =>
    deps.store.clearDefault(c.req.param('id')) ? c.body(null, 204) : c.json({ error: '没有这条扩展绑定' }, 404),
  )

  app.delete('/api/ext/bindings/:id', (c) => {
    const id = c.req.param('id')
    if (!deps.store.revoke(id)) return c.json({ error: '没有这条扩展绑定' }, 404)
    deps.registry.kick(id, REVOKED_CLOSE_CODE, 'revoked')
    return c.body(null, 204)
  })
}
