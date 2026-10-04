/**
 * 把面板的明暗态推给外接面板（embed 频道）iframe 里的网页。
 *
 * 跨域 iframe 读不到父页面的任何东西——既看不到我们根上的 `.dark`，也读不到 `--background`，
 * 只能由父页面**主动告诉它**。消息形状是本文件与 Lean 监控页（`arbitrage/monitoring/frontend/
 * src/lib/hostTheme.js`）之间的契约，两边一起改：
 *
 *   父 → 子  { type: 'stream:theme', dark: boolean, background: string }
 *   子 → 父  { type: 'stream:theme-request' }
 *
 * `background` 是面板根上**已解析**的 `--background`（`#0a0a0a` 这类），子页直接拿它当自己的
 * 底色——只发 `dark` 布尔的话，子页只能套自己那套暗色 token，和我们的底色差一档，嵌在面板里
 * 就是一块颜色不对的方块。
 *
 * 三个时机都要发：iframe `load`（子页刚起来）、宿主翻转明暗（订阅 `subscribeHostDark`）、
 * 子页主动来要（它的脚本可能比 `load` 事件晚挂监听——SPA 挂载是异步的）。
 * `targetOrigin` 钉死为 embed URL 的 origin：消息里没有秘密，但也没理由广播给一张被劫持到
 * 别处的 iframe。
 */
import { subscribeHostDark } from './hostTheme.ts'

export const THEME_MESSAGE_TYPE = 'stream:theme'
export const THEME_REQUEST_TYPE = 'stream:theme-request'

export type ThemeMessage = { type: typeof THEME_MESSAGE_TYPE; dark: boolean; background: string }

/** 自定义属性会继承，iframe 元素自己就能解析出最近祖先（面板根的 `.dark` / `.light`）给的值。 */
function resolvedBackground(el: HTMLElement): string {
  return getComputedStyle(el).getPropertyValue('--background').trim()
}

/**
 * 开始向 `frame` 推送主题。
 * @param frame - 外接面板那张 iframe。
 * @param embedUrl - 它的 src；只用来算 `targetOrigin`。
 * @returns 停止推送。
 */
export function publishThemeToFrame(frame: HTMLIFrameElement, embedUrl: string): () => void {
  let origin: string
  try {
    origin = new URL(embedUrl).origin
  } catch {
    return () => {}
  }
  let dark = false
  const post = (): void => {
    const win = frame.contentWindow
    if (!win) return
    const message: ThemeMessage = { type: THEME_MESSAGE_TYPE, dark, background: resolvedBackground(frame) }
    win.postMessage(message, origin)
  }
  const stopHost = subscribeHostDark((next) => {
    dark = next
    post()
  })
  const onLoad = (): void => post()
  frame.addEventListener('load', onLoad)
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow) return
    if ((event.data as { type?: unknown } | null)?.type !== THEME_REQUEST_TYPE) return
    post()
  }
  window.addEventListener('message', onMessage)
  return () => {
    stopHost()
    frame.removeEventListener('load', onLoad)
    window.removeEventListener('message', onMessage)
  }
}
