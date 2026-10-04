/**
 * 详情视图的独立 IIFE bundle：`panel-detail.js` + `panel-detail.css`，只有打开详情
 * 才按需装（`StreamPanel.tsx` 的 `loadDetailBundle`）。
 *
 * 为什么不是 `React.lazy(() => import('./PanelDetail.tsx'))`：面板主 bundle 必须是
 * IIFE（entry.tsx 头注解释了原因——跨源 `<script type=module>` 要 CORS），而 IIFE/UMD
 * 格式下 Rollup 没有跨 chunk 的模块加载器，遇到动态 `import()` 会**静默内联回主文件**——
 * 实测过：加了 `React.lazy` 之后 `panel.js` 体积几乎没变（2224.35KB → 2224.73KB），
 * 没有任何报错，看起来分包了、其实什么都没分。真正的分包只能是"第二个独立的 IIFE
 * bundle + 手工注入 `<script>`"，跟 `entry.tsx` 本身被 `hosts/dsh` 的 `host.ts`
 * 加载的方式是同一个模式（`globalThis.__streamXxx` + `mount`/`unmount`）——这里原样
 * 复用它，而不是自造一套。
 *
 * 这份 bundle **自带一份完整的 React**（不是从主 bundle 借），所以它开自己的 root，
 * 不是把 `PanelDetail` 塞进主 bundle 的 React 树。两个 React 根共存是本仓库已经在用
 * 的隔离手法（entry.tsx 头注："两个 React root 共存……是有意的隔离"）；这里只是把
 * 同一手法再套一层——第三个根，多出一份 React 的体积（gzip 后几十 KB），换来的是
 * 不用给两个独立打包的 IIFE 互相暴露内部模块（跨 bundle 共享同一份 React 实例需要
 * external + globals 的 UMD 手法，对这个从没用过它的仓库来说是额外的失败面）。
 */
import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import '../entry.css'
// 副作用 import：设好 react-i18next 的全局默认实例。这份 bundle 有自己一套模块实例
// （见文件头注），不 import 的话 `Detail` 动作行里的 `t('timeline.extract')`/`t('timeline.download')`
// 会**原样画出 key**——不报错，只是按钮上写着 `timeline.extract`（活体实测过）。
// movie-entry.tsx 头注 §1 记的是同一个坑。
import '../i18n/index.ts'
import { applyBackend } from '../lib/api.ts'
import { setAskChatSink, type AskChatSink } from '../lib/askExtract.ts'
import { Toaster } from '../components/acrylic/sonner.tsx'
import { PanelDetail } from './PanelDetail.tsx'
import type { ExtractCapabilities } from '../lib/extract.ts'
import type { Item as StreamItem } from '../lib/types.ts'

let root: Root | undefined

interface MountOptions {
  /** Stream 后端的绝对地址，如 `http://127.0.0.1:8900`——这份 bundle 是独立的 JS
   *  运行时，`../lib/api.ts` 的 `LOCAL` 单例在它里面是另一份，跟主 bundle 各自为政，
   *  必须自己再 apply 一次，不能假设主 bundle 已经 apply 过就对它生效。 */
  backend: string
  item: StreamItem
  startMediaIndex: number
  /** 见 `detailBundle.ts` 的同名字段：点媒体进来的才自动播。 */
  autoPlayMedia: boolean
  /** 列表那棵树已经拉到的「转成文字」能力发现结果（理由见 `PanelDetail.tsx` 头注 §3）。
   *  缺席 = 那边还没拉到/拉失败，这棵树自己去拉。 */
  extractCaps?: ExtractCapabilities
  /** 「把这句话发进一条新对话」的通道——转成文字按钮就画在这棵树里，而这份 bundle 是
   *  另一份 JS 运行时，主 bundle 装的那一份它读不到（详见 `lib/askExtract.ts` 的
   *  `askChatSink()` 头注）。缺席 = 点了只说人话拒绝。 */
  askChat?: AskChatSink
  onClose: () => void
}

/** 把详情挂进宿主给的容器（`StreamPanel.tsx` 里那个占位 div）。 */
export function mount(el: HTMLElement, opts: MountOptions): void {
  applyBackend(opts.backend, opts.backend.replace(/^http/, 'ws'))
  setAskChatSink(opts.askChat)
  root = createRoot(el)
  root.render(
    <StrictMode>
      {/* 播放失败要说得出话（`ArtPlayer`/`AudioStageProvider` 的失败回执走 toast）。
          这份 bundle 自带一份完整的 React（见文件头注），`sonner` 也是它自己那份独立实例——
          `StreamPanel.tsx` 那枚 Toaster 挂在 feed root 上，够不着这棵树发的 toast，
          没有这一枚就是静音失败（详情自动播的这一路尤其明显：失败连 spinner 都不留）。 */}
      <Toaster />
      <PanelDetail
        item={opts.item}
        startMediaIndex={opts.startMediaIndex}
        autoPlayMedia={opts.autoPlayMedia}
        extractCaps={opts.extractCaps}
        onClose={opts.onClose}
      />
    </StrictMode>
  )
}

/** 卸载并交还容器（详情关闭，或整个面板卸载时一并清）。 */
export function unmount(): void {
  root?.unmount()
  root = undefined
  setAskChatSink(undefined)
}
