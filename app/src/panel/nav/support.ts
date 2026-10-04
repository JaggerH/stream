/**
 * 「这个频道面板伺候得了吗」「频道按什么次序列」——导航与内容区共用的两条判据。
 *
 * 具名导出、住在一个文件里，而不是内联在某棵树的 JSX 里：判据有名字才搜得到、才钉得住
 * （见 AGENTS.md「加了一份名单 / 一条判据」）。往 `present` 注册表加新档时，这里必须回答
 * 新的那档算不算——答不出来就是不算，它会自动落进"灰着的那一堆"，而不是静默变成一个坏视图。
 */
import { DEFAULT_TIMELINE_CHANNEL_ID, type ChannelView } from '../../lib/types.ts'

/**
 * 这个频道的内容，面板伺候得了吗。
 *
 * - `timeline`：图文流，就是 PostFeed 本来干的活。
 * - `audio`：主应用那份 `MusicChannel` 整个搬进来（歌单网格 / 曲目表 / 播放条），
 *   见 `PanelMusicChannel.tsx`。面板挂着 AudioStage，播放就地出声。同样要宽度，
 *   浮层态由 `StreamPanel` 的 `shellMode` 另行处理。
 * - `video`：主应用那份 `MovieChannel` 整个搬进来（海报墙 / 作品详情 / 分集 / 播放器），
 *   见 `PanelMovieChannel.tsx`。**海报墙要宽度**：420px 的浮层态里排不下，那一档由
 *   `shellMode` 另行处理——这里只回答"面板这套视图有没有它"，不管窗口多宽。
 * - `research`：主应用那份 `ResearchChannel` 整个搬进来（run 列表 / run 详情 / artifact 卡），
 *   见 `PanelResearchChannel.tsx`。**不挑宽度**：列表是一列文字行，420px 里读得了。
 * - `tasks`：`TasksPage` 整个搬进来（任务表 / 展开看历次执行）。同 `research`：live 取数、
 *   不挑宽度。
 * - `embed`：整个主窗格一张 iframe 装 `options.url` 指的外部网页。不挑宽度——那张网页
 *   自己会响应式，我们只给它整个窗格。
 * - `search`：资源搜索在主应用里走的是完全不同的一套视图（跨网盘搜、解析、转存），
 *   面板没有。**灰着列出来，不是悄悄不列**：用户在主应用里明明有这个频道，面板里找不到
 *   只能猜是不是坏了。
 *
 * 灰掉的底线只有一条：**受理的那一档点开必须真能用**。把一个视图硬塞进 PostFeed 能画出个
 * 样子，但点开只有一页元数据、放不了——那种"看着有、其实是空壳"比灰着更糟。
 */
export function panelSupportsChannel(channel: ChannelView): boolean {
  return channel.present === 'timeline' || channel.present === 'audio'
    || channel.present === 'video' || channel.present === 'research' || channel.present === 'tasks'
    || channel.present === 'embed'
}

/** 时间线永远排头（它是面板的默认落点），其余系统频道次之，自建频道垫后。 */
export function orderChannels(channels: ChannelView[]): ChannelView[] {
  const rank = (c: ChannelView) => (c.id === DEFAULT_TIMELINE_CHANNEL_ID ? 0 : c.system ? 1 : 2)
  return [...channels].sort((a, b) => rank(a) - rank(b))
}
