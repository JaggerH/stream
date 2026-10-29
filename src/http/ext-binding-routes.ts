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
import type { PairingGuard } from './rate-limit.ts'

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
  isAdmin: (c: Context) => boolean
  /** 扩展里该填的地址（同 `/api/devices/pairing-code` 的 `backendUrls`）：面板把它和码一起给用户。 */
  backendUrls?: (c: Context) => string[]
  extId?: string
  /**
   * 浏览器节点表（browser-identity D1）：设备的默认浏览器住在节点上。缺席 = 只有绑定表上的旧标记。
   * 本机节点不在绑定表里，它们的默认只能经这里设（`/api/ext/bindings/local:<nodeId>/default`）。
   */
  nodes?: {
    get(nodeId: string): { nodeId: string; deviceId: string } | undefined
    setDefault(nodeId: string): boolean
    clearDefault(nodeId: string): boolean
    defaultOf(deviceId: string): { nodeId: string } | undefined
  }
  /** 取这次请求的来源地址（限流 / 锁定的键）。缺省 = 连接地址，受信代理头见 `client-ip.ts`。 */
  sourceIp?: (c: Context) => string | undefined
  /** 扩展配对口防爆破与限流；不给 = 不限。 */
  pairingGuard?: PairingGuard
  /** 撤销成功后的回调（嵌入方在这里同步摘掉自己的在线视图）。 */
  onRevoked?: (bindingId: string) => void
}

/**
 * `/ext/pair` 的处理器：扩展拿一次性码换绑定 token。
 *
 * 单独导出是因为它要出现在**两处**：本文件所在的管理面 app（挂在宿主的 basePath 下），以及设备
 * 网关给嵌入方准备的固定路径 app（`${origin}/api/ext/pair`——扩展的路径写死，见
 * `ext-public-routes.ts` 头注）。两处必须同一份实现；**别把它挪进 `ext-public-routes.ts`**：
 * 这里的这一条在访问门**之后**（`TOKEN_EXEMPT_ROUTES` 按路径放行，Host/Origin 检查仍在），
 * 挪到门之前就少一道 rebinding 防线。
 */
export function extPairHandler(
  deps: Pick<ExtBindingRoutesDeps, 'store' | 'devices' | 'extId' | 'sourceIp' | 'pairingGuard'>,
): (c: Context) => Promise<Response> {
  return async (c) => {
    const source = deps.sourceIp?.(c)
    if (deps.pairingGuard && !deps.pairingGuard.allow(source)) {
      return c.json({ error: 'too-many-attempts' }, 429, { 'Retry-After': String(deps.pairingGuard.retryAfterSeconds(source) || 60) })
    }
    if (!isExtensionOrigin(c.req.header('Origin') ?? '', deps.extId)) return c.json({ error: 'forbidden' }, 403)
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'body 不是合法 JSON' }, 400) }
    const { code, name, browser, platform } = (body ?? {}) as Record<string, unknown>
    if (typeof code !== 'string') {
      deps.pairingGuard?.fail(source)
      return c.json({ error: 'code 必须是字符串' }, 400)
    }
    const r = deps.store.pair(code, { name, browser, platform })
    if (!r.ok) {
      deps.pairingGuard?.fail(source)
      return c.json({ error: r.reason }, 403)
    }
    deps.pairingGuard?.succeed(source)
    return c.json({ bindingId: r.bindingId, token: r.token, deviceId: r.deviceId, deviceName: deps.devices.name(r.deviceId) ?? r.deviceId })
  }
}

export function mountExtBindingRoutes(app: Hono, deps: ExtBindingRoutesDeps): void {
  /** 这条绑定落在哪个已知节点上：本机节点从 id 上读，配对绑定看它记下的 `nodeId`。节点表里没有 = 没有。 */
  const nodeOf = (bindingId: string): { nodeId: string; deviceId: string } | undefined => {
    const nodeId = bindingId.startsWith(`${LOCAL_DEVICE}:`) ? bindingId.slice(LOCAL_DEVICE.length + 1) : deps.store.get(bindingId)?.nodeId
    return nodeId ? deps.nodes?.get(nodeId) : undefined
  }
  const isDefault = (b: { bindingId: string; deviceId: string; default?: true }): boolean => {
    const n = nodeOf(b.bindingId)
    return n ? deps.nodes?.defaultOf(n.deviceId)?.nodeId === n.nodeId : b.default === true
  }

  app.post('/devices/:id/ext-pairing-code', (c) => {
    if (!deps.isAdmin(c)) return c.json({ error: '配对码只能在运行 Stream 的那台机器上生成' }, 403)
    const id = c.req.param('id')
    if (id === LOCAL_DEVICE) return c.json({ error: '本机的浏览器不需要配对——装上扩展就会自己连上' }, 400)
    if (deps.devices.name(id) === undefined) return c.json({ error: `没有这台设备：${id}` }, 404)
    return c.json({ ...deps.store.createPairingCode(id), backends: deps.backendUrls?.(c) ?? [] })
  })

  app.post('/ext/pair', extPairHandler(deps))

  app.get('/ext/bindings', (c) =>
    c.json({ bindings: deps.store.list().map((b) => ({ ...b, default: isDefault(b), online: deps.registry.isOnline(b.bindingId) })) }),
  )

  // 设备的默认浏览器：执行选绑定时先看它（离线时退回最近连上的，见 `ExtRelayRegistry.pick`）。
  // 绑定的节点已知 → 设在节点上（browser-identity D1：用户选的本来就是一个 profile），同设备绑定表上
  // 的旧标记一并清掉，免得两处各说一个默认；节点还不知道（扩展没升级）→ 照旧记在绑定上，节点连上时迁。
  app.put('/ext/bindings/:id/default', (c) => {
    const id = c.req.param('id')
    const n = nodeOf(id)
    if (n && deps.nodes?.setDefault(n.nodeId)) {
      const legacy = deps.store.defaultOf(n.deviceId)
      if (legacy) deps.store.clearDefault(legacy)
      return c.body(null, 204)
    }
    return deps.store.setDefault(id) ? c.body(null, 204) : c.json({ error: '没有这条扩展绑定' }, 404)
  })
  app.delete('/ext/bindings/:id/default', (c) => {
    const id = c.req.param('id')
    const n = nodeOf(id)
    const cleared = n ? deps.nodes?.clearDefault(n.nodeId) ?? false : false
    return deps.store.clearDefault(id) || cleared ? c.body(null, 204) : c.json({ error: '没有这条扩展绑定' }, 404)
  })

  app.delete('/ext/bindings/:id', (c) => {
    const id = c.req.param('id')
    if (!deps.store.revoke(id)) return c.json({ error: '没有这条扩展绑定' }, 404)
    deps.registry.kick(id, REVOKED_CLOSE_CODE, 'revoked')
    deps.onRevoked?.(id)
    return c.body(null, 204)
  })
}
