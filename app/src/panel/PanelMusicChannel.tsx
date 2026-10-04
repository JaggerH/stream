/**
 * 面板里的「音乐/播客」频道：直接用主应用那一份 `<MusicChannel>`（歌单网格 → 曲目表 → 搜索），
 * **不复刻第二份歌单视图**。这一层薄封装只做「把它在面板里活下来所需的东西补齐」。
 *
 * 为什么非有这一层不可——三件事，缺一件就是静默坏掉：
 *
 * 1. **路径不能写地址栏。** MusicChannel 的层级选择（网格 / 某个歌单 / 搜索）走 `useSubRoute`，
 *    默认档是真地址栏 + pushState。但面板住在 DSH 的页面里，那条 URL 归 DSH——往上面写等于
 *    劫持宿主路由（刷新落到宿主 404、后退键跳的是我们的层）。所以这里注入内存档
 *    （`createMemorySubRouteLocation`）：路径只活在内存里，代价是没有深链、后退键管不到层级——
 *    那本来就不是面板能提供的东西。初始 `/music` = L1 网格。
 * 2. **`ChannelManageSheet` 要 `ChannelsProvider`。** MusicChannel 无条件挂着那张管理面板
 *    （`open=false` 时也挂），而它组件体里就调 `useChannels()`——没有 Provider 直接抛错、
 *    整个面板白屏。StreamPanel 自己那份只读名录**刻意**不套 Provider（见它的注释），所以在这里
 *    就地补一份：它自己会拉一次 `/api/channels`，与 StreamPanel 那一次是两份快照，但**写**入口
 *    只有这一份（管理面板），丢更新的那类问题不存在。
 * 3. **高度/滚动。** 面板主区是个 flex 列；MusicChannel 的根是 `h-full min-h-0 flex-col`、
 *    自带 ScrollArea，所以它要的是一个 `min-h-0 flex-1` 的坑位，而不是 StreamPanel 给
 *    PostFeed 的那个 `overflow-y-auto` 滚动容器（两层滚动会打架）。
 *
 * **已知降级**（不是 bug，是面板这个宿主环境的边界，别当成待修）：
 * - 行内菜单 / 悬浮卡 / 弹窗都是 Radix，浮层 portal 到 `document.body`——那是 DSH 的 body，
 *   不在面板这棵挂着 `.dark` 的子树里（见 hostTheme.ts），暗色宿主下这些浮层会用浅色档渲染。
 *   功能可用，配色不跟随。导航那棵树因此一概不用 Radix 件（见 nav/NavDialogs.tsx 头注）。
 * - `NowPlayingBar` 是 `fixed` 定位的全局播放条，它贴的是**整个 DSH 页面**的底边，不是面板的。
 */
import { useMemo, type ReactElement } from 'react'
import { LOCAL } from '../lib/api.ts'
import { ChannelsProvider } from '../lib/channels.tsx'
import { MusicChannel } from '../components/MusicChannel.tsx'
import { SubRouteLocationProvider, createMemorySubRouteLocation } from '../hooks/useSubRoute.ts'
import type { ChannelView } from '../lib/types.ts'

export function PanelMusicChannel({ channel, onChannelsChanged, onReload }: {
  /** 当前选中的那个 audio 频道。MusicChannel 的标题 / 重新抓取 / 管理频道全从 `channels[0]`
   *  推出来，所以只给这一个——给全部 audio 频道会让标题和内容说的不是同一件事。 */
  channel: ChannelView
  /** 管理面板改完频道后重拉名录（接到 StreamPanel 那一份取数上，别传空函数）。 */
  onChannelsChanged: () => void
  /** 标题下拉里的「重新抓取」。 */
  onReload: () => void
}): ReactElement {
  // 每次渲染新建一个 location 会让 useSubRoute 的订阅 effect 每渲染重挂一次，且已选中的层级
  // 会被新对象的初始路径顶回网格——必须一棵树一份，所以 memo 到挂载那一次。
  const location = useMemo(() => createMemorySubRouteLocation('/music'), [])
  return (
    <div data-testid="panel-music" className="flex min-h-0 flex-1 flex-col">
      <SubRouteLocationProvider location={location}>
        <ChannelsProvider conn={LOCAL}>
          <MusicChannel
            conn={LOCAL}
            channels={[channel]}
            onChannelsChanged={onChannelsChanged}
            onReload={onReload}
          />
        </ChannelsProvider>
      </SubRouteLocationProvider>
    </div>
  )
}
