import type { Item } from './types.ts'

/**
 * 同质内容归堆在列表这一层的形态：**同一堆只占一行，其余收起来**。
 *
 * 后端把整堆都发下来了（成员条一条不少），收不收是这一层的事。两条不许破的规矩：
 *
 * 1. **代表不在这一页时，成员必须照常显示。** 堆的代表可能是上个月的、在分页之外——
 *    这时候把成员藏起来，用户看到的就是"这条内容凭空消失了"，而且他没有任何入口找回来。
 * 2. **收起来的数目要说出口。** 一行只写标题、不说"另有 3 条"，等于无声删除。
 */

export interface FoldedFeed {
  /** 真正要渲染的条目（按原顺序）。 */
  rendered: Item[]
  /** 代表 id → 这一页里被它收起来的条数。0 或缺席 = 没有可展开的东西。 */
  hidden: Map<string, number>
  /** 堆 id → 这堆的成员（含被收起的），供「首发早多久」这类读数用。 */
  membersOf: Map<string, Item[]>
}

export function foldFeed(items: Item[], expanded: ReadonlySet<string>): FoldedFeed {
  // 这一页里各堆的代表是谁。代表不在本页的堆，整堆都按普通条目摊开——见上面规矩 1。
  const repOnPage = new Set(
    items.filter((it) => it.storyGroup?.isRep).map((it) => it.storyGroup!.id),
  )
  const hidden = new Map<string, number>()
  const membersOf = new Map<string, Item[]>()
  const rendered = items.filter((it) => {
    const g = it.storyGroup
    if (!g) return true
    // 成员表要在过滤之前攒齐——「首发早多久」算的是整堆，不是"没被收起来的那些"。
    if (!g.isRep) membersOf.set(g.id, [...(membersOf.get(g.id) ?? []), it])
    if (g.isRep) return true
    if (!repOnPage.has(g.id)) return true // 代表不在这一页：照常显示，绝不凭空消失
    if (expanded.has(g.id)) return true
    hidden.set(g.id, (hidden.get(g.id) ?? 0) + 1)
    return false
  })
  return { rendered, hidden, membersOf }
}

/** 「另有 N 条同源」——收起来的数目必须说出口，否则就是无声删除。 */
export function foldedLabel(n: number, isExpanded: boolean): string {
  return isExpanded ? '收起同源的' : `另有 ${n} 条同源`
}

/**
 * 「首发」那一枚：**门面这条就是这堆里最早发出来的**，所以标在它身上。
 *
 * 只有真的领先才标——同一时刻发的不标（判谁快是编造精度），领先不到一分钟的也不标
 * （那个数字对人没有意义，只会让这行变吵）。
 */
export function leadLabel(rep: Item, members: Item[]): string | null {
  const repAt = Date.parse(rep.timestamp || rep.fetched_at)
  const others = members
    .map((m) => Date.parse(m.timestamp || m.fetched_at))
    .filter((t) => Number.isFinite(t) && t > repAt)
  if (!Number.isFinite(repAt) || others.length === 0) return null
  const gapS = Math.round((Math.min(...others) - repAt) / 1000)
  if (gapS < 60) return null
  if (gapS < 3600) return `首发，早 ${Math.round(gapS / 60)} 分钟`
  if (gapS < 86400) return `首发，早 ${Math.round(gapS / 3600)} 小时`
  return `首发，早 ${Math.round(gapS / 86400)} 天`
}

/** 展开/收起一堆。 */
export function toggleExpanded(expanded: ReadonlySet<string>, groupId: string): Set<string> {
  const next = new Set(expanded)
  if (!next.delete(groupId)) next.add(groupId)
  return next
}
