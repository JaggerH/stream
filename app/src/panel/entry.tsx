/**
 * IIFE bundle 的入口：导出两个挂载点 + 各自的卸载，Vite lib 模式把它们挂到 `window.__streamPanel`。
 *
 * | 挂载点 | 画什么 |
 * |---|---|
 * | `mount(el, opts)` | 内容区（收件箱 / 影视 / 音乐 / 研究 …） |
 * | `mountNav(el, opts)` | 「空间 → 频道」树，含建 / 改名 / 删空间、建频道、折叠记忆 |
 *
 * **宿主只决定把这两块摆在哪**（8900 独立正门：左列导航 + 右列内容；DSH：侧栏里一段 + 主区）。
 * 两块之间的"当前频道"同步在 bundle 内部完成（模块级 `channelStore`），宿主不参与——以前那套
 * `onChannelNavState` / `setChannel` / `reloadChannels` 往返契约已经退役，每个宿主都得自己养
 * 一份镜像状态的日子随之结束。
 *
 * 两个 React root 各挂各的，**顺序无关**：先挂哪个都行，任一方没挂时另一方照常工作。
 * 与 DSH 那棵树共存也是**有意的隔离**：不共享 context、不共享 store，DSH 换版波及不到我们
 * 这半。代价是 bundle 里自带一份 React。
 */
import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import '../i18n/index.ts'   // 副作用 import：设好 react-i18next 的全局默认实例
import '../entry.css'        // Tailwind v4 + acrylic tokens，Vite 会把它单独出成 panel.css
import { applyBackend } from '../lib/api.ts'
import { setAskChatSink, type AskChatSink } from '../lib/askExtract.ts'
import { StreamPanel } from './StreamPanel.tsx'
import { NavTree, type NavFooter } from './nav/NavTree.tsx'
import { channelStore } from './nav/channel-store.ts'
import type { PanelItemContextState } from './itemRef.ts'
import { watchHostTheme } from './hostTheme.ts'

let root: Root | undefined
let navRoot: Root | undefined
let stopWatchingTheme: (() => void) | undefined

export type { PanelItemContextState, NavFooter }

/**
 * 把内容区挂进宿主给的容器。
 * @param el - 宿主容器（DSH 页面里我们自己 appendChild 的那个 div）。
 * @param opts.backend - Stream 后端的绝对地址，如 `http://127.0.0.1:8900`。
 */
export function mount(el: HTMLElement, opts: {
  backend: string
  manageWidth?: boolean
  /** 有它 = 宿主要「用户此刻手边有哪些内容」（对话输入框的 `@` 引用候选）：正在看的那条
   *  + 当前频道这一批，变化时整份推过去。见 itemRef.ts 头注。 */
  onItemContext?: (s: PanelItemContextState) => void
  /** 有它 = 宿主能替面板做「发进对话 / 塞进输入框」这三件事（转成文字、引用一条订阅、引用
   *  一条内容）。缺席时这三件事都说人话拒绝——没有对话的壳里根本没有输入框可塞，所以带
   *  对话的壳必须给。 */
  onAskChat?: AskChatSink
}): void {
  applyBackend(opts.backend, opts.backend.replace(/^http/, 'ws'))
  setAskChatSink(opts.onAskChat)
  // 跟着宿主当前的明暗态走——见 hostTheme.ts 头注。挂在 el 上：详情那第二个 IIFE
  // bundle 会把自己的 React root 挂在 el 的某个后代节点上，同样吃得到这个 .dark。
  stopWatchingTheme = watchHostTheme(el)
  root = createRoot(el)
  // 宽度由面板自己说了算，外壳不参与：`el` 就是外壳建的那个容器，改它的行内 width 会
  // 直接压过外壳设的 420px（同一条行内样式）。跨包契约因此是零——外壳不需要知道
  // "详情"这个概念，理由见 StreamPanel 的 onWidthChange 注释。
  // 例外是壳反转的主区（`manageWidth: false`）：容器宽度归壳的网格列管，面板再写就打架。
  root.render(
    <StrictMode>
      <StreamPanel
        onWidthChange={opts.manageWidth === false ? undefined : (width) => { el.style.width = width }}
        onItemContext={opts.onItemContext}
      />
    </StrictMode>
  )
}

/** 卸载内容区并交还容器。 */
export function unmount(): void {
  root?.unmount()
  root = undefined
  stopWatchingTheme?.()
  stopWatchingTheme = undefined
  // 通道指着壳里的那棵树，面板都没了还留着就是个悬空引用。
  setAskChatSink(undefined)
}

/**
 * 把「空间 → 频道」树挂进宿主给的容器。
 *
 * `applyBackend` 与 `mount` 是同一份、幂等：两个挂载点谁先来都得先把后端地址落定，
 * 因为**先来的那个就要开始取数了**（这里紧接着 `channelStore.load()`）。
 * @param el - 宿主容器（独立正门的左列 / DSH 侧栏里那一段）。
 */
export function mountNav(el: HTMLElement, opts: {
  backend: string
  /** 用户点了一行频道。isCurrentRow = 点的就是此刻高亮那条。DSH 壳用它做布局联动
   *  （pickRow：收起侧栏 / 让位）；独立正门不传。 */
  onPickChannel?: (isCurrentRow: boolean) => void
  /** 这一栏此刻收得起来吗（DSH：= 对话列开着）。只影响高亮行的提示文案。默认 false。 */
  collapsible?: boolean
  /** 树底下那条**宿主动作栏**：「管理」入口与明暗切换，各自给了才画，两格都不给就整条不出现
   *  （DSH 走的就是这一档，DOM 与没有这个能力时逐字相同）。见 NavTree.tsx 的 `NavFooter`。 */
  footer?: NavFooter
}): void {
  applyBackend(opts.backend, opts.backend.replace(/^http/, 'ws'))
  // **不挂 `watchHostTheme`**：导航的明暗全走 `--stream-nav-*` token，那组 token 自己就跟着
  // `body[data-ds-dark-theme]` 换（见 nav-styles.ts），不需要 `.dark` 这个类。更要紧的是那个
  // watcher 的停手函数会把 `document.body` 上的 `.dark` **摘掉**——那是全页共享的一份状态，
  // 两个 root 各挂一份的话，卸掉导航就会把还挂着的内容区那些 portal 浮层打回浅色档。
  navRoot = createRoot(el)
  navRoot.render(
    <StrictMode>
      <NavTree onPickChannel={opts.onPickChannel} collapsible={opts.collapsible} footer={opts.footer} />
    </StrictMode>
  )
  // 导航可能是**先挂的那个**（甚至是唯一挂着的那个）：名录得自己拉一次，不能指望内容区。
  void channelStore.load()
}

/** 卸载导航并交还容器。 */
export function unmountNav(): void {
  navRoot?.unmount()
  navRoot = undefined
}
