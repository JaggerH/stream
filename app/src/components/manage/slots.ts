import type { ChannelView } from '../../lib/types.ts'

/** Radix Select.Item 不接受空字符串 value——UI 用这个哨兵代表「跟随全局」。 */
export const SLOT_DEFAULT = '__default__'

/** 频道 options.slots 的一次改动：选 provider = 单元素数组覆盖；选默认 = 删键
 *  （没有键 = 该 callsite 没有频道级覆盖）。语义同 docs spec present-channel-slots v1：
 *  槽位覆盖只支持「这个频道换一家」的单选，多 provider 编排是全局 binding 页的事。 */
export function nextSlotsFor(channel: ChannelView, callsiteId: string, uiValue: string): Record<string, string[]> {
  const value = uiValue === SLOT_DEFAULT ? '' : uiValue
  const next: Record<string, string[]> = { ...((channel.options?.slots as Record<string, string[]> | undefined) ?? {}) }
  if (value) next[callsiteId] = [value]
  else delete next[callsiteId]
  return next
}
