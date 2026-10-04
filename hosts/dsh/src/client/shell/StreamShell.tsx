/**
 * 壳反转的整页布局：Stream 是主面，DSH 的对话是可召唤的侧面。
 *
 * 注册进 DSH 的 `root` 单槽（profile 已关掉 ui-layout 那行，所以这里是唯一的 root 条目）。
 * 声明即渲染权，子槽 kind/scope 必须与原声明逐字一致（消费方按契约注册），别改。
 *
 * **0.2.0 换了两格槽名**（ui-layout 把 root 的四个子槽重划成了五个）：
 *
 * | 0.1.2 | 0.2.0 | 为什么 |
 * |---|---|---|
 * | `conversation`（single/session-maybe） | `main`（`kind: 'keyed'`、root），会话取保留键
 *   `conversation` | 中央区从"一个对话位"变成"可切换的主面板列"，对话成了其中一格的保留 key |
 * | `details`（single/**session**） | `rightbar`（single/**root**） | 会话绑定挪进了占位者内部
 *   （它自己声明 `rightbar.session`）；框架这一层不再替它铸 scope |
 * | — | `shell.leading` | 新增（macOS 整栏收起时的窗口控制位）。我们不做那个形态，不声明它 |
 *
 * 于是**这里不再需要 `SessionProvider`**：`main` / `rightbar` 都是 root 作用域的槽，
 * 拿到的渲染件 props 里根本没有那一格（0.1.2 的 `details` 是 strict session 槽，不裹框架
 * 发下来的 `SessionProvider` 就会抛「rendered without a scope binding」把整页卸成空白——
 * 那条教训现在归 `rightbar` 的占位者自己去满足）。**别把裹壳当"保险"加回来**：`main` 上
 * 没有这个 prop，加了是编译错误。
 *
 * **侧栏也是我们的壳件**——不复用 ui-sidebar 的 SidebarRoot（它在"新会话下方"没有留缝，
 * 塞进去只能 DOM 手术）。它本来就只是"品牌行 + 新会话 + 若干 renderSlot"的组合壳：我们的
 * root 直接声明它那几个内缝（`sidebar.workspaces` / `sidebar.settings` /
 * `sidebar.footer.action`），DSH 的工作区浏览器、设置、脚下动作照标准插槽落进**我们的**
 * 侧栏，「Stream」分区放在新会话下方、工作区上方。ui-sidebar 插件照常装载，但它注册的
 * 目标槽 `sidebar` 永远无人声明——`slots.inject` 等声明等不到，安静休眠，无冲突。
 * （新会话的行为与它逐字同源：`ctx.workspaces.startSession()`。）
 *
 * **`sidebar.panellist` 我们没声明、也没渲染**（0.2.0 新增的"全局面板"导航行）。代价写明：
 * 注册进去的行（ui-schedule / ui-plugin-manager 各一行）落进一个没人声明的槽 → 安静休眠，
 * 于是**那两张全局面板在侧栏里没有入口**。它们各自的其它入口都还在：ui-schedule 在会话头
 * 的 `conversation.session.header.utilities` 有一枚按钮（那条缝归 ui-conversation 渲染，
 * 不经过我们），插件管理在设置的 `settings.plugins.tab`（归
 * `dsh-client-ui-settings-plugin-inventory`）。哪天要补这一行，得连 `main` 的选中态一起做
 * （`ActivePanel` 那一格已经就位，缺的只是那排图标）。
 *
 * 列布局：侧栏（280 / 收起 56）| 主区（Stream 内容，或选中的全局面板）| 对话列（默认开，
 * 480px）| 工具详情列（右列，由占位者经 `ctx.layout.openRightbar` 报告要不要占轨道）。
 * 几何状态住 ShellLayoutController。
 *
 * **主区里点开一条详情时对话列自动让位**（详情自己就是「媒体 + 简介/评论 480」两栏，
 * 再并排一列 480 的对话，窄屏上三块谁都看不清）；关掉详情它自己回来。要边看边聊就点
 * 右上角那颗开关把它叫回来——那一下之后这一轮详情不再自动动它。联动的信号见下面
 * StreamMain 的第一个 effect，规则与归位判据在 layout-service 的 setContentDetail。
 */
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
// 类型 only：SlotMap 里 `main` / `rightbar` / `shell.overlay` 的合并声明。
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  BrandWordmark,
  FishLogo,
  IconNewChatOutlineMedium,
  IconNewChatOutlineRegular,
  IconPanelLeftOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { mountNavInto, mountPanelInto } from '../panel/host.ts'
import type { AskChatOp } from '../compose-into-conversation.ts'
import { itemContext } from '../panel/item-context-store.ts'
import { BACKEND_MISSING_MESSAGE } from '../backend.ts'
import type { ShellLayoutController } from './layout-service.ts'

/** 展开态侧栏宽度（对齐 DSH 原壳的默认档）。 */
const SIDEBAR_WIDE = 280
/** 收起态图标条宽度（ui-sidebar 的 rail 同一个数，落进来的插槽件按它排版）。 */
const SIDEBAR_RAIL = 56
/** 对话列宽度。 */
const CONVERSATION_WIDTH = 480
/** 工具详情列（右列）宽度。 */
const DETAILS_WIDTH = 340
/** 中央区留给自己/全局面板的最小宽度——`canShow` 的判据之一（照 ILayout 那份契约的说法：
 *  "在 400px 的中央区旁边还留得住 300px 右列"）。 */
const MAIN_MIN_WIDTH = 400

type ShellProps = PropsRenderSlots<
  'sidebar.workspaces' | 'sidebar.settings' | 'sidebar.footer.action' | 'main' | 'rightbar' | 'shell.overlay'
>

/**
 * 挂 Stream 内容流的主区：容器交给 panel bundle 自渲染（资产装载见 host.ts）。
 *
 * `backend` 为 `undefined` = 后端地址没下发：面板的资产（`panel.js` / `panel.css`）没有
 * 可取的地址，这时**画一句人话**而不是留一块空白——空白和"后端挂了"、"面板崩了"长得
 * 一模一样，而这三种的下一步动作完全不同。
 */
function StreamMain({ backend, controller, askChat }: { backend: string | undefined; controller: ShellLayoutController; askChat: (op: AskChatOp) => Promise<void> }): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string>()
  // 主区被全屏内容占满 → 对话列让位/归位。订阅挂在**面板挂载的这条生命周期上**（面板不在时
  // 这条联动无从谈起），信号取 itemContext 的 `fullscreen`——那块覆盖层住在 panel bundle 那棵
  // React 树里（详情和影视各自还是独立 bundle），壳没有第二条路知道它开没开。
  //
  // **读 `fullscreen`，不是 `open !== null`**：影视频道全屏看片时主区一样被占满，但那不是一条
  // item，`open` 恒为 null——照 `open` 推的症状是看片时对话列还杵在那儿，且没有一处会报错。
  // 判据在面板那一侧算一次（`StreamPanel` 把详情和看片两档合成这一格），壳只转发。
  useEffect(() => {
    const push = (): void => { controller.setContentDetail(itemContext.get().fullscreen === true) }
    const stop = itemContext.subscribe(push)
    push()
    return () => {
      stop()
      // 壳走了就别把"主区被占着"这个状态留在 controller 里——下一次挂载会从它开始算边沿。
      controller.setContentDetail(false)
    }
  }, [controller])
  useEffect(() => {
    const el = hostRef.current
    if (el === null || backend === undefined) return
    let disposed = false
    let handle: { unmount: () => void } | undefined
    // 发进对话之前先把对话列露出来：这一句多半是详情里点「转成文字」发的，而详情正把
    // 对话列收着——不露出来就是"发出去了但用户看不见"。露出来归壳管（几何是壳的事），
    // 所以包在这一层而不是让 apply() 那个回调自己去动 controller。
    // 引用（compose / ref-item）同样要露出来：塞进了输入框而用户看不见输入框，
    // 表现和"什么都没发生"一模一样。
    const ask = async (op: AskChatOp): Promise<void> => {
      controller.revealConversation()
      await askChat(op)
    }
    void mountPanelInto(el, backend, ask)
      .then((h) => {
        // effect 已经清理过（StrictMode 双跑、或壳被卸载）就立刻回滚这次挂载，别留孤儿 root。
        if (disposed) h.unmount()
        else handle = h
      })
      .catch((e: unknown) => { if (!disposed) setError(e instanceof Error ? e.message : String(e)) })
    return () => {
      disposed = true
      handle?.unmount()
      handle = undefined
    }
    // askChat 不进依赖：它是 apply() 里闭包出来的稳定函数，进了依赖只会在它换引用时
    // 把整块面板拆了重挂（重挂 = 重新拉一遍列表、丢掉滚动位置）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend])
  if (backend === undefined) {
    return (
      <div
        data-stream-backend-missing
        style={{ padding: 24, maxWidth: 560, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary, inherit)' }}
      >
        {BACKEND_MISSING_MESSAGE}
      </div>
    )
  }
  return (
    <div style={{ position: 'relative', height: '100%', minWidth: 0, overflow: 'hidden' }}>
      {error !== undefined && (
        <div style={{ padding: 16, color: 'var(--dsw-alias-state-error-primary, #d33)', fontSize: 13 }}>
          Stream 面板没起来：{error}
        </div>
      )}
      <div ref={hostRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} />
    </div>
  )
}

/**
 * 侧栏里「Stream」那一段的配色对账表：面板那组 `--stream-nav-*` token → DSH 自己的变量。
 *
 * 面板给每个 token 都带了默认值（数值抄自 DSH 主题包，见它的 `nav-styles.ts`），所以**漏一格
 * 不会报错、也不会降级**——那一格静默停在一个固定颜色上，跟着宿主换肤时就差那么一点，
 * 只能靠肉眼比色发现。`test/nav-token-overrides.test.ts` 拿面板那份 `:root` 段当名单对着账：
 * 面板加一格，这里当场变红。
 *
 * 覆盖写在**挂载容器**上而不是导航根上：面板的默认值定义在 `:root`，写在导航根上的声明会
 * 压过祖先继承来的值，那样这份覆盖就静默失效了（见 `nav-styles.ts` 头注）。
 *
 * `--stream-nav-inline-padding` 指向 `--dsh-sidebar-inline-padding`：导航的左右内边距要和
 * 落进同一条侧栏的 DSH 插槽件（工作区浏览器等）对齐，那个变量正是侧栏自己在下面设的那份。
 */
export const NAV_TOKEN_OVERRIDES: Record<string, string> = {
  '--stream-nav-label-primary': 'var(--dsw-alias-label-primary)',
  '--stream-nav-label-secondary': 'var(--dsw-alias-label-secondary)',
  '--stream-nav-label-tertiary': 'var(--dsw-alias-label-tertiary)',
  '--stream-nav-label-caption': 'var(--dsw-alias-label-caption)',
  '--stream-nav-hover-bg': 'var(--dsw-alias-interactive-bg-hover)',
  // 选中态和 hover 在 DSH 侧栏里本来就是同一个底色（工作区那几行同款）。
  '--stream-nav-active-bg': 'var(--dsw-alias-interactive-bg-hover)',
  '--stream-nav-border': 'var(--dsw-alias-border-l1)',
  '--stream-nav-accent': 'var(--dsw-alias-state-business-primary)',
  '--stream-nav-error': 'var(--dsw-alias-state-error-primary)',
  // 浮层（⋯ 菜单、几张弹窗）的卡片底色：DSH 弹层同款的那一层。
  '--stream-nav-surface': 'var(--dsw-alias-bg-layer-1)',
  '--stream-nav-inline-padding': 'var(--dsh-sidebar-inline-padding)',
  '--stream-nav-ease': 'var(--ds-ease-in-out)',
}

/**
 * 侧栏里的「Stream」分区：一个容器 + 面板 bundle 的 `mountNav`。
 *
 * 树本身（空间/频道两层、建删改名、折叠记忆、"这个频道面板画得了吗"的判据）**整棵归面板**，
 * 8900 那扇独立正门挂的是同一份。壳这边只剩三件事：摆在哪、配色指到自己的变量、把"用户点了
 * 一行频道"接到 `controller.pickRow` 上（收起这一栏 / 让位是壳的几何，面板不该知道）。
 *
 * `collapsible` 进依赖 = 对话列每开合一次就把这棵树拆了重挂。这是**有意的**：mountNav 的
 * opts 只在挂载那一刻读一次，不重挂就是高亮行的提示文案永远停在挂载时那一档（"再点一次
 * 收起这一栏"许诺一个按了没反应的手势）。重挂的代价是重拉一次名录 + 导航自己的滚动位置回顶；
 * 空间的折叠状态住 localStorage，不会跟着丢。
 */
function StreamNav({ backend, controller, collapsible }: {
  /** Stream 后端地址；没有 = 面板资产没有可取的地址，这一段整个不画（主区会说那句人话）。 */
  backend: string | undefined
  controller: ShellLayoutController
  /** 这一栏此刻收得起来吗（= 对话列开着）。 */
  collapsible: boolean
}): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string>()
  useEffect(() => {
    const el = hostRef.current
    if (el === null || backend === undefined) return
    let disposed = false
    let handle: { unmount: () => void } | undefined
    setError(undefined)
    void mountNavInto(el, backend, {
      onPickChannel: (isCurrentRow) => { controller.pickRow('stream', isCurrentRow) },
      collapsible,
    })
      .then((h) => {
        // effect 已经清理过（StrictMode 双跑、或壳被卸载）就立刻回滚这次挂载，别留孤儿 root。
        if (disposed) h.unmount()
        else handle = h
      })
      .catch((e: unknown) => { if (!disposed) setError(e instanceof Error ? e.message : String(e)) })
    return () => {
      disposed = true
      handle?.unmount()
      handle = undefined
    }
  }, [backend, collapsible, controller])
  if (backend === undefined) return null
  return (
    // 高度封顶 40%：它下面还有工作区浏览器，频道多的时候不能把那半挤没（与改造前同一个数）。
    <div style={{ flex: 'none', maxHeight: '40%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {error !== undefined && (
        <div role="alert" style={{ padding: '4px 8px', fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #d33)' }}>{error}</div>
      )}
      {/* 横向负 margin 把这一段推到列边，导航自己那份 `--stream-nav-inline-padding`（= 侧栏
          同一个变量）再把内容推回来——净效果与改造前逐像素相同，而行高亮能顶到列边。
          `display:flex` + `minHeight:0`：导航根是这里的 flex 子元素，被封顶之后它自己那条
          `overflow-y:auto` 才有意义；否则它按内容撑高，滚动条永远不出现、超出的部分被裁掉。 */}
      <div
        ref={hostRef}
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          marginInline: 'calc(-1 * var(--dsh-sidebar-inline-padding))',
          ...NAV_TOKEN_OVERRIDES,
        } as CSSProperties}
      />
    </div>
  )
}

/** 图标按钮的公共样式（品牌行的折叠钮、rail 态的新会话）。 */
const ICON_BUTTON_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 36,
  height: 36,
  padding: 0,
  border: 'none',
  borderRadius: 10,
  cursor: 'pointer',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, inherit)',
}

/** 建 StreamShell 组件（controller/backend/startSession/askChat 在 apply() 里闭包进来）。 */
export function makeStreamShell(
  controller: ShellLayoutController,
  backend: string | undefined,
  startSession: () => void,
  /** 面板里的「转成文字」落点：开一条对话把这句发进去（见 client/ask-conversation.ts）。 */
  askChat: (op: AskChatOp) => Promise<void>,
) {
  return function StreamShell({ renderSlot }: ShellProps): ReactNode {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const wide = !state.sidebarCollapsed
    const sidebarWidth = wide ? SIDEBAR_WIDE : SIDEBAR_RAIL
    const streamOpen = state.streamOpen
    // 专注对话态（streamOpen=false）：主区列归 0（面板保持挂载），对话列从固定宽变成吃满。
    // controller 保证两列不会同时为 0（见 toggleStream / toggleConversation）。
    const mainCol = streamOpen ? 'minmax(0, 1fr)' : '0px'
    const convCol = state.conversationOpen ? (streamOpen ? `${CONVERSATION_WIDTH}px` : 'minmax(0, 1fr)') : '0px'
    const convVisible = state.conversationOpen
    // 右列的宽度来自**占位者自报的那一格**（openRightbar 的 track），不是我们自己开关的。
    const rightbarTrack = state.rightbarTrack
    const rightbarCol = rightbarTrack ? `${DETAILS_WIDTH}px` : '0px'
    // 帧宽：占位者拿它判"是不是窄到该自动全屏"（<768px），以及够不够放下右列。
    // 量的是这个网格容器而不是 window——侧栏收起来时两者差一节，而占位者问的是帧宽。
    const frameRef = useRef<HTMLDivElement>(null)
    const [viewport, setViewport] = useState<number>(() => (typeof window === 'undefined' ? 0 : window.innerWidth))
    useEffect(() => {
      const el = frameRef.current
      if (el === null) return
      // jsdom（单测）里没有 ResizeObserver。帧宽这一格只喂给右列占位者判"窄到该自动全屏"，
      // 量不到就退回渲染时那个 window.innerWidth——**不要为了测试环境把整页挂掉**。
      if (typeof ResizeObserver === 'undefined') return
      const observer = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width
        if (typeof width === 'number' && width > 0) setViewport(width)
      })
      observer.observe(el)
      return () => { observer.disconnect() }
    }, [])
    // 放下右列之后中央区还剩不剩得下 MAIN_MIN_WIDTH——照 ILayout 那份契约的原话
    // （"在 400px 的中央区旁边还留得住 300px 右列"）。判 false 时占位者会自己收起来，
    // 所以这个值宁可算得诚实：它决定"窄屏上右列根本展不开"，算宽了就是一块挤没的中央区。
    const rightbarCanShow = viewport - sidebarWidth - (convVisible ? CONVERSATION_WIDTH : 0) >= MAIN_MIN_WIDTH + DETAILS_WIDTH
    // 中央区那一格：`panelId === null` 是我们的 Stream 主区，否则是选中的全局面板
    // （keyed `main`，全局面板各自注册一个 key）。会话用的是保留 key `conversation`——
    // 它不在中央，而在右边那一列（这就是反转壳的形状）。
    const activePanel = state.panelId
    return (
      <div
        ref={frameRef}
        style={{
          display: 'grid',
          gridTemplateColumns: `${sidebarWidth}px ${mainCol} ${convCol} ${rightbarCol}`,
          gridTemplateRows: '100%',
          height: '100%',
          position: 'relative',
          overflow: 'hidden',
          background: 'var(--dsw-alias-bg-base)',
        }}
        data-sidebar-collapsed={state.sidebarCollapsed || undefined}
        data-rightbar-collapsed={!rightbarTrack || undefined}
        data-rightbar-fullscreen={state.rightbarFullscreen || undefined}
      >
        {/* ── 侧栏（我们的壳件；结构对齐 DSH 原壳：品牌行 → 新会话 → [Stream 分区] → 工作区 → 脚）。
            列级基准（字号/内边距/滚动条变量）**逐字对齐原壳 `.root`**：落进来的插槽件
            （工作区浏览器等）的字号是 em 继承、横向对齐吃 `--dsh-sidebar-inline-padding`，
            这层不给就是"字大一号 + 贴边"的怪版式。 */}
        <div
          style={{
            minWidth: 0,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            boxSizing: 'border-box',
            padding: wide ? '6px var(--dsh-sidebar-inline-padding)' : '18px 10px 6px',
            fontSize: 14,
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-specific-sidebar-fill)',
            borderRight: '1px solid var(--dsw-alias-border-l1)',
            ['--dsh-sidebar-inline-padding' as never]: '12px',
            ['--dsh-scrollbar-thumb' as never]: 'var(--dsw-alias-scrollbar-bg-l2)',
            ['--dsh-scrollbar-thumb-hover' as never]: 'var(--dsw-alias-scrollbar-hover-l2)',
          }}
        >
          <div style={wide
            ? { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, height: 60, marginBottom: 8, padding: '8px 0 8px 4px', overflow: 'hidden', flex: 'none' }
            : { display: 'flex', alignItems: 'center', justifyContent: 'flex-start', height: 36, marginBottom: 12, padding: 0, flex: 'none' }}
          >
            {wide && (
              <button type="button" aria-label="新建会话" onClick={startSession} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 0, flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', overflow: 'hidden' }}>
                <BrandWordmark />
              </button>
            )}
            <Tooltip label={wide ? '收起侧边栏' : '打开侧边栏'} delayMs={500}>
              <button type="button" aria-label={wide ? '收起侧边栏' : '打开侧边栏'} onClick={() => controller.toggleSidebar()} style={{ ...ICON_BUTTON_STYLE, width: wide ? 28 : 36, height: wide ? 28 : 36, borderRadius: '50%', color: wide ? 'var(--dsw-alias-label-secondary, inherit)' : 'var(--dsw-alias-label-primary, inherit)' }}>
                {!wide && <FishLogo size={24} />}
                <IconPanelLeftOutlineRegular size={wide ? 16 : 18} />
              </button>
            </Tooltip>
          </div>
          <Tooltip label="新建会话" delayMs={500} disabled={wide}>
            <button
              type="button"
              aria-label="新建会话"
              onClick={startSession}
              style={wide
                ? { boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: 38, margin: '0 2px 8px', padding: '8px 16px', fontSize: 14, fontWeight: 500, lineHeight: '22px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, cursor: 'pointer', background: 'var(--dsw-alias-button-elevated-fill)', color: 'var(--dsw-alias-label-primary)', flex: 'none', overflow: 'hidden' }
                : { ...ICON_BUTTON_STYLE, alignSelf: 'flex-start', margin: '0 0 12px' }}
            >
              {/* 两档用**两个**图标件（和 ui-sidebar 原壳逐字同款）：0.2.0 起图标按笔画粗细
                  分了 Regular(1px) / Medium(1.3px)，展开态 14px 那一档必须用 Medium——拿
                  Regular 顶上去的表现是这颗图标比旁边几个横竖都细一圈，肉眼才发现。 */}
              {wide ? <IconNewChatOutlineMedium size={14} /> : <IconNewChatOutlineRegular size={18} />}
              {wide && <span style={{ whiteSpace: 'nowrap', overflow: 'hidden' }}>新会话</span>}
            </button>
          </Tooltip>
          {/* Stream 分区：新会话下方、工作区上方。rail 态没有它的位置（文字行装不进 56px）。
              注意这里的 `wide` 和**空间自己**的折叠是两个状态：这一行管"整条侧栏收窄时它在
              不在"，空间折叠管"它在的时候那一组频道展不展开"，两者互不重置——后者住面板那侧
              的 localStorage，收窄再展开不会把用户折起来的那几个空间弹回展开态。 */}
          {wide && <StreamNav backend={backend} controller={controller} collapsible={convVisible} />}
          {/* regionArea 的负 margin 对齐原壳：列表自己的行高亮要顶到列边，滚动条贴右缘。 */}
          <div style={wide
            ? { minHeight: 0, flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', marginLeft: -4, marginRight: 'calc(-1 * var(--dsh-sidebar-inline-padding))', paddingLeft: 4 }
            : { minHeight: 0, flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
          >
            {renderSlot('sidebar.workspaces', {
              wide,
              expandSidebar: () => { if (!wide) controller.toggleSidebar() },
            })}
          </div>
          <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', alignItems: wide ? 'stretch' : 'center' }}>
            <div style={{ flex: 'none', minWidth: 0, display: 'flex', justifyContent: wide ? 'flex-start' : 'center' }}>{renderSlot('sidebar.footer.action', { wide })}</div>
            <div>{renderSlot('sidebar.settings', { wide })}</div>
          </div>
        </div>
        {/* ── 中央区：我们的 Stream 主区，或选中的全局面板（keyed `main` 的另一个 key）。 */}
        <div style={{ minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {activePanel === null
            ? <StreamMain backend={backend} controller={controller} askChat={askChat} />
            : renderSlot('main', {}, { entryKey: activePanel })}
        </div>
        {/* 对话列收起时宽度归 0 但**不卸载**——ConversationRoot 的会话内状态（草稿等）跟着组件走。
            它取的是 keyed `main` 的保留键 `conversation`（0.1.2 那个独立的 `conversation` 槽）。 */}
        <div style={{ minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', borderLeft: convVisible && streamOpen ? '1px solid var(--dsw-alias-border-l1)' : 'none' }}>
          {renderSlot('main', {}, { entryKey: 'conversation' })}
        </div>
        {/* 右列：**常挂载**，宽度由占位者自报的 `track` 决定。0.2.0 的 `openRightbar` 是"报告"
            不是"命令"——不挂载它就没机会报，列也就永远开不出来（0.1.2 那份是我们替它开的）。
            不设 `overflow`：占位者按契约贴着列的右缘定位、没轨道时允许探到中央区上。 */}
        <div
          style={{ minWidth: 0, borderLeft: rightbarTrack ? '1px solid var(--dsw-alias-border-l2)' : 'none' }}
        >
          {renderSlot('rightbar', {
            // 宽度给**我们的偏好值**而不是当前实际轨道宽：占位者用它做测量，
            // 第一拍（它还没报 track、轨道还是 0）给 0 会让它按 0 排版一次。
            width: DETAILS_WIDTH,
            viewportWidth: viewport,
            canShow: rightbarCanShow,
          })}
        </div>
        {/* 浮层：全帧、点击穿透，条目自己开 pointer-events（与 ui-layout 的 overlayLayer 同契约）。 */}
        <div style={{ position: 'absolute', inset: 0, zIndex: 20, pointerEvents: 'none' }} data-shell-overlay>
          {renderSlot('shell.overlay', {})}
        </div>
      </div>
    )
  }
}
