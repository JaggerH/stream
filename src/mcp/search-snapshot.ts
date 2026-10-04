import type { StoredItem } from '../item-store.ts'

/**
 * 现搜结果的瞬时快照——extract 句柄的第三命名空间。
 * 权威设计:docs/superpowers/specs/2026-08-23-purchase-evidence-deepread-design.md §2.1。
 *
 * content_search 的结果**不落库**,而深读(转写/OCR)的唯一入口 extract 只认句柄。这里把
 * "模型刚看到的那批搜索结果"按 item.id 留一份完整原件(slim 之前的),TTL 内可被 extractImpl
 * 指到。不落库、不持久:重启后模型重新搜一遍是可接受代价。
 *
 * 喂入点在 MCP 边界(mcp-extras 包 contentSearch 的那一层)——**单一咽喉**,不用各处记得喂。
 * price_search 不喂(比价条目没有可深读的正文)。
 */
export const SEARCH_SNAPSHOT_TTL_MS = 30 * 60_000
export const SEARCH_SNAPSHOT_CAP = 500

export interface SearchSnapshot {
  put(items: StoredItem[]): void
  /** 命中返回完整 StoredItem;过期/没见过返回 undefined(过期顺手清掉)。 */
  get(id: string): StoredItem | undefined
  size(): number
}

export function makeSearchSnapshot(now: () => number = Date.now): SearchSnapshot {
  // Map 的插入序就是逐出序:重复 put 先 delete 再 set,把"最近又见到"的条目挪到队尾。
  const map = new Map<string, { item: StoredItem; at: number }>()
  return {
    put(items) {
      const at = now()
      for (const item of items) {
        if (!item || typeof item.id !== 'string' || item.id === '') continue
        map.delete(item.id)
        map.set(item.id, { item, at })
      }
      while (map.size > SEARCH_SNAPSHOT_CAP) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
    },
    get(id) {
      const hit = map.get(id)
      if (!hit) return undefined
      if (now() - hit.at > SEARCH_SNAPSHOT_TTL_MS) {
        map.delete(id)
        return undefined
      }
      return hit.item
    },
    size: () => map.size,
  }
}
