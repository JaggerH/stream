/**
 * 「空间 → 频道」树——面板的**第二个挂载点**（`mountNav`）画的那棵树。
 *
 * 它以前住在 DSH 宿主插件的壳里，于是别的宿主拿不到它，只能退回面板顶上那条横向 chip。
 * 数据、写操作、折叠记忆全是 Stream 自己的东西，所以整棵搬进面板；宿主只决定把它摆在哪
 * （8900 独立正门放左列，DSH 放侧栏的「新会话」下方）。见 spec 2026-09-06-shared-sidebar-nav。
 *
 * **结构与 DSH 工作区浏览器一一对应**——静态分区标题（Stream / 工作区）→ 可折叠的分组行
 * （空间 / 工作区）→ 叶子行（频道 / 会话）。与工作区行逐条对齐的三处交互（用户按肌肉记忆
 * 点这里）：
 * 1. 分区标题**不可折叠、也没有 hover 底色**——它是一行标签，不是控件；
 * 2. 分组行默认显示文件夹图标，hover 时换成折叠箭头；整行是折叠触发器；
 * 3. 行尾功能区（⋯ / ＋）平时不占视觉，hover 或自己的菜单开着时才露出来。
 *
 * 几何与 hover 那三条规则在 `nav-styles.ts`（CSS 表达得了、React 的 hover state 表达不好），
 * 这里只负责结构与状态。**浮层（菜单 / 弹窗）一律就地渲染、不 portal**，理由见 `NavDialogs.tsx`。
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import type React from 'react'
import { ChevronRight, Ellipsis, Folder, FolderOpen, Moon, Plus, Settings, Sun } from 'lucide-react'
import { api, LOCAL } from '../../lib/api.ts'
import { fetchSourceHealth, needsAttention } from '../../lib/api.source-health.ts'
import type { ChannelView } from '../../lib/types.ts'
import { EventsProvider, useEvents } from '../../components/EventsProvider.tsx'
import { NotificationBell } from '../../components/NotificationBell.tsx'
import { manageBridge, type ManageTarget } from '../manage-bridge.ts'
import { channelStore } from './channel-store.ts'
import { NavDialogs, type NavDialog } from './NavDialogs.tsx'
import { ensureNavStyles } from './nav-styles.ts'
import { spaceCollapse as sharedCollapse, type SpaceCollapseStore } from './space-collapse-store.ts'
import { orderChannels, panelSupportsChannel } from './support.ts'

/** 所有频道的默认落点。与后端 `DEFAULT_SPACE_ID`（`src/store/types.ts`）同一个字面量——
 *  前端 tsconfig 够不着后端那棵树，只能抄，所以改那边的时候记得搜这个名字。 */
const DEFAULT_SPACE_ID = 'default-space'

/** 频道行容器的 id 前缀：每个空间行的 `aria-controls` 指向它自己那一组的容器。 */
const CHANNEL_LIST_ID = 'stream-channel-list'
/** 拖频道时 dataTransfer 里的自定义类型——落点只认它，别的东西（文字、链接）拖过来不接。 */
const DRAG_TYPE = 'application/x-stream-channel'

/**
 * 树底下那一条**由宿主提供的动作**。两格都是可选的：**给了才画**。
 *
 * 为什么不由面板自己决定：这两件事都是**宿主态**——「管理」是宿主把管理面板摆在哪
 * （独立正门弹一层，DSH 有自己的设置窗），明暗是宿主自己的主题开关（DSH 跟着 DSH 走，
 * 独立正门自己维护 `data-ds-dark-theme`）。面板只画那颗按钮，按下去做什么归宿主。
 * 两格都不给 → 整条 footer 不出现，DOM 与没有这个能力时逐字相同（DSH 走的就是这一档）。
 */
export interface NavFooter {
  /** 「管理」入口。有它才画。带 target 时直接落到那一页（如某个源的修复页）。 */
  onManage?: (target?: ManageTarget) => void
  /** 明暗切换。有它才画；`isDark()` 读当前，`toggle()` 切换。 */
  theme?: { isDark: () => boolean; toggle: () => void }
}

export function NavTree({ onPickChannel, collapsible = false, collapse = sharedCollapse, footer }: {
  /** 用户点了一行频道（`isCurrentRow` = 点的就是此刻高亮那条）。宿主用它做布局联动
   *  （DSH：收起这一栏 / 让位）；独立正门不传。 */
  onPickChannel?: (isCurrentRow: boolean) => void
  /** 这一栏此刻收得起来吗（DSH：= 对话列开着）。只影响高亮行的提示文案——收不起来的时候
   *  别许诺一个按了没反应的手势。 */
  collapsible?: boolean
  /** 折叠态的 store。默认是模块级共享的那一份（挂载/卸载不重置用户折起来的组）；
   *  测试传一份 key 隔离的进来。 */
  collapse?: SpaceCollapseStore
  /** 树底下那条宿主动作栏。缺席 = 不画（见 `NavFooter`）。 */
  footer?: NavFooter
}): ReactElement | null {
  // 第一帧就得带着样式画出来，晚一帧就是一次可见的无样式闪烁。幂等，见 nav-styles.ts。
  ensureNavStyles()
  const state = useSyncExternalStore(channelStore.subscribe, channelStore.getSnapshot)
  const collapsedSpaces = useSyncExternalStore(collapse.subscribe, collapse.getSnapshot)
  const [dialog, setDialog] = useState<NavDialog | null>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [spaceMenu, setSpaceMenu] = useState<string | null>(null)
  const [busyError, setBusyError] = useState<string | null>(null)
  /** 正被拖着的频道悬在哪个空间上（高亮那一组）。null = 没在拖 / 不在任何组上。 */
  const [dragOver, setDragOver] = useState<string | null>(null)
  // 明暗态**不由我们持有**，每次渲染都现问宿主一次（`isDark()`）——宿主可能从别处切了主题。
  // 这颗 tick 只负责"按了之后重画一次"，它自己不是真相。
  const [, tick] = useState(0)
  const rootRef = useRef<HTMLElement>(null)

  // 点外面关菜单。"外面" = 不在菜单本身、也不在它那颗触发钮上（触发钮自己负责开合，
  // 这里再关一次就变成"点了没反应"）。**不是**"不在导航这棵树里"：侧栏里别的行、空白处
  // 都算外面——按那个判据，点一条频道菜单还挂着（活体 2026-09-06）。
  const menuOpen = addMenuOpen || spaceMenu !== null
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target
      if (t instanceof Element && t.closest('.stream-nav-menu, [aria-expanded]') !== null) return
      setAddMenuOpen(false)
      setSpaceMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [menuOpen])

  // 把宿主的开法登记进桥：内容区那棵树（频道配置的源行）要开修复页时只有这一条路可走。
  // 宿主没给「管理」就不登记——`manageBridge.available()` 因此如实回 false，调用方据此不画入口。
  useEffect(() => {
    if (footer?.onManage === undefined) return
    return manageBridge.register((t) => footer.onManage?.(t))
  }, [footer?.onManage])

  const theme = footer?.theme
  const dark = theme?.isDark() ?? false
  // 两格都没给就整条不画——DOM 与没有这个能力时逐字相同（DSH 就走这一档）。
  const footerNode = (footer?.onManage !== undefined || theme !== undefined) ? (
    <div className="stream-nav-footer">
      {footer?.onManage !== undefined ? (
        <>
          {/* 铃和 watcher 都住在这个分支里：**没有 footer 的宿主（DSH）一个字节都不多**——
              多起一条 WS、多拉一次 /api/source-health 都是它没要过的东西。 */}
          <EventsProvider>
            <NotificationBell
              onOpenSourceRepair={(sourceId) => footer.onManage?.({ view: 'source-health', sourceId })}
              // 这个铃挂在自己的独立 root 里，没有面板主 root 那个 AuthPanel 在订阅
              // dispatchLocal——auth.needed / transcribe.* 两条继续画成可点行就是点了没反应。
              legacyActions={false}
            />
            <AttentionWatcher />
          </EventsProvider>
          {/* 不写成 `onClick={footer.onManage}`：那样 MouseEvent 会被当成 target 传出去。 */}
          <button type="button" className="stream-nav-footer-button" onClick={() => footer.onManage?.()}>
            <Settings size={16} />
            <span>管理</span>
          </button>
        </>
      ) : null}
      {theme !== undefined ? (
        <button
          type="button"
          className="stream-nav-footer-button stream-nav-footer-icon"
          // 图标与文案说的都是**按下去会变成什么**，不是此刻是什么——按钮上画当前态，
          // 用户会读成"点它切到这个"，方向正好反了。
          aria-label={dark ? '切换到浅色' : '切换到深色'}
          title={dark ? '切换到浅色' : '切换到深色'}
          onClick={() => { theme.toggle(); tick((n) => n + 1) }}
        >
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      ) : null}
    </div>
  ) : null

  // 名录和空间都还没到货：画不出任何东西，也不占位——一条空骨架和"导航坏了"长得一样。
  // 但 footer 是宿主的动作栏，跟名录到没到货无关：它在就得一直够得着。
  if (state.channels.length === 0 && state.spaces.length === 0) {
    return footerNode === null ? null : (
      <nav ref={rootRef} className="stream-nav-root stream-nav-has-footer" aria-label="Stream 频道">
        <div className="stream-nav-scroll" />
        {footerNode}
      </nav>
    )
  }

  // 空间还没到货（或读失败）时退回**平铺**，不画分组——那时候画不出正确的分组，
  // 画一个假的「Default」会让人以为频道真的都在那儿。
  const grouped = state.spaces.length > 0
  const known = new Set(state.spaces.map((s) => s.id))
  const bucket = (spaceId: string): string =>
    // 归属指向一个我们还不知道的空间（名录和空间两趟取数之间的时间差），先挂在第一个空间
    // 下面——它下一次刷新就会归位。丢掉它才是真正的坏法：那个频道会从导航里整个消失。
    known.has(spaceId) ? spaceId : state.spaces[0]!.id
  const channels = orderChannels(state.channels)

  // ── 拖一条频道到另一个空间（收纳）。原生 HTML5 DnD，不引库：一种拖法、一种落点，
  //    库带来的只有多一份 20KB 和"两个 root 各一个 DnD 上下文"这类新坑。
  //    系统频道（`system`）不能拖：它们是各视图的固定入口，挪走等于把入口藏起来。
  //    落点是**整个分组**（标题行 + 列表），折起来的组也接得住，不用先展开再拖。
  const canDrag = (c: ChannelView): boolean => c.system !== true
  const dropChannel = async (channelId: string, spaceId: string): Promise<void> => {
    const c = state.channels.find((x) => x.id === channelId)
    if (c === undefined || !canDrag(c) || bucket(c.space_id) === spaceId) return
    try {
      await api.updateChannel(LOCAL, channelId, { space_id: spaceId })
      await channelStore.load()
      setBusyError(null)
    } catch (e) {
      setBusyError(`移动「${c.label}」失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const dropProps = (spaceId: string): {
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  } => ({
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (dragOver !== spaceId) setDragOver(spaceId)
    },
    onDragLeave: (e) => {
      // 从组内一个子元素挪到另一个子元素也会触发 leave——只有真离开这个组才清高亮。
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
      setDragOver((v) => (v === spaceId ? null : v))
    },
    onDrop: (e) => {
      const id = e.dataTransfer.getData(DRAG_TYPE)
      if (id === '') return
      e.preventDefault()
      setDragOver(null)
      void dropChannel(id, spaceId)
    },
  })

  const channelRow = (c: ChannelView): ReactElement => {
    const supported = panelSupportsChannel(c)
    const active = supported && c.id === state.active
    return (
      <button
        key={c.id}
        type="button"
        className={`stream-nav-chan-row${active ? ' stream-nav-selected' : ''}`}
        disabled={!supported}
        aria-current={active ? 'true' : undefined}
        draggable={canDrag(c)}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, c.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={() => { setDragOver(null) }}
        title={
          supported
            ? (active && collapsible ? `${c.label}（再点一次收起这一栏）` : c.label)
            : `${c.label}：这类频道要另一套视图，面板暂不支持`
        }
        // 点频道 = 要看内容：主区收着就先放回来；点的是已高亮那条则由宿主决定收不收
        // （DSH 的 pickRow）。setActive 只在真换频道时有效果——收起这一栏不该顺手把面板滚回顶。
        onClick={() => {
          if (!supported) return
          onPickChannel?.(active)
          if (!active) channelStore.setActive(c.id)
        }}
      >
        {/* 会话行同款的 16px 前导槽——频道文字因此和上面分组行的文字对齐成一层缩进。 */}
        <span className="stream-nav-slot" />
        <span className="stream-nav-title">{c.label}</span>
        {state.attention.has(c.id) ? <span className="stream-nav-attention" aria-label="有修复等你拍板" title="有修复等你拍板" /> : null}
        {supported ? null : <span style={{ flex: 'none', opacity: 0.7, fontSize: 11 }}>·暂不支持</span>}
      </button>
    )
  }

  const spaceRow = (space: { id: string; label: string }, listId: string, open: boolean, hasActive: boolean): ReactElement => {
    const open_ = spaceMenu === space.id
    const toggle = (): void => { collapse.toggle(space.id) }
    return (
      <div
        className={`stream-nav-space-row${open_ ? ' stream-nav-menu-open' : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={listId}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          toggle()
        }}
      >
        {/* 两个槽都在树里，谁显示由 CSS 的 :hover 决定——用 JS 的 hover state 换会在快速
            划过时漏掉 mouseleave，留下一行永远显示箭头的分组。 */}
        <span className={`stream-nav-slot stream-nav-folder${open && hasActive ? ' stream-nav-folder-active' : ''}`}>
          {open ? <FolderOpen size={16} /> : <Folder size={16} />}
        </span>
        <span className="stream-nav-slot stream-nav-chevron">
          <ChevronRight size={14} className={`stream-nav-arrow${open ? ' stream-nav-arrow-open' : ''}`} />
        </span>
        <span className="stream-nav-space-text"><span className="stream-nav-title">{space.label}</span></span>
        {/* 功能区里的每个钮都要 stopPropagation：外面整行是折叠触发器，不拦就是"点新建
            顺手把这一组折起来了"。 */}
        <span className="stream-nav-row-actions" onClick={(e) => { e.stopPropagation() }}>
          <button
            type="button"
            className="stream-nav-icon-button"
            aria-label={`${space.label} 的操作`}
            aria-expanded={open_}
            onClick={() => { setSpaceMenu((v) => (v === space.id ? null : space.id)) }}
          >
            <Ellipsis size={16} />
          </button>
          <button
            type="button"
            className="stream-nav-icon-button"
            aria-label={`在 ${space.label} 里新建频道`}
            onClick={() => { setDialog({ kind: 'new-channel', spaceId: space.id }) }}
          >
            <Plus size={16} />
          </button>
          {open_ ? (
            <div className="stream-nav-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => { setSpaceMenu(null); setDialog({ kind: 'rename-space', space }) }}
              >
                重命名
              </button>
              {/* 默认空间不可删（后端也拦）：它是所有频道的兜底落点。 */}
              <button
                type="button"
                role="menuitem"
                className="stream-nav-danger"
                disabled={space.id === DEFAULT_SPACE_ID}
                onClick={() => { setSpaceMenu(null); setDialog({ kind: 'delete-space', space }) }}
              >
                删除空间
              </button>
            </div>
          ) : null}
        </span>
      </div>
    )
  }

  const tree = (
    <>
      {/* 分区标题：一行标签 + 右侧功能区，和 DSH 的「工作区」那行同款。不可折叠、无 hover 底色。 */}
      <div className="stream-nav-sec-header">
        <span className="stream-nav-sec-label">Stream</span>
        <div className="stream-nav-sec-actions">
          <button
            type="button"
            className="stream-nav-sec-icon"
            aria-label="新建"
            aria-expanded={addMenuOpen}
            // 提示走原生 `title`：面板不依赖任何宿主的组件库，自己再画一颗气泡不值当。
            title="新建"
            onClick={() => { setAddMenuOpen((v) => !v) }}
          >
            <Plus size={16} />
          </button>
          {addMenuOpen ? (
            <div className="stream-nav-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); setDialog({ kind: 'new-channel' }) }}>
                新建频道
              </button>
              <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); setDialog({ kind: 'new-space' }) }}>
                新建空间
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {grouped ? state.spaces.map((space) => {
        const listId = `${CHANNEL_LIST_ID}-${space.id}`
        const open = !collapsedSpaces.has(space.id)
        const rows = channels.filter((c) => bucket(c.space_id) === space.id)
        return (
          <div
            key={space.id}
            className={`stream-nav-group${dragOver === space.id ? ' stream-nav-drop-target' : ''}`}
            data-testid={`stream-nav-group-${space.id}`}
            {...dropProps(space.id)}
          >
            {spaceRow(space, listId, open, rows.some((c) => panelSupportsChannel(c) && c.id === state.active))}
            {/* 容器常在（`aria-controls` 得有个指得着的元素），折叠时里面的行**不渲染**——
                它们都是 button，留在树里会把 Tab 焦点送进一堆看不见的控件。 */}
            <div id={listId}>
              {open ? (
                rows.length > 0
                  ? rows.map((c) => channelRow(c))
                  : <div className="stream-nav-empty">还没有频道</div>
              ) : null}
            </div>
          </div>
        )
      }) : channels.map((c) => channelRow(c))}
      {busyError !== null ? <div role="alert" className="stream-nav-error">{busyError}</div> : null}
    </>
  )

  const dialogs = dialog !== null ? (
    <NavDialogs
      dialog={dialog}
      spaces={state.spaces}
      onClose={() => { setDialog(null) }}
      onError={setBusyError}
    />
  ) : null

  // 没有 footer 时**一个包裹层都不加**：DSH 侧栏走的就是这一档，多一层 div 就够改动几何了。
  if (footerNode === null) {
    return (
      <nav ref={rootRef} className="stream-nav-root" aria-label="Stream 频道">
        {tree}
        {dialogs}
      </nav>
    )
  }
  // 有 footer：根变成竖排的 flex，树自己滚，footer 钉在底下。
  return (
    <nav ref={rootRef} className="stream-nav-root stream-nav-has-footer" aria-label="Stream 频道">
      <div className="stream-nav-scroll">{tree}</div>
      {footerNode}
      {dialogs}
    </nav>
  )
}

/**
 * 「哪些频道要亮红」的算法只有这一处：拉 `/api/source-health`，取 status 为 awaiting 的源，
 * 用后端给的 affectedChannels 直接落进 channelStore.attention。WS 上任何 intervention.* 事件 → 重拉。
 */
function AttentionWatcher(): null {
  const { subscribe } = useEvents()
  useEffect(() => {
    let alive = true
    // 多帧 intervention.* 快速到达会并发发起多次 fetch；网络到达顺序不保证跟发起顺序一样，
    // 慢的旧请求晚回来会把新请求的结果盖掉。只认「此刻最新发起的那一次」的响应。
    let seq = 0
    const refresh = (): void => {
      const mine = ++seq
      fetchSourceHealth(LOCAL.baseUrl).then((d) => {
        if (!alive || mine !== seq) return
        const ids = new Set<string>()
        for (const v of d.sources) if (needsAttention(v.status)) for (const c of v.affectedChannels) ids.add(c.id)
        channelStore.setAttention(ids)
      }).catch(() => { /* 读不到就保留上一份：一次网络抖动不该把红点闪没 */ })
    }
    refresh()
    const off = subscribe((m: { type?: string; event?: { type?: string } }) => {
      if (m?.type === 'event' && typeof m.event?.type === 'string' && m.event.type.startsWith('intervention.')) refresh()
    })
    return () => { alive = false; off() }
  }, [subscribe])
  return null
}
