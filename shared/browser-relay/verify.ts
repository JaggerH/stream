import { createHmac } from 'node:crypto'
import { VERIFY_PREFIX } from './wire.ts'

export { VERIFY_PREFIX } from './wire.ts'

/**
 * 后端/插件用来自证「我也知道 ext-relay 那把 secret」的应答。
 * **回的是 proof，不是 secret** —— nonce 由扩展每次新生成，录下的应答不能重放；proof 是
 * 公开值，泄露它不泄露 token。扩展侧的对应实现是 backend-identity.ts 的 expectedProof
 * （WebCrypto），两者对同一 (token, nonce) 必须逐字节相同。
 */
export function extVerifyProof(token: string, nonce: string): string {
  return createHmac('sha256', token).update(VERIFY_PREFIX + nonce).digest('hex')
}

/**
 * 配对绑定的挑战应答（design D7）。实例只存 token 的 SHA-256（小写 hex），算不出
 * `HMAC(token, …)`，所以 key 就是那个哈希；扩展侧先算 `sha256hex(token)` 再签。
 * 代价：拿到 `ext-bindings.json` 的人能冒充这个实例骗过挑战——但他随后从握手里拿到的 token
 * 只对这一条绑定有效，而能读那个文件的人本来就在实例机器上。
 */
export function extVerifyProofForBinding(tokenHashHex: string, nonce: string): string {
  return extVerifyProof(tokenHashHex, nonce)
}
