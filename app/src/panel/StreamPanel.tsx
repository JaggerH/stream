/**
 * 工作台面板的内容：Stream 真实的图文内容流（瀑布流档）+ 点开一条的详情。
 *
 * **按当前频道的 `present` 判路**：图文流走这里的 `PostFeed`；`video` 档整个交给主应用那份
 * `MovieChannel`（经 `PanelMovieChannel` 补齐面板独有的几件事，见那个文件的头注），不复刻
 * 第二份海报墙。影视只在**壳态**下画（`shellMode`，见下面那个常量）——420px 的浮层态排不下。
 * `research` 档同样整个交给主应用那份 `ResearchChannel`（经 `PanelResearchChannel`），
 * 它**不挑宽度**，两态都画——理由见下面 `researchMode` 那一格。
 *
 * 详情用的是 Stream 自己那一份 `<Detail>`（经 `PanelDetail` 补齐面板独有的两件事，
 * 见那个文件的头注）——不复刻第二份详情页。
 *
 * **影视和详情都不在这个 bundle 里**：两者各是一个独立的 IIFE bundle + 独立的 React root，
 * 第一次用到才装（`movieBundle` / `detailBundle`）。壳反转之后这份主 bundle 是**开页必载**
 * 的那一份，而影视一家就带进来播放器 + 海报墙 + 资源查找 + 网盘解析（实测把 `panel.js` 从
 * 1,170KB 顶到 2,821KB），绝大多数人开工作台只看时间线、一次都用不到它。为什么不能用
 * `React.lazy` 来做这件事，见 `panelBundleLoader.ts` 头注。这棵树里因此有两个只放占位 div
 * 的分支（`detailContainerRef` / `movieContainerRef`），它们的内容由各自的 root 摆。
 *
 * **播放**：这一页只该有一个 `<audio>`，它就挂在这棵树上（`AudioStageProvider`）。
 * 详情是另一个 React root，两个 Provider 各挂各的 `<audio>` 会同时出声，所以选择只挂一份，
 * 详情那侧降级（见 `PanelDetail` 头注 §1，含真实代价——播客详情因此是个死页面）。这是
 * **选择**，不是"两个 root 没法共用一份舞台"：两个 root 其实同住一个浏览器页面，页面级
 * 共享状态技术上可行，只是没做。详情盖上来时列表并不卸载，正在播的那条照常播下去。
 * 视频不同：它是可见元素，跟着详情走，由详情自己那份 `VideoStageProvider` 管。
 *
 * 续页跟随 `useInbox.ts` 的 `loadMoreChannel` 那一套已确立的模式：走频道时间线端点
 * （keyset 分页，`next_cursor` 缺失=到底）、`loadingMore` 单飞、失败静默保留已有一批。
 * 滚到底的判据抄 `App.tsx` 的 `onListScroll`——面板自己拥有滚动容器（DSH 页面没有
 * 我们能借用的滚动容器），所以判据直接挂在这个滚动 div 的 `onScroll` 上。
 *
 * **详情是盖在列表上的，不是替换列表**：列表整棵树一直挂着，所以关掉详情回来时
 * 已经翻出来的那几页和滚动位置原地都在，不会重新取数。
 *
 * **切频道是整批重来，不留每频道的分页/滚动**：只保留"当前这一个频道"的一批 items 和一个
 * 游标。代价说清楚——切回去要重取第一页、并回到顶部。换成 `useInbox` 那种按频道分桶能免掉
 * 这一次重取，但要多养一份 `Record<频道, items>` + 一份 `Record<频道, scrollTop>`，而面板
 * 是个 420px 的旁路视图、内容还随时被后台采集刷新，"看到的是十分钟前那一份"比多取一页更坏。
 * 真要换，分桶的写法照抄 `useInbox`，别另发明一套。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { api, LOCAL } from '../lib/api.ts'
import { ChannelTitleMenu } from '../components/ChannelTitleMenu.tsx'
import { ExtensionOnboardingCard, extensionActions } from '../components/extension/ExtensionOnboardingCard.tsx'
import { ExtensionRequiredNotice } from '../components/extension/ExtensionRequiredNotice.tsx'
import { useExtensionCapability } from '../hooks/useExtensionCapability.ts'
import { promptRecord, recordPrompted, shouldPrompt } from '../lib/extensionPrompt.ts'
import { ChannelConfigPanel } from '../components/manage/ChannelConfigPanel.tsx'
import { ChannelTabs, type ChannelTab } from '../components/manage/ChannelTabs.tsx'
import { StreamSettingPage } from '../components/StreamSettingPage.tsx'
import { ChannelsProvider } from '../lib/channels.tsx'
import { subscribeInventory } from '../lib/inventoryBus.ts'
import { DEFAULT_TIMELINE_CHANNEL_ID, type ChannelStream, type ChannelView, type Item as StreamItem } from '../lib/types.ts'
import { channelStore } from './nav/channel-store.ts'
import { RECENT_LIMIT, toItemRef, type PanelItemContextState } from './itemRef.ts'
import { PanelMusicChannel } from './PanelMusicChannel.tsx'
import { researchBundle, type ResearchBundle } from './researchBundle.ts'
import { TasksPage } from '../components/tasks/TasksPage.tsx'
import { PostFeed } from '../components/feed/PostFeed.tsx'
import { Toaster, toast } from '../components/acrylic/sonner.tsx'
import { AudioStageProvider } from '../lib/audioStageProvider.tsx'
import type { ExtractCapabilities } from '../lib/extract.ts'
import { ExtractCapsProvider, useExtractCaps } from '../lib/extractCaps.tsx'
import type { AudioStage } from '../lib/audioStage.ts'
import { toTracks } from '../lib/audioTrack.ts'
import { autoPlaysDetailMedia } from '../lib/openDetail.ts'
import { detailBundle } from './detailBundle.ts'
import { askChatSink } from '../lib/askExtract.ts'
import { movieBundle, type MovieBundle } from './movieBundle.ts'
import { publishThemeToFrame } from './embedTheme.ts'

const PAGE_LIMIT = 60

/** 列表态的宽度——与 `dsh-plugin-stream-ui` 的 host.ts 建容器时那个 420px 是同一个数。 */
const LIST_WIDTH = '420px'
/** 详情态的宽度：详情是"媒体/正文 + 480px 右栏"两栏，420px 里塞不下。
 *  `min(…, 100vw)` 兜住窄屏，别把面板撑到比窗口还宽。 */
const DETAIL_WIDTH = 'min(1100px, 100vw)'

export function StreamPanel({ onWidthChange, onItemContext }: {
  /** 面板该多宽了——由 bundle 的 mount 接到宿主容器的 `style.width` 上（见 entry.tsx）。
   *
   *  为什么由 bundle 报宽度、而不是让外壳（host.ts）暴露一个"开详情/关详情"的接口：
   *  跨包契约小一档。外壳建完容器就不再管里面发生什么，"什么时候该宽"完全是面板内部的
   *  状态；让外壳知道详情这个概念，等于把一个纯内部状态抬成跨包 API。
   *  这也天然扛住"关掉再开"——外壳每次 open 都重建一个 420px 的容器、重新 mount，
   *  这一格状态跟着新树从头来过，没有任何需要清理的残留。 */
  onWidthChange?: (width: string) => void
  /** 「用户此刻手边有哪些内容」——对话输入框的 `@` 引用候选就是它（见 itemRef.ts 头注）。
   *  正在看的那条 + 当前频道这一批，任一变化就整份重推。 */
  onItemContext?: (s: PanelItemContextState) => void
} = {}): ReactElement {
  const [items, setItems] = useState<StreamItem[]>([])
  const [error, setError] = useState<string>()
  const [loadingMore, setLoadingMore] = useState(false)
  // 频道/空间/当前频道住在**模块级 store**里，不是这棵树的 state：导航树是另一个 React root
  // （`mountNav`），跨 root 没有 context 也没有 props——两边各存一份就会互相说谎。见 nav/channel-store.ts。
  const nav = useSyncExternalStore(channelStore.subscribe, channelStore.getSnapshot)
  const channels = nav.channels
  const channelId = nav.active
  /** 切频道。名录里没有 / 面板伺候不了的 id 静默不动（判据在 store 里，见那个模块）。 */
  const setChannelId = useCallback((id: string) => { channelStore.setActive(id) }, [])
  // 一次「这一批取数属于谁」的序号。每次换频道 +1；任何异步结果落地前先核一遍自己那个序号
  // 还是不是当前的——不是就整个丢掉（items 不写、游标不写、错误不报、单飞标志不清）。
  // 光靠"落地时比一下 channelId"不够：同一个频道来回切两次，旧请求的 id 又对上了，它带回的
  // 却是上一轮的游标，接着分页就从别处继续——**内容静默错位，没有任何一处会报错**。
  const loadSeqRef = useRef(0)
  const [detail, setDetail] = useState<{ item: StreamItem; mediaIndex: number; autoPlay: boolean } | null>(null)
  // 图文流那一档的「内容 / 配置」分页。音乐/影视/研究各自的树里有自己那一份（分页归频道，
  // 见 `ChannelTabs` 头注），这一格只管这棵树顶栏下面那条。
  //
  // **切频道要回内容页**：配置页是「改这一个频道」的地方，换了频道还停在配置页上，等于替用户
  // 决定了他下一步想改配置——而他刚做的动作是「我想看那个频道的内容」。
  const [tab, setTab] = useState<ChannelTab>('content')
  /** 外接面板的「刷新」= 换 key 重挂 iframe。iframe 没有可靠的跨域 reload 入口，重挂是唯一
   *  对任何来源都成立的做法。 */
  const [embedReloadSeq, setEmbedReloadSeq] = useState(0)
  /** 外接面板的明暗跟随：iframe 一挂上就开始向它推送面板主题，换 key 重挂 / 卸载时收回。
   *  用回调 ref 而不是 useEffect——iframe 在 embed 分支里条件渲染，effect 抓不准它何时出现。 */
  const stopEmbedThemeRef = useRef<(() => void) | null>(null)
  const embedFrameRef = useCallback((frame: HTMLIFrameElement | null) => {
    stopEmbedThemeRef.current?.()
    stopEmbedThemeRef.current = frame ? publishThemeToFrame(frame, frame.src) : null
  }, [])
  useEffect(() => { setTab('content') }, [channelId])
  // 整条 Stream 的抓取设置是一整页（周期/策略/网盘绑定），420px 的分页里没有它的位置，
  // 盖成浮层（见下面渲染处）。null = 没开。
  const [settingStream, setSettingStream] = useState<ChannelStream | null>(null)
  // 队列生产者住在组件体里（要读当前这批 items），而 stage 归下面的 Provider 所有——
  // 组件体在 Provider 外面读不到 context，所以由 Provider 回填进这个 ref。
  // 契约见 lib/audioStageProvider.tsx 头注（主应用 App.tsx 用的是同一个出口）。
  const audioStageRef = useRef<AudioStage | null>(null)
  // next_cursor：undefined = 到底/首页未回来。用 ref 而非只用 state 读，
  // 因为 onScroll 里要在同一个事件里马上做"还有没有下一页"的判断，不等重渲染。
  const cursorRef = useRef<string | undefined>(undefined)
  const loadingMoreRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 详情是独立打包的第二个 IIFE bundle（见 detailBundle.ts / detail-entry.tsx 头注），
  // 这个容器**只交给它自己的 React root 摆内容**：outer（这棵树）绝不往里塞 children，
  // 下面的 detailReady/detailError 覆盖层是并排的兄弟节点，不是它的子节点——两个 React
  // 根同时写同一个 DOM 节点的子树会互相踩脏对方的 diff。
  const detailContainerRef = useRef<HTMLDivElement>(null)
  // 「转成文字」能不能做——开页拉一次，这棵树里的右键菜单（`ItemContextMenu` 走 context 读）
  // 和详情那棵树都吃它。详情是**另一个 React root**，context 过不去，只能把结果当种子
  // 顺着 `mount()` 递过去（理由见 `PanelDetail.tsx` 头注 §3）。
  const { caps: extractCaps, status: extractCapsStatus } = useExtractCaps(LOCAL)
  // 扩展装没装上（首启引导的挂载条件）。**判据永远是这一口**——install 的回执不算数。
  const extCap = useExtensionCapability(LOCAL)
  const extActions = useMemo(() => extensionActions(LOCAL), [])
  // 点了「以后再说」之后本次会话立刻收起来：后端那条 declinedAt 要下次进来才读得到。
  const [extBannerDismissed, setExtBannerDismissed] = useState(false)
  // 动作现场那一条（拒绝之后引导就挪到这里，spec §4.2）。
  const [extNoticeShown, setExtNoticeShown] = useState(false)
  // 三态放 ref 供回调**当场现取**：写进 useCallback 的依赖会让 harvestActiveChannel 在能力
  // 状态变化时重建，而它被 movie bundle 的 mount 参数拿着——重建一次就是整棵树重挂。
  const extCapRef = useRef(extCap.state)
  extCapRef.current = extCap.state
  // 种子放 ref 而不是进下面那个 effect 的依赖：caps 迟到一拍就重挂一次详情，
  // 视频/滚动位置全丢，而它换来的只是一个按钮早出现几十毫秒。
  const extractSeedRef = useRef<ExtractCapabilities | undefined>(undefined)
  useEffect(() => {
    // 只在**确实拉到**时才递。递一份"还没拉到"的全 false 过去，详情那棵树会把它当结论。
    extractSeedRef.current = extractCapsStatus === 'ready' ? extractCaps : undefined
  }, [extractCaps, extractCapsStatus])
  const [detailReady, setDetailReady] = useState(false)
  const [detailError, setDetailError] = useState<string>()
  // 影视频道同样是独立打包的 IIFE bundle（第三个，见 movie-entry.tsx 头注）——它占了主 bundle
  // 约 2.1MB，而绝大多数人开工作台只看时间线。同 detail：这个容器只交给它自己的 React root，
  // outer 绝不往里塞 children（两个 React 根写同一个子树会互相踩脏 diff）。
  const movieContainerRef = useRef<HTMLDivElement>(null)
  const movieRef = useRef<MovieBundle | null>(null)
  const [movieReady, setMovieReady] = useState(false)
  // 影视那棵树里有没有开着全屏播放器（它自己经 onOverlayChange 报过来——那棵树是另一个
  // bundle 的另一个 React 运行时，这边没有第二条路知道）。
  const [movieOverlay, setMovieOverlay] = useState(false)
  const [movieError, setMovieError] = useState<string>()
  // 研究频道是第四个独立 IIFE bundle（lightweight-charts + react-dom/server 约 860KB，
  // 见 research-entry.tsx 头注）。形状与影视逐条相同，容器同样只交给它自己的 React root。
  const researchContainerRef = useRef<HTMLDivElement>(null)
  const researchRef = useRef<ResearchBundle | null>(null)
  const [researchReady, setResearchReady] = useState(false)
  const [researchError, setResearchError] = useState<string>()

  // 频道名录。拉不到就静默留空——bar 不画，面板照常显示默认时间线（名录只决定"能切到哪"，
  // 不是这一页的内容来源）。不套 ChannelsProvider：那份共享状态是为了挡多个**写**入口
  // 互相覆盖（见 lib/channels.tsx 头注），面板这一份只读、只有一个读者，套一层没有收益。
  // （音乐视图那棵子树里另有一份 Provider——那里真有个写入口，见 PanelMusicChannel 头注。）
  //
  // 具名而不是内联在 effect 里：影视/音乐两边的管理面板改完频道（`onChannelsChanged`）也要
  // 重拉这一份，三个入口同一条代码路径。
  // 取数与失败策略（两条独立的 catch、失败保留旧值）都在 store 里，这一层只是个稳定的入口——
  // 影视/音乐两边的管理面板改完频道（`onChannelsChanged`）也调它，三个入口同一条代码路径。
  const loadChannels = useCallback(() => { void channelStore.load() }, [])
  useEffect(() => { loadChannels() }, [loadChannels])
  // 别处改了库存（尤其是**对话里让 AI 去订阅/改配置**，走的是 MCP 工具、不经过这个面板上的
  // 任何一个按钮）就重读名录——侧栏的频道列表就是从这份状态推过去的。
  // 这一份和配置页里 `ChannelsProvider` 那一份是两个订阅者：那边管配置面自己的数据，这边管
  // 侧栏的名录，各自重读各自的（面板这棵树刻意不套 Provider，见 loadChannels 上面的注释）。
  useEffect(() => subscribeInventory(api.wsUrl(LOCAL), loadChannels), [loadChannels])

  // **壳态**（面板住在 DSH 页面里、宽度归壳的网格列管）还是**浮层态**（420px 窄条）：
  // 判据就是宽度归谁——`onWidthChange` 在 = 我们自己报宽度 = 浮层态；不在 = 壳说了算 = 壳态
  // （见 entry.tsx 的 `manageWidth: false`）。海报墙、歌单表这类要横向铺开的视图只在壳态下
  // 画得下：歌单是序号/标题/专辑/喜欢/时长 五列 + 一条工具栏，420px 里没法看。
  const shellMode = onWidthChange === undefined
  // 当前这个频道走的是哪套视图。名录还没回来时 undefined，按图文流走（默认落点就是时间线）。
  const selectedChannel = channels.find((c) => c.id === channelId)
  const moviePresent = selectedChannel?.present === 'video'
  /** 这一屏该画歌单视图而不是图文流。 */
  const musicMode = shellMode && selectedChannel?.present === 'audio'
  /** 这一屏该画影视视图——浮层态（420px）排不下，那一档给一句话不装 bundle。 */
  const movieMode = moviePresent && shellMode
  /** 这一屏该画研究视图。**不看 shellMode**：run 列表是一列文字行、详情是自上而下的卡片流，
   *  420px 里读得了（海报墙和五列曲目表才排不下）。更要紧的是落回 PostFeed 在这一档是纯亏——
   *  研究数据是 live 的、永不入库，那一档必然画出一页空，看起来像"这个频道没内容"。 */
  const researchMode = selectedChannel?.present === 'research'
  /** 这一屏该画定时任务看板。同研究：不看 shellMode（一张表 + 展开行，420px 里读得了），
   *  也不落回 PostFeed（`present:'tasks'` 没有时间线，那一档取数恒为空）。它只依赖
   *  `cronFriendly.ts` 和 fetch，没有重依赖，直接在主 bundle 里渲染，不另开一份 IIFE。 */
  const tasksMode = selectedChannel?.present === 'tasks'
  /** 这一屏该画外接面板：整个主窗格一张 iframe 装 `options.url` 指的网页。同上：不看
   *  shellMode（那张网页自己响应式），也不落回 PostFeed（`embed` 没有时间线）。 */
  const embedMode = selectedChannel?.present === 'embed'
  const embedUrl = embedMode ? embedUrlOf(selectedChannel?.options) : undefined
  // 首帧那份频道从 ref 里现取（理由见下面 mount effect 的注释），不是从闭包里拿。
  const researchChannelRef = useRef<ChannelView | undefined>(undefined)
  researchChannelRef.current = selectedChannel
  // 只喂**当前这一个**频道，不聚合全部 video 频道——和主应用 `videoChannels` 同一个理由：
  // 点了儿童就该只看见儿童，频道的全部意义就是把它们分开。
  // 必须 memo：这份数组要跨 bundle 边界推进另一棵 React 树（下面的 update effect），
  // 每渲染一次换个新引用就等于每渲染一次重推一次。
  const movieChannels = useMemo(
    () => channels.filter((c) => c.id === channelId),
    [channels, channelId],
  )
  // 首帧那份名录从 ref 里现取（理由见 mount effect 末尾），不是从闭包里拿。
  const movieChannelsRef = useRef<ChannelView[]>(movieChannels)
  movieChannelsRef.current = movieChannels

  // 首页：换频道就整批重来（items 清空、游标清空、续页单飞标志清掉——那三样都属于**上一个**
  // 频道，带过来就是把两个频道的内容缝在一起）。
  // 音乐视图不吃这批 items（MusicChannel 自己按歌单/曲目取数），所以那一档**不发这个请求**：
  // 发了不但白烧一次分页取数，失败时还会画出一条与眼前内容无关的错误条。
  useEffect(() => {
    const seq = ++loadSeqRef.current
    // 滚动位置也归上一个频道：不归零的话，新频道的第一页画完后人落在半路上（还可能当场
    // 触发一次续页）。这一格 jsdom 验不了（不排版），但它和"游标不能带过来"是同一件事。
    if (scrollRef.current !== null) scrollRef.current.scrollTop = 0
    setItems([])
    setError(undefined)
    cursorRef.current = undefined
    loadingMoreRef.current = false
    setLoadingMore(false)
    // 影视/音乐频道的内容都不是一条时间线：`MovieChannel` 按 stream 取（海报墙 + 榜单货架），
    // `MusicChannel` 按歌单/曲目取。这里再取一遍频道时间线是白打一次请求，更糟的是它一旦失败
    // 就把整页画成 panel-error，把一个其实好好的海报墙/歌单盖掉。
    // 研究频道同理，而且更彻底：它的内容是 live 的、**永不入库**，这个端点对它恒返回空。
    // 定时任务同理：它的内容来自调度引擎的执行台账，不是任何频道的时间线。
    // 外接面板同理：它的内容就是另一张网页，本地库里没有它的任何一行。
    if (moviePresent || musicMode || researchMode || tasksMode || embedMode) return
    api.channelItems(LOCAL, channelId, { limit: PAGE_LIMIT })
      .then((r) => {
        if (seq !== loadSeqRef.current) return
        setItems(r.items)
        cursorRef.current = r.next_cursor
      })
      .catch((e: unknown) => {
        if (seq !== loadSeqRef.current) return
        setError(e instanceof Error ? e.message : String(e))
      })
  }, [channelId, moviePresent, musicMode, researchMode, tasksMode, embedMode])

  const loadMore = useCallback(() => {
    const cursor = cursorRef.current
    if (!cursor || loadingMoreRef.current) return
    const seq = loadSeqRef.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    api.channelItems(LOCAL, channelId, { limit: PAGE_LIMIT, cursor })
      .then((r) => {
        if (seq !== loadSeqRef.current) return // 迟到的上一个频道的续页：整页丢掉
        setItems((prev) => {
          const have = new Set(prev.map((i) => i.id))
          return [...prev, ...r.items.filter((i) => !have.has(i.id))]
        })
        cursorRef.current = r.next_cursor
      })
      // 续页失败静默：保留已有一批，用户滚回来再触发一次即可重试（同 useInbox.loadMoreChannel）。
      .catch(() => { /* keep current items */ })
      .finally(() => {
        // 只有仍属于当前这一轮才收拾单飞标志：切频道时新的一轮已经把它清成 false 了，
        // 旧请求再清一次会把**新频道**那次在途的续页解锁，同一页就取两遍。
        if (seq !== loadSeqRef.current) return
        loadingMoreRef.current = false
        setLoadingMore(false)
      })
  }, [channelId])

  const detailOpen = detail !== null
  useEffect(() => {
    onWidthChange?.(detailOpen ? DETAIL_WIDTH : LIST_WIDTH)
  }, [detailOpen, onWidthChange])

  // 「此刻手边有哪些内容」推给宿主（`@` 引用的候选源）：面板这侧是唯一知道"详情开着谁"
  // "这一批是哪些"的地方，壳不复刻判据，只当转发点。
  //
  // 频道那条线**不在这里**了：导航是面板自己的第二个挂载点（`mountNav`），两块共读
  // `channelStore`，宿主不再当中间的转发点。见 nav/channel-store.ts 与 entry.tsx。
  //
  // **投影后再推**（toItemRef）而不是整条 Item：跨包契约越小越好，理由见 itemRef.ts 头注。
  useEffect(() => {
    onItemContext?.({
      open: detail === null ? null : toItemRef(detail.item),
      recent: items.slice(0, RECENT_LIMIT).map(toItemRef),
      // 「主区被占满了」的两档合成一格给壳（详情页 / 影视全屏看片）。**别让壳去从 `open` 推**：
      // 看片那一档没有 item，`open` 恒为 null——判据在这里算一次，理由见 itemRef.ts。
      fullscreen: detailOpen || movieOverlay,
    })
  }, [items, detail, detailOpen, movieOverlay, onItemContext])

  // 装详情 bundle 并挂进 detailContainerRef：装好之前 detailReady 是 false（画"加载中"），
  // 装失败画 detailError（不是空白——空白和"面板挂了"长得一模一样）。cancelled 挡的是
  // "装到一半用户已经关掉详情"：不把迟到的 mount 落到一个已经不该显示详情的容器上。
  useEffect(() => {
    if (detail === null) return
    setDetailReady(false)
    setDetailError(undefined)
    let cancelled = false
    let mounted: { unmount: () => void } | undefined
    detailBundle.load(LOCAL.baseUrl)
      .then((bundle) => {
        if (cancelled || detailContainerRef.current === null) return
        bundle.mount(detailContainerRef.current, {
          backend: LOCAL.baseUrl,
          item: detail.item,
          startMediaIndex: detail.mediaIndex,
          autoPlayMedia: detail.autoPlay,
          extractCaps: extractSeedRef.current,
          // 对话通道要**现取**（不是开页时存一份）：壳是在挂载主 bundle 那一刻才装上它的，
          // 而这里每次开详情都会重新读到当前那一份。递不过去的症状见 askChatSink() 头注。
          askChat: askChatSink(),
          onClose: () => setDetail(null),
        })
        mounted = bundle
        setDetailReady(true)
      })
      .catch((e: unknown) => {
        if (!cancelled) setDetailError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      // 延到微任务：`onClose` 常常是详情自己（内层 root）的一次点击事件触发的——
      // 那一刻内层 React 还在处理这次事件/渲染，站在调用栈里同步 `root.unmount()`
      // 会撞见 "Attempted to synchronously unmount a root while React was already
      // rendering"。让给当前这轮渲染/事件先走完，卸载动作本身不关心早一拍还是晚一拍。
      const toUnmount = mounted
      if (toUnmount !== undefined) queueMicrotask(() => toUnmount.unmount())
    }
  }, [detail])

  // 播客队列的生产者：播点中的这条，并把当前这批里的音频条目按列表顺序排在它后面
  // （自动续播 nextTrack 就沿着用户看到的顺序走）。语义与 App.tsx 的 playPodcastFrom 同一份。
  const playPodcastFrom = useCallback((item: StreamItem) => {
    const tracks = toTracks(items, LOCAL.baseUrl, 'podcast')
    const idx = tracks.findIndex((track) => track.id === item.id)
    if (idx >= 0) audioStageRef.current?.playQueue(tracks, idx, 'podcast')
  }, [items])

  // 频道标题菜单里那一项「重新抓取」——影视和音乐共用这**一个**入口。语义抄主应用的
  // `harvestSelected`：选中的是一个频道，就采这个频道下挂的每一个源（`api.refreshChannel`），
  // 采完重拉名录——海报墙的内容全部派生自 `channels[].streams`，名录换了新引用 `MovieChannel`
  // 自己就会重取各 stream 的条目。**不接空函数**：一个点了什么都不发生的刷新按钮，和坏了
  // 长得一模一样。
  //
  // **必须有进度反馈**：扇出可能要几十秒，静默的 fetch 在用户眼里就是"点了没反应"，和坏了
  // 长得一模一样。部分失败照常报成功并说出没成的条数——某个 facility 掉登录态是常态，不该
  // 让另外几条成功的抓取在 UI 上一起消失。
  const harvestActiveChannel = useCallback(() => {
    const p = api.refreshChannel(LOCAL, channelId)
    toast.promise(p, {
      loading: '正在重新抓取…',
      success: (r) => {
        const base = `抓取完成：取到 ${r.fetched} 条，新增 ${r.written} 条`
        return r.failed > 0 ? `${base}（${r.failed}/${r.streams.length} 条源没成）` : base
      },
      error: (e: unknown) => `抓取失败：${e instanceof Error ? e.message : String(e)}`,
    })
    // toast 已经报过了，这里只是不让它变成 unhandled rejection。成没成都重拉一次名录：
    // 采不动就还是旧内容，但新采到的流可能刚进这个频道。
    void p
      .catch(() => {
        // 用户**自己按的**采集没成，而这台机器的扩展从来没连上过 → 就在这个动作的现场
        // 给他安装入口（spec §4.2）。`disconnected` 那一档故意不进来：那是"装过又掉了"，
        // 该走排查，劝他再装一遍只会多出第二份扩展。一天最多提一次。
        if (extCapRef.current !== 'never-seen') return
        const now = new Date()
        if (!shouldPrompt('harvest', promptRecord('harvest'), now)) return
        recordPrompted('harvest', now)
        setExtNoticeShown(true)
      })
      .finally(() => loadChannels())
  }, [channelId, loadChannels])

  // 装影视 bundle 并挂进 movieContainerRef。形状同上面的详情，两处差别只有两点：
  //  1. **换频道要整棵重建**（deps 里的 channelId）：二级路由（海报墙 ↔ 某部作品）存在那棵树
  //     的内存里、随树生灭（见 PanelMovieChannel 头注 §1），不重建就会停在上一个频道某部剧的
  //     详情上——把两个频道缝在一起。这一条以前由 `key={channelId}` 免费提供，独立 root 里
  //     没有 key 这回事，得自己写出来。
  //  2. 多一个 `update`（见下一个 effect）：名录刷新要推进去，但**不能**靠重建来推。
  useEffect(() => {
    if (!movieMode) return
    setMovieReady(false)
    setMovieError(undefined)
    setMovieOverlay(false)
    let cancelled = false
    let mounted: MovieBundle | undefined
    movieBundle.load(LOCAL.baseUrl)
      .then((bundle) => {
        if (cancelled || movieContainerRef.current === null) return
        bundle.mount(movieContainerRef.current, {
          backend: LOCAL.baseUrl,
          channels: movieChannelsRef.current,
          onChannelsChanged: loadChannels,
          onReload: harvestActiveChannel,
          onOverlayChange: setMovieOverlay,
          // 同详情那一格（见上）：影视树里的引用/AI 匹配按钮在另一份 JS 运行时里，
          // 主 bundle 装的通道递不过去就等于没有。递不过去的症状见 askChatSink() 头注。
          askChat: askChatSink(),
        })
        mounted = bundle
        movieRef.current = bundle
        setMovieReady(true)
      })
      .catch((e: unknown) => {
        if (!cancelled) setMovieError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      movieRef.current = null
      // 同详情：延到微任务再卸。卸载常常是内层那棵树自己的一次事件触发的（点频道导航 →
      // 内层还在渲染），站在调用栈里同步 unmount 会撞 "Attempted to synchronously unmount
      // a root while React was already rendering"。
      const toUnmount = mounted
      if (toUnmount !== undefined) queueMicrotask(() => toUnmount.unmount())
    }
    // 名录有意不进 deps（它的变化走下面那个 update effect），所以首帧那份从 ref 里现取——
    // 写进闭包就成了"装配期冻住的答案"：bundle 是异步装的，等它到货时闭包里那份名录可能
    // 已经旧了，而这条不会报错，只会画出一个内容对不上的海报墙。
  }, [movieMode, channelId, loadChannels, harvestActiveChannel])

  // 名录刷新（管理频道改完 / 重新抓取完）推进那棵独立的树。主 bundle 那边这一步是 React
  // 自己做的（props 变了就重渲染），跨 root 之后没人替我们做——不推就是"改完了页面没反应"。
  useEffect(() => {
    if (!movieReady) return
    movieRef.current?.update({
      backend: LOCAL.baseUrl,
      channels: movieChannels,
      onChannelsChanged: loadChannels,
      onReload: harvestActiveChannel,
      onOverlayChange: setMovieOverlay,
      // `update` 是整份 opts 重渲染——漏这一格等于在「管理频道改完」那一刻把对话通道掐了。
      askChat: askChatSink(),
    })
  }, [movieReady, movieChannels, loadChannels, harvestActiveChannel])

  // 装研究 bundle 并挂进 researchContainerRef。形状抄影视那两个 effect，两处差别只有：
  //  1. 换频道靠 deps 里的 channelId 整棵重建（二级路由「run 列表 ↔ 某个 run」存在那棵树的
  //     内存里，不重建就停在上一个频道某个 run 的详情上——把两个频道缝在一起）；
  //  2. 只递一个频道对象 + 一个名录重拉（顶栏那个齿轮开的是 `ChannelManageSheet`）。没有
  //     `onReload`：live 档现读不入库，"重新抓取"这件事不存在，刷新由那棵树自己重读一次。
  useEffect(() => {
    if (!researchMode || selectedChannel === undefined) return
    setResearchReady(false)
    setResearchError(undefined)
    let cancelled = false
    let mounted: ResearchBundle | undefined
    researchBundle.load(LOCAL.baseUrl)
      .then((bundle) => {
        if (cancelled || researchContainerRef.current === null) return
        // 首帧那份频道从 ref 里现取（同影视）：写进闭包就成了"装配期冻住的答案"，
        // bundle 是异步装的，到货时闭包里那份可能已经旧了，而这条不会报错。
        const channel = researchChannelRef.current
        if (channel === undefined) return
        bundle.mount(researchContainerRef.current, { backend: LOCAL.baseUrl, channel, onChannelsChanged: loadChannels })
        mounted = bundle
        researchRef.current = bundle
        setResearchReady(true)
      })
      .catch((e: unknown) => {
        if (!cancelled) setResearchError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      researchRef.current = null
      // 同影视/详情：延到微任务再卸，别站在内层那棵树自己的渲染栈里同步 unmount。
      const toUnmount = mounted
      if (toUnmount !== undefined) queueMicrotask(() => toUnmount.unmount())
    }
    // 频道对象有意不进 deps（它的变化走下面那个 update effect），理由同影视那一处。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [researchMode, channelId])

  // 名录刷新（管理频道改完 / 重新抓取完）推进那棵独立的树。跨 root 之后 React 不替我们做——
  // 不推就是这个频道新绑的 live 流一直不出现在 run 列表里。
  useEffect(() => {
    if (!researchReady || selectedChannel === undefined) return
    researchRef.current?.update({ backend: LOCAL.baseUrl, channel: selectedChannel, onChannelsChanged: loadChannels })
  }, [researchReady, selectedChannel, loadChannels])

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight) loadMore()
  }, [loadMore])

  return (
    // 「后端此刻能做哪几档转成文字」摊给这棵树：消费者是右键菜单，它挂在每一张卡片底下，
    // 走 prop 就得沿途每一层都为一个自己不用的东西留个洞（同 App.tsx 那一层，理由在
    // lib/extractCaps.tsx 头注）。没有这一层，面板右键里的「转成文字」永远不出现。
    // relative：详情那层是 absolute inset-0，盖在列表上（列表不卸载，见文件头注）。
    // text-foreground 必须钉在这棵树的根上：基础文字色的全局规则写在 body 级（Tailwind
    // preflight），而明暗翻转的 `dark` 类挂在面板根（hostTheme.ts）、到不了 body——不钉的话，
    // 所有没带显式 text-* 类的文字永远继承浅色档的黑字，暗色下发黑、也不跟主题翻转。
    <ExtractCapsProvider caps={extractCaps}>
    <div className="relative flex h-full flex-col text-foreground">
      {/* 播放失败要说得出话：`AudioStageProvider` 的失败回执走 toast，没有这一枚就是静音失败
          （面板是独立的一页，主应用那枚 Toaster 在另一页上，够不着）。 */}
      <Toaster />
      {/* 首启引导（spec 2026-08-30-extension-onboarding §4.1）：**只在"从没连上过"且没被
          拒绝过时画**。`disconnected` 那一档故意不画——那是"装过又掉了"，走排查提示，
          再劝老用户装一遍只会让他去装第二份。 */}
      {extCap.state === 'never-seen' && extCap.declinedAt === undefined && !extBannerDismissed && (
        <ExtensionOnboardingCard
          variant="banner"
          actions={extActions}
          onDismiss={() => setExtBannerDismissed(true)}
          onConnected={extCap.refresh}
        />
      )}
      {/* 动作现场那一条：只有用户自己按的采集失败过、且这台机器从没连上过扩展时才出现。 */}
      {extNoticeShown && extCap.state === 'never-seen' && (
        <ExtensionRequiredNotice actions={extActions} onConnected={extCap.refresh} />
      )}
      {/* 这棵树里**没有频道切换条**：切频道归导航（面板的第二个挂载点 `mountNav`，见
          nav/NavTree.tsx）。同一份切换器画两份，两处的选中态只会互相说谎。 */}
      <AudioStageProvider stageRef={audioStageRef}>
      {/* 判路只有这**一个**点：present 决定画哪套视图，两支互斥。往 `present` 注册表加新档时
          在这里加一支，别在别处再开第二个判路点——两处各写各的，选中态迟早说两种话。 */}
      {moviePresent ? (
        shellMode ? (
          // 影视是第三个独立打包的 IIFE bundle（约 2.1MB，见 movie-entry.tsx 头注），第一次
          // 切到影视频道才装。这个占位 div **只交给它自己的 React root 摆内容**：outer（这棵
          // 树）绝不往里塞 children，下面两个覆盖层是并排的兄弟节点。
          // `absolute inset-0 flex flex-col` 是给里面那棵树撑出高度的：`PanelMovieChannel`
          // 的根是 `flex-1`，父级不是 flex 容器的话它一格高度都拿不到（画出来是一条零高的线，
          // 不报错）。
          <div data-testid="panel-movie-host" className="relative min-h-0 flex-1">
            <div ref={movieContainerRef} className="absolute inset-0 flex flex-col" />
            {movieError !== undefined ? (
              <div data-testid="panel-movie-error" className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-destructive">
                影视频道加载失败：{movieError}
              </div>
            ) : !movieReady ? (
              // 装 2.6MB 要一会儿，白屏和"面板挂了"长得一模一样。
              // testid 不是可有可无的：`MovieChannel` 自己也有一格写着"加载中…"的骨架
              // （它那几份取数还没回来时），按文字找会同时命中两个，断言"我这层已经收了"
              // 就变成一条**随对方取数时序变红**的假偶发。按 testid 找只认这一层。
              <div data-testid="panel-movie-loading" className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                加载中…
              </div>
            ) : null}
          </div>
        ) : (
          // 浮层态只有 420px：海报墙、hero、分集卡墙在这个宽度里排不下，画出来也只是一列挤扁的
          // 卡片。说清"要更宽"比给一个看着有、其实读不了的页面诚实。
          <div data-testid="panel-movie-too-narrow" className="p-4 text-sm text-muted-foreground">
            影视频道要更宽的版面，请在工作台里打开。
          </div>
        )
      ) : /* 音乐/播客走主应用那一份歌单视图（`MusicChannel`），不是同一个 PostFeed——
             `present === 'audio'` 的频道装的是歌单/播客，画成图文流等于把它变成时间线的副本。
             必须在 AudioStageProvider **里面**：MusicChannel 内部用 useAudioStage()，
             这一页只有这一份舞台（见文件头注）。浮层态（420px）不给歌单，落回下面的 PostFeed。 */
        musicMode && selectedChannel !== undefined ? (
        <PanelMusicChannel
          channel={selectedChannel}
          onChannelsChanged={loadChannels}
          onReload={harvestActiveChannel}
        />
      ) : /* 研究 run 走主应用那一份 `ResearchChannel`（经 `PanelResearchChannel` 补齐面板独有的
             两件事，见那个文件的头注）。数据是 live 的、不入库，所以这一档**必须**判出来：
             落回下面的 PostFeed 不会报错，只会画出一页空。宽度不挑（见上面 researchMode 那一格
             的注释），所以没有 shellMode 那一支。
             研究是第四个独立打包的 IIFE bundle（见 research-entry.tsx 头注），同影视：这个占位
             div **只交给它自己的 React root 摆内容**，下面两个覆盖层是并排的兄弟节点。 */
        researchMode ? (
        <div data-testid="panel-research-host" className="relative min-h-0 flex-1">
          <div ref={researchContainerRef} className="absolute inset-0 flex flex-col" />
          {researchError !== undefined ? (
            <div data-testid="panel-research-error" className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-destructive">
              研究频道加载失败：{researchError}
            </div>
          ) : !researchReady ? (
            // 同影视：白屏和"面板挂了"长得一模一样。按 testid 找只认这一层——`ResearchChannel`
            // 自己也画「载入中…」（run 列表还没回来时），按文字找会同时命中两个。
            <div data-testid="panel-research-loading" className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              加载中…
            </div>
          ) : null}
        </div>
      ) : /* 定时任务看板：`TasksPage` 只依赖 cronFriendly.ts、acrylic 组件和 fetch，没有重依赖，不像研究/
             影视/音乐那样需要单开一份 IIFE bundle——直接在主 bundle 里当普通组件渲染。
             apiBase 取 `LOCAL.baseUrl`，跟研究档的后端地址同一个来源。 */
        tasksMode ? (
        <div data-testid="panel-tasks-host" className="min-h-0 flex-1">
          {/* 滚动归 `TasksPage` 自己：它顶上那条 navbar 与其余四档同一格，得钉在滚动容器
              **外面**一直看得见。这里再套一层 `overflow-y-auto` 会把顶栏一起卷走。 */}
          {/* `conn` 不能省：账号那份表单走 `/api/config/*`，要带 token（只给 baseUrl 的话
              别的都正常、只有那一格 401）。 */}
          <TasksPage apiBase={LOCAL.baseUrl} conn={LOCAL} title={selectedChannel?.label ?? '定时任务'} />
        </div>
      ) : /* 外接面板：整个主窗格交给一张 iframe。sandbox 放开脚本 / 同源 / 表单 / 弹窗——
             对象是用户自己配进来的受信仪表盘（Grafana、监控页），锁成只读等于装不上。
             URL 没填或不是 http(s)：画说明，**不画空 iframe**——空 iframe 和"面板挂了"长得一样。
             切到「配置」分页填地址走的是下面那条 tab 路径，所以这里顺带把分页栏也画上。 */
        embedMode && selectedChannel !== undefined ? (
        <>
          <div data-testid="panel-timeline-header" className="flex h-8 shrink-0 items-center gap-2 px-4 pt-3 pb-0 box-content">
            <ChannelTitleMenu
              title={selectedChannel.label}
              onRefresh={() => setEmbedReloadSeq((n) => n + 1)}
              refreshLabel="重新载入面板"
              exportChannel={{ conn: LOCAL, id: selectedChannel.id }}
              className="min-w-0 flex-1"
            />
          </div>
          <ChannelTabs value={tab} onChange={setTab} />
          {tab === 'config' ? (
            <div data-testid="panel-config" className="min-h-0 flex-1 overflow-y-auto">
              <ChannelsProvider conn={LOCAL}>
                <ChannelConfigPanel
                  conn={LOCAL}
                  channelId={selectedChannel.id}
                  showHeader={false}
                  onChanged={loadChannels}
                  onDeleted={() => { setTab('content'); setChannelId(DEFAULT_TIMELINE_CHANNEL_ID) }}
                />
              </ChannelsProvider>
            </div>
          ) : embedUrl !== undefined ? (
            <iframe
              key={`${embedUrl}#${embedReloadSeq}`}
              ref={embedFrameRef}
              data-testid="panel-embed-frame"
              title={selectedChannel.label}
              src={embedUrl}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              className="min-h-0 w-full flex-1 border-0 bg-background"
            />
          ) : (
            <div data-testid="panel-embed-empty" className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
              这个外接面板还没有地址。到「配置」分页填一个 http(s) 网址，这里就会整页装它。
            </div>
          )}
        </>
      ) : (
      <>
      {/* 图文流的顶栏。与音乐/影视/研究同一格（照 DSH 对话页那条 navbar：标题行 32px + 上留白
          12px、**没有图标也没有下边框**，分区靠留白不靠线）——四档 Present 在同一个壳里换来
          换去，差一格都会看见跳。
          没有搜索框：主应用那一档的搜索在全局 Navbar 上，面板没有那条栏，硬塞一个只会是
          一个不接任何东西的输入框。
          在滚动容器**外面**：顶栏得一直看得见，取内容失败时更是。 */}
      <div data-testid="panel-timeline-header" className="flex h-8 shrink-0 items-center gap-2 px-4 pt-3 pb-0 box-content">
        <ChannelTitleMenu
          title={selectedChannel?.label ?? '时间线'}
          onRefresh={harvestActiveChannel}
          // 名录还没回来时不给导出项：那一刻标题是兜底文案，"导出哪一个"没有答案。
          exportChannel={selectedChannel ? { conn: LOCAL, id: selectedChannel.id } : undefined}
          className="min-w-0 flex-1"
        />
      </div>
      {/* 标题栏正下方那条「内容 | 配置」——配置从齿轮开的抽屉改成了分页，理由见 ChannelTabs
          头注。没有 selectedChannel（名录还没回来）时不画：配置页没有对象可配。 */}
      {selectedChannel !== undefined ? <ChannelTabs value={tab} onChange={setTab} /> : null}
      {tab === 'config' && selectedChannel !== undefined ? (
        <div data-testid="panel-config" className="min-h-0 flex-1 overflow-y-auto">
          {/* 就地补一份 `ChannelsProvider`：配置面组件体里就调 `useChannels()`。这棵树自己那份
              只读名录**刻意**不套 Provider（见上面的注释），所以在这里补，且只在配置页开着时挂
              ——常挂着就是白拉一次 `/api/channels`。 */}
          <ChannelsProvider conn={LOCAL}>
            <ChannelConfigPanel
              conn={LOCAL}
              channelId={selectedChannel.id}
              showHeader={false}
              onChanged={loadChannels}
              // 删掉了就回内容页：配置页指着一个不存在的频道，只会显示「这个频道已不存在」。
              onDeleted={() => { setTab('content'); setChannelId(DEFAULT_TIMELINE_CHANNEL_ID) }}
              onEditStream={setSettingStream}
              // 预览要 PreviewContext（弹窗归主应用的 App 画），面板里没有那个 Provider——
              // 不传 = 不画预览键，而不是画一个点了抛错的键。
            />
          </ChannelsProvider>
        </div>
      ) : error !== undefined ? (
        <div data-testid="panel-error" className="p-4 text-sm text-destructive">
          取内容失败：{error}
        </div>
      ) : (
      <div ref={scrollRef} data-testid="panel-scroll" className="min-h-0 flex-1 overflow-y-auto p-5" onScroll={onScroll}>
        <PostFeed
          items={items}
          layout="waterfall"
          // 切频道要让 PostFeed 知道（它据此判"这次 layout 变化是不是切频道带来的"，
          // 见 PostFeed 头注）——写死一个 `__panel__` 会让它把切频道当成同一个列表的更新。
          channelId={channelId}
          onOpen={(item, opts) => setDetail({
            item,
            mediaIndex: opts?.mediaIndex ?? 0,
            autoPlay: autoPlaysDetailMedia(opts?.intent),
          })}
          onPlayAudio={playPodcastFrom}
        />
        {loadingMore ? <div className="py-3 text-center text-xs text-muted-foreground">加载中…</div> : null}
      </div>
      )}
      </>
      )}
      </AudioStageProvider>
      {detail !== null ? (
        <>
          {/* 空容器，只用来给 detail bundle 自己的 React root 挂载——见上面 effect 的注释。 */}
          <div ref={detailContainerRef} className="absolute inset-0" />
          {detailError !== undefined ? (
            <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-destructive">
              详情加载失败：{detailError}
            </div>
          ) : !detailReady ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              加载中…
            </div>
          ) : null}
        </>
      ) : null}
      {/* 一整条 Stream 的抓取设置（周期/策略/网盘绑定）是一整页，配置分页里塞不下，盖上来。
          `absolute inset-0` 而不是 Radix 的 Sheet：Sheet 会 portal 到 DSH 的 body 上去，
          那不是我们这棵挂着 `.dark` 的子树（见 hostTheme.ts）。 */}
      {settingStream !== null ? (
        <div data-testid="panel-stream-setting" className="absolute inset-0 z-10 flex flex-col bg-background">
          <StreamSettingPage
            conn={LOCAL}
            channelId={channelId}
            channelName={selectedChannel?.label}
            stream={settingStream}
            onBack={() => setSettingStream(null)}
            onSaved={loadChannels}
          />
        </div>
      ) : null}
    </div>
    </ExtractCapsProvider>
  )
}

/** `options.url` 能不能直接当 iframe 的 src。后端写入时已经拦了非 http(s)，这里再守一遍是因为
 *  频道记录也可能来自旧分享包 / 手改的库——面板不该因为一个坏值画出空 iframe。 */
function embedUrlOf(options: Record<string, unknown> | undefined): string | undefined {
  const raw = options?.url
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? raw : undefined
  } catch { return undefined }
}
