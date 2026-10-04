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
