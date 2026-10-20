/**
 * 用一次性配对码把这个扩展绑到一个（多半是远处的）Stream 上（design D7）。
 *
 * 码是用户在那个 Stream 上**为某台设备**签的：配上之后，这个 Chrome 就是那台设备的浏览器。
 * 换回来的 token 只对这一条绑定有效，之后每次连接前仍先挑战应答（`verifyBackend` 带 `binding`）。
 *
 * **只配 HTTPS 或本机地址。** 配对这一步 token 要过一次网络——明文 HTTP 上谁在路上谁就拿走了它。
 * 地址不合格时在发出任何请求之前就拒绝：码也不该被明文送出去。
 */

export class PairAddressRefused extends Error {
  constructor(baseUrl: string) {
    super(`只能配对 HTTPS 或本机地址：${baseUrl}`)
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

export function isPairableAddress(baseUrl: string): boolean {
  let u: URL
  try {
    u = new URL(baseUrl)
  } catch {
    return false
  }
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))
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
