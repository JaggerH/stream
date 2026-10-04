/** 频道 `options.slots` 的合法性唯一定义:只认「非空、全字符串数组」的槽值,其余
 *  (缺失/空数组/混型/非对象)一律视为未配置。路由(bindings.slotProviderIds)与删除保护的
 *  引用反查(user-store.channelSlotsReferencing)共用这一份——守卫只保护路由真会用到的引用,
 *  别各写一份微妙不同的判断彼此漂移。
 *  有意**不**用它的三处:export-closure 的候选收集(要宽,混型数组里的字符串也收)、
 *  导出净化(要保留空键),与系统行退役的槽位清理(user-store.clearProviderFromSlots——
 *  要清的恰恰包括被这里判成"未配置"的形状)。 */
export function readSlots(options: Record<string, unknown> | undefined): Record<string, string[]> {
  const raw = (options as { slots?: unknown } | undefined)?.slots
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string[]> = {}
  for (const [callsiteId, ids] of Object.entries(raw)) {
    if (Array.isArray(ids) && ids.length > 0 && ids.every((v) => typeof v === 'string')) out[callsiteId] = ids as string[]
  }
  return out
}
