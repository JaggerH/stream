import { networkInterfaces } from 'node:os'
import { getConnInfo } from '@hono/node-server/conninfo'
import { tokenEqual } from './secrets.ts'

/**
 * 「这次请求准不准进 /api/*」——**本机免密，外来要 token**。
 *
 * 为什么不是"要么全开、要么全要 token"：后端绑 `0.0.0.0`（用户要从手机/局域网访问，这是
 * 有意的），可它同时也是自己机器上一切东西的邻居——浏览器里**任意一个网页**都能 fetch
 * `127.0.0.1:8900`。两类请求的信任度天差地别，用一个开关一起管，只能二选一地错：
 * 全开 = 任何网页都能驱动你的登录态浏览器；全要 token = 自己机器上用还得先配凭证。
 *
 * 所以判据是**连接从哪来**，不是"配没配 token"：
 * - loopback → 放行。能从 127.0.0.1 连上来，说明已经在这台机器上了，token 拦不住这种人。
 * - 其余（局域网、任何非本机）→ 必须带 token。
 *
 * 实测过的一件事（改这里之前必须知道）：用户日常是 **Windows 的 Chrome 访问 WSL 里的后端**，
 * 这一跳后端看到的 `remoteAddress` 就是 `127.0.0.1`（WSL2 mirrored 网络），所以主路无感。
 * 同一台 Windows 若改用局域网 IP（`http://10.0.0.21:8900`）访问，看到的是那个 LAN 地址、
 * 判为外来——这是对的，我们无法把它和真正的外来机器区分开。
 *
 * 拿不到对端地址时**判为外来**（fail-closed）。"读不到源地址"绝不能变成"那就当本机吧"。
 */

/** 127.0.0.0/8、::1，以及 IPv4-mapped 形式（`::ffff:127.0.0.1`，Node 双栈监听下的常见形状）。 */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false
  let a = addr.trim().toLowerCase()
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1) // 括号形式的 IPv6
  if (a.startsWith('::ffff:')) a = a.slice(7)
  if (a === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
  if (!m) return false
  const octets = m.slice(1).map(Number)
  if (octets.some((o) => o > 255)) return false
  return octets[0] === 127
}

/**
 * 这次请求的对端地址。取不到就是 `undefined`，交给 authorizeAccess 判成外来（fail-closed）——
 * node-server 的 helper 在没有底层 socket 时会抛（进程内 `app.request()` 就是这种），
 * 那种场合本来也不该被当成"本机"放行。
 */
export function peerAddress(c: unknown): string | undefined {
  try {
    return getConnInfo(c as Parameters<typeof getConnInfo>[0]).remote.address
  } catch {
    return undefined
  }
}

/** localhost 及其子域（`*.localhost` 按规范必然解析到本机，rebinding 用不了它）。 */
const isLocalhostName = (h: string) => h === 'localhost' || h.endsWith('.localhost')

/** IPv4/IPv6 字面量。DNS rebinding 必须借域名，所以字面量地址天然免疫。 */
const isIpLiteral = (h: string) =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || (h.startsWith('[') && h.endsWith(']')) || h.includes(':')

/**
 * `Host` 头可不可信 —— **防 DNS rebinding**。
 *
 * 攻击长这样：`evil.com` 解析到 `127.0.0.1`，骗用户的浏览器去访问它。这时请求的 Host 和
 * Origin 都是 `evil.com`，"同源"成立、来源地址也是 loopback —— 前面两道判据全都放行。
 * 唯一还认得出它的地方，就是**这个域名我们从没登记过**。
 */
export function isTrustedHost(hostHeader: string | undefined | null, trustedHosts: string[] = []): boolean {
  const raw = (hostHeader ?? '').trim().toLowerCase()
  if (!raw) return false
  const host = raw.replace(/:\d+$/, '') // 去端口（IPv6 是 [::1]:8900，方括号保留）
  if (isLocalhostName(host) || isIpLiteral(host)) return true
  return trustedHosts.some((h) => h.trim().toLowerCase().replace(/:\d+$/, '') === host)
}

/**
 * `Origin` 头可不可信 —— **防"你自己浏览器里的任意网页"**。
 *
 * 这是前面那道"本机免密"挡不住的威胁：一个恶意页面 fetch `127.0.0.1:8900`，对后端来说
 * 它就是 loopback，和你自己的前端长得一模一样。区分两者的只有 Origin。
 *
 * - 没有 Origin → 可信。不是浏览器发起的（curl、MCP、本机原生进程），或是同源 GET。
 * - Origin 与 Host 同源 → 可信。这就是我们自己的前端页面。
 * - 我们自己的扩展 → 可信（Origin 是 chrome-extension://<固定 ID>，网页伪造不了）。
 * - **本机来源**（`http://127.0.0.1:<任意口>`、`http://localhost:<任意口>`、`[::1]`、`*.localhost`）
 *   → 可信。一张页能以本机地址为 origin，它就是这台机器上跑着的软件发出来的——用户自己 DSH 里
 *   装了 Stream UI 插件的那张页就是这种（绑在他的 dsh web 口上，我们不知道那个数）。远程攻击者
 *   做不到这一点：互联网上的页面 origin 是它自己的域名，DNS rebinding 也只能把域名指过来、
 *   改不了 origin 串。放开的只有"本机上别的程序发出的页面"这一档，而那种程序本来就在你机器上。
 * - 登记在 `extraOrigins` 里的 origin → 可信（**精确串匹配**）。留给后端不在本机的场景
 *   （`STREAM_TRUSTED_ORIGINS`，比如页面在局域网另一台机器上）。
 * - 其余一律不可信，**包括别的扩展**。
 */
/** origin 的 host 是不是本机地址：localhost / *.localhost / 127.0.0.0/8 / ::1（端口任意）。 */
function isLoopbackOrigin(origin: string): boolean {
  let hostname: string
  try {
    hostname = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }
  return isLocalhostName(hostname) || isLoopbackAddress(hostname)
}

export function isTrustedOrigin(opts: {
  origin?: string | null
  hostHeader?: string | null
  extId?: string
  extraOrigins?: string[]
}): boolean {
  const origin = (opts.origin ?? '').trim()
  if (!origin) return true
  if (opts.extId && origin === `chrome-extension://${opts.extId}`) return true
  if (isLoopbackOrigin(origin)) return true
  if (opts.extraOrigins?.some((o) => o.toLowerCase() === origin.toLowerCase())) return true
  const host = (opts.hostHeader ?? '').trim().toLowerCase()
  if (!host) return false
  let originHost: string
  try {
    originHost = new URL(origin).host.toLowerCase()
  } catch {
    return false
  }
  return originHost === host
}

/**
 * `STREAM_TRUSTED_ORIGINS=http://127.0.0.1:3000,http://127.0.0.1:3100` → 去空白、去尾斜杠、
 * 丢空项。产出直接喂 `isTrustedOrigin` 的 `extraOrigins`（精确串匹配，所以尾斜杠必须统一掉，
 * 否则用户抄浏览器地址栏那一下就静默失效）。住这里而不是 serve.ts：serve.ts 一 import 就有
 * 启动副作用，纯函数放它旁边测不了。
 */
export function parseTrustedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => s.length > 0)
}

/**
 * 「在手机上打开这个」——本机各网卡的 IPv4 地址拼成带令牌的链接。
 *
 * 只回 IPv4 且跳过 loopback：给别的设备用的地址，127.0.0.1 在那边指的是它自己；IPv6 链路本地
 * 地址要带 zone id，扫码/手输都不现实。一个都没有（没接网）时回空数组——空**不是**故障，
 * 就是"这台机器现在没有别的设备够得着的地址"。
 */
export function lanUrls(port: string, token: string): string[] {
  const out: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      out.push(`http://${a.address}:${port}/?token=${encodeURIComponent(token)}`)
    }
  }
  return out
}

export type AccessVerdict = 'local' | 'token' | 'denied'

/**
 * 判 verdict（三态而不是布尔：调用方要能把"本机放行"和"凭 token 放行"分开记日志/分开限流，
 * 而 `denied` 的响应还要告诉前端"去要 token"）。
 *
 * `bearer` 是 Authorization 头原文；`queryToken` 是 URL 上的 `?token=`——**只为浏览器存在**：
 * WebSocket 在浏览器里没法自设请求头，手机首访也需要一条能点的链接。它会进日志和 Referer，
 * 所以前端拿到后立刻存起来改走 header（见 app/src/lib/api.ts）。
 */
export function authorizeAccess(opts: {
  remoteAddress?: string | null
  bearer?: string | null
  queryToken?: string | null
  token: string
}): AccessVerdict {
  if (isLoopbackAddress(opts.remoteAddress)) return 'local'
  const presented = opts.bearer?.startsWith('Bearer ')
    ? opts.bearer.slice(7).trim()
    : (opts.queryToken ?? '').trim()
  if (!presented || !opts.token) return 'denied'
  return tokenEqual(presented, opts.token) ? 'token' : 'denied'
}
