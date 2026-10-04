/**
 * 面板里的研究频道：把主应用那一份 `<ResearchChannel>` 原样搬进工作台，不复刻第二份 run 列表。
 *
 * 同 `PanelMovieChannel` / `PanelMusicChannel`，这一层**只补"搬进来"必须补的东西**，一行都不改
 * `ResearchChannel`——那是主应用正在用的那一份。这里要补的只有两件，另外两件**刻意不补**：
 *
 * ## 1. 二级路由的路径必须存在内存里，不能写地址栏（必须补）
 *
 * `ResearchChannel` 的「run 列表 → 某个 run」是一条真路由（`useSubRoute`），主应用里它写浏览器
 * 地址栏。面板住在 DSH 的页面里，**那条 URL 归 DSH**：写上去等于劫持宿主路由（刷新落到宿主
 * 404、后退键跳的是我们的层）。所以注入 `createMemorySubRouteLocation()`——路径只活在内存里，
 * 代价是没有深链、后退键管不到层级，而那两样本来就不是面板能提供的东西。
 *
 * 初始路径给 `/c/<频道 id>` 而不是 `/`：base 由 `researchBaseFrom(pathname)` 从存放处**推导**
 * 出来（它要拼 `<base>/run/<streamId>/<runId>`），而那个函数只认 `/c/<id>` 这个形状——给别的
 * 形状它原样返回，base 就成了"我们随手写了什么"。写死成组件自己认得的那一个，路径长什么样
 * 是可预测的（同 `PanelMovieChannel` §1 的理由）。
 *
 * ## 2. 高度（必须补）
 *
 * 面板主区是个 flex 列，而 `ResearchChannel` 的根是 `h-full min-h-0 flex-col`（顶栏固定、
 * 列表在自己那格里滚），所以它要的是一个 `min-h-0 flex-1` 的**坑位**，不是一个滚动容器——
 * 外面再套一层 `overflow-auto` 就是两层滚动打架（同 `PanelMusicChannel` §3）。
 *
 * ## 3. `ChannelsProvider`（必须补）
 *
 * `ResearchChannel` 的顶栏挂着管理入口（齿轮 → `ChannelManageSheet`），那张面板组件体里就调
 * `useChannels()`，没 Provider 直接抛。`StreamPanel` 自己那份只读名录**刻意**不套 Provider
 * （见它的注释），所以在这里就地补一份——与 `PanelMusicChannel` §2 同一个理由、同一个写法。
 *
 * ## 4. 不用 `translateZ(0)` 关 `fixed`（刻意不补）
 *
 * 那一手是给影视/详情用的：它们的根是 `fixed inset-0`（`DetailShell`），在工作台里会盖住 DSH
 * 整页，所以要靠祖先的 `transform` 造一个包含块把它关回面板这一列。研究这棵树里**一个
 * `fixed` 都没有**（列表是 flex 列，详情是 `height:100%` 的滚动块），造包含块无事可做，
 * 徒增一个会拦住将来任何合法 `fixed` 的隐形规则。
 */
import { useMemo, type ReactElement } from 'react'
import { ResearchChannel } from '../components/ResearchChannel.tsx'
import { SubRouteLocationProvider, createMemorySubRouteLocation } from '../hooks/useSubRoute.ts'
import { LOCAL } from '../lib/api.ts'
import { ChannelsProvider } from '../lib/channels.tsx'
import type { ChannelView } from '../lib/types.ts'

/** 内存档路由的初始路径——见文件头注 §1。 */
export function panelResearchBase(channelId: string): string {
  return `/c/${encodeURIComponent(channelId)}`
}

export function PanelResearchChannel({ channel, onChannelsChanged }: {
  /** 当前选中的那个 research 频道（`StreamPanel` 已经选好了是哪一个，这里不再筛）。 */
  channel: ChannelView
  /** 管理面板改完频道后重拉名录（接到 `StreamPanel` 那一份取数上，别传空函数）。 */
  onChannelsChanged: () => void
}): ReactElement {
  // 一棵树一份：每次渲染新建会让 useSubRoute 的订阅 effect 每渲染重挂一次，已经点开的 run
  // 还会被新对象的初始路径顶回列表。切频道由 `StreamPanel` 用 `key` 整棵重建（换了频道还停在
  // 上一个频道某个 run 的详情上，是把两个频道缝在一起）。
  const location = useMemo(() => createMemorySubRouteLocation(panelResearchBase(channel.id)), [channel.id])
  return (
    <div data-testid="panel-research" className="flex min-h-0 flex-1 flex-col">
      <SubRouteLocationProvider location={location}>
        <ChannelsProvider conn={LOCAL}>
          <ResearchChannel channel={channel} conn={LOCAL} onChannelsChanged={onChannelsChanged} />
        </ChannelsProvider>
      </SubRouteLocationProvider>
    </div>
  )
}
