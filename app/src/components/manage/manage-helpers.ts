import type { ChannelStream, ChannelView, Stream } from '../../lib/types.ts'
import { DEFAULT_TIMELINE_CHANNEL_ID } from '../../lib/types.ts'

/** 删掉 channel 后将不再被任何频道引用的流（Stream 是全局身份，删频道只解引用——
 *  这份名单用于删除确认里的提示，不用于任何自动删除）。 */
export function orphanedStreams(channel: ChannelView, all: ChannelView[]): ChannelStream[] {
  return channel.streams.filter(
    (s) => !all.some((c) => c.id !== channel.id && c.streams.some((x) => x.id === s.id)),
  )
}

/** 「挂已有的」候选：库里不在本频道的流，各自标注当前引用它的频道 label（给用户判断
 *  这是共享引用还是闲置流）。 */
export function attachCandidates(
  channel: ChannelView,
  allStreams: Stream[],
  allChannels: ChannelView[],
): Array<{ stream: Stream; referencedBy: string[] }> {
  const mine = new Set(channel.streams.map((s) => s.id))
  return allStreams
    .filter((s) => !mine.has(s.id))
    .map((stream) => ({
      stream,
      referencedBy: allChannels.filter((c) => c.id !== channel.id && c.streams.some((x) => x.id === stream.id)).map((c) => c.label),
    }))
}

/** 时间线头部「管理」按钮的目标频道：未选中 = 系统时间线；选中了真实频道 = 它；
 *  虚拟频道（发现/广告/全局搜索）和裸 stream 没有频道记录可管 → null（不显示按钮）。 */
export function manageableChannelId(
  selected: string | null,
  selectedChannel: { id: string } | null,
  virtualIds: string[],
): string | null {
  if (selected === null) return DEFAULT_TIMELINE_CHANNEL_ID
  if (virtualIds.includes(selected)) return null
  return selectedChannel?.id ?? null
}
