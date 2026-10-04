import type { Evidence } from './fold.ts'
import type { StoryFoldStore } from './store.ts'

/**
 * 投影层要的那一格：**这条属于哪个堆、是不是门面、这堆一共几条、凭什么并的**。
 *
 * `why` 一路带到前端不是装饰——用户看到两条被并在一起，第一反应就是「凭什么」，
 * 答不上来他就不敢信任折叠，也就不会用它。
 */
export interface StoryGroup {
  id: string
  isRep: boolean
  size: number
  why: Evidence[]
}

/**
 * 给一页 item 挂上归堆信息。**批量预取，不逐条 join**——列表一页两百条，
 * 逐条查是两百次往返，而这是首屏路径。
 *
 * **成员条照发不隐藏**：收不收起来是前端的事。后端在这里少发一条，就等于替用户
 * 决定了他看不到什么，而且分页数会跟着对不上（一页 200 条折成 180 条，翻页就开始跳）。
 */
export function attachStoryGroups<T extends { id: string }>(
  items: T[],
  store: StoryFoldStore | undefined,
): Array<T & { storyGroup?: StoryGroup }> {
  if (!store || items.length === 0) return items
  const memberships = store.membershipsFor(items.map((i) => i.id))
  if (memberships.size === 0) return items
  const sizes = store.sizes([...memberships.values()].map((m) => m.groupId))
  return items.map((it) => {
    const m = memberships.get(it.id)
    if (!m) return it
    return { ...it, storyGroup: { id: m.groupId, isRep: m.isRep, size: sizes.get(m.groupId) ?? 1, why: m.why } }
  })
}
