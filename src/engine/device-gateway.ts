/**
 * 设备网关（openspec `embeddable-device-gateway`）：把设备的连接面——设备配对与管理、扩展绑定、
 * 浏览器节点、站点身份四组 HTTP 路由，加上扩展中继与宿主中继两条 WS 端点——装成一个可挂到宿主
 * 应用上的对象。`stream serve` 的 `routes()` 内部用的也是它（`isAdmin` = 回环、`backendUrls` =
 * 局域网地址），嵌入方把这两样换成自己的口径即可，路径与行为逐字节一致。
 *
 * **不新建任何存储**：设备表、扩展绑定表、节点表、身份表都用实例已经打开的那几份
 * （`stream.devices`）；两条中继注册表是 `kernel.harvest` 上 recipe 派活走的那两份。
 *
 * 设备自己调用的口不经 `isAdmin`：`/devices/pair` 与 `/ext/pair` 只认一次性配对码，两条 WS 只认
 * 设备 / 绑定 token——`isAdmin` 只落在签码、列设备、撤销、改绑定、对设备下 op 这些管理类端点上。
 *
 * **两套路径**：管理面跟着宿主的 `basePath` 走（`app`）；扩展的路径写死在它自己代码里
 * （`${origin}/api/ext/pair|verify|claimed-tabs|debug-log` 与 WS `/api/ext`），所以另有一份挂在
 * `/api` 上的 `extApp`，`handleUpgrade` 也认 `/api/ext`。宿主逐条挂 `mounts` 就不会漏——漏了的表现
 * 是扩展配对成功、却永远连不上（2026-10-29 X2-R1）。
 */
import { Hono, type Context } from 'hono'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { REVOKED_CLOSE_CODE, extPairHandler, mountExtBindingRoutes } from '../http/ext-binding-routes.ts'
import { mountExtPublicRoutes } from '../http/ext-public-routes.ts'
import { devicePairHandler, mountDeviceRoutes } from '../http/device-routes.ts'
import { clientIp } from '../http/client-ip.ts'
import { EXT_VERIFY_LIMIT, PairingGuard, TokenBucket, type PairingGuardOptions, type TokenBucketOptions } from '../http/rate-limit.ts'
import { mountIdentityRoutes } from '../http/identity-routes.ts'
import { mountNodeRoutes } from '../http/node-routes.ts'
import { closeRelayServer, extRelayHandler } from '../http/ext-relay.ts'
import { hostRelayHandler } from '../http/host-relay.ts'
import { resolveExtToken } from '../http/ext-upgrade.ts'
import { agentFrom, ProfileClaims } from '../devices/profile-claim.ts'
import { PAIRED_PLATFORMS } from '../devices/device-store.ts'
import { cookieSlot } from '../credentials/cookie-slot.ts'
import { STREAM_EXTENSION_ID } from '../ext-id.ts'
import type { StreamDevices } from './devices.ts'
import type { Stream } from './index.ts'

export interface DeviceGatewayOptions {
  /** 路径前缀，缺省 '/api'（与 serve 一致）。嵌入方可挂到别处，如 '/api/stream'。 */
  basePath?: string
  /** 谁在调「管理类」HTTP 口（签发配对码、列设备、撤销、改 facility 绑定、对设备下 op）。
   *  serve 传「本机回环才算」；嵌入方传自己的鉴权（已登录的真人）。返回 false = 403。 */
  isAdmin: (c: Context) => boolean
  /** 配对码二维码 / 回执里给设备的「主实例地址」。serve 传局域网地址；嵌入方传自己的公网 / 内网地址。 */
  backendUrls: () => string[]
  /** 中继心跳周期（缺省跟随两条中继自己的默认）。测试用。 */
  pingIntervalMs?: number
  /**
   * 受信的反向代理地址：只有连接来自这些地址时才读 `X-Forwarded-For` 作为来源（限流 / 锁定的键）。
   * **缺省不信任任何头**——直连时那个头只是调用方自己打的字。
   */
  trustedProxies?: string[]
  /** 限流参数（测试注入用）；缺省见 `rate-limit.ts`。 */
  rateLimit?: { pairing?: PairingGuardOptions; verify?: TokenBucketOptions }
  log?: (line: string) => void
}

export interface DeviceGateway {
  readonly basePath: string
  /** 配对、设备、扩展绑定、节点、facility 绑定、身份这几组 HTTP 路由（相对 basePath）。
   *  宿主 app.route(basePath, gateway.app)；**只挂这一份不够**，见 `mounts`。 */
  app: Hono
  /**
   * 扩展**写死在代码里**的那几口（`${origin}/api/ext/pair|verify|claimed-tabs|debug-log`），
   * 相对 `/api` 注册：宿主 app.route('/api', gateway.extApp)。
   *
   * 为什么单独一份：扩展拼的是绝对路径（`extension/src/lib/backend-identity.ts`、`driver.ts`），
   * 它不认识宿主的 basePath。`stream serve` 的 basePath 恰好就是 '/api'，那几口由
   * `src/http/app.ts` 注册在访问门之前（那里写着理由），所以 serve 不需要这一份；嵌入方把网关
   * 挂到别的 basePath 上时必须挂上它——否则扩展配对成功、`/api/ext/verify` 却 404，永远连不上
   * （2026-10-29 X2-R1 真机验收撞到的就是这个）。
   */
  extApp: Hono
  /**
   * host agent **写死在代码里**的那一口（`POST ${origin}/api/devices/pair`，device.rs 的 `pair`），
   * 相对 `/api` 注册：宿主 app.route('/api', gateway.hostApp)。
   *
   * 为什么单独一份：host agent 拼的是绝对路径（`app/host-agent/src/device.rs`），它不认识宿主的
   * basePath。与 `extApp` 同一个先例（X2-R1）：网关挂在 `/api/stream` 上时，agent 打的仍是根上的
   * `/api/devices/pair`。缺了它的表现是 agent 配对必 401 / 404，被拒后 park 不再重试
   * （2026-10-29 HA 线真机验收撞到的就是这个）。WS `/api/host` 不在这里——由 `handleUpgrade`
   * 的 `alsoPaths` 认领，与 `/api/ext` 同一个形状。
   */
  hostApp: Hono
  /**
   * 宿主要挂的全部 (前缀, 子应用)：逐条 `app.route(m.path, m.app)` 即可，**别只挂第一条**。
   * basePath 是 '/api' 时只有一条（serve 的情形，那几口由 app.ts 提供）；否则三条（管理面 +
   * 扩展写死的 `/api/ext/*` + host agent 写死的 `/api/devices/pair`）。
   */
  mounts: ReadonlyArray<{ readonly path: string; readonly app: Hono }>
  /** 宿主的 http server 'upgrade' 事件里调：路径是 `${basePath}/host` / `${basePath}/ext`，或
   *  写死的 `/api/ext`（配对绑定连的就是这一条）、`/api/host`（host agent 连的就是这一条）就接管
   *  并返回 true，否则 false 留给别人（不碰 socket）。 */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
  close(): void
}

export function deviceGateway(stream: Stream, opts: DeviceGatewayOptions): DeviceGateway {
  const base = (opts.basePath ?? '/api').replace(/\/+$/, '') || '/api'
  const log = opts.log ?? console.log
  const kernel = stream.kernel
  const devices: StreamDevices = stream.devices
  const harvest = kernel.harvest
  const { deviceStore, extBindings, facilityDevices, nodes: browserNodes, identities: siteIdentities } = devices
  const pkgs = kernel.packages

  // 公网入口的限流（ingress）：来源取自连接地址；只有受信代理追加的 X-Forwarded-For 才算数。
  const trustedProxies = opts.trustedProxies ?? []
  const sourceIp = (c: Context) => clientIp(c, trustedProxies)
  const devicePairGuard = new PairingGuard(opts.rateLimit?.pairing)
  const extPairGuard = new PairingGuard(opts.rateLimit?.pairing)
  const verifyLimiter = new TokenBucket({ ...EXT_VERIFY_LIMIT, ...opts.rateLimit?.verify })

  const app = new Hono()
  // 四个 mount 用**相对**路径注册，宿主 `app.route(basePath, gateway.app)` 后得到完整路径；
  // serve 的 basePath 是 '/api'，最终绝对路径与从前逐字节一致。
  mountDeviceRoutes(app, {
    store: deviceStore,
    registry: harvest.hostRelays,
    isAdmin: opts.isAdmin,
    backendUrls: () => opts.backendUrls(),
    sourceIp,
    pairingGuard: devicePairGuard,
    ...(facilityDevices ? { bindings: facilityDevices } : {}),
    // 只收有包认领的 facility；调用时才问（包热装卸会变）。
    knownFacility: (f) => pkgs.networkForFacility(f) !== undefined,
    facilities: () => pkgs.facilities(),
    // 身份 / 环境目标（browser-identity D7）：只收身份表里见过的账号、节点上标过的环境。表打不开 = 一律拒。
    ...(siteIdentities ? { knownIdentity: (f: string, a: string) => siteIdentities!.list({ facility: f }).some((i) => i.accountId === a) } : {}),
    ...(browserNodes ? { knownEnvironment: (e: string) => browserNodes!.list().some((n) => n.environment === e) } : {}),
    // 设备没了，挂在它上面的 Chrome 也就没有执行位置可言——一并撤销并断开。
    onRevoked: (id) => {
      for (const b of extBindings.revokeDevice(id)) harvest.extRelays.kick(b, REVOKED_CLOSE_CODE, 'revoked')
    },
  })
  mountIdentityRoutes(app, { identities: () => kernel.siteIdentities })
  mountExtBindingRoutes(app, {
    store: extBindings,
    registry: harvest.extRelays,
    devices: { name: (id) => deviceStore.list().find((d) => d.deviceId === id)?.name },
    isAdmin: opts.isAdmin,
    backendUrls: () => opts.backendUrls(),
    extId: STREAM_EXTENSION_ID,
    sourceIp,
    pairingGuard: extPairGuard,
    ...(browserNodes ? { nodes: browserNodes } : {}),
  })
  // profile 认领（browser-identity D3）：没有节点表就无处可记，整组不挂。
  let claims: ProfileClaims | undefined
  if (browserNodes) {
    claims = new ProfileClaims({
      agent: agentFrom(harvest.hostRelays),
      nodes: browserNodes,
      deviceOf: (b) => harvest.extRelays.deviceOf(b),
      nodeOf: (b) => harvest.extRelays.nodeOf(b),
      extId: STREAM_EXTENSION_ID,
      log,
    })
    harvest.extRelays.onClaim((b, nonce) => claims!.redeem(b, nonce))
    // 新 profile 的竞态：认领等待中这台设备上新连上一个未认领的节点 → 补发一次。
    harvest.extRelays.onBindingConnected((b) => claims!.onBindingConnected(b))
    mountNodeRoutes(app, {
      claims, nodes: browserNodes, isAdmin: opts.isAdmin,
      online: (b) => harvest.extRelays.isOnline(b),
      // 节点行上的「扩展没给的登录态域」：读那个节点槽位最近一轮 cookiePull 的结果。
      cookieGaps: (n) => kernel.auth.cookieGaps(cookieSlot(n.deviceId, n.nodeId)),
      // 能识别 profile 的扩展设备：本机（桌面 agent）与每台在线的配对设备，agent 声明了 browser.claim 才算。
      claimable: () => {
        const claimAgent = agentFrom(harvest.hostRelays)
        return ['local', ...harvest.hostRelays.devices().filter((d) => PAIRED_PLATFORMS.has(d.hello.platform)).map((d) => d.hello.deviceId)]
          .filter((id) => claimAgent(id)?.ops.has('browser.claim'))
      },
    })
  }

  // 扩展写死的路径（`${origin}/api/ext/*`）。扩展在**连上中继之前**要先让后端自证身份
  // （`POST /api/ext/verify`），连上后立刻对账孤儿标签、报生命周期事件——这几口不在这一份里，
  // 嵌入方就永远连不上（X2-R1）。pair 与它们同一份实现、同一个处理器（见 extPairHandler 的头注）。
  const extApp = new Hono()
  extApp.post('/ext/pair', extPairHandler({
    store: extBindings,
    devices: { name: (id) => deviceStore.list().find((d) => d.deviceId === id)?.name },
    extId: STREAM_EXTENSION_ID,
    sourceIp,
    pairingGuard: extPairGuard,
  }))
  mountExtPublicRoutes(extApp, {
    auth: { token: stream.secrets.extToken, extId: STREAM_EXTENSION_ID, tokenHashOf: (id) => extBindings.tokenHashOf(id) },
    claimedTabs: harvest.claimedTabs,
    sourceIp,
    verifyLimiter,
    // 嵌入方没有 debug bus（serve 那份在 `src/http/app.ts`）——缺席时 debug-log 只收不回，
    // 与 app.ts 的 `deps.debug?.record ?? noop` 同款。要接就在 DeviceGatewayOptions 里加一格。
  })

  // host agent 写死的路径（`${origin}/api/devices/pair`）。agent 的 WS `/api/host` 由下面的
  // hostHandler alsoPaths 认领；HTTP 的配对在这一份里。与 extApp 同一个先例（X2-R1）：agent
  // 不认识宿主的 basePath，网关挂在别的 basePath 上时必须答得出根上的这条。码即凭据、不经 isAdmin
  // （与 `app.ts` 的 TOKEN_EXEMPT_ROUTES 同一口径），限流用与设备面同一份 PairingGuard。
  const hostApp = new Hono()
  hostApp.post('/devices/pair', devicePairHandler({ store: deviceStore, sourceIp, pairingGuard: devicePairGuard }))

  // 本机 token → 本机节点（不带 nodeId 的老扩展 → 兼容槽）；配对 token → 那条绑定，换节点来连 4004
  // （device-execution D7、browser-identity D1/D2，判法在 resolveExtToken）。
  const extHandler = extRelayHandler(harvest.extRelays, {
    path: `${base}/ext`,
    // 配对绑定连的是扩展写死的 `/api/ext`（不认识 basePath）。basePath 本来就是 '/api' 时
    // 这一条与上面重复，Set 会去重。
    alsoPaths: ['/api/ext'],
    resolveToken: (t, hs) => resolveExtToken(t, hs, { localToken: stream.secrets.extToken, bindings: extBindings, log }),
    log,
    ...(opts.pingIntervalMs ? { pingIntervalMs: opts.pingIntervalMs } : {}),
  })
  // host-desktop Engine relay at `${base}/host` — Stream Desktop's native process (enigo + OS a11y)
  // connects here. Reuses the local shared secret — it reads it straight off disk (it is a local
  // process, so the filesystem is its channel; see app/host-agent datadir.rs — the directory name
  // is internal, the shipped binary is `stream-desktop`).
  // Nothing connected → kind:'desktop' sources decline as a miss.
  const hostHandler = hostRelayHandler(harvest.hostRelays, {
    path: `${base}/host`,
    // host agent 连的是它写死的 `/api/host`（不认识 basePath）。basePath 本来就是 '/api' 时
    // 这一条与上面重复，Set 会去重。
    alsoPaths: ['/api/host'],
    token: stream.secrets.extToken,
    deviceAuth: (t) => deviceStore.deviceForToken(t),
    onDeviceSeen: (id) => deviceStore.touch(id),
    // A phone whose accessibility service went off can still connect but cannot do anything.
    // The OS turns it off silently (app updates, some OEM cleanups), so say it where the user looks.
    onDeviceState: (id, prev, next) => {
      if (next.a11yEnabled || prev?.a11yEnabled === false) return
      const name = harvest.hostRelays.devices().find((d) => d.hello.deviceId === id)?.hello.name ?? id
      kernel.streamEvents.emit({
        type: 'device.a11y-off', severity: 'warn',
        title: `${name} 的无障碍服务关了`,
        body: '手机上的 Stream 连着，但无障碍服务被系统关掉了，手机上的 recipe 都跑不了。到手机的 设置 → 无障碍 → Stream 重新打开。',
        dedupeKey: `device-a11y-off:${id}`,
      })
    },
    log,
    ...(opts.pingIntervalMs ? { pingIntervalMs: opts.pingIntervalMs } : {}),
  })

  return {
    basePath: base,
    app,
    extApp,
    hostApp,
    mounts: base === '/api'
      ? [{ path: base, app }]
      : [{ path: base, app }, { path: '/api', app: extApp }, { path: '/api', app: hostApp }],
    handleUpgrade: (req, socket, head) => extHandler.handle(req, socket, head) || hostHandler.handle(req, socket, head),
    close: () => {
      closeRelayServer(extHandler.wss)
      closeRelayServer(hostHandler.wss)
      try { claims?.close() } catch { /* 关停期一条失败不拖累其余 */ }
    },
  }
}
