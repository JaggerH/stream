// 贴文布局偏好：list（时间线的一列窄行）| waterfall（多列瀑布流）。
//
// 它和后端的 Channel.present 是**两根正交的轴**：present 决定这个频道是什么(怎么采集、
// 能挂哪些能力槽位)，layout 只决定贴文怎么排。所以它不进 ChannelRecord.options——那是
// 频道配置，而这是视图偏好；而且搜索频道压根不是真 ChannelRecord(前端假 id
// __content_search__)，走后端会退化成两套机制。
//
// 形状照抄 lib/theme.ts。以后要跨设备同步是**加法不是改法**：localStorage 降级为
// "服务端没给值时的兜底"，PostFeed 那一层完全不用动。
export const POST_LAYOUTS = ['list', 'waterfall'] as const
export type PostLayout = (typeof POST_LAYOUTS)[number]

export const LAYOUT_STORAGE_PREFIX = 'stream.layout.'

/** 搜索天生要密（一屏扫结果），时间线天生要读（一列窄行）。 */
export function defaultLayoutFor(present: string | undefined): PostLayout {
  return present === 'search' ? 'waterfall' : 'list'
}

export function readLayout(channelId: string, present: string | undefined): PostLayout {
  try {
    const stored = window.localStorage.getItem(LAYOUT_STORAGE_PREFIX + channelId)
    if (POST_LAYOUTS.includes(stored as PostLayout)) return stored as PostLayout
  } catch {
    /* 隐私模式 / storage 被禁 —— 回落到默认值即可，这不是用户在等的操作 */
  }
  return defaultLayoutFor(present)
}

export function writeLayout(channelId: string, layout: PostLayout): void {
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_PREFIX + channelId, layout)
  } catch {
    /* 同上 */
  }
}
