import type { MappingSet, ReconcileShowConfig } from './types.ts'

/**
 * 「这条整理配置是谁家的」——**唯一判据**：整理配置本身不记订阅，它只记一个绑定 id；
 * 那条绑定的左侧才写着 streamId。所以归属得绕一道：show → bindingId → binding.left.streamId。
 *
 * 两处要下同一个判断（整理弹窗自己筛、网盘面板那一块摘要），各写一份就是两条判据：一处认得出、
 * 另一处认不出，表现是"整理里明明配着，网盘面板说还没配"，而两边单看都正常。
 */
export function showsForStream(
  shows: ReconcileShowConfig[],
  bindings: MappingSet[],
  streamId: string,
): ReconcileShowConfig[] {
  const ids = new Set(bindings.filter((b) => b.left.streamId === streamId).map((b) => b.id))
  return shows.filter((s) => ids.has(s.bindingId))
}
