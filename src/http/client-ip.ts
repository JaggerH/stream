/**
 * 谁在调用——限流与锁定的键。
 *
 * 服务可能挂在一个反向代理后面。只有**连接本身来自我们被告知可信的代理**时才读
 * `X-Forwarded-For`；否则那个头只是调用方自己打的字。缺省一个都不信。
 *
 * 只认精确地址（不做 CIDR）：部署里代理就那几个回环 / 内网地址，写成清单最不容易猜错。
 */
import type { Context } from 'hono'
import { peerAddress } from './access-guard.ts'

const MAX_IP_LEN = 64
/** IPv4、IPv6（含 `::ffff:` 映射与方括号）。不做完整校验，只挡明显不是地址的垃圾。 */
const IP_SHAPE = /^[0-9a-fA-F:.]+$/

/** 归一：去空白、去方括号、IPv4 映射的 IPv6 还原成 v4；不像地址的返回 undefined。 */
export function normalizeIp(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string') return undefined
  let s = raw.trim()
  if (!s || s.length > MAX_IP_LEN) return undefined
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s)
  if (mapped) s = mapped[1]!
  // 同时有 `.` 与 `:` 的是「IPv4:端口」或畸形地址（IPv6 不带点，映射形式上面已经还原）
  if (!IP_SHAPE.test(s) || (s.includes('.') && s.includes(':'))) return undefined
  return s.toLowerCase()
}

export function isTrustedProxy(addr: string | undefined | null, trusted: readonly string[] = []): boolean {
  const a = normalizeIp(addr)
  if (!a) return false
  return trusted.some((t) => normalizeIp(t) === a)
}

/**
 * 限流用的来源地址。`peer` 是这次 TCP 连接的对端，`xff` 是 `X-Forwarded-For` 原文。
 * 纯函数，测试直接喂。
 */
export function resolveClientIp(
  peer: string | undefined,
  xff: string | undefined,
  trustedProxies: readonly string[] = [],
): string | undefined {
  const direct = normalizeIp(peer)
  if (!direct) return undefined
  if (!isTrustedProxy(direct, trustedProxies)) return direct
  const hops = (xff ?? '').split(',').map((h) => h.trim()).filter(Boolean)
  const last = hops.at(-1)
  return normalizeIp(last) ?? direct
}

/** 从请求取来源地址（受信代理头见 `resolveClientIp`）。 */
export function clientIp(c: Context, trustedProxies: readonly string[] = []): string | undefined {
  return resolveClientIp(peerAddress(c), c.req.header('x-forwarded-for'), trustedProxies)
}
