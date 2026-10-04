/**
 * 面板里的影视频道：把主应用那一份 `<MovieChannel>` 原样搬进工作台，不复刻第二份海报墙。
 *
 * 和 `PanelDetail` 一样，这一层**只补"搬进来"必须补的东西**，一行都不改 `MovieChannel`——
 * 那是主应用正在用的那一份。要补的是三件：
 *
 * ## 1. 二级路由的路径必须存在内存里，不能写地址栏
 *
 * `MovieChannel` 的「海报墙 → 某部作品」是一条真路由（`useSubRoute`），主应用里它写浏览器
 * 地址栏。但面板住在 DSH 的页面里，**那条 URL 归 DSH**：写上去等于劫持宿主路由（刷新落到
 * 宿主 404、后退键跳的是我们的层而不是宿主的）。所以这里必须注入
 * `createMemorySubRouteLocation()`——路径只活在内存里，代价是没有深链、后退键管不到层级，
 * 而那两样本来就不是面板能提供的东西（见 `hooks/useSubRoute.ts` 头注）。
 *
 * 初始路径给 `/video` 而不是 `/`：`MovieChannel` 的 base 由 `videoBaseFrom(pathname)` 从存放处
 * **推导**出来（它要拼 `<base>/item/<id>`）。`/video` 推出 base `/video`，正是主应用聚合入口
 * 那一档，`videoRouteFrom('/video')` 又恰好是 `{kind:'home'}`——首帧落在海报墙上。给 `/` 也能
 * 转（`videoToPathFrom` 专门塌陷了 `'/'`），但那时 base 就是「宿主此刻碰巧在哪」的形状，读代码
 * 的人得多绕一圈才知道它其实无所谓；写死一个我们自己的常量，路径长什么样是可预测的。
 *
 * ## 2. `ChannelsProvider`：管理频道那个齿轮真按得动
 *
 * `MovieChannel` 头上的 ⚙ 打开 `ChannelManageSheet`，它 `useChannels()` ——**没有 Provider
 * 就直接抛**，不是降级成灰按钮。`StreamPanel` 自己那份频道名录是只读的、没套这层
 * （见它的头注），所以这层由这里补。代价是多一次 `/api/channels`（Provider 自己拉一份）；
 * 换来的是齿轮点下去真能改频道，而不是把面板整棵树炸掉。
 *
 * ## 3. 把 `fixed` 关进面板这一列
 *
 * 播放器走 `DetailShell`，它的根是 `fixed inset-0`——在主应用里那就是"铺满整屏"，在工作台里
 * 会盖住 DSH 整页。祖先只要有非 none 的 `transform` 就成为 `fixed` 后代的包含块，所以外面这层
 * `translateZ(0)` 把它关在面板里（同 `PanelDetail` §2 的做法）。**别去改 `DetailShell`**——
 * 那会动到主应用。浏览器全屏不受影响：Fullscreen API 走 top layer，不是 `fixed` 定位。
 */
import { useMemo, type ReactElement } from 'react'
import { MovieChannel } from '../components/MovieChannel.tsx'
import { SubRouteLocationProvider, createMemorySubRouteLocation } from '../hooks/useSubRoute.ts'
import { ChannelsProvider } from '../lib/channels.tsx'
import { LOCAL } from '../lib/api.ts'
import type { ChannelView } from '../lib/types.ts'

/** 内存档路由的初始路径——见文件头注 §1。 */
export const PANEL_VIDEO_BASE = '/video'

export function PanelMovieChannel({ channels, onChannelsChanged, onReload }: {
  /** 这次要渲染的影视频道（`StreamPanel` 已经选好了是哪一个，这里不再筛）。 */
  channels: ChannelView[]
  /** 管理频道改完了：让面板重拉自己那份名录。 */
  onChannelsChanged: () => void
  /** 标题菜单的「重新抓取」。 */
  onReload: () => void
}): ReactElement {
  // 每次挂载一个自己的存放处。切频道时 `StreamPanel` 用 `key` 重建这棵树（换了个频道还留在
  // 上一个频道某部剧的详情上，是把两个频道缝在一起）——所以这里不需要跟着 channels 变。
  const location = useMemo(() => createMemorySubRouteLocation(PANEL_VIDEO_BASE), [])
  return (
    <div data-testid="panel-movie" className="relative min-h-0 flex-1 [transform:translateZ(0)]">
      <SubRouteLocationProvider location={location}>
        <ChannelsProvider conn={LOCAL}>
          <MovieChannel
            conn={LOCAL}
            channels={channels}
            onChannelsChanged={onChannelsChanged}
            onReload={onReload}
          />
        </ChannelsProvider>
      </SubRouteLocationProvider>
    </div>
  )
}
