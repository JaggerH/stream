/**
 * 研究频道的独立 IIFE bundle：`panel-research.js` + `panel-research.css`，只有**第一次切到
 * 研究频道**才按需装（`StreamPanel.tsx` 的 `researchBundle.load`）。
 *
 * **为什么要拆**：和影视同一个理由，只是量级小一档。面板主 bundle 是**开页必载**的那一份，
 * 而研究这一棵树带进来的是 lightweight-charts（timeseries / backtest 两个 view）+
 * `react-dom/server`（text view 用 `renderToStaticMarkup` 铺 markdown）——实测直接
 * `import` 进主树会把 `panel.js` 从 1,170,793 字节顶到 2,033,443 字节（+862,650），当场撞穿
 * `panel-split.build.test.ts` 那道 1.6MB 的闸门。绝大多数人开工作台只看时间线，一次都用不到它。
 *
 * **为什么不是 `React.lazy`**：IIFE/UMD 格式下 Rollup 没有跨 chunk 的模块加载器，动态
 * `import()` 会**静默内联回主文件**——体积几乎不变、没有任何报错（详见 `panelBundleLoader.ts`
 * 头注）。真正的分包只能是独立 IIFE + 手工注入 `<script>`。
 *
 * ## 独立 root 里必须自己备齐的几样
 *
 * 1. **后端地址**：`applyBackend` 必须在这里再调一次（见 `ResearchMountOptions.backend`）。
 *    这棵树的每一次取数（run 列表 / manifest / artifact）和那条 `live-changed` 的 WS 订阅
 *    全走 `LOCAL`；不 apply 就会落回 DSH 那一页的源，症状是整页「读不到研究数据」。
 * 2. **CSS**：`entry.css`（Tailwind v4 + acrylic tokens）。研究这几张卡自己写的是内联样式 +
 *    DSW token，但 text view 铺 markdown 用的是仓里那份 `Markdown` 组件，它是 Tailwind 类。
 * 3. **内存路由**：在 `PanelResearchChannel.tsx` 里，理由见那个文件头注 §1。它整个搬进了
 *    这份 bundle。
 *
 * **不需要的两样**（别照着影视那份抄）：这棵树里没有 `useTranslation`（不用 i18n 副作用
 * import，否则满屏原始 key 那个坑根本不存在），也不发 toast（不用第二枚 `<Toaster />`）。
 */
import { StrictMode, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import '../entry.css'  // Tailwind v4 + acrylic tokens，Vite 单独出成 panel-research.css
import { applyBackend } from '../lib/api.ts'
import { PanelResearchChannel } from './PanelResearchChannel.tsx'
import type { ResearchMountOptions } from './researchBundle.ts'

/** 模块级单 root，和详情/影视那两份同一形状（含同一条已知形状：切频道时的 unmount → mount
 *  靠微任务 FIFO 保序，见 `movie-entry.tsx` 头注里那段说明）。 */
let root: Root | undefined

function tree(opts: ResearchMountOptions): ReactElement {
  return (
    <StrictMode>
      <PanelResearchChannel channel={opts.channel} onChannelsChanged={opts.onChannelsChanged} />
    </StrictMode>
  )
}

/** 把研究频道挂进宿主给的容器（`StreamPanel.tsx` 里那个占位 div）。 */
export function mount(el: HTMLElement, opts: ResearchMountOptions): void {
  applyBackend(opts.backend, opts.backend.replace(/^http/, 'ws'))
  root = createRoot(el)
  root.render(tree(opts))
}

/** 换一批 props 重渲染同一棵树。名录重拉之后频道对象是新的一份，而这棵树读它的 `streams`
 *  决定去哪几个流下面取 run——不推进来就是"新绑的流一直不出现"。走 `root.render` 而不是
 *  重建 root：重建会把二级路由打回 run 列表。 */
export function update(opts: ResearchMountOptions): void {
  root?.render(tree(opts))
}

/** 卸载并交还容器（切走频道，或整个面板卸载时一并清）。 */
export function unmount(): void {
  root?.unmount()
  root = undefined
}
