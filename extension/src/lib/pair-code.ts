/**
 * 用一次性配对码把这个扩展绑到一个（多半是远处的）Stream 上（design D7）。
 *
 * 码是用户在那个 Stream 上**为某台设备**签的：配上之后，这个 Chrome 就是那台设备的浏览器。
 * 换回来的 token 只对这一条绑定有效，之后每次连接前仍先挑战应答（`verifyBackend` 带 `binding`）。
 *
 * **HTTPS 和 HTTP 都配。** 自建的 Stream 多半没有证书，只收 HTTPS 等于把它们全挡在门外。
 * 代价要说清：明文 HTTP 上，配对码、token、之后 `cookiePull` 交出去的 cookie 都是路上可见的，
 * 同一网络里能截包的人就拿得到——所以远程明文地址照配，但 popup 要明说（`isPlaintextRemote`）。
 * 内网 / Tailscale（WireGuard 本身加密）下这个代价基本不存在。
 */

export class PairAddressRefused extends Error {
  constructor(baseUrl: string) {
    super(`只能配对 http:// 或 https:// 地址：${baseUrl}`)
    this.name = 'PairAddressRefused'
  }
}

export class PairFailed extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'PairFailed'
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

function parse(baseUrl: string): URL | null {
  try {
    return new URL(baseUrl)
  } catch {
    return null
  }
}

export function isPairableAddress(baseUrl: string): boolean {
  const u = parse(baseUrl)
  return u?.protocol === 'https:' || u?.protocol === 'http:'
}

/** 明文、且不在本机：token 和 cookie 会不加密地过网络（popup 据此提醒，不拦）。 */
export function isPlaintextRemote(baseUrl: string): boolean {
  const u = parse(baseUrl)
  return u?.protocol === 'http:' && !LOOPBACK.has(u.hostname)
}

export interface PairedReply {
  bindingId: string
  token: string
  deviceId: string
  deviceName: string
}

export async function pairWithCode(
  baseUrl: string,
  code: string,
  info: { name?: string; browser?: string; platform?: string },
  deps: { fetch: typeof fetch } = { fetch: (...a) => fetch(...a) },
): Promise<PairedReply> {
  const base = baseUrl.trim().replace(/\/$/, '')
  if (!isPairableAddress(base)) throw new PairAddressRefused(base)
  let res: Response
  try {
    res = await deps.fetch(`${base}/api/ext/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), ...info }),
    })
  } catch (e) {
    throw new PairFailed(`连不上 ${base}：${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status === 403) throw new PairFailed('配对码不对或已过期——在 Stream 上重新生成一个')
  if (!res.ok) throw new PairFailed(`配对被拒：HTTP ${res.status}`)
  const body = (await res.json().catch(() => null)) as Partial<PairedReply> | null
  if (!body || typeof body.bindingId !== 'string' || typeof body.token !== 'string' || typeof body.deviceId !== 'string') {
    throw new PairFailed('配对的回复不完整——对端可能不是 Stream，或版本太旧')
  }
  return { bindingId: body.bindingId, token: body.token, deviceId: body.deviceId, deviceName: body.deviceName ?? body.deviceId }
}
