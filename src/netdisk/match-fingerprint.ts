import type { MappingEntry } from './types.ts'
import type { AlistFile } from './alist-client.ts'

/**
 * 重绑认亲：旧 entries 里 confirmed（最高资产）的指纹，在新目录文件里按 size 精确匹配。
 * size 撞车（两个新文件同字节数）→ 放弃该指纹（宁漏配不错配）。
 * 返回 leftKey → 新 rightFile；调用方继承 confirmed 状态。
 */
export function matchByFingerprint(
  oldEntries: MappingEntry[],
  newFiles: AlistFile[],
): Map<string, string> {
  const bySize = new Map<number, string | null>() // null = 撞车哨兵
  for (const f of newFiles) {
    bySize.set(f.size, bySize.has(f.size) ? null : f.name)
  }
  const out = new Map<string, string>()
  for (const e of oldEntries) {
    if (e.status !== 'confirmed' || !e.fingerprint) continue
    const name = bySize.get(e.fingerprint.size)
    if (name) out.set(e.leftKey, name)
  }
  return out
}
