/**
 * 能力包的宿主（spec 2026-09-06）：实例是唯一的聚合者。内置的 Stream Desktop 与用户装进 `<dataDir>/recipes/` 的可选包
 * 走同一个 `host.mount()`，工具从同一个工具面出去。
 *
 * 分三步，各有各的时机：
 * 1. `createCapabilities`——**在 `bootstrap()` 之前**：bootstrap 拿它当「该同步哪些 cookie 域」的第三个来源（能力包是
 *    一等的登录态消费者）。建它本身没有副作用。
 * 2. `provideBrowserCookies`——bootstrap 之后（要凭证域与授权域）。
 * 3. `loadOptionalCapabilities`——装配的最后一步；必须早于调用方开始对外服务（`stream mcp` 探到 health 一通就把那一刻
 *    的 `tools/list` 缓起来，晚装的包一件工具都不在表上）。
 *
 * 内置的 Stream Desktop 不在这里挂：它要养一个本机进程、要知道后端的口（`serve.ts` 的 `mountHostAgent`）。
 */
import { join } from 'node:path'
import type { Context } from 'cordis'
import { createCapabilityHost, type CapabilityHost } from '../capabilities/host.ts'
import { loadOptionalCapabilities, type LoadedCapability } from '../capabilities/load.ts'
import { BROWSER_COOKIE_SERVICE } from '../../capabilities/desktop/src/cookies.ts'
import { backendToolNames } from '../mcp/server.ts'
import type { AgentDomain } from '../kernel/plugins/agent.ts'
import type { AppConfig } from '../types.ts'

/** 能力包取登录态前，快照旧过这个数就先去浏览器取一次。**不是缓存 TTL**：`ensureFresh` 自己带并发去重，这个数只决定
 *  "多旧算旧"。取小了每次都发一轮 `cookiePull`；取大了就退化成读快照，白设这道闸。 */
const COOKIE_FRESH_MS = 60_000

export interface StreamCapabilities {
  host: CapabilityHost
  /** 已装载的可选能力包。**可变数组**：读它的地方都是 thunk，指着同一个数组就永远读到最新的一份。 */
  loaded: LoadedCapability[]
}

export function createCapabilities(stateDir: string, kernel: Context, log: (line: string) => void): StreamCapabilities {
  const host = createCapabilityHost({
    dataDir: stateDir,
    log,
    // 后端自己的动词。**thunk**：工具面按域的可用性现算，装配那一刻取一次会把「此刻还没醒的那些工具」永久算成不存在，
    // 于是一个第三方包可以拿走它们的名字。只在 mount 时调，那时两个域早就在了。
    reservedToolNames: () => backendToolNames(kernel.scheduling.service, (kernel.agent as AgentDomain).mcpExtras),
  })
  kernel.effect(() => async () => { await host.dispose() })
  return { host, loaded: [] }
}

/**
 * 唯一一格由宿主主动提供的服务：包 `require('streamBrowserCookies')` 取用户浏览器里的登录态。后端自己就有那条接缝
 * （`cookieString` / `cookiesFor`，同一把作用域尺子），这里只是翻译成包认识的形状——**不是**再开一条取 cookie 的路。
 *
 * **每次都先催一次新鲜度再读**：`cookieProvider` 读的是落盘快照，而包在这一刻要 cookie，通常正是因为它刚吃了一个 401。
 * `ensureFresh` 自带并发去重和"够新就不动"的短路，中继没连不报错，照旧读快照。
 */
export function provideBrowserCookies(caps: StreamCapabilities, kernel: Context, log: (line: string) => void): void {
  const freshCookies = async (verb: string) => {
    try {
      await kernel.auth.cookiePuller.ensureFresh(COOKIE_FRESH_MS, `capability:${verb}`)
    } catch (err) {
      // 取数失败不该让"读一份可能还好用的旧快照"也跟着失败——但必须留一行，否则「一直在用旧 cookie」和「刚取过一份新的」
      // 在日志上分不出来。
      log(`[stream-capabilities] WARN 取登录态前的刷新失败（${verb}）：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  caps.host.provide(BROWSER_COOKIE_SERVICE, {
    cookieFor: async (domain: string) => {
      await freshCookies('cookieFor')
      return (await kernel.credentials.cookieProvider.cookieString(domain)) ?? undefined
    },
    cookiesFor: async (domain: string) => {
      await freshCookies('cookiesFor')
      return kernel.credentials.cookieProvider.cookiesFor(domain)
    },
  })
}

/** 扫 `<stateDir>/recipes/` 里填了 capability 槽位的包，逐个装、逐个兜错。 */
export async function loadOptional(caps: StreamCapabilities, stateDir: string, config: AppConfig, log: (line: string) => void): Promise<void> {
  const loaded = await loadOptionalCapabilities({
    recipesDir: join(stateDir, 'recipes'),
    host: caps.host,
    log,
    config: config.capabilities,
  })
  caps.loaded.push(...loaded)
  if (loaded.length) log(`[stream] ${loaded.length} 个可选能力包已装载：${loaded.map((c) => c.name).join(', ')}`)
}
