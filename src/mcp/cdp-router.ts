import type { ActionSpec, ActResult } from '../replay/interactive-gate.ts'
import type { DesktopDriver } from '../replay/desktop-driver.ts'
import { DesktopUnavailable, SESSION_BUSY_REASON, USER_ABORTED_REASON } from '../replay/desktop-failure.ts'
import { HostSessionQueueTimeout, HostAbortedByUser, INTERACTIVE_SESSION_WAIT_MS } from '../http/host-relay.ts'
import { desktopAct, desktopLook, desktopMatch, desktopOpen, desktopPages, desktopShot } from './desktop-surface.ts'
import { parseCdpTarget } from './cdp-target.ts'
import {
  type ChromeSurfaceDeps,
  chromeActVerb,
  chromeLookVerb,
  chromePagesVerb,
  chromeShotVerb,
  chromeTabId,
  expandRef,
  resolveLookJs,
} from '../../shared/browser-relay/cdp-chrome.ts'

/** chrome 那一档的七格住在 `shared/browser-relay/cdp-chrome.ts`（**没有 Stream 后端的宿主
 *  只有那一档**，共享库就是为它立的）；这里只把它和另外两档拼在一起。 */
export interface CdpRouterDeps extends ChromeSurfaceDeps {
  facilityLook: (facility: string, expression: string) => Promise<{ value: unknown } | null>
  facilityShot: (facility: string) => Promise<string | null>
  facilityAct: (action: ActionSpec & { facility: string }, confirmed?: boolean) => Promise<ActResult | null>
  /** 原生窗口这一档。**没连 Stream Desktop 时返回 undefined**——这一档随即报
   *  `agent-disconnected`，而不是静默降级成别的面（降级会让调用方以为动作生效了）。 */
  desktop?: () => DesktopDriver | undefined
}

export type LookArgs = { target: string; js?: string; url?: string; interactive?: boolean; inventory?: boolean; frame?: string }
/** `ref` 在 `ActArgs` 而不是 `ActionSpec`：它是**元素寻址糖**（解析成一个 selector 就没了），
 *  不是一种动作语义——进了 ActionSpec 就会流到高危分类、recipe 回放这些不该认识它的地方。 */
export type ActArgs = { target: string; confirmed?: boolean; ref?: number } & ActionSpec

export interface CdpRouter {
  look(a: LookArgs): Promise<unknown>
  shot(a: { target: string }): Promise<{ shot: string | null; via?: 'window'; target?: string; note?: string }>
  act(a: ActArgs): Promise<ActResult | { live: false }>
  pages(a: { target: string; close?: number }): Promise<unknown>
}

const isDesktop = (scheme: string): scheme is 'desktop' | 'app' => scheme === 'desktop' || scheme === 'app'

/** 扩展那句「Page.captureScreenshot 在 …ms 内没有回执：这个标签没有产出帧」——窗口不显示在屏幕上。 */
const isNoFrame = (e: unknown): boolean => e instanceof Error && /captureScreenshot[\s\S]*没有产出帧/.test(e.message)

/**
 * 桌面这一档四个动词（look/shot/act/pages）共用的会话租约包裹——跟 `runDesktopRecipe`
 * 包一整趟 recipe 走的是**同一把** `driver.withSession`（见 `host-relay.ts` 里
 * `WsHostRelay.withSession` 的头注）。不包这一层时，`cdp_act`/`cdp_look` 各自的单发 op
 * 只在 `send()` 里拿一次性租约，一趟并发的 desktop recipe 能在它的 await 缝隙里插进来
 * 抢到租约、跑完整趟——2026-08 复评在这个仓库里用真 `WsHostRelay` 实测出这条交错，
 * `cdp_act type` 的文字因此打进了 recipe 抢到的那个窗口。
 *
 * 包在 `cdp-router.ts` 而不是 `desktop-surface.ts` 逐个函数包：这里是四档 × 四动词唯一的
 * switch 入口，新增第五个动词也不会漏接这道闸。
 *
 * 没有 `withSession`（测试用的假驱动器）就直接跑 `fn`，不做跨调用互斥——那正是
 * `runDesktopRecipe` 对同一情形的处理方式，两处保持一致。
 *
 * 传 `INTERACTIVE_SESSION_WAIT_MS`（远小于默认的 180s）：`cdp_act`/`cdp_look` 是 MCP 客户端
 * 直接在等的交互路径，客户端自己的调用超时通常比 180s 短得多——排队要在客户端放弃之前先
 * 失败，不然客户端超时重试之后，原来排队里那份 op 还会在背后悄悄真的执行（见
 * `INTERACTIVE_SESSION_WAIT_MS` 头注的 I1）。
 */
const withDesktopSession = <T>(d: DesktopDriver, fn: () => Promise<T>): Promise<T> =>
  (d.withSession ? d.withSession(fn, { waitMs: INTERACTIVE_SESSION_WAIT_MS }) : fn()).catch((e: unknown) => {
    // 排队没轮到 ≠ 这次动作失败。裸抛 `HostSessionQueueTimeout` 时调用方只看得到「超时」，
    // 而「agent 没响应」和「前面那趟占着没让出来」的下一步是相反的（查 agent vs 直接重试）。
    // `run_action_recipe` 那条路早就归了类（`action-recipe.ts`），这里补上同一句——**共用
    // `SESSION_BUSY_REASON`**，两条路的措辞不许各写各的。
    // 只吃这一种：别的错误原样抛出去，把陌生错误归成"通道忙"比不归类更坏。
    if (e instanceof HostSessionQueueTimeout) throw new Error(SESSION_BUSY_REASON, { cause: e })
    // 用户在本机按了中止热键。同样共用一句（`USER_ABORTED_REASON`）：这一档是四档里唯一
    // **不许自动重试**的，两条交互路径的措辞分了家，就会有一条只说"超时"而把重试留给调用方猜。
    if (e instanceof HostAbortedByUser) throw new Error(USER_ABORTED_REASON, { cause: e })
    throw e
  })

export function makeCdpRouter(deps: CdpRouterDeps): CdpRouter {
  /** 桌面这一档的入口守卫。**「没连」和「连了但这次不行」必须分开**——前者是能力不可用，
   *  后者是这次动作失败，调用方的下一步完全不同。 */
  const desktopDriver = (): DesktopDriver => {
    const d = deps.desktop?.()
    if (!d) {
      throw new DesktopUnavailable(
        'agent-disconnected',
        'agent-disconnected: Stream Desktop 没连上，桌面这一档整个不可用（不是这次动作失败）',
      )
    }
    return d
  }

  /**
   * chrome 档截不到图（窗口被盖住 / 最小化 / 锁屏——合成器不给看不见的窗口出帧，扩展那边
   * 1.5s 上界 + beyond-viewport 回落都没救回来）→ **自动改走原生窗口档**截那扇 Chrome 窗。
   *
   * 为什么放心自动回落：原生档截的是窗口本身（PrintWindow），被盖住照样有图；而它截到的**一定是
   * 这张标签**——只在这张标签是它那扇窗的当前标签时才走（Chrome 窗口标题 = 当前标签标题），
   * 并且按标题认窗口必须恰好认出一扇。任一条不成立就不回落、把能走的路写进报错：截到别的标签
   * 比截不到糟得多。
   *
   * 回落的图是**整扇窗**（含标签栏、地址栏，物理像素），不是页面视口——回执带 `via:'window'` 与
   * 用到的 `app:` 地址，调用方别拿图上的坐标去点页面。
   *
   * 住在路由这层而不是共享库：原生窗口那一档只有 Stream 后端有，共享库那份（插件宿主）没有可回落的地方。
   */
  const windowShotFallback = async (tabId: number, cause: Error) => {
    const tab = (await deps.chromeTabs().catch(() => [])).find((t) => t.tabId === tabId)
    const d = deps.desktop?.()
    const why = (s: string) => new Error(`${cause.message}\n→ ${s}`, { cause })
    if (!tab) throw why(`这张标签不在会话组里，没法替你认它的窗口。`)
    if (!tab.title) throw why(`这张标签还没有标题，认不出它的窗口——cdp_pages({target:'desktop'}) 找到那扇 Chrome 窗，再 cdp_shot({target:'app:<process>/<窗口标题>'})。`)
    const hint = `cdp_shot({target:'app:chrome.exe/${tab.title}'})`
    if (tab.active === false) {
      throw why(`它不是它那扇窗的当前标签，窗口截图会截到别的标签。先让它成为当前标签（例如 cdp_act kind:'open' 同一个 URL 会切过去），再 ${hint}。`)
    }
    if (!d) throw why(`原生窗口档（Stream Desktop）没连，自动回落不了；连上后可 ${hint}（窗口截图被盖住也能截）。`)
    const shot = await withDesktopSession(d, async () => {
      const wins = (await d.windows()).filter(
        (w) => /chrome/i.test(w.process) && (w.title === tab.title || w.title.startsWith(`${tab.title} - `)),
      )
      if (wins.length !== 1) {
        throw why(
          wins.length === 0
            ? `没找到标题是「${tab.title}」的 Chrome 窗口（窗口可能被最小化后改名，或标题刚变）——cdp_pages({target:'desktop'}) 看一眼再 ${hint}。`
            : `有 ${wins.length} 扇 Chrome 窗标题都像「${tab.title}」，不擅自挑——cdp_pages({target:'desktop'}) 认出那一扇再截。`,
        )
      }
      const w = wins[0]!
      return { target: `app:${w.process}/${w.title}`, shot: await desktopShot(d, { process: w.process, title: w.title }) }
    })
    return {
      shot: shot.shot,
      via: 'window' as const,
      target: shot.target,
      note: '页面截图拿不到帧（窗口被盖住/最小化/锁屏），这张是整扇 Chrome 窗口的截图（含标签栏与地址栏，物理像素）——别拿图上坐标去点页面。',
    }
  }

  return {
    async look({ target, js, url, interactive, inventory, frame }) {
      const { scheme, address } = parseCdpTarget(target)
      // `inventory` / `js` 的互斥与展开是 chrome 档的判据，共享库那一份说了算（两边各写一遍
      // 就会漂移成"一个报错、一个静默丢掉 js"）。
      const resolved = resolveLookJs({ js, inventory })
      if (isDesktop(scheme) && inventory) {
        throw new Error(`cdp_look: 原生窗口档没有 DOM，inventory 不适用——那一档的 a11y query 本来就是清单`)
      }
      if (frame && scheme !== 'chrome') throw new Error(`cdp_look: frame 只在 chrome 档有效（${scheme} 档没有 iframe 这回事）`)
      if (scheme === 'chrome') {
        return chromeLookVerb(deps, {
          address,
          js: resolved,
          url,
          interactive,
          ...(inventory ? { inventory } : {}),
          ...(frame ? { frame } : {}),
        })
      }
      if (scheme === 'facility') {
        const r = await deps.facilityLook(address!, resolved)
        return r ?? { value: null, live: false }
      }
      if (isDesktop(scheme)) {
        const d = desktopDriver()
        return withDesktopSession(d, () => desktopLook(d, desktopMatch(scheme, address), resolved))
      }
      throw new Error(`cdp_look: unhandled target scheme '${scheme}'`)
    },

    async shot({ target }) {
      const { scheme, address } = parseCdpTarget(target)
      if (scheme === 'chrome') {
        try {
          return await chromeShotVerb(deps, { address })
        } catch (e) {
          if (!isNoFrame(e)) throw e
          return windowShotFallback(chromeTabId(address, 'shot'), e as Error)
        }
      }
      if (scheme === 'facility') return { shot: await deps.facilityShot(address!) }
      if (isDesktop(scheme)) {
        const d = desktopDriver()
        return { shot: await withDesktopSession(d, () => desktopShot(d, desktopMatch(scheme, address))) }
      }
      throw new Error(`cdp_shot: unhandled target scheme '${scheme}'`)
    },

    async act({ target, confirmed, ref, ...spec }) {
      const { scheme, address } = parseCdpTarget(target)
      if (spec.frame && scheme !== 'chrome') throw new Error(`cdp_act: frame 只在 chrome 档有效`)
      if (ref !== undefined) {
        // 「ref 只在 chrome 档有效」是一条**跨档**的规矩，所以守在路由这一层；展开本身
        // （编号 → `[data-stream-el=...]`）是 chrome 档的语义，交给共享库。
        if (scheme !== 'chrome') {
          if (spec.selector) throw new Error(`cdp_act: ref 与 selector 二选一（ref 展开后就是一个 selector）`)
          throw new Error(`cdp_act: ref 编号只在 chrome 档有效——facility 采集页不开放按编号动作`)
        }
        spec = expandRef(spec, ref)
      }
      if (scheme === 'chrome') return chromeActVerb(deps, { address, confirmed, spec })
      if (scheme === 'facility') {
        const r = await deps.facilityAct({ ...spec, facility: address! }, confirmed)
        return r ?? { live: false }
      }
      if (isDesktop(scheme)) {
        const d = desktopDriver()
        const match = desktopMatch(scheme, address)
        // 整个分流（含 open）都在同一把租约里跑：单发 op 与整趟 recipe 共用同一道闸，
        // 才不会有"这一支路忘了包"的漏网之鱼。
        return withDesktopSession(d, async () => {
          // open 在这一档是「唤起应用」，**必须先于 desktopAct 分流**：那条路一上来就
          // scopeWindow/focusApp，而要开的进程按定义还没有窗口——走过去只会报 no-window-match。
          if (spec.kind === 'open') return await desktopOpen(d, match, spec) as never
          return desktopAct(d, match, spec) as never
        })
      }
      throw new Error(`cdp_act: unhandled target scheme '${scheme}'`)
    },

    async pages({ target, close }) {
      const { scheme } = parseCdpTarget(target)
      if (isDesktop(scheme)) {
        const d = desktopDriver()
        return withDesktopSession(d, () => desktopPages(d))
      }
      if (scheme === 'chrome') return chromePagesVerb(deps, { close })
      // facility: a single managed page, nothing to list/close
      return { pages: [{ target }] }
    },
  }
}
