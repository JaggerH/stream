/**
 * 「这个 CDP 地址准不准连」——**只许回环**。
 *
 * CDP 端口等价于「驱动这台浏览器里的一切」：任意页面求值、读 cookie、代填密码。它只在
 * `--remote-debugging-address=127.0.0.1` 上开（浏览器自己也拒绝在没有认证的情况下绑外网），
 * 而这条绑定是一个普通进程——**它不该成为把那扇门带出本机的那一步**。
 *
 * 判据复用 `access-guard.ts` 的 `isLoopbackAddress`（127.0.0.0/8、::1、IPv4-mapped 形式），
 * 外加 `localhost`（规范上必然解析到本机）。**别在这里另写一套字符串判断**：两套判据漂移
 * 之后，一处放行的地址另一处会拒，而两边单看都正常。
 */
import { isLoopbackAddress } from '../http/access-guard.ts'

export class CdpAddressRefused extends Error {
  constructor(raw: string, reason: string) {
    super(`CDP 地址只许回环（127.0.0.1 / ::1 / localhost）：${raw} —— ${reason}`)
    this.name = 'CdpAddressRefused'
  }
}

/** 校验并归一化 CDP 地址。不是 http(s) / 主机不是回环 → 抛 `CdpAddressRefused`。 */
export function loopbackCdpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new CdpAddressRefused(raw, '不是合法的 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CdpAddressRefused(raw, `协议只能是 http/https，给的是 ${url.protocol}`)
  }
  const host = url.hostname.toLowerCase()
  // `new URL('http://[::1]:9222').hostname` 是带方括号的 `[::1]`；isLoopbackAddress 会自己剥掉。
  // IPv4-mapped 的方括号形式会被 URL 归一成十六进制（`[::ffff:7f00:1]`），那个判据认不出 →
  // 落到下面按非回环拒（fail-closed）。不在这里补一套十六进制判断：地址判据只留一处。
  if (isLoopbackAddress(host) || host === 'localhost' || host.endsWith('.localhost')) return url
  throw new CdpAddressRefused(raw, `主机是 ${host}，不是本机`)
}

/** 服务端地址：只认 http/https（与扩展的配对口径一致——自建 Stream 多半没有证书）。 */
export function serverUrlOf(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`服务端地址不是合法的 URL：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`服务端地址只认 http/https：${raw}`)
  }
  return url.toString().replace(/\/+$/, '')
}
