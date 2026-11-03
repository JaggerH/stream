/**
 * 经设备连接转发 HTTP / WebSocket 到设备回环端口（openspec `device-loopback-forward`）。
 *
 * 方向与 `http.fetch`（出站代发）相反：这里是**入站转发**——主实例把对某个入口的请求经设备
 * 已经连上来的节点连接送到**那台设备自己回环地址**上的端口，再把响应送回。设备不开任何入站
 * 端口。三道闸门在这里、一道在设备上：
 *
 * 1. **短期凭证**：入口请求必须带主实例为该挂载签发的 HMAC 凭证，绑定 `(device, port)`，常量
 *    时间比较；**不带、也不替换用户 token**（用户的访问令牌留在主实例的门上，不出这扇门）。
 * 2. **剥掉主实例的身份**：入站的 `Cookie` / `Authorization` / `Proxy-*` 一律不转发（iframe 是
 *    同站导航，浏览器会自动带上主实例的 cookie，原样转过去等于把用户会话交给构件后端）；出站
 *    响应剥掉全部 `Set-Cookie`。
 * 3. **直开也沙箱**：每个响应带 `CSP: sandbox allow-scripts allow-forms` 与 `nosniff`——iframe
 *    的 sandbox 属性只对被嵌入生效；直接在标签页打开转发地址时由 CSP sandbox 把页面压进不透明
 *    源，调不到主实例的同源 API。
 * 4. **设备侧**（agent）：端口必须在它自己声明过的清单里、只连 127.0.0.1。
 *
 * 再加限流（令牌桶按 `(来源, device, port)` 记键）与大小上限（请求 1 MiB、响应 8 MiB、ws 单帧
 * 1 MiB）。缺省值都是代码常量（v1 不做配置面）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { TokenBucket, type TokenBucketOptions } from './rate-limit.ts'
import type { DeviceForwardRelay } from './host-registry.ts'
import type { HttpFetchResult } from './host-relay.ts'
import { clientIp } from './client-ip.ts'

// ── 短期凭证 ────────────────────────────────────────────────────────────────

/** 凭证缺省寿命：60 分钟。挂载页在过期前（`exp - 5min`）刷新 iframe 地址。 */
export const FORWARD_CRED_TTL_MS = 60 * 60_000

/** 凭证绑定的范围：设备与端口必绑；挂载 id（widget id）可选绑定。 */
export interface ForwardScope {
  device: string
  port: number
  widget?: string
}

/**
 * 主实例给转发凭证用的 HMAC 密钥：从已有的中继 secret 派生（`secrets.ts` 的 `extToken`——
 * 它本身从不离开实例，派生值也不进任何网络），不新增一份要管理的落盘密钥。
 */
export function forwardSecretOf(extToken: string): string {
  return createHmac('sha256', extToken).update('device-loopback-forward/v1').digest('hex')
}

const b64u = (b: Buffer): string => b.toString('base64url')

export interface MintedCredential {
  cred: string
  /** 绝对过期时刻（毫秒时间戳）。挂载页据此安排刷新。 */
  exp: number
}

/** 签发一条绑定 `scope` 的短期凭证。`cred` 会进 URL 路径（iframe 用）——日志里只许出现
 *  {@link maskCredential} 的形状。 */
export function mintForwardCredential(
  secret: string,
  scope: ForwardScope,
  opts?: { ttlMs?: number; now?: () => number },
): MintedCredential {
  const exp = (opts?.now ?? Date.now)() + (opts?.ttlMs ?? FORWARD_CRED_TTL_MS)
  const payload = b64u(Buffer.from(JSON.stringify({ d: scope.device, p: scope.port, ...(scope.widget ? { w: scope.widget } : {}), e: exp })))
  const mac = b64u(createHmac('sha256', secret).update(payload).digest())
  return { cred: `${payload}.${mac}`, exp }
}

export type CredentialVerdict =
  | { ok: true }
  | { ok: false; reason: 'credential-malformed' | 'credential-expired' | 'credential-scope' }

/** 校验一条凭证：常量时间比对 mac，再查过期与范围。范围不符与过期分两个错误码——「重新拿一条」
 *  和「这条不是给这个端口的」是两个不同的下一步。 */
export function verifyForwardCredential(secret: string, scope: ForwardScope, cred: string, now: number = Date.now()): CredentialVerdict {
  const dot = cred.indexOf('.')
  if (dot <= 0) return { ok: false, reason: 'credential-malformed' }
  const payload = cred.slice(0, dot)
  const mac = cred.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(payload).digest()
  let given: Buffer
  try {
    given = Buffer.from(mac, 'base64url')
  } catch {
    return { ok: false, reason: 'credential-malformed' }
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'credential-scope' }
  let m: { d?: unknown; p?: unknown; w?: unknown; e?: unknown }
  try {
    m = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'credential-malformed' }
  }
  if (typeof m.e !== 'number') return { ok: false, reason: 'credential-malformed' }
  if (m.e <= now) return { ok: false, reason: 'credential-expired' }
  if (m.d !== scope.device || m.p !== scope.port) return { ok: false, reason: 'credential-scope' }
  if (m.w !== undefined && m.w !== scope.widget) return { ok: false, reason: 'credential-scope' }
  return { ok: true }
}

/** 日志与错误信息里凭证只许以这个形状出现。 */
export function maskCredential(cred: string): string {
  return cred.slice(0, 8) + '…'
}

// ── 缺省值（v1 代码常量）───────────────────────────────────────────────────

/** 令牌桶：容量 30、每秒补 3，键 `(来源, device, port)`。 */
export const FORWARD_RATE_LIMIT: TokenBucketOptions = { capacity: 30, refillPerSecond: 3 }
/** 请求体上限。构件后端是小 JSON API，1 MiB 绰绰有余。 */
export const MAX_FORWARD_BODY = 1024 * 1024
/** 响应体上限。与设备代发 `http.fetch` 的 10 MB 同一量级。 */
export const MAX_FORWARD_RESPONSE = 8 * 1024 * 1024
/** ws 双向单帧上限。 */
export const MAX_FORWARD_FRAME = 1024 * 1024
/** HTTP 转发的缺省入口前缀。挂载器可挂到任意前缀下（嵌入方），这一份是 serve 的缺省。 */
export const FORWARD_BASE_PATH = '/api/fwd'

/** 直开也沙箱：见文件头注第 3 条。 */
const SANDBOX_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['content-security-policy', 'sandbox allow-scripts allow-forms'],
  ['x-content-type-options', 'nosniff'],
]

// ── 依赖 ────────────────────────────────────────────────────────────────────

/** 设备目录的窄视图。三个口都现取：设备会断连、hello 会换。 */
export interface DeviceForwardDirectory {
  isOnline(id: string): boolean
  /** 在线设备声明过的可转发端口；离线 = undefined。 */
  portsOf(id: string): readonly number[] | undefined
  forwardRelay(id: string, op: 'http.forward' | 'ws.forward'): DeviceForwardRelay | undefined
}

export interface DeviceForwardDeps {
  directory: DeviceForwardDirectory
  /** {@link forwardSecretOf} 派生的 HMAC 密钥。 */
  secret: string
  /** 这次请求的来源（限流键）。缺省用连接地址（不读代理头——转发入口不该被伪造来源打满桶）。 */
  sourceIp?: (c: Context) => string | undefined
  rateLimit?: TokenBucketOptions
  now?: () => number
  log?: (line: string) => void
}

// ── 路径 ────────────────────────────────────────────────────────────────────

/**
 * 入口路径形状：`<base>/:device/:port/:cred/<构件路径…>`。`base` 由挂载方传入（缺省
 * {@link FORWARD_BASE_PATH}），**不写死**——嵌入方可以挂到任意前缀、或将来在专用主机名下整站
 * 提供。iframe 地址一律相对页面自己的 base 拼，不含 host。
 */
interface ForwardTarget {
  device: string
  port: number
  cred: string
  /** 构件侧路径，以 '/' 开头；空余段 = '/' */
  rest: string
  search: string
}

function parseForwardPath(pathname: string, search: string, base: string): ForwardTarget | null {
  const b = base.endsWith('/') ? base.slice(0, -1) : base
  if (!pathname.startsWith(b + '/')) return null
  const rest1 = pathname.slice(b.length + 1)
  const segs = rest1.split('/')
  if (segs.length < 3) return null
  const [device, portRaw, cred] = segs
  const port = Number(portRaw)
  if (!/^\d+$/.test(portRaw) || !Number.isInteger(port) || port < 1 || port > 65535) return null
  const rest = segs.slice(3).join('/')
  return { device, port, cred, rest: rest === '' ? '/' : `/${rest}`, search }
}

/** 入站请求头里不转发给设备后端的：主实例身份（cookie / authorization / proxy-*）与逐跳头。
 *  转发请求唯一的身份是 `x-stream-fwd-cred`。 */
const STRIPPED_REQUEST_HEADERS = new Set([
  'cookie', 'authorization', 'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length', 'expect',
])
const isStrippedRequestHeader = (k: string): boolean => STRIPPED_REQUEST_HEADERS.has(k.toLowerCase()) || k.toLowerCase().startsWith('proxy-')

const errorResponse = (c: Context, status: ContentfulStatusCode, code: string, message?: string) =>
  c.json({ error: code, ...(message ? { message } : {}) }, status)

// ── HTTP 挂载器 ─────────────────────────────────────────────────────────────

export interface DeviceForwardMountOptions {
  /** 解析用的绝对前缀。**注册是相对的**（子应用按 `path` 挂），`base` 只用来切出目标段——
   *  嵌入方挂到别的 mount 点时两者都要跟着改。缺省 {@link FORWARD_BASE_PATH}。 */
  base?: string
  /** 相对注册路径，缺省 'fwd'。 */
  path?: string
}

/**
 * 把转发入口挂到一个 Hono app 上（相对路径，可与任意 mount 前缀组合）。返回的子应用也可以
 * 单独拿去 route。WS 升级不经 Hono——用 {@link deviceForwardUpgrade} 另挂到 server 的
 * `upgrade` 上（与两条中继同一形状）。
 */
export function deviceForwardApp(deps: DeviceForwardDeps, opts: DeviceForwardMountOptions = {}): Hono {
  const app = new Hono()
  mountDeviceForward(app, deps, opts)
  return app
}

export function mountDeviceForward(parent: Hono, deps: DeviceForwardDeps, opts: DeviceForwardMountOptions = {}): void {
  const base = (opts.base ?? FORWARD_BASE_PATH).replace(/\/+$/, '') || FORWARD_BASE_PATH
  const sub = opts.path ?? 'fwd'
  const bucket = new TokenBucket({ ...FORWARD_RATE_LIMIT, ...deps.rateLimit })
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})

  const refuse = (c: Context, kind: 'bad-port' | 'offline' | 'undeclared' | 'no-relay', device: string, port: number) => {
    if (kind === 'offline') return errorResponse(c, 502, 'device-offline', `设备不在线：${device}`)
    if (kind === 'undeclared') return errorResponse(c, 403, 'port-not-declared', `设备 ${device} 没有声明允许转发端口 ${port}`)
    if (kind === 'no-relay') return errorResponse(c, 502, 'device-offline', `设备刚好断开了：${device}`)
    return errorResponse(c, 400, 'bad-port', '端口必须是 1–65535 的整数')
  }

  const handle = async (c: Context): Promise<Response> => {
    const t = parseForwardPath(c.req.path, new URL(c.req.url).search, base)
    if (!t) return errorResponse(c, 404, 'not-found', '转发路径形状是 <base>/:device/:port/:cred/<path>')
    // 1) 凭证（先于一切：没有凭证的请求连限流桶都不该占）。
    const verdict = verifyForwardCredential(deps.secret, { device: t.device, port: t.port }, t.cred, now())
    if (!verdict.ok) return errorResponse(c, 403, verdict.reason)
    // 2) 限流：按 (来源, device, port) 记键。
    const source = deps.sourceIp?.(c) ?? clientIp(c, [])
    if (!bucket.take(`${source}|${t.device}|${t.port}`)) {
      return errorResponse(c, 429, 'too-many-requests', '转发请求太快，稍后再试')
    }
    // 3) 目标：设备在线、端口声明过、通道还在。
    if (!deps.directory.isOnline(t.device)) return refuse(c, 'offline', t.device, t.port)
    if (!deps.directory.portsOf(t.device)?.includes(t.port)) return refuse(c, 'undeclared', t.device, t.port)
    const relay = deps.directory.forwardRelay(t.device, 'http.forward')
    if (!relay) return refuse(c, 'no-relay', t.device, t.port)
    // 4) 大小上限：请求体先量再收——超限的请求一帧都不该发往设备。
    let body: Buffer | undefined
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      body = Buffer.from(await c.req.arrayBuffer())
      if (body.byteLength > MAX_FORWARD_BODY) return errorResponse(c, 413, 'payload-too-large', `请求体超过 ${MAX_FORWARD_BODY} 字节`)
    }
    // 5) 剥掉主实例的身份与逐跳头；转发请求唯一的身份是转发凭证。
    const headers: [string, string][] = []
    c.req.raw.headers.forEach((v, k) => {
      if (!isStrippedRequestHeader(k)) headers.push([k, v])
    })
    headers.push(['x-stream-fwd-cred', t.cred])
    const started = now()
    try {
      const result = await relay.forwardOp({
        port: t.port,
        cred: t.cred,
        method: c.req.method,
        path: `${t.rest}${t.search}`,
        headers,
        ...(body ? { body: body.toString('base64') } : {}),
        timeoutMs: 30_000,
      })
      return forwardResultResponse(c, result)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const code = (e as { code?: string }).code
      log(`[device-forward] ${t.device}:${t.port} ${t.rest} → ${code ?? 'error'} (${now() - started}ms) cred=${maskCredential(t.cred)}`)
      // 设备自己点名拒绝的（端口没声明、回环连不上、它侧的超限）原样分类；断连/超时映射成
      // 网关语义的 502/504。范围仍 fail closed：任何没认出的错误都不退回"转发成功"。
      if (code === 'port-not-declared') return errorResponse(c, 403, 'port-not-declared', msg)
      if (code === 'connect-failed') return errorResponse(c, 502, 'connect-failed', msg)
      if (code === 'too-large') return errorResponse(c, 413, 'payload-too-large', msg)
      if ((e as { name?: string }).name === 'HostRelayTimeout') return errorResponse(c, 504, 'gateway-timeout', msg)
      return errorResponse(c, 502, 'device-offline', msg)
    }
  }

  parent.all(`${sub}/*`, (c) => handle(c))
  parent.all(sub, (c) => handle(c))
}

/** 出站响应：剥 `Set-Cookie`、加沙箱头。其余头原样（构件自己的 CSP 会与我们追加的并存——
 *  浏览器取并集里更严的那些，方向正确）。 */
export function forwardResultResponse(c: Context, r: HttpFetchResult): Response {
  const headers = new Headers()
  for (const [k, v] of r.headers) {
    if (k.toLowerCase() === 'set-cookie') continue
    headers.append(k, v)
  }
  for (const [k, v] of SANDBOX_HEADERS) headers.set(k, v)
  const bytes = Buffer.from(r.body, 'base64')
  const body = bytes.byteLength > MAX_FORWARD_RESPONSE
    ? Buffer.from(`响应体超过 ${MAX_FORWARD_RESPONSE} 字节`)
    : bytes
  return new Response(body, { status: bytes.byteLength > MAX_FORWARD_RESPONSE ? 413 : r.status, headers })
}

// ── WebSocket 升级 ──────────────────────────────────────────────────────────

/**
 * 转发入口的 WS 升级处理器（与两条中继同一形状：认领自己的路径，别人的路径返回 false 且不碰
 * socket）。同一个前缀、同一条凭证校验；升级成功后入口 socket 与设备回环 socket 经 `fwd-data`/
 * `fwd-close` 帧双向搬运。凭证无效/端口未声明时以 HTTP 响应拒绝（401/403），不留半开连接。
 */
export function deviceForwardUpgrade(deps: DeviceForwardDeps, opts: DeviceForwardMountOptions = {}): (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean {
  const base = (opts.base ?? FORWARD_BASE_PATH).replace(/\/+$/, '') || FORWARD_BASE_PATH
  const bucket = new TokenBucket({ ...FORWARD_RATE_LIMIT, ...deps.rateLimit })
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })

  const deny = (socket: Duplex, status: number, body: string): true => {
    socket.write(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Bad Request'}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
    socket.destroy()
    return true
  }

  return (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const t = parseForwardPath(url.pathname, url.search, base)
    if (!t) return false // 不是我们的路径：留给别的 upgrade 监听器
    const verdict = verifyForwardCredential(deps.secret, { device: t.device, port: t.port }, t.cred, now())
    if (!verdict.ok) return deny(socket, 403, verdict.reason)
    if (!bucket.take(`${req.socket.remoteAddress ?? ''}|${t.device}|${t.port}`)) {
      return deny(socket, 429, 'too-many-requests')
    }
    if (!deps.directory.isOnline(t.device)) return deny(socket, 502, `device-offline: ${t.device}`)
    if (!deps.directory.portsOf(t.device)?.includes(t.port)) return deny(socket, 403, `port-not-declared: ${t.port}`)
    const relay = deps.directory.forwardRelay(t.device, 'ws.forward')
    if (!relay) return deny(socket, 502, `device-offline: ${t.device}`)

    // 剥身份：升级请求同样只带转发凭证进设备（浏览器会给 WS 升级带 cookie，同样不许过去）。
    const headers: [string, string][] = []
    for (const [k, v] of Object.entries(req.headers)) {
      if (isStrippedRequestHeader(k)) continue
      if (Array.isArray(v)) for (const x of v) headers.push([k, x])
      else if (typeof v === 'string') headers.push([k, v])
    }
    headers.push(['x-stream-fwd-cred', t.cred])

    wss.handleUpgrade(req, socket, head, (client) => {
      let session: ReturnType<DeviceForwardRelay['openForwardWs']> | null = null
      let clientOpen = true
      const end = () => {
        clientOpen = false
        try { client.close(1000, 'forward closed') } catch { /* 已关 */ }
        session?.close()
      }
      session = relay.openForwardWs(
        { port: t.port, cred: t.cred, path: `${t.rest}${t.search}`, headers },
        {
          onData: (b64) => {
            const bytes = Buffer.from(b64, 'base64')
            if (bytes.byteLength > MAX_FORWARD_FRAME) { end(); return }
            if (clientOpen) client.send(bytes)
          },
          onClose: () => {
            clientOpen = false
            try { client.close(1000, 'forward closed') } catch { /* 已关 */ }
          },
        },
      )
      session.opened.then(() => {
        log(`[device-forward] ws open ${t.device}:${t.port}${t.rest} cred=${maskCredential(t.cred)}`)
      }, (e) => {
        log(`[device-forward] ws refused ${t.device}:${t.port} — ${e instanceof Error ? e.message : String(e)}`)
        try { client.close(1011, 'device refused') } catch { /* 已关 */ }
      })
      client.on('message', (data) => {
        if (!clientOpen || !session) return
        const bytes = data instanceof Buffer ? data : Buffer.from(data.toString('binary'))
        if (bytes.length > MAX_FORWARD_FRAME) { end(); return }
        session.send(bytes.toString('base64'))
      })
      client.on('close', () => {
        clientOpen = false
        session?.close()
      })
      client.on('error', () => {
        clientOpen = false
        session?.close()
      })
    })
    return true
  }
}
