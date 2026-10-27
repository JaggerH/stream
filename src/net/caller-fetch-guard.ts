// src/net/caller-fetch-guard.ts
//
// 「调用方传入任意网址」抓取路径的可选私网拒绝（openspec/changes/private-fetch-guard）。
//
// 作用范围：MCP 的 read_url / stream_fetch_url / video_resolve 与 HTTP 门
// /api/media/from-url、/api/enrich?source=link（正文阅读器）。这些门的共同底层只有两处——safe-fetch 的两个函数与 fetchFor 的
// local 分支——但那两处同时服务订阅采集、网盘、BYOK 端点等**可信配置**路径，所以校验不挂
// 在函数上、也不挂在全局 fetch 上，挂在「这次调用在不在受守卫的作用域里」：
//
//   - `withCallerFetchGuard(fn)` 用 AsyncLocalStorage 划作用域，四个门的入口各包一层；
//   - 作用域内的出站连接走受校验的连接层（`guardedDispatcher`），作用域外的一切照旧。
//
// 防 DNS rebinding 只有一条正解：**校验的地址就是实际连接的地址**。undici 的 connector
// 把 BuildOptions（含自定义 lookup）原样递给 net.connect / tls.connect——
//   - IP 字面量：net.connect 对它不调 lookup，所以 connector 入口直接判（重定向到
//     `http://127.0.0.1/` 这种目标只有这一步接得住）；
//   - 主机名：自定义 lookup 解析后**先判后还**，返回给连接层的地址列表里只剩放行的地址，
//     undici / Node 只会连 lookup 还回的地址。`redirect:'follow'` 的每一跳都重建连接、
//     都过同一道闸。
// 「先解析校验一遍、再让 fetch 自己重新解析」的写法在这里不存在。
//
// 开关关闭（缺省）时：策略位为 null，`withCallerFetchGuard` 原样透传，safe-fetch 与
// fetchFor 连 dispatcher 字段都不出现——所有路径与引入前逐字节一致。

import { Agent, buildConnector, fetch as undiciFetch } from 'undici'
import { lookup as nodeLookup } from 'node:dns'
import type { LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { AsyncLocalStorage } from 'node:async_hooks'

// ─── 地址判定 ────────────────────────────────────────────────────────

/** IPv4 拒绝网段：网络地址（BigInt）+ 前缀长度 + 原因。 */
const V4_BLOCKED: Array<[network: bigint, prefix: number, reason: string]> = [
  [v4('0.0.0.0'), 8, '未指定地址（0.0.0.0/8）'],
  [v4('10.0.0.0'), 8, '私有段（10.0.0.0/8）'],
  [v4('100.64.0.0'), 10, 'CGNAT 共享地址段（100.64.0.0/10）'],
  [v4('127.0.0.0'), 8, '回环地址（127.0.0.0/8）'],
  [v4('169.254.0.0'), 16, '链路本地（169.254.0.0/16）'],
  [v4('172.16.0.0'), 12, '私有段（172.16.0.0/12）'],
  [v4('192.0.0.0'), 24, 'IETF 协议保留段（192.0.0.0/24）'],
  [v4('192.168.0.0'), 16, '私有段（192.168.0.0/16）'],
  [v4('224.0.0.0'), 4, '组播地址（224.0.0.0/4）'],
]

/** IPv6 拒绝网段：网络地址（BigInt）+ 前缀长度 + 原因。 */
const V6_BLOCKED: Array<[network: bigint, prefix: number, reason: string]> = [
  [0n, 128, '未指定地址（::）'],
  [ip6('::1'), 128, '回环地址（::1）'],
  [ip6('::ffff:0:0'), 96, 'IPv4 映射的 IPv6'],
  [ip6('fe80::'), 10, '链路本地（fe80::/10）'],
  [ip6('fc00::'), 7, 'ULA 私有地址（fc00::/7）'],
  [ip6('ff00::'), 8, '组播地址（ff00::/8）'],
]

function v4(ip: string): bigint {
  const [a, b, c, d] = ip.split('.').map(Number)
  return (BigInt(a) << 24n) | (BigInt(b) << 16n) | (BigInt(c) << 8n) | BigInt(d)
}

function ip6(ip: string): bigint {
  const head: string[] = []
  let tail: string[] = []
  let intoTail = false
  for (const group of ip.split(':')) {
    if (group === '') { intoTail = true; continue }
    ;(intoTail ? tail : head).push(group)
  }
  tail = tail.flatMap((g) => (g.match(/.{1,4}/g) ?? []).map((s) => s.padStart(4, '0')))
  const groups = [...head.map((g) => g.padStart(4, '0')), ...Array(8 - head.length - tail.length).fill('0000'), ...tail]
  return BigInt(`0x${groups.join('')}`)
}

const MASK6 = (prefix: number) => (prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix))

/** IPv4 映射的 IPv6（::ffff:a.b.c.d）→ 内嵌的 IPv4 字符串；不是映射返回 null。 */
function embeddedV4Of(ip: string): string | null {
  const m = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (m) return m[1]
  if (!ip.includes(':')) return null
  const v = ip6(ip)
  if ((v & MASK6(96)) === ip6('::ffff:0:0')) {
    const n = v & 0xffffffffn
    return [(n >> 24n) & 255n, (n >> 16n) & 255n, (n >> 8n) & 255n, n & 255n].join('.')
  }
  return null
}

/** 判定口径统一的一步：把 ::ffff: 映射地址剥回 IPv4；点分 IPv4 原样；其余（纯 IPv6）null。 */
function asV4(ip: string): string | null {
  return embeddedV4Of(ip) ?? (ip.includes(':') ? null : ip)
}

/**
 * 判一个地址该不该拒绝；返回拒绝原因（带地址类），放行返回 null。
 * IPv4 映射的 IPv6 按内嵌 IPv4 判——它连的就是一台 IPv4 主机。
 */
export function privateAddressReason(ip: string): string | null {
  const v4ish = asV4(ip)
  if (v4ish) {
    const value = v4(v4ish)
    for (const [network, prefix, reason] of V4_BLOCKED) {
      if ((value & v4Mask(prefix)) === (network & v4Mask(prefix))) {
        return reason
      }
    }
    return null
  }
  const value = ip6(ip)
  for (const [network, prefix, reason] of V6_BLOCKED) {
    if ((value & MASK6(prefix)) === (network & MASK6(prefix))) return reason
  }
  return null
}

const v4Mask = (prefix: number) => (prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(32 - prefix))

// ─── 例外名单 ────────────────────────────────────────────────────────

interface AllowHostname { kind: 'hostname'; host: string }
interface AllowCidr { kind: 'cidr'; family: 4 | 6; network: bigint; prefix: number }
type AllowEntry = AllowHostname | AllowCidr

/** 名单项解析：主机名（精确）或 CIDR；裸 IP 视为 /32 | /128。解析不了抛错（配置错了要说出来）。 */
function parseAllowEntry(entry: string): AllowEntry {
  const raw = entry.trim().toLowerCase().replace(/\.$/, '')
  if (isIP(raw)) {
    if (raw.includes(':')) return { kind: 'cidr', family: 6, network: ip6(raw), prefix: 128 }
    return { kind: 'cidr', family: 4, network: v4(raw), prefix: 32 }
  }
  if (raw.includes('/')) {
    const [base, bitsRaw] = raw.split('/', 2)
    const prefix = Number(bitsRaw)
    if (!base || !Number.isInteger(prefix)) throw new Error(`caller_fetch_guard.allow: 无法解析网段「${entry}」`)
    if (base.includes(':')) {
      if (prefix < 0 || prefix > 128) throw new Error(`caller_fetch_guard.allow: IPv6 前缀长度越界「${entry}」`)
      return { kind: 'cidr', family: 6, network: ip6(base), prefix }
    }
    if (prefix < 0 || prefix > 32) throw new Error(`caller_fetch_guard.allow: IPv4 前缀长度越界「${entry}」`)
    return { kind: 'cidr', family: 4, network: v4(base), prefix }
  }
  return { kind: 'hostname', host: raw }
}

function cidrAllows(entry: AllowCidr, ip: string): boolean {
  if (entry.family === 4) {
    const a = asV4(ip)
    if (!a) return false
    return (v4(a) & v4Mask(entry.prefix)) === (entry.network & v4Mask(entry.prefix))
  }
  if (asV4(ip)) return false // 名单里的 IPv6 段不放行 IPv4 目标（含映射形态）
  return (ip6(ip) & MASK6(entry.prefix)) === (entry.network & MASK6(entry.prefix))
}

// ─── 策略 ────────────────────────────────────────────────────────────

export interface CallerFetchGuardConfig {
  /** true = 守卫激活。缺省 false：一切与引入前一致。 */
  reject_private?: boolean
  /** 例外名单：主机名（精确）或 CIDR 网段（IPv4 / IPv6）。 */
  allow?: string[]
}

export interface CallerFetchGuardPolicy {
  /** 解析一个主机名的全部地址。可注入：测试给假解析表，生产走 node:dns。 */
  resolve: (hostname: string) => Promise<Array<{ address: string; family: number }>>
  /** @internal 名单（解析后的形态）。 */
  readonly allow: AllowEntry[]
}

const defaultResolve = (hostname: string) =>
  new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    nodeLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err)
      else resolve((addresses as LookupAddress[]).map((a) => ({ address: a.address, family: a.family })))
    })
  })

/** 配置 → 策略。未打开（缺省）返回 null——调用方一切照旧。名单配置错了抛错，装配期就炸出来。 */
export function callerFetchGuardPolicy(
  config: CallerFetchGuardConfig | undefined,
  resolve?: CallerFetchGuardPolicy['resolve'],
): CallerFetchGuardPolicy | null {
  if (!config?.reject_private) return null
  return { allow: (config.allow ?? []).map(parseAllowEntry), resolve: resolve ?? defaultResolve }
}

/**
 * 名单内的主机名跳过 IP 判定（连接时 lookup 同样放行——名单就是「这个主机我背书」）。
 * 名单里没有主机名通配：`*.internal` 不在本次范围，要放一段网络写 CIDR。
 */
function hostnameAllowed(policy: CallerFetchGuardPolicy, hostname: string): boolean {
  return policy.allow.some((e) => e.kind === 'hostname' && e.host === hostname.toLowerCase().replace(/\.$/, ''))
}

/** 地址级判定：先名单后拒绝清单。返回 null = 放行。 */
function judgeAddress(policy: CallerFetchGuardPolicy, ip: string): string | null {
  for (const e of policy.allow) {
    if (e.kind === 'cidr' && cidrAllows(e, ip)) return null
  }
  return privateAddressReason(ip)
}

// ─── 错误 ────────────────────────────────────────────────────────────

/** 拒绝访问内网地址。带被拒主机、地址与原因；消息面向调用方（工具回执 / HTTP 门直接引用）。 */
export class CallerUrlBlockedError extends Error {
  readonly host: string
  readonly address: string
  readonly reason: string

  constructor(host: string, address: string, reason: string) {
    super(
      address && address !== host
        ? `拒绝访问内网地址：${host} 解析到 ${address}（${reason}）`
        : `拒绝访问内网地址：${host}（${reason}）`,
    )
    this.name = 'CallerUrlBlockedError'
    this.host = host
    this.address = address
    this.reason = reason
  }
}

// ─── 作用域与策略位 ──────────────────────────────────────────────────

let policy: CallerFetchGuardPolicy | null = null

/** 装配期把解析好的策略放进来（null = 关闭）。进程级部署配置，不是实例级业务数据。 */
export function configureCallerFetchGuard(p: CallerFetchGuardPolicy | null): void {
  policy = p
}

const scope = new AsyncLocalStorage<boolean>()

/** 守卫此刻是否对这次调用激活：策略已配置 **且** 调用处在受守卫的作用域里。 */
export function callerFetchGuardActive(): boolean {
  return policy !== null && scope.getStore() === true
}

/** 划一块受守卫的作用域。策略未配置时原样透传（零开销、零行为变化）。 */
export async function withCallerFetchGuard<T>(fn: () => Promise<T>): Promise<T> {
  if (policy === null) return fn()
  return scope.run(true, fn)
}

/** 作用域内的策略；不在作用域 / 未配置返回 null。safe-fetch 与 fetchFor 用它决定走哪条路。 */
export function activeCallerFetchGuard(): CallerFetchGuardPolicy | null {
  return policy !== null && scope.getStore() === true ? policy : null
}

// ─── URL 预检（门入口的第一道，发包前就给 crisp 的拒绝） ────────────

/** 校验一个调用方传入的 URL：协议 http/https；IP 字面量直判；主机名解析后逐地址判。 */
export async function assertCallerUrlAllowed(raw: string): Promise<void> {
  const p = activeCallerFetchGuard()
  if (!p) return
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new CallerUrlBlockedError(raw, '', 'URL 无法解析')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new CallerUrlBlockedError(raw, '', `协议只允许 http/https，收到 ${u.protocol}`)
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (hostnameAllowed(p, host)) return
  if (isIP(host)) {
    const reason = judgeAddress(p, host)
    if (reason) throw new CallerUrlBlockedError(host, host, reason)
    return
  }
  // 解析失败不在这里拒：让正常抓取按它自己的路径报 DNS 错误。
  const addresses = await p.resolve(host).catch(() => [])
  for (const { address } of addresses) {
    const reason = judgeAddress(p, address)
    if (reason) throw new CallerUrlBlockedError(host, address, reason)
  }
}

// ─── 连接时校验（第二道，也是对重定向唯一有效的那道） ───────────────

/** undici fetch 把连接层错误包成 `TypeError('fetch failed')`（原错误进 cause）——沿 cause 链剥回来。 */
export function unwrapCallerUrlBlocked(e: unknown): CallerUrlBlockedError | null {
  let cur: unknown = e
  while (cur instanceof Error) {
    if (cur instanceof CallerUrlBlockedError) return cur
    cur = (cur as { cause?: unknown }).cause
  }
  return null
}


type ConnectCallback = Parameters<ReturnType<typeof buildConnector>>[1]
type GuardedLookup = (
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void,
) => void

/**
 * 受校验的 lookup：解析全部地址、逐个判定，只把放行的还回给连接层。
 * 解析统一走策略的 `resolve`（生产 = node:dns，测试可注入）——预检与连接时校验用**同一份**
 * 解析语义，rebinding 才没有缝；名单内的主机名跳过 IP 判定（名单就是「这个主机我背书」），
 * 解析本身照走。解析失败原样透传（DNS 坏了不是本守卫的事）。
 */
function guardedLookup(p: CallerFetchGuardPolicy): GuardedLookup {
  return (hostname, options, callback) => {
    const skipIpCheck = hostnameAllowed(p, hostname)
    p.resolve(hostname).then(
      (resolved) => {
        if (skipIpCheck) {
          const first = resolved[0]
          if (!first) {
            callback(new Error(`caller-fetch-guard: ${hostname} 解析不到地址`), undefined, undefined)
            return
          }
          if (options.all) {
            callback(null, resolved.map((a) => ({ address: a.address, family: a.family as 4 | 6 })), undefined)
          } else {
            callback(null, first.address, first.family)
          }
          return
        }
        const allowed: LookupAddress[] = []
        let firstBlocked: { address: string; reason: string } | null = null
        for (const a of resolved) {
          const reason = judgeAddress(p, a.address)
          if (reason) {
            firstBlocked ??= { address: a.address, reason }
            continue
          }
          allowed.push({ address: a.address, family: a.family as 4 | 6 })
        }
        if (allowed.length === 0) {
          const hit = firstBlocked!
          callback(new CallerUrlBlockedError(hostname, hit.address, hit.reason), undefined, undefined)
          return
        }
        if (options.all) callback(null, allowed, undefined)
        else callback(null, allowed[0].address, allowed[0].family)
      },
      (err) => callback(err, undefined, undefined),
    )
  }
}

/**
 * 受校验的 dispatcher：undici Agent + 自定义 connector。
 * IP 字面量在 connector 入口直接判（net.connect 对它不调 lookup）；主机名走上面的守卫 lookup。
 */
const dispatcherCache = new WeakMap<CallerFetchGuardPolicy, Agent>()

export function guardedDispatcher(p: CallerFetchGuardPolicy): Agent {
  const hit = dispatcherCache.get(p)
  if (hit) return hit
  const inner = buildConnector({ lookup: guardedLookup(p) as never })
  const connect = (options: { hostname?: string }, callback: ConnectCallback) => {
    const host = (options.hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
    if (host && isIP(host)) {
      const reason = judgeAddress(p, host)
      if (reason) {
        queueMicrotask(() => callback(new CallerUrlBlockedError(host, host, reason), null))
        return
      }
    }
    inner(options as never, callback)
  }
  const agent = new Agent({ connect: connect as never })
  dispatcherCache.set(p, agent)
  return agent
}

/**
 * 守卫激活时的出站 fetch：undici 自己的 fetch + 受校验 dispatcher（同版本 Agent 塞给全局
 * fetch 不保证兼容，见 netdisk/alist-client 的同款决定；直接 import 不受 RSSHub 对
 * globalThis 的补丁影响，它只换全局属性）。未激活返回 null——调用方走原路径。
 */
export function guardedFetch(): ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) | null {
  const p = activeCallerFetchGuard()
  if (!p) return null
  const dispatcher = guardedDispatcher(p)
  return (input, init) =>
    undiciFetch(input as never, { ...init, dispatcher } as never) as unknown as Promise<Response>
}
