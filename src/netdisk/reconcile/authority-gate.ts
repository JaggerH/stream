/**
 * 权威清单的健康闸（spec 2026-09-03 §2.1）：本轮清单和**上一轮账本里记的**清单比一次。
 * 两个数来源独立（本轮来自 listLeft，上一轮来自 reconcile_runs），比较才有意义。
 *
 * 为什么必须有：清单一缩水，库里已认领的文件会被判"清单里没有它"整批搬去下架；`needsSupply`
 * 翻面则让定时轮直接删网盘副本。两者今天都是"读到什么信什么"。闸住的那一轮记 preview 行，
 * 每条本该执行的动作照记（带 `gated`），用户在预览里看得见"本来会动、因为清单变了没动"。
 *
 * 只管定时轮。手动执行 = 那一轮的人眼确认，不过闸。
 */
import type { AuthorityStats } from './plan.ts'

export type GateReason = 'authority-shrink' | 'authority-flip' | 'authority-truncated' | 'authority-empty'
export interface GateVerdict { reason: GateReason; detail: string }

/** 缩水：少 ≥10% 或 ≥5 条。两条取"或"——百分比放过小清单、绝对数放过大清单，各堵一头。 */
export const SHRINK_RATIO = 0.1
export const SHRINK_ABS = 5
/** 翻面：`needsSupply` 少 ≥10% 或 ≥3 条。它是删除闸的唯一依据，掉得比清单本身更值得盯。 */
export const FLIP_RATIO = 0.1
export const FLIP_ABS = 3

const dropped = (prev: number, cur: number, ratio: number, abs: number): boolean => {
  const d = prev - cur
  if (d <= 0) return false
  return d >= abs || (prev > 0 && d / prev >= ratio)
}

export function gateAuthority(prev: AuthorityStats | undefined, cur: AuthorityStats, truncated: boolean): GateVerdict | null {
  // 绝对地板，**先于一切相对比较**：空清单下每一份库内文件都会被判"清单里没有它"，一轮就把整个
  // 认领货架搬空。相对比较在这一格恰好看不见它——首轮没有基线，而上一轮也是 0 时"没变化"是真的。
  if (cur.entries === 0) {
    return { reason: 'authority-empty', detail: '清单是空的——空清单下每一份库内文件都会被判"清单里没有它"' }
  }
  if (truncated) return { reason: 'authority-truncated', detail: `清单只取到 ${cur.entries} 条就到上限了，后面还有` }
  if (!prev) return null
  if (dropped(prev.entries, cur.entries, SHRINK_RATIO, SHRINK_ABS)) {
    return { reason: 'authority-shrink', detail: `清单从上一轮 ${prev.entries} 条缩到 ${cur.entries} 条` }
  }
  // 老账本行没有 needsSupply（字段后加的）——没有就不比，别把 undefined 当 0 算出一次假翻面。
  if (typeof prev.needsSupply === 'number' && dropped(prev.needsSupply, cur.needsSupply, FLIP_RATIO, FLIP_ABS)) {
    return { reason: 'authority-flip', detail: `「源站放不出」的集从上一轮 ${prev.needsSupply} 条掉到 ${cur.needsSupply} 条` }
  }
  return null
}
