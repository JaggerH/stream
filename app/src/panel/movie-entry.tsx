/**
 * 影视频道的独立 IIFE bundle：`panel-movie.js` + `panel-movie.css`，只有**第一次切到影视
 * 频道**才按需装（`StreamPanel.tsx` 的 `movieBundle.load`）。
 *
 * **为什么要拆**：壳反转之后面板的主 bundle 是**开页必载**的那一份（DSH 整页由我们接管），
 * 浏览器要把它整个 parse 完首屏才动。而影视一家就带进来 ArtPlayer + dashjs + hls.js + 海报墙
 * + 详情/分集 + 资源查找 + 网盘解析——实测 `panel.js` 从 600.71 kB 涨到 2,690.18 kB，其中
 * 影视约 2.1MB。绝大多数人开工作台只看时间线，一次都用不到它。
 *
 * **为什么不是 `React.lazy`**：IIFE/UMD 格式下 Rollup 没有跨 chunk 的模块加载器，动态
 * `import()` 会**静默内联回主文件**——实测过，体积几乎不变、没有任何报错（详见
 * `panelBundleLoader.ts` 头注）。真正的分包只能是独立 IIFE + 手工注入 `<script>`。
 *
 * **这份 bundle 自带一份完整的 React**（不是从主 bundle 借），所以它开自己的 root。代价明码：
 * 多一份 React（gzip 后几十 KB）+ 一份完整 CSS（约 200 kB / gzip 30 kB）。详情那份也是这么
 * 付的，理由见 `detail-entry.tsx` 头注。
 *
 * ## 独立 root 里必须自己备齐的几样（漏一样都是静默降级，不是报错）
 *
 * 1. **i18n**：`MovieChannel` 里 13 处 `useTranslation()`。react-i18next 的全局默认实例是
 *    `i18n/index.ts` 的**副作用**设上的，而这份 bundle 有自己一套模块实例——不 import 就是
 *    满屏原始 key。（详情那份不需要它，`PanelDetail` 那棵树没有 `useTranslation`。）
 * 2. **`<Toaster />`**：`MovieChannel` 自己发 toast（识别说话人、继续观看取数失败……），
 *    走的是它这份 bundle 里那个独立的 `sonner` 实例。主 bundle 那枚 Toaster 挂在另一棵 root
 *    上，够不着——没有这一枚就是静音失败。
 * 3. **内存路由 + `ChannelsProvider` + 把 `fixed` 关进这一列**：三样都在
 *    `PanelMovieChannel.tsx` 里，理由见那个文件的头注。它整个搬进了这份 bundle。
 * 4. **主题**：不需要在这里做任何事——`hostTheme.ts` 把 `.dark` 挂在**面板根**（`entry.tsx`
 *    的 `el`）和 `document.body` 上，而这棵树的容器是那个根的后代，Radix 浮层 portal 到
 *    body，两条路都吃得到。**前提是宿主容器必须挂在面板子树里**（`StreamPanel.tsx` 里那个
 *    `movieContainerRef` 就是），别把它挪到面板外面去。
 * 5. **后端地址**：`applyBackend` 必须在这里再调一次（见 `MovieMountOptions.backend`）。
 *    视频源那条链路尤其吃它——`lib/backendUrl.ts` 拿 `LOCAL.baseUrl` 把根相对地址
 *    （`/api/media/netdisk-play?…`）绝对化；这份 bundle 里 `LOCAL` 没 apply 过的话，
 *    地址会落回 DSH 那一页的源、`<video>` 报 `error.code 4`，而海报墙完全正常、没有一处会喊。
 */
import { StrictMode, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import '../i18n/index.ts'   // 副作用 import：设好 react-i18next 的全局默认实例——见头注 §1
import '../entry.css'        // Tailwind v4 + acrylic tokens，Vite 单独出成 panel-movie.css
import { applyBackend } from '../lib/api.ts'
import { setAskChatSink } from '../lib/askExtract.ts'
import { overlayOpen, subscribeOverlay } from '../lib/overlayPresence.ts'
import { Toaster } from '../components/acrylic/sonner.tsx'
import { PanelMovieChannel } from './PanelMovieChannel.tsx'
import type { MovieMountOptions } from './movieBundle.ts'

/**
 * 模块级单 root，和详情那份同一形状：切频道时的 unmount → mount 靠微任务 FIFO 保序
 * （cleanup 先入队），所以顺序是对的——但**这个正确性来自入队次序，不是来自结构**。
 * 真要更稳是按容器 keyed（一个容器一个 root），那要改掉详情那份已经跑通的公共面，
 * 不在这次范围里。撞到"切频道后画的还是上一个频道那棵树"这类时序症状，先看这里。
 */
let root: Root | undefined
/** 撤订阅（覆盖层在场与否 → 宿主）。挂载时建、卸载时撤——不撤就是指着一棵已经没了的树报状态。 */
let stopOverlay: (() => void) | undefined
/** 最近一次 mount/update 给的转发口。存模块级而不是闭包进订阅里：`update` 会换一份 opts，
 *  订阅却是 mount 那一刻建的，闭包住旧的那个就会在名录刷新之后往一个过期的回调里报。 */
let overlaySink: ((open: boolean) => void) | undefined

function tree(opts: MovieMountOptions): ReactElement {
  return (
    <StrictMode>
      {/* 见头注 §2：这棵树自己发的 toast 只有这一枚接得住。 */}
      <Toaster />
      <PanelMovieChannel
        channels={opts.channels}
        onChannelsChanged={opts.onChannelsChanged}
        onReload={opts.onReload}
      />
    </StrictMode>
  )
}

/**
 * 把影视频道挂进宿主给的容器（`StreamPanel.tsx` 里那个占位 div）。
 *
 * **已知形状：`root` 是模块级的一份，和详情那份一样。** 换频道时 `StreamPanel` 会先卸旧的、
 * 再挂新的，两步的正确顺序靠**微任务 FIFO** 保证：effect 的 cleanup 先把 `unmount` 入队，
 * 新一轮的 `load().then(mount)` 排在它后面。顺序反了的后果是 `unmount` 把**刚挂上的那个**
 * root 卸掉——一个空白的影视频道，不报错。
 *
 * 真要更稳是按容器 keyed（`Map<HTMLElement, Root>`），但那要动 `unmount()` 的签名，也就是
 * 动详情那份已经跑通的公共面，超出这次分包的范围。**下一个撞到影视/详情时序问题的人：
 * 先看这里，别从 React 那头查起。**
 */
export function mount(el: HTMLElement, opts: MovieMountOptions): void {
  applyBackend(opts.backend, opts.backend.replace(/^http/, 'ws'))
  // 见头注 §6：这棵树里的引用/AI 匹配按钮走的是**这份 bundle 自己那份** askExtract 模块实例，
  // 主 bundle 装的通道它读不到。不 set 就是"点了只弹一句请到工作台"。
  setAskChatSink(opts.askChat)
  overlaySink = opts.onOverlayChange
  // 这份 bundle 自己那份 presence（模块实例不跨 bundle 共享，见 overlayPresence.ts 头注）。
  stopOverlay = subscribeOverlay(() => { overlaySink?.(overlayOpen()) })
  root = createRoot(el)
  root.render(tree(opts))
}

/**
 * 换一批 props 重渲染同一棵树。为什么需要它、而详情那份不需要：详情的输入（那一条 item）
 * 一旦打开就不再变；影视的频道名录会在**管理频道改完**之后重拉一份新的，海报墙的内容全部
 * 派生自 `channels[].streams`——不推进来就是"改完了页面没反应"。走 `root.render` 而不是
 * 重建 root：重建会把二级路由打回海报墙。
 */
export function update(opts: MovieMountOptions): void {
  setAskChatSink(opts.askChat) // 同 mount：整份 opts 重渲染，漏了就是把通道悄悄掐了
  overlaySink = opts.onOverlayChange
  root?.render(tree(opts))
}

/** 卸载并交还容器（切走频道，或整个面板卸载时一并清）。 */
export function unmount(): void {
  stopOverlay?.()
  stopOverlay = undefined
  root?.unmount()
  root = undefined
  // 树没了就把"占着"撤掉：切走频道时正开着播放器，不报这一声宿主会永远以为还在看片。
  overlaySink?.(false)
  overlaySink = undefined
}
