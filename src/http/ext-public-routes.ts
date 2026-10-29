/**
 * 扩展**在连上中继之前 / 对账时**要打的几个 HTTP 口（design D7、openspec `embeddable-device-gateway`）。
 *
 * 为什么单拎一个模块：这几口的路径在扩展里是**写死的绝对路径**（`${origin}/api/ext/verify` 等，
 * 见 `extension/src/lib/backend-identity.ts`、`driver.ts` 的 `connect()`），与后端把自己的路由
 * 挂在哪儿无关。`stream serve` 的路由表把它们注册在访问门之前；设备网关要让**嵌入方**也答得出
 * 同一批口，就必须共用同一份实现——否则嵌入模式下扩展配对成功、却永远连不上（2026-10-29
 * X2-R1：网关只带了 WS，`/api/ext/verify` 404，扩展在开 WS 之前就卡住了）。
 *
 * 收进来的判据：**配对绑定这条路上，扩展自己会打的**。逐个：
 *  - `POST /ext/verify`        后端自证「我也知道那把 secret」（Origin 门控；带 binding 时 key 是
 *                              那条绑定 token 的哈希——见 `extVerifyProofForBinding`）
 *  - `GET  /ext/claimed-tabs`  连上后立刻对账孤儿标签（只读；**空集合与 503 必须分开**，见下）
 *  - `POST /ext/debug-log`     SW 生命周期事件进 debug bus（Origin 门控、低频）
 *
 * 没收进来的，以及为什么：
 *  - `POST /ext/pair`：它在访问门**之后**（`TOKEN_EXEMPT_ROUTES` 按路径放行，Host/Origin 检查
 *    仍然生效）。挪到这里等于把它移到门之前，少一道 rebinding 防线——它留在
 *    `ext-binding-routes.ts`，网关的固定路径 app 单独挂同一个处理器。
 *  - `GET /ext/sync-config`：**配对绑定不调它**（它要 API token，扩展拿不到；见 `driver.ts`
 *    `connect()` 的 open 分支）。只有本机绑定走，而本机绑定只存在于 `stream serve` 那台机器上。
 *  - `GET /ext/bindings`、`PUT/DELETE /ext/bindings/:id/default`、`DELETE /ext/bindings/:id`：
 *    管理面，宿主 UI 用，必须留在宿主的鉴权之后（挂到固定 `/api` 上会绕过它）。
 *  - `GET /ext/relay-status`：诊断探针，扩展不调它（popup 的健康检查看的是 WS 在线状态）。
 *  - `POST /ext/cookies`：已退役（方向反了，现在是后端按需 pull）。**别加回来。**
 *
 * 鉴权口径与 `src/http/app.ts` 里的那几口逐字一致（Origin 门控 / 严格键名 / nonce 长度 / 503 语义），
 * 这里只是搬家。
 */
import type { Context, Hono } from 'hono'
import type { DebugEntry } from '../debug.ts'
import { cleanNodeId } from '../../shared/browser-relay/handshake.ts'
import { isExtensionOrigin } from './ext-binding-routes.ts'
import { localNodeBinding } from './ext-relay-registry.ts'
import { EXT_RELAY_PROTOCOL } from './ext-relay.ts'
import { extVerifyProof, extVerifyProofForBinding } from './ext-verify.ts'
import { unknownKey, unknownKeyMessage } from './strict-input.ts'
import { clientIp } from './client-ip.ts'
import { EXT_VERIFY_LIMIT, TokenBucket } from './rate-limit.ts'
import { randomBytes } from 'node:crypto'

/** `POST /ext/verify` 认识的字段。 */
const EXT_VERIFY_KEYS = ['nonce', 'binding'] as const
/** `POST /ext/debug-log` 认识的字段。 */
const EXT_DEBUG_LOG_KEYS = ['event', 'summary', 'fields', 'ok'] as const

export interface ExtPublicRoutesDeps {
  /**
   * ext-relay 的身份面。缺席 = `/ext/verify` 404（与 app.ts 里 `deps.extRelayAuth` 缺席时一致，
   * 不假装成 403）。
   */
  auth?: {
    /** 本机扩展那条路用的 secret（不带 binding 时签 proof 用它）。**不外发**。 */
    token: string
    extId?: string
    /** 配对绑定 id → 那条绑定 token 的哈希（带 binding 时作 HMAC key）。 */
    tokenHashOf?: (bindingId: string) => string | undefined
  }
  /** 后端此刻骑着的标签；缺席 = 503（"问不到"，不是"一个都不认"）。 */
  claimedTabs?: (bindingId?: string) => number[]
  /** debug bus。缺席 = 只收不回（同 app.ts 的 `deps.debug?.record ?? noop`）。 */
  debug?: { record(entry: DebugEntry): void }
  /** 受信的反向代理地址（只有连接来自它们时才读 `X-Forwarded-For`）。缺省不信任任何头。 */
  trustedProxies?: string[]
  /** 取来源地址（限流键）。缺省按连接地址与受信代理头；测试可注入。 */
  sourceIp?: (c: Context) => string | undefined
  /** `/ext/verify` 的令牌桶；缺省每挂载一份 `EXT_VERIFY_LIMIT`。 */
  verifyLimiter?: TokenBucket
}

function errorBody(code: 'validation_error' | 'unavailable', message: string): { error: { code: string; message: string } } {
  return { error: { code, message } }
}

/** body 是对象就查一遍键名，认不出的当场 400 并指出该写哪个。返回 `null` = 放行。 */
function strictBody(c: Context, body: unknown, allowed: readonly string[]): Response | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const bad = unknownKey(Object.keys(body as Record<string, unknown>), allowed)
  return bad ? c.json(errorBody('validation_error', unknownKeyMessage('字段', bad, allowed)), 400) : null
}

export function mountExtPublicRoutes(app: Hono, deps: ExtPublicRoutesDeps): void {
  const limiter = deps.verifyLimiter ?? new TokenBucket(EXT_VERIFY_LIMIT)
  const sourceIp = deps.sourceIp ?? ((c: Context) => clientIp(c, deps.trustedProxies ?? []))
  /**
   * 「证明你也知道那把 secret」——扩展在**交出 token 之前**打这一口。
   *
   * 这里曾经是 `POST /api/ext/token`，直接把 ext-relay secret 发给对方。**别把它加回来。**
   * 那条路的方向是反的：扩展向对端索取凭证，于是本机任何进程抢到这个口就拿到了这条通道的
   * 全部能力（任意页面 `Runtime.evaluate`）。现在 token 由扩展经 native messaging 从
   * `data/ext-relay-token` 自取（只有同一个用户读得到），这一口只负责让后端**证明**自己也
   * 知道它——回的是 `HMAC-SHA256(token, VERIFY_PREFIX + nonce)`，不是 token 本身。
   *
   * 仍然保留 Origin 门控：proof 虽然不是 secret，但没必要让任意扩展拿它当预言机。
   * 同 `/api/health` 注册在门之前——扩展拿不到 api_token，而网页伪造不了
   * `chrome-extension://` Origin（浏览器强制 Origin 头，fetch/XHR/WS 均不可自设）。
   * 必须是 POST：扩展带 host_permissions 时 GET 走非 CORS 路径、Chrome 不附 Origin 头
   * （实测 Sec-Fetch-Mode: cors 但无 Origin）；非 GET 请求浏览器强制带 Origin，两端才对得上。
   */
  app.post('/ext/verify', async (c) => {
    const auth = deps.auth
    if (!auth) return c.json({ error: 'ext relay disabled' }, 404)
    // 公网入口：这一口没有 token，按来源限流。每次扩展连接打一次，正常用量远低于阈值。
    if (!limiter.take(sourceIp(c))) return c.json({ error: 'too-many-requests' }, 429, { 'Retry-After': '1' })
    const origin = c.req.header('Origin') ?? ''
    if (!isExtensionOrigin(origin, auth.extId)) return c.json({ error: 'forbidden' }, 403)
    const body = (await c.req.json().catch(() => null)) as { nonce?: unknown } | null
    const gate = strictBody(c, body, EXT_VERIFY_KEYS)
    if (gate) return gate
    // nonce 由客户端出，服务端只签不解释；但**必须是它自己给的那个**才防得住重放，
    // 所以空/非串一律拒，绝不用默认值兜底签一个可预测的挑战。
    if (!body || typeof body.nonce !== 'string' || body.nonce.length < 16) {
      return c.json({ error: 'nonce required (>=16 chars)' }, 400)
    }
    const binding = (body as { binding?: unknown }).binding
    if (binding !== undefined) {
      if (typeof binding !== 'string') return c.json({ error: 'binding must be a string' }, 400)
      // 不认识的绑定也照样签一个（随机 key）：回 404 就等于告诉对方哪些 id 存在。
      const key = auth.tokenHashOf?.(binding) ?? randomBytes(32).toString('hex')
      return c.json({ proof: extVerifyProofForBinding(key, body.nonce), protocol: EXT_RELAY_PROTOCOL })
    }
    return c.json({ proof: extVerifyProof(auth.token, body.nonce), protocol: EXT_RELAY_PROTOCOL })
  })

  // 后端此刻还骑着哪些浏览器标签。lane→tab 的映射只在进程内存里，后端一重启就全丢了——
  // 扩展靠这一口回收留在用户 Chrome 里的孤儿采集标签（它自己判断收不收、怎么收，红线在那边）。
  // **空集合和「问不到」必须分开**：空集合 = 一个都不认（后端刚重启的常态，该收就收），
  // dep 没接线 = 503，扩展见到非 200 一律什么都不做。注册在访问门之前：
  // 扩展的对账不该依赖它先拿到凭证。
  app.get('/ext/claimed-tabs', (c) => {
    if (!deps.claimedTabs) return c.json(errorBody('unavailable', 'facility sessions not available'), 503)
    // 每个扩展绑定只拿自己那个 Chrome 里的标签对账（design D7）；不带 = 本机兼容槽，与以前一致。
    // 本机节点带 `node`（browser-identity D2）而不是 `binding=local:…`——老后端不认 `node`，回的是本机全集，
    // 不会把在跑的标签当孤儿。形状不对的 node 当没带。
    const node = cleanNodeId(c.req.query('node'))
    return c.json({ tabIds: deps.claimedTabs(c.req.query('binding') || (node ? localNodeBinding(node) : undefined)) })
  })

  /*
   * 这里曾经有 `POST /api/ext/cookies`：扩展定时把登录态推给后端。**别加回来**，方向已经反了
   * ——现在是后端在需要的时刻去取（`ExtRelay.cookiePull` → `CookiePuller`）。
   *
   * 为什么反：扩展不知道后端什么时候要用登录态，只能按时间猜（30 分钟一轮）。猜的代价是
   * cookie 轮换之后干等一整个周期，期间每次取流都 412——而后端明明当场就知道自己吃了个 401。
   * 取数的调度权必须在知道"什么时候要用"的那一端。
   *
   * 撤掉它不是洁癖：留着就是一条没有调用方的写全站登录态的口子，而且它会让下一个人以为
   * "推那条路还活着"，在 pull 出问题时去修一条早就没人走的路。
   */

  // 扩展 SW 的关键生命周期事件 → debug bus 的 `ext-cdp` channel（`GET /api/debug/log?channel=ext-cdp`）。
  // **走 HTTP 不走 relay 的 WS**：要记的那几件事（onStartup 触发、账本清空、认领旧组）全发生在
  // connect 之前，走 WS 就等于永远记不到最需要的那一刻。
  // 只收扩展自己的低频事件（浏览器/扩展每次启动至多各一次），高频路径（每个 tab 的 add/remove）
  // 不许往这里打。同 /api/ext/verify 用 Origin 门控、注册在门之前：扩展拿不到 api_token。
  app.post('/ext/debug-log', async (c) => {
    if (!/^chrome-extension:\/\/[a-p]{32}$/.test(c.req.header('Origin') ?? '')) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const body = await c.req.json().catch(() => undefined) as
      { event?: unknown; summary?: unknown; fields?: unknown; ok?: unknown } | undefined
    const gate = strictBody(c, body, EXT_DEBUG_LOG_KEYS)
    if (gate) return gate
    const event = typeof body?.event === 'string' ? body.event : undefined
    if (!event) return c.json(errorBody('validation_error', 'event required'), 400)
    const at = Date.now()
    const record = deps.debug?.record ?? (() => {})
    record({
      id: `ext-cdp:${event}@${at}`,
      at,
      channel: 'ext-cdp',
      key: event,
      title: `扩展：${event}`,
      summary: typeof body?.summary === 'string' ? body.summary : event,
      // ok **由扩展申报**，缺省 true（生命周期事件 onStartup / ledger-cleared 都不是故障）。
      // 慢命令那两条要报 false，否则 DebugBox 的 failedOnly 会只留下后端侧的 relay-timeout
      // 而藏掉配对的 slow-command —— 而"有 timeout、没 slow-command"正是"命令没送到 SW"的
      // 判据，等于一个过滤器凭空造出一个错误结论。
      ok: body?.ok !== false,
      fields: Array.isArray(body?.fields)
        ? (body.fields as unknown[])
            .filter((f): f is { label: string; value: unknown } =>
              !!f && typeof (f as { label?: unknown }).label === 'string')
            .slice(0, 12)
            .map((f) => ({ label: f.label, value: String(f.value) }))
        : [],
    })
    return c.json({ ok: true })
  })
}
