import type { CanonicalBrowserRecipe } from './recipe.ts'

const DEFAULT_LANE = 'default'

/**
 * 每条 lane 一本有序账本：**这条 lane 的标签上现在铺着哪些条目、按什么顺序**。
 *
 * 它是 locate 的坐标系（`packages/*` 的 locate step 通过 `orderedParam` 收下这一份）。账本和页面
 * 对不齐，表现出来是三种毫不相干的症状——定位失败、去重不灵、列表顺序乱——很容易被当成三个 bug
 * 分头修（见 `.claude/skills/write-recipe/references/pipeline.md` §2）。所以这里只守两条：
 *
 * 1. **整本替换。** 一次 feed 运行 = 那个标签被换成了这一批（xhs 每搜一个新词就整页导航一次），
 *    旧账本描述的是一个已经不存在的页面，追加只会让坐标系错位。
 * 2. **lane 没了，账本跟着没。** 账本描述的是那个标签；标签被显式收尾或闲置回收关掉之后，它就是
 *    废纸——留着只会让下一次 locate 拿着一批不存在的 id 去找，白烧一轮再落 fallback-nav。
 *
 * 进程内内存即可：它跟着标签活，而标签活不过一次重启。
 */
export class FeedLedger {
  private readonly byLane = new Map<string, string[]>()

  private key(facility: string, laneKey: string): string {
    return `${facility}\0${laneKey}`
  }

  /** 整本替换这条 lane 的账本（空数组 = 这次什么都没铺开，等同清空）。 */
  record(facility: string, ids: string[], laneKey: string = DEFAULT_LANE): void {
    this.byLane.set(this.key(facility, laneKey), [...ids])
  }

  /** 这条 lane 当前的有序 id；没有账本 = 空数组（locate 会据此直接判 MISS 并走 fallback）。 */
  ordered(facility: string, laneKey: string = DEFAULT_LANE): string[] {
    return this.byLane.get(this.key(facility, laneKey)) ?? []
  }

  clearLane(facility: string, laneKey: string = DEFAULT_LANE): void {
    this.byLane.delete(this.key(facility, laneKey))
  }

  /** 这个 facility 名下所有 lane 的账本一起丢（对应 closeFacility）。 */
  clearFacility(facility: string): void {
    const prefix = `${facility}\0`
    for (const k of [...this.byLane.keys()]) if (k.startsWith(prefix)) this.byLane.delete(k)
  }
}

/**
 * 从一次运行的产出里抠出账本 id —— recipe 没声明 `ledger` 就返回 null（**不记账**，别把
 * "这次没产出" 和 "这份 recipe 本来就不建账本" 混成同一件事：前者该清空账本，后者不该碰它）。
 *
 * 顺序就是产出顺序：`interpret` 的累加器按 feed 顺序 append 且只去重不重排，所以产出顺序 = 页面
 * 上的铺排顺序，这正是 locate 要的坐标系。缺 id 字段的条目跳过而不是塞个空串——空串会跟着排进
 * 索引，把后面每一条的位置都推错一格。
 */
export function ledgerIdsFrom(
  recipe: Pick<CanonicalBrowserRecipe, 'ledger'>,
  items: ReadonlyArray<Record<string, unknown>>,
): string[] | null {
  const idField = recipe.ledger?.idField
  if (!idField) return null
  const ids: string[] = []
  for (const item of items) {
    const raw = item?.[idField]
    if (raw == null || raw === '') continue
    ids.push(String(raw))
  }
  return ids
}
