import { VERIFY_PREFIX } from '@browser-relay/wire.ts'

/**
 * 「`127.0.0.1:8900` 那头真的是我那台 Stream 吗」——每次用 token 之前问一次。
 *
 * 拿到 token（`native-host.ts`）只解决了一半：扩展知道了正确的 secret，但**它还是会把这个
 * secret 递给对端**（WS 握手把 token 放在 `Sec-WebSocket-Protocol` 里，cookie 直推把它放在
 * `Authorization` 里）。冒充者什么都不用做，光是被连上就白拿一份 secret。
 *
 * 所以顺序必须是：**先让对端证明它也知道这个 secret，再把 secret 交出去。** 证明方式是
 * 挑战应答——扩展给一个随机 nonce，后端回 `HMAC-SHA256(token, VERIFY_PREFIX + nonce)`。
 * 应答里没有 secret 本身，nonce 每次新生成所以录下来也不能重放。冒充者不知道 token，算不出。
 *
 * 前缀是**域分隔**，不是装饰：同一把 key 将来若被用在别处签别的东西，没有前缀就可能让
 * 一处的合法应答变成另一处的有效凭证。
 */

/** 挑战应答的域分隔前缀。**改它就是改协议**——值来自 shared/browser-relay/wire.ts（两侧唯一真相源）。 */
export { VERIFY_PREFIX }

export class BackendNotTrusted extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'BackendNotTrusted'
  }
}

/** `HMAC-SHA256(token, VERIFY_PREFIX + nonce)` 的小写 hex。与后端同名函数必须逐字节一致。 */
export async function expectedProof(token: string, nonce: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(VERIFY_PREFIX + nonce))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 定长比较——proof 是公开值，时序泄露的收益接近零，但比较判据本来就不该给坏习惯留样板。 */
export function proofEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** 每次新生成，绝不复用——重放的唯一防线就是它。 */
export function freshNonce(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  return [...raw].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 向 `baseUrl` 那头验一次身份。通过则返回，否则抛 `BackendNotTrusted`。
 *
 * **调用方必须把它当闸门，不能当日志**：验不过就别连、别推 cookie。这条路上没有"降级继续"
 * 那一档——降级就等于没有这道锁。
 */
export async function verifyBackend(baseUrl: string, token: string): Promise<void> {
  const nonce = freshNonce()
  let res: Response
  try {
    res = await fetch(baseUrl.replace(/\/$/, '') + '/api/ext/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce }),
    })
  } catch (e) {
    throw new BackendNotTrusted(`验身份的请求没发出去：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) throw new BackendNotTrusted(`验身份被拒：HTTP ${res.status}`)
  let proof: unknown
  try {
    proof = ((await res.json()) as { proof?: unknown }).proof
  } catch {
    throw new BackendNotTrusted('验身份的应答不是 JSON')
  }
  if (typeof proof !== 'string') throw new BackendNotTrusted('验身份的应答里没有 proof')
  if (!proofEqual(proof, await expectedProof(token, nonce))) {
    throw new BackendNotTrusted('对端算不出正确的 proof —— 它不是我们配对的那台 Stream')
  }
}
