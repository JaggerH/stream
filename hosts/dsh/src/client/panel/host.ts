/**
 * 面板资产装载：把 Stream 打出来的 panel bundle（脚本 + 样式表）装进页面，挂进
 * 调用方给的容器。
 *
 * bundle 有**两个挂载点**，壳把它们摆在两处：内容区（`mountPanelInto` → 主区）与
 * 「空间 → 频道」导航树（`mountNavInto` → 侧栏那一段）。两块之间的"当前频道"同步在
 * bundle 内部完成，壳**不是**中间的转发点——以前那套 `onChannelNavState` / `setChannel` /
 * `reloadChannels` 往返契约（连同壳自己养的那份镜像状态）已经退役，别重新引入。
 *
 * 两个挂载点各自是 bundle 里的一个模块级 React root，所以**同一时刻各只能有一处挂载**：
 * 内容区别造第二条挂载路（fixed 浮层、抽屉之类），表现是"页面上叠出两份时间线"。
 *
 * 装载那一层（跨源 script、样式表生命周期、失败清理）在 `asset-loader.ts` 里，与设置里那份
 * 运维页（`manage-host.ts`）共用同一份实现。
 */
import { createAssetLoader } from './asset-loader.ts'
import { itemContext, type PanelItemContextState } from './item-context-store.ts'
import type { AskChatOp } from '../compose-into-conversation.ts'

interface PanelBundle {
  mount: (el: HTMLElement, opts: {
    backend: string
    manageWidth?: boolean
    onItemContext?: (s: PanelItemContextState) => void
    onAskChat?: (op: AskChatOp) => Promise<void>
  }) => void
  unmount: () => void
  /** 导航树的挂载点。**可选**：后端比插件旧时 bundle 里没有它，`mountNavInto` 会说人话。 */
  mountNav?: (el: HTMLElement, opts: {
    backend: string
    onPickChannel?: (isCurrentRow: boolean) => void
    collapsible?: boolean
  }) => void
  unmountNav?: () => void
}

const loader = createAssetLoader<PanelBundle>({
  file: 'panel',
  marker: 'data-stream-panel',
  globalName: '__streamPanel',
  label: 'panel',
})

function bundle(): PanelBundle | undefined {
  return (globalThis as Record<string, unknown>).__streamPanel as PanelBundle | undefined
}

/**
 * 把 Stream 面板挂进**调用方给的**容器（壳反转的 StreamShell 用它把内容流放进主区）。
 * 容器的几何完全归调用方；`manageWidth: false` 让 bundle 不写容器行内宽度——壳的
 * 网格列在管宽度，bundle 再写会打架。
 *
 * bundle 的 React root 是模块级单例（entry.tsx），所以**同一时刻只能有一处挂载**；
 * 本函数是唯一的挂载入口，别再造第二个（第二处挂载的表现是页面上叠出两份时间线）。
 *
 * @returns unmount（卸载 + 摘样式表；脚本单例保留复用）。
 */
export async function mountPanelInto(
  el: HTMLElement,
  backend: string,
  onAskChat?: (op: AskChatOp) => Promise<void>,
): Promise<{ unmount: () => void }> {
  loader.ensureStylesheet(backend)
  const api = await loader.load(backend)
  api.mount(el, {
    backend,
    manageWidth: false,
    onItemContext: itemContext.set,
    // 转成文字经它开一条对话（面板里那颗按钮的落点）。老 bundle 不认这个键就当没给过——
    // 那一档会退回"跳工作台"，在工作台里再跳一次工作台，难看但不致命。
    ...(onAskChat !== undefined ? { onAskChat } : {}),
  })
  return {
    unmount: () => {
      api.unmount()
      itemContext.clear()
      loader.removeStylesheet()
    },
  }
}

/**
 * 把「空间 → 频道」导航树挂进侧栏那一段容器。
 *
 * **不碰样式表**：导航自己的样式由 bundle 注一份 `<style>`（见面板的 `nav-styles.ts`），而
 * `panel.css` 的生命周期跟着内容区那一次挂载走。两边都种/摘一次的话，先卸的那个会把还挂着
 * 的另一半的样式一并摘走。脚本仍走同一份 loader，所以谁先挂都只装一次。
 *
 * 老 bundle（后端比插件旧）没有这个挂载点时**抛错**而不是静默 no-op：静默的表现是侧栏一片
 * 空白，和"后端挂了"、"样式没加载"长得一模一样，而这三种的下一步动作完全不同。
 *
 * @returns unmount（只卸导航那棵树，内容区不受影响）。
 */
export async function mountNavInto(
  el: HTMLElement,
  backend: string,
  opts: { onPickChannel?: (isCurrentRow: boolean) => void; collapsible?: boolean },
): Promise<{ unmount: () => void }> {
  const api = await loader.load(backend)
  if (api.mountNav === undefined) {
    throw new Error('这份后端的面板还没有导航挂载点（panel bundle 太旧），侧栏的频道树画不出来')
  }
  api.mountNav(el, { backend, ...opts })
  // 经 bundle() 现取：卸载发生在很久以后，那时候 api 这个引用可能已经是上一份脚本的了。
  return { unmount: () => { bundle()?.unmountNav?.() } }
}
