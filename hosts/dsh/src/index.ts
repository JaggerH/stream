/**
 * host 半边。它只做一件事：**把行 config 里的 Stream 后端地址送到浏览器那半**。
 *
 * 渲染逻辑一行都不在这儿（Stream 的数据全部经 MCP 到达 DSH，这个包只管渲染，渲染在
 * `exports["./client"]` 那半）。这条配置线为什么非得绕 host 半走一趟，见 `src/wire.ts`
 * 的头注——浏览器半拿不到自己那一行的 config，这是 DSH 装载器的形状决定的。
 */
import { STREAM_UI_GLOBAL, normalizeBackendUrl, type StreamUiWire } from './wire.ts'

/**
 * 我们从 cordis 用到的那点面（`inject` 软门 + `effect` + `webServer.tapIndex` + logger）。
 *
 * **有意不 import `@deepseek-ai/cordis` 的 `Context`**：`ctx.webServer` 是
 * `@deepseek-ai/dsh-host-webserver` 的模块增强声明的，要拿到它就得把那个包也变成本包的
 * 依赖——而我们只用它一个方法。结构类型把这点面写清楚，比多背一个依赖诚实。
 */
export interface StreamUiHostContext {
  inject(deps: string[], callback: (scoped: StreamUiHostContext) => void): void
  effect(setup: () => () => void, label?: string): void
  logger: { warn(...args: unknown[]): void }
  webServer: { tapIndex(transform: (html: string) => string): () => void }
}

/** 这一行在 profile 里收的 config。 */
export interface StreamUiHostConfig {
  /** Stream 后端那扇门（用户在 profile 里给本行的 `streamBaseUrl` 原样传过来）。 */
  streamBaseUrl?: string
}

/**
 * 把常量注进 `<head>`。
 *
 * `<` 在 JSON 里转义成 `\u003c`——照 `dsh-client-modules` 的做法，防止配置里的字符串
 * 提前闭合 `</script>` 把后面的页面吃掉。
 * @param html - index.html 原文。
 * @param wire - 要注入的常量。
 * @returns 注入后的 html。
 */
export function injectStreamUiConfig(html: string, wire: StreamUiWire): string {
  const script = `<script>window.${STREAM_UI_GLOBAL} = ${JSON.stringify(wire).replaceAll('<', '\\u003c')}</script>`
  const head = html.indexOf('<head>')
  if (head !== -1) return `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
  return `${script}${html}`
}

/**
 * host 插件体。
 * @param ctx - host cordis context.
 * @param config - 这一行的 config（`streamBaseUrl`）。
 */
export function apply(ctx: StreamUiHostContext, config: StreamUiHostConfig = {}): void {
  const backendUrl = normalizeBackendUrl(config.streamBaseUrl)
  if (backendUrl === undefined) {
    // 不抛：一个渲染包不该把整个工作台的装载搞崩。浏览器那半会在主区画出同样一句人话
    // （见 client/index.tsx），所以这条日志是给运维看的第二现场，不是唯一现场。
    ctx.logger.warn(
      `stream-ui: 这一行没有可用的 streamBaseUrl（拿到 ${JSON.stringify(config.streamBaseUrl)}），` +
      '浏览器半将拿不到 Stream 后端地址，内容面板与深链都会停摆。',
    )
    return
  }
  // 软门：`webServer` 不在场（非 Web 档的 DSH 组合）就安静休眠，别把整包卡在 pending。
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () => scoped.webServer.tapIndex((html) => injectStreamUiConfig(html, { backendUrl })),
      'stream-ui: backend url injection',
    )
  })
}

export { STREAM_UI_GLOBAL, normalizeBackendUrl } from './wire.ts'
export type { StreamUiWire } from './wire.ts'
export { STREAM_MCP_SERVER_NAME, wireToolName, registryRows, customRows } from './registry.ts'
export type { RegistryRow, Treatment } from './registry.ts'
