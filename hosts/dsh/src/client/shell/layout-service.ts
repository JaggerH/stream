/**
 * 壳反转后的 `ctx.layout` 供体。
 *
 * profile 关掉了 `@deepseek-ai/dsh-client-ui-layout` 那一行（它的 AppFrame 三列壳被
 * StreamShell 接管），但 `layout` 是 ui-sidebar / ui-conversation / ui-sidebar-right 的
 * **硬 inject 门**——不给这个服务，它们整个不装载。所以接管壳的人必须连服务一起接：
 * 接口就是 ui-layout 导出的 `ILayout`，实现落在我们自己的面板几何状态上。
 *
 * **0.2.0 起这个接口比 0.1.2 大一圈，而且是两种不同性质的扩张：**
 *
 * - `openDetails()` / `closeDetails()`（0.1.2：命令式地开/关右列）→
 *   `openRightbar(track, fullscreen)` / `closeRightbar()`（0.2.0：右列**自己报告**它的呈现
 *   方式，框架据此决定给不给网格轨道）。方向反过来了：以前是"谁调谁开列"，现在是"占位者
 *   报告、框架听"。所以我们只存这两个标志位，几何照旧自己算；**右列占位者要能被渲染出来
 *   才可能报**，所以右列那一格常挂载、宽度由标志位决定（见 StreamShell）。
 * - `panelInfo` / `selectPanel` / `beginNavigation`（0.2.0 新增，**跟壳反转无关**）：
 *   中央主面板的选择。全局面板（ui-schedule / ui-plugin-manager）注册进 keyed 的 `main`，
 *   靠这里选中；`beginNavigation()` 是它们异步导航的取代信号——ui-workspace 的
 *   `openWorkspace` 就是拿它做"后一趟取消前一趟"的。这三格不实现 = 那几个插件硬 inject
 *   落不下来，整批客户端插件跟着起不来。
 *
 * 状态做成 useSyncExternalStore 形状（subscribe/getSnapshot），StreamShell 直接订阅——
 * 服务方法（对话 UI 里点"查看详情"那类跨插件调用）和壳内按钮走的是同一份状态。
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout, MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'

export interface ShellLayoutState {
  /** 侧栏收成 56px 图标条（true）还是展开 280px（false）。默认展开：Stream 的频道分区
   *  就住在这条侧栏里（SidebarChannelSection），收起态图标条里没有它的位置。 */
  sidebarCollapsed: boolean
  /** 对话列开合。 */
  conversationOpen: boolean
  /** DSH 的工具详情列（右列）要不要占一条网格轨道——由占位者经 `openRightbar` 报告。 */
  rightbarTrack: boolean
  /** 右列此刻是不是铺满整帧（占位者自报的第二格；与轨道无关）。 */
  rightbarFullscreen: boolean
  /** Stream 主区开合。false = **专注对话**：主区列归 0（面板保持挂载，滚动/频道状态原地留着），
   *  对话列吃满剩余宽度。跨刷新记忆（localStorage）——专注是个粘住的选择，不是一次性的。 */
  streamOpen: boolean
  /** 中央主区此刻选中的**全局面板**（keyed `main` 的 key）；`null` = 我们的 Stream 主区。
   *
   *  契约里 `null` 的原意是"回到当前会话"，那是给 DSH 原壳的（它把对话放中央）。我们是
   *  反转壳——对话常驻右侧那一列，中央本来就是 Stream 内容，所以这一格对我们就是"没选
   *  任何全局面板"。改动前请先读 StreamShell 头注。 */
  panelId: MainPanelId | null
}

const STREAM_OPEN_KEY = 'stream-shell:stream-open'

function readStreamOpen(): boolean {
  // localStorage 在隐私模式/严格设置下会抛——读不到就按默认（开着），别让壳起不来。
  try { return localStorage.getItem(STREAM_OPEN_KEY) !== '0' } catch { return true }
}

function writeStreamOpen(open: boolean): void {
  try { localStorage.setItem(STREAM_OPEN_KEY, open ? '1' : '0') } catch { /* 记不住就不记 */ }
}

export class ShellLayoutController implements ILayout {
  #state: ShellLayoutState = {
    sidebarCollapsed: false,
    conversationOpen: true,
    rightbarTrack: false,
    rightbarFullscreen: false,
    streamOpen: readStreamOpen(),
    panelId: null,
  }

  #listeners = new Set<() => void>()

  /** 内容详情此刻开着没有（只认边沿：itemContext 在详情开着期间会反复推同一个状态）。 */
  #contentDetailOpen = false

  /** 上一次让位是**我们**收的（true）还是用户本来就收着 / 用户又叫回来了（false）。
   *  只有前者才有资格在详情关掉时把对话放回去——擅自开出一列用户刚亲手收掉的东西，
   *  比不归位更烦人。 */
  #autoCollapsed = false

  /**
   * `panelInfo` 的快照缓存。
   *
   * **必须缓存**：`useSyncExternalStore` 用 `Object.is` 比快照，每次现拼一个新对象会让它
   * 认定"变了"，于是无限重渲染（页面活着但 CPU 打满，一处都不报）。
   */
  #panelInfo: PanelInfo = { activePanelId: null }

  /** 那一趟还没被取代的导航。`beginNavigation` 换一个新的就把它中止掉。 */
  #navigation: AbortController | undefined

  /** 主面板注册表是不是有这个 key。**现取**，由 apply() 拿 `ctx.slots.entries('main')` 给——
   *  注册表是活的（插件随装载/卸载进出），存下来就冻住了那一刻的答案。 */
  #hasMainPanel: (id: MainPanelId) => boolean

  /**
   * @param hasMainPanel - 判"这个 key 注册过没有"，`selectPanel` 的校验用它。
   */
  constructor(hasMainPanel: (id: MainPanelId) => boolean = () => false) {
    this.#hasMainPanel = hasMainPanel
  }

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn)
    return () => { this.#listeners.delete(fn) }
  }

  getSnapshot = (): ShellLayoutState => this.#state

  /**
   * 根标准座位：全局面板选择（`usePanelInfo` 读的就是它）。
   *
   * ui-layout 在它自己的 apply 里 `ctx.slots.provideRoot({ hooks: { panelInfo } })`；它被我们
   * 关掉了，所以这一格得由我们补上——**注册进 `sidebar.panellist` / `main` 的那些组件
   * （ui-schedule、ui-plugin-manager）`usePanelInfo` 一读就是空**，而那是它们判"我是不是
   * 当前那格"的唯一依据。
   */
  panelInfo: HostObservable<PanelInfo> = {
    getSnapshot: () => this.#panelInfo,
    subscribe: (fn: () => void) => this.subscribe(fn),
  }

  #set(patch: Partial<ShellLayoutState>): void {
    const next = { ...this.#state, ...patch }
    this.#state = next
    // 只有真换了面板才换快照引用（见 #panelInfo 头注）。
    if (patch.panelId !== undefined && patch.panelId !== this.#panelInfo.activePanelId) {
      this.#panelInfo = { activePanelId: next.panelId }
    }
    for (const fn of this.#listeners) fn()
  }

  /** 选一格全局面板（`null` = 回到 Stream 主区）。 */
  selectPanel(panelId: MainPanelId | null): void {
    if (panelId !== null && !this.#hasMainPanel(panelId)) {
      // 契约要求这里抛。静默记下一个没人渲染的 key，表现是"点了没反应"——而调用方
      // （侧栏那行、快捷键）不会得到任何反馈，也就永远没人发现。
      throw new Error(`[stream-ui] main 槽里没有注册 ${JSON.stringify(panelId)} 这格面板`)
    }
    this.#set({ panelId })
  }

  /** 起一趟异步导航，取代上一趟。 */
  beginNavigation(): AbortSignal {
    // 契约：返回的信号在下一次导航或布局销毁时中止。ui-workspace 的 openWorkspace 靠它
    // 做"后一趟取消前一趟"——不发这个信号，两趟快速点击就会互相打架（后建的会话被
    // 前一趟的收尾覆盖）。
    this.#navigation?.abort()
    this.#navigation = new AbortController()
    return this.#navigation.signal
  }

  /** 壳卸载时收尾：把还挂着的那趟导航中止掉（不然它的 await 结束后会接着动一个已经拆了的壳）。 */
  dispose(): void {
    this.#navigation?.abort()
    this.#navigation = undefined
  }

  toggleSidebar(): void { this.#set({ sidebarCollapsed: !this.#state.sidebarCollapsed }) }

  /**
   * 右列占位者报告自己的呈现方式（0.2.0 的新方向：**报告**，不是命令）。
   *
   * `track` = 右列要不要在网格里占一条轨道；`fullscreen` = 它是不是盖住整个帧。
   * `UI 那边两格都报 false` 等价于关闭，所以这里顺手归一化，免得两条入口（open/close）
   * 在占位者那侧各写一半。
   *
   * 开出来的那一刻把对话列露出来：右列装的是**这条会话**的工具详情，对话列收着的时候它
   * 没有意义（与 0.1.2 的 `openDetails` 逐字同一条理由）。
   * @param track - 是否占一条网格轨道。
   * @param fullscreen - 是否铺满整帧。
   */
  openRightbar(track: boolean, fullscreen: boolean): void {
    if (!track && !fullscreen) { this.closeRightbar(); return }
    this.#set({ rightbarTrack: track, rightbarFullscreen: fullscreen, conversationOpen: true })
  }

  /** 右列占位者报告自己收起了（无轨道、无拖拽柄）。 */
  closeRightbar(): void { this.#set({ rightbarTrack: false, rightbarFullscreen: false }) }

  /**
   * 内容详情（面板里点开的那条）开合了——**不是** DSH 的工具详情列（右列归 openRightbar）。
   *
   * 详情在主区里铺满一整列（媒体 + 简介/评论 480），再并排一列 480 的对话，窄屏上三块
   * 挤成谁都看不清。所以详情开出来时对话列自动让位，详情关掉再放回来；要边看边聊就点
   * 右上角那颗开关把它叫回来，此后这一轮详情不再自动动它（见 `#autoCollapsed`）。
   *
   * 信号来自 panel bundle 推给壳的 itemContext（`fullscreen` 非空 = 详情开着），不是壳自己知道
   * 的——详情住在另一个 bundle 的另一棵 React 树里。
   * @param open - 详情是不是开着。
   */
  setContentDetail(open: boolean): void {
    if (open === this.#contentDetailOpen) return
    this.#contentDetailOpen = open
    if (open) {
      this.#autoCollapsed = this.#state.conversationOpen
      if (this.#state.conversationOpen) this.#set({ conversationOpen: false })
    } else {
      if (this.#autoCollapsed) this.#set({ conversationOpen: true })
      this.#autoCollapsed = false
    }
  }

  /**
   * 把对话列露出来（已经开着就什么都不做）。
   *
   * 给的是「有话要发进对话」那一类动作用的——详情里点「转成文字」会开一条新会话并发出一句，
   * 而详情正把对话列收着，不露出来就是**发出去了但用户看不见**，和"点了没反应"长得一样。
   *
   * 与用户亲手点开关**同权**：露出来之后详情关掉时不再自动收/放它（那套只对"我收的我
   * 放回去"成立）。
   */
  revealConversation(): void {
    this.#autoCollapsed = false
    if (!this.#state.conversationOpen) this.#set({ conversationOpen: true })
  }

  /** 把 Stream 主区露出来（已开着就什么都不做）。给「我要看内容」那类动作用——
   *  专注态下点侧栏频道，意图就是看流，不该还要再按一次开关。 */
  revealStream(): void {
    if (this.#state.streamOpen) return
    writeStreamOpen(true)
    this.#set({ streamOpen: true })
  }

  /**
   * 侧栏名单里点了一行——**布局的唯一入口**（旧的三档分段开关已删）。
   *
   * 两份名单（Stream 频道 / DSH 会话）同一条规则，所以只有这一个方法：
   * 1. 那一栏关着 → 打开它（点频道就是要看流，点会话就是要看对话，不该还要再按个开关）；
   * 2. 开着、且点的就是那一栏此刻选中的那行 → **收起它**（这就是那个"再点一次收起"的手势）；
   * 3. 开着、点的是别的行 → 布局不动，只换选中项（换频道/换会话是常态，不该抖布局）。
   *
   * 第 2 条有一道闸：**另一栏关着时不收**，否则两列全空就是白屏。
   *
   * 收起某一栏**不清那一侧的选中项**：高亮的意思是"我在看的是这条"，不是"那一栏开着"
   * （栏开没开看布局本身就知道）。而且 DSH 会话行的高亮是它自己的 CSS module 画的、
   * 类名编译期 hash，我们压根压不掉——只压我们这半边就成了两份名单各画各的。
   *
   * @param column - 这一行属于哪一栏。
   * @param isCurrentRow - 点的是不是那一栏此刻选中的那行。
   */
  pickRow(column: 'stream' | 'conversation', isCurrentRow: boolean): void {
    if (column === 'stream') {
      if (!this.#state.streamOpen) { this.revealStream(); return }
      if (!isCurrentRow || !this.#state.conversationOpen) return
      // 用户亲手收的，与手动同权：详情关掉时不再自动动对话列。
      this.#autoCollapsed = false
      writeStreamOpen(false)
      this.#set({ streamOpen: false })
      return
    }
    if (!this.#state.conversationOpen) { this.revealConversation(); return }
    if (!isCurrentRow || !this.#state.streamOpen) return
    this.#autoCollapsed = false
    this.#set({ conversationOpen: false })
  }
}
