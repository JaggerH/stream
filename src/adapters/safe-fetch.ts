/** Server-side HTML fetch with an SSRF guard, shared by the favicon proxy and the
 *  article extractor. Fetching on the backend is deliberate: it reaches publisher
 *  sites a CN browser often can't, and keeps third-party page HTML off the client. */

// owned 通道：绕开内嵌 RSSHub request-rewriter 的进程级 fetch 补丁（见 http/owned-outbound.ts）。
// SSRF 守卫（isPrivateHost/publicHttpUrl）语义不变，只换底层传输。
import { ownedFetch } from '../http/owned-outbound.ts'
// caller-fetch-guard（openspec/changes/private-fetch-guard）：可选拒绝私网。只在守卫激活
// （开关打开且这次调用在 read_url 等门的作用域里）时改走受校验的连接层——连接时按实际要连
// 的 IP 逐跳判，例外名单可以放行旧闸拦下的主机；未激活时每个分支与引入前一字不差。
import {
  assertCallerUrlAllowed,
  guardedFetch,
  unwrapCallerUrlBlocked,
} from '../net/caller-fetch-guard.ts'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** Refuse loopback / link-local / private ranges for a ?url= param (SSRF guard). */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 0 || a === 127 || a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/** Parse a public http(s) URL, or null if it's malformed / private / non-http. */
export function publicHttpUrl(raw: string): URL | null {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (isPrivateHost(u.hostname)) return null
    return u
  } catch {
    return null
  }
}

export interface FetchedPage {
  html: string
  /** url after redirects — the base for resolving relative links/images */
  finalUrl: string
}

/** SSRF-guarded binary fetch (any content-type) for byte payloads — images, PDFs. Returns
 *  the Response (so the caller reads the bytes + content-type) or null on a private host,
 *  timeout, non-2xx, a redirect to a private host, or an over-cap Content-Length.
 *
 *  `opts.signal` = 调用方的取消信号（如一次转换任务被用户撤销）。它和内部超时**叠加**，
 *  不是二选一：`signal` 与 `AbortSignal.timeout` 争的是同一个位置，直接赋值等于静默关掉超时，
 *  于是一个不返回的服务端能把请求永远挂住——症状只是"这次特别慢"，没人会想到是超时没了。 */
export async function safeFetchResponse(
  rawUrl: string,
  opts: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<Response | null> {
  const { maxBytes = 50_000_000, timeoutMs = 20_000 } = opts
  const guarded = guardedFetch()
  if (guarded) {
    await assertCallerUrlAllowed(rawUrl) // 名单放行旧闸（publicHttpUrl）拦下的主机
  } else if (!publicHttpUrl(rawUrl)) {
    return null
  }
  const timeout = AbortSignal.timeout(timeoutMs)
  let res: Response
  try {
    const init: RequestInit = {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      redirect: 'follow',
    }
    res = guarded ? await guarded(rawUrl, init) : await ownedFetch(rawUrl, init)
  } catch (e) {
    // 守卫的拒绝要原样出去（它就是这次调用的答案），不能被吞成 null——那会被上层说成「没抓到」。
    if (unwrapCallerUrlBlocked(e)) throw unwrapCallerUrlBlocked(e)
    return null
  }
  if (!res.ok) return null
  if (guarded) {
    await assertCallerUrlAllowed(res.url || rawUrl) // 重定向落点（连接层已逐跳判过，这里兜名单语义）
  } else if (!publicHttpUrl(res.url || rawUrl)) {
    return null // redirect landed on a private host
  }
  const len = Number(res.headers.get('content-length') ?? '0')
  if (len && len > maxBytes) return null
  return res
}

/** Fetch a page's HTML (text/html only), with SSRF guard, timeout and a size cap.
 *  Returns null on any failure (private host, non-html, timeout, non-2xx). */
export async function safeFetchText(
  rawUrl: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {}
): Promise<FetchedPage | null> {
  const { maxBytes = 2_000_000, timeoutMs = 8000 } = opts
  const guarded = guardedFetch()
  if (guarded) {
    await assertCallerUrlAllowed(rawUrl)
  } else if (!publicHttpUrl(rawUrl)) {
    return null
  }
  let res: Response
  try {
    const init: RequestInit = {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    }
    res = guarded ? await guarded(rawUrl, init) : await ownedFetch(rawUrl, init)
  } catch (e) {
    if (unwrapCallerUrlBlocked(e)) throw unwrapCallerUrlBlocked(e)
    return null
  }
  if (!res.ok) return null
  const ct = res.headers.get('content-type') ?? ''
  if (ct && !/text\/html|application\/xhtml/i.test(ct)) return null
  // guard against a redirect landing on a private host
  if (guarded) {
    await assertCallerUrlAllowed(res.url || rawUrl)
  } else if (!publicHttpUrl(res.url || rawUrl)) {
    return null
  }
  try {
    const buf = await res.arrayBuffer()
    const bytes = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf
    return { html: new TextDecoder('utf-8').decode(bytes), finalUrl: res.url || rawUrl }
  } catch {
    return null
  }
}
