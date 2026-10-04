/**
 * 装影视频道的独立 bundle（`panel-movie.js` + `panel-movie.css`）——为什么要有它，见
 * `movie-entry.tsx` 头注。装载机制与详情共用 `panelBundleLoader.ts` 那一份工厂。
 */
import { createPanelBundleLoader } from './panelBundleLoader.ts'
import type { ChannelView } from '../lib/types.ts'
import type { AskChatSink } from '../lib/askExtract.ts'

/** 挂一棵影视树要的全部输入。`mount` 和 `update` 吃同一份——见 `movie-entry.tsx`。 */
export interface MovieMountOptions {
  /** Stream 后端的绝对地址。这份 bundle 是独立的 JS 运行时，`lib/api.ts` 的 `LOCAL`
   *  单例在它里面是另一份，必须自己再 apply 一次。 */
  backend: string
  /** 这次要渲染的影视频道（`StreamPanel` 已经选好了是哪一个）。 */
  channels: ChannelView[]
  /** 管理频道改完了：让面板重拉自己那份名录。 */
  onChannelsChanged: () => void
  /** 标题菜单的「重新抓取」。 */
  onReload: () => void
  /** 这棵树里有没有一块全屏覆盖层（看片）——工作台的对话列据此让位。见 `lib/overlayPresence.ts`。
   *  **`mount` 和 `update` 都要带上它**：`update` 是整份 opts 重渲染，漏了这一格就等于在
   *  「管理频道改完」那一刻把这条线悄悄掐了（不报错，只是此后看片不再收对话列）。 */
  onOverlayChange?: (open: boolean) => void
  /** 「把这句话发进对话 / 把这条引用塞进输入框」的通道——引用作品、引用分集、网盘下拉里的
   *  「AI 匹配」都画在这棵树里，而这份 bundle 是另一份 JS 运行时，主 bundle 装的那一份它
   *  读不到（详见 `lib/askExtract.ts` 的 `askChatSink()` 头注）。
   *
   *  **`mount` 和 `update` 都要带上它**：`update` 是整份 opts 重渲染，漏了这一格等于在
   *  「管理频道改完」那一刻把通道悄悄掐了。缺席的表现不是报错，是点了按钮弹一句
   *  "要在带对话的那张页里进行"——而用户明明就在那张页里。 */
  askChat?: AskChatSink
}

export interface MovieBundle {
  mount: (el: HTMLElement, opts: MovieMountOptions) => void
  /** 换一批 props 重渲染**同一棵树**（频道名录刷新用）。不重建 root——重建会把二级路由
   *  （海报墙 ↔ 某部作品）打回起点，而"管理频道改完了"不该把人踢出正在看的那一页。 */
  update: (opts: MovieMountOptions) => void
  unmount: () => void
}

export const movieBundle = createPanelBundleLoader<MovieBundle>({
  marker: 'data-stream-panel-movie',
  globalName: '__streamPanelMovie',
  file: 'panel-movie',
  label: '影视',
})
