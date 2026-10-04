import type { ReplayLauncher, ReplayPage } from './browser-fetch.ts'
import type { ResolvedFetch } from './interpret.ts'
import { makeExtPageDriver, makeExtRawPage, type ExtDriveDeps, type ExtRawPage } from './browser-ext-drive.ts'
import { openDrivenTab } from '../../shared/browser-relay/ext-page.ts'
import type { GroupTab } from '../../shared/browser-relay/relay.ts'

/** makeExtensionLauncher 只依赖中继的这三个方法（ExtRelay 满足之；假 relay 便于单测）。 */
export interface ExtRelayLike {
  newTab(url: string, waitUntil?: string, background?: boolean): Promise<number>
  closeTab(tabId: number): Promise<void>
  sendCommand(tabId: number, method: string, params: unknown): Promise<any>
  list(): Promise<GroupTab[]>
}

/**
 * 把 page.evaluate(fn, arg) 翻译成目标 tab 上的一条 Runtime.evaluate。
 *
 * `__name` 坑根治：esbuild keepNames 会把箭头函数编译成含 `__name(...)` 包装的源码，
 * 页内没有 `__name` 会 ReferenceError。这里把 fn.toString() 包进自执行 IIFE，并在
 * IIFE 作用域内就地定义 `const __name = (f) => f` shim —— extension 只见一条普通
 * Runtime.evaluate，保持纯 transport（设计文档 §4）。arg 是纯 JSON（ResolvedFetch），
 * 直接 JSON.stringify 内联。
 */
function buildExpression(fn: (arg: ResolvedFetch) => unknown, arg: ResolvedFetch): string {
  return `(() => { const __name = (f) => f; return (${fn.toString()})(${JSON.stringify(arg)}); })()`
}

/**
 * 采集用的唯一 launcher：实现 ReplayLauncher 接口，经中继在用户自己 Chrome 的登录态 tab 上
 * 跑 in-page fetch。（browser.ts 里那个 connectOverCDP launcher 只服务配方创作 CLI，不在采集
 * 路径上。）
 */
export function makeExtensionLauncher(relay: ExtRelayLike, deps: ExtDriveDeps = {}): ReplayLauncher {
  return {
    // Browser recipe over ext-cdp: drive the tab with an evaluate+CDP-Input PageDriver
    // (trusted gestures), not a Playwright page. rawPage carries the handle.
    // deps 只带 DebugBox 入口 —— driver 里那些不改行为的静默出口（goto 撞 readyState 上界）
    // 要留痕，走的就是它；两条造 driver 的路（这里和 Transport.driverFactory）都得接上，
    // 否则同一个缺陷在其中一条路上照旧沉默。
    driverFactory: (rawPage: unknown) => makeExtPageDriver(rawPage as ExtRawPage, deps),
    listTabs: () => relay.list(),
    // 借用户的 tab：不开、不导航、不关。组内即授权（扩展只查在不在组里，不查是谁开的），
    // 所以这里拿到的 rawPage 和自建 tab 的一模一样；差别只在 close——那是用户的 tab，还回去就完了。
    async adopt(tabId: number) {
      const rawPage = makeExtRawPage(relay, tabId)
      const page: ReplayPage = {
        evaluate: <T>(fn: (arg: ResolvedFetch) => T | Promise<T>, arg: ResolvedFetch): Promise<T> =>
          rawPage.evalExpr<T>(buildExpression(fn as (a: ResolvedFetch) => unknown, arg)),
      }
      return { page, rawPage, close: async () => {} }
    },
    async launch(entryUrl: string, waitUntil = 'domcontentloaded', opts?: { interactive?: boolean }) {
      // interactive → a foreground tab in the user's CURRENT window, joined to the visible
      // session tab group (scroll/render/trusted input all need a genuinely focused tab).
      // else → a background tab (passive in-page fetch/eval): no focus steal, closed per harvest.
      // 开标签 + 开焦点模拟是同一件事，收在 `openDrivenTab` 里（活体四档对照数字、它撒的谎、
      // 它救不了什么，全在那份头注）。**每一张自己开的 tab 都要走它**：不开的话后台标签上
      // 一次可信输入要 39.8–41.6 秒，而中继超时是 30 秒——必然超时，且没有一处会喊。
      //
      // 还有两条只属于这里、不属于那个通用出口的历史，留在这儿：
      // - **为什么之前是 `false`**：一条 2026-07-11 的注释（commit 9abced11）称「实测 xhs 据此
      //   作废会话」。2026-07-29 复查：**这条结论没有任何实验记录**——commit 正文只字未提，
      //   specs / research / skill 全仓搜不到，而同一个仓库的录制 launcher（`browser.ts`）却
      //   一直明确开着它。用户亲历的唯一一次 xhs 告警发生在很早期，与本开关无关。那是从单次
      //   告警推出来的口传，不是实测。Playwright 给每个页面默认开这条。
      // - **真正的封号治理是限速，不是撒谎与否**（见 facility rate limit）：那次登录墙是高频
      //   打 detail 打出来的，和这个开关无关。
      const tabId = await openDrivenTab(relay, entryUrl, {
        waitUntil,
        background: opts?.interactive !== true,
      })
      // 前台/后台在这一层不再有任何行为差别：可信输入由上面那个开关接住，而"逼帧"整条已经
      // 摘掉（后台标签的懒加载实测不需要它，见 ExtPageDriver 的 sleep）。
      const rawPage = makeExtRawPage(relay, tabId)
      const page: ReplayPage = {
        // 骑 rawPage.evalExpr：一条 Runtime.evaluate 的发法、回包拆包、页内异常怎么冒出来
        // （登录墙/风控 → exceptionDetails → reject → resolve ladder 记一次 miss），
        // 都只在 makeExtRawPage 里写一遍。这里只负责把 fn+arg 编译成那条表达式。
        evaluate: <T>(fn: (arg: ResolvedFetch) => T | Promise<T>, arg: ResolvedFetch): Promise<T> =>
          rawPage.evalExpr<T>(buildExpression(fn as (a: ResolvedFetch) => unknown, arg)),
      }
      return {
        page,
        rawPage,
        // close 只关本 launcher 开的 tab —— 绝不碰用户 tab / 其他 launcher 的 tab
        close: async () => {
          await relay.closeTab(tabId)
        },
      }
    },
  }
}
