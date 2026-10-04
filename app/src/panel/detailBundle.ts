/**
 * 装详情的独立 bundle（`panel-detail.js` + `panel-detail.css`）——为什么要有它、为什么不能用
 * `React.lazy`，见 `detail-entry.tsx` 头注。**"怎么把它装进来"不在这里**：那套 script/link
 * 注入、单例、失败清理是 `panelBundleLoader.ts` 那一份工厂（影视那份 bundle 吃的是同一份）。
 * 这个文件只声明"详情这一份长什么样"和它的公共面类型。
 */
import { createPanelBundleLoader } from './panelBundleLoader.ts'

export interface DetailBundle {
  mount: (el: HTMLElement, opts: {
    backend: string
    item: import('../lib/types.ts').Item
    startMediaIndex: number
    /** 左边那格媒体要不要自己播起来——由**打开它的那一下点击**决定
     *  （`autoPlaysDetailMedia(opts.intent)`，判据与主应用同一份）。 */
    autoPlayMedia: boolean
    /** 列表那棵树**已经拉到**的「转成文字」能力发现结果（`/api/conversion-kinds`）——
     *  详情是另一个 React root、另一份 JS 运行时，context 过不来，只能顺着 mount 递数据。
     *  **只在确实拉到时才递**（理由见 `PanelDetail.tsx` 头注 §3）；缺席 = 那棵树自己去拉。 */
    extractCaps?: import('../lib/extract.ts').ExtractCapabilities
    /** 面板→对话的通道（工作台的壳递给主 bundle 的那一份）。
     *  同样是"另一份 JS 运行时"造成的：主 bundle 里 `setAskChatSink` 装的那个，详情这边
     *  读不到，只能顺着 mount 递过去。缺席 = 详情里的转成文字点了只说人话拒绝。 */
    askChat?: import('../lib/askExtract.ts').AskChatSink
    onClose: () => void
  }) => void
  unmount: () => void
}

export const detailBundle = createPanelBundleLoader<DetailBundle>({
  marker: 'data-stream-panel-detail',
  globalName: '__streamPanelDetail',
  file: 'panel-detail',
  label: '详情',
})
