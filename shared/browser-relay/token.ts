import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * 定长比较两个 token。
 *
 * 先各自 SHA-256 再 `timingSafeEqual`：`timingSafeEqual` 要求两侧等长，直接喂原始字符串会因
 * 长度不同而抛错——而"长度不同"本身就泄露了信息。哈希成固定 32 字节把这个泄露也一并堵掉。
 */
export function tokenEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}
