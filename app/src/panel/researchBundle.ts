/**
 * 装研究频道的独立 bundle（`panel-research.js` + `panel-research.css`）——为什么要有它，见
 * `research-entry.tsx` 头注。装载机制与详情/影视共用 `panelBundleLoader.ts` 那一份工厂。
 */
import { createPanelBundleLoader } from './panelBundleLoader.ts'
import type { ChannelView } from '../lib/types.ts'

/** 挂一棵研究树要的全部输入。`mount` 和 `update` 吃同一份——见 `research-entry.tsx`。 */
export interface ResearchMountOptions {
  /** Stream 后端的绝对地址。这份 bundle 是独立的 JS 运行时，`lib/api.ts` 的 `LOCAL`
   *  单例在它里面是另一份，必须自己再 apply 一次（取 run 列表/manifest/artifact 全吃它，
   *  还有 `api.wsUrl` 那条 live-changed 订阅）。 */
  backend: string
  /** 这次要渲染的研究频道（`StreamPanel` 已经选好了是哪一个，这里不再筛）。 */
  channel: ChannelView
  /** 顶栏那个齿轮（`ChannelManageSheet`）改完频道后重拉名录。跨 root 之后 React 不替我们
   *  传播——不接上去，改完名/加完流之后宿主那份名录还是旧的，而且不会有任何报错。 */
  onChannelsChanged: () => void
}

export interface ResearchBundle {
  mount: (el: HTMLElement, opts: ResearchMountOptions) => void
  /** 换一批 props 重渲染**同一棵树**（频道名录刷新用）。不重建 root——重建会把二级路由
   *  （run 列表 ↔ 某个 run）打回起点，而"名录刷新了"不该把人踢出正在看的那个 run。 */
  update: (opts: ResearchMountOptions) => void
  unmount: () => void
}

export const researchBundle = createPanelBundleLoader<ResearchBundle>({
  marker: 'data-stream-panel-research',
  globalName: '__streamPanelResearch',
  file: 'panel-research',
  label: '研究',
})
