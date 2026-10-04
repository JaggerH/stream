import { makeExtPageDriver, type ExtRawPage } from './browser-ext-drive.ts'
import type { ReplayLauncher } from './browser-fetch.ts'
import type { PageDriver } from './actions.ts'
import type { ObserverRelay } from './observer-pipeline.ts'
import type { DebugEntry } from '../debug.ts'

/**
 * One object that folds every browser-specific detail — launcher, PageDriver + network-observer
 * construction, and the `evaluate` / `screenshot` primitives — behind a single seam, so the
 * session manager, the executor and look/act/shot all read the page through the same object.
 *
 * There is exactly ONE browser now: the user's own Chrome, reached over the extension relay.
 * The seam survives its second implementation because it is also the boundary the session
 * manager and executor are written against — they hold a Transport, not a Playwright page.
 */
export interface Transport {
  launcher: ReplayLauncher
  /** build a browser-recipe PageDriver over this transport's rawPage */
  driverFactory(rawPage: unknown): PageDriver
  /** build the network observer relay (undefined = no per-page relay for this transport) */
  relayFactory(rawPage: unknown): ObserverRelay | undefined
  /** run an expression in-page and return its (JSON) value — `look` rides this */
  evaluate(rawPage: unknown, expression: string): Promise<unknown>
  /** a JPEG of the live page as a Buffer (null = unsupported / no result) — `shot` rides this */
  screenshot(rawPage: unknown): Promise<Buffer | null>
  /**
   * a JPEG of ONE element, or null if the selector matches nothing — the QR-login scan rides this.
   *
   * `padRatio` 往元素外面多留一圈（按短边比例，有 16px 下限，且夹在视口内）。**二维码要靠它**：
   * QR 规范要求四周有一圈静默区（quiet zone），裁到元素边框正好把那圈切掉，扫码器就认不出来
   * ——2026-07-29 用户实测「边缘扫不出」。默认 0（紧贴元素），只有需要留白的调用方才传。
   */
  elementShot(rawPage: unknown, selector: string, padRatio?: number): Promise<Buffer | null>
  /**
   * Where the page really is, per the BROWSER — never per the page.
   *
   * This must not be `evaluate('location.href')`: an expression runs in the page's own world,
   * where the page can hand back whatever it likes (it can shadow the accessors, or override
   * the `JSON.stringify` the look-wrapper flattens through). A page that wants to be acted on
   * while pretending to be somewhere else is exactly the case this answer exists to catch, so
   * asking the page is asking the suspect. This reads a browser-process record instead.
   */
  url(rawPage: unknown): Promise<string>
  /**
   * 把这个标签放到前面来。**只在用户显式要求时**（focusFacilityTab），采集链路不调。
   *
   * **为什么每次运行都要调，而不是建标签时调一次就够**：建标签时它确实是当前窗口的活动标签，
   * 但用户下一秒就会切回 Stream 去看结果——等到下一次运行（detail 骑着同一个标签点开笔记），
   * 它早就在后台了。而后台标签的可信输入由 focus 仿真兜住（见 RecipeSessionSpec.visibility），
   * 一帧都不用逼；**真帧本身它救不了**（见 browser-ext.ts 的注释），但采集链路今天也不要真帧了
   * ——"逼帧"整条已摘，见 browser-ext-drive.ts 的 sleep。要真帧的只剩 settle 与 cdp_shot。
   */
  bringToFront(rawPage: unknown): Promise<void>
}

export interface TransportDeps {
  /** the ext-cdp launcher (the user's own Chrome over the relay) */
  extLauncher: ReplayLauncher
  /** the shared CDP relay backing the ext-cdp network observer */
  extRelay: ObserverRelay
  /**
   * DebugBox 的入口，给 driver 里那些**不改变行为的静默出口**留痕用（今天只有 goto 撞 readyState
   * 上界那一条，见 GOTO_READY_BUDGET_MS）。可选：不给就是不留痕，测试里没人要看这个。
   */
  onDebug?: (entry: DebugEntry) => void
}

/**
 * The transport every session runs on: the user's own visible Chrome via the extension relay
 * (evalExpr + CDP Input/screenshot). It carries the user's real logins, so nothing here injects
 * cookies — that was CloakBrowser's tax for being a browser the user had never logged into.
 */
export function resolveTransport(deps: TransportDeps): Transport {
  return {
    launcher: deps.extLauncher,
    driverFactory: (rawPage) => makeExtPageDriver(rawPage as ExtRawPage, { onDebug: deps.onDebug }),
    relayFactory: () => deps.extRelay,
    evaluate: (rawPage, expression) => (rawPage as ExtRawPage).evalExpr(expression),
    screenshot: async (rawPage) => captureJpeg(rawPage as ExtRawPage),
    // Clip to the element's own box: read the rect in-page, then let the BROWSER crop. Doing it
    // this way (rather than rasterizing in-page) works for any element — an <img>, a <canvas>,
    // or a div with the QR as a background — because it screenshots what is actually painted.
    elementShot: async (rawPage, selector, padRatio = 0) => {
      const rect = (await (rawPage as ExtRawPage).evalExpr(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return null;
          const pad = ${padRatio} > 0 ? Math.max(16, Math.round(Math.min(r.width, r.height) * ${padRatio})) : 0;
          // 往外扩之后夹回视口内：负坐标 / 超出右下边界的 clip 截出来是空的或报错，
          // 而"扩不出去"只是边留窄一点，不该让整张图作废。
          const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad);
          const width = Math.min(innerWidth - x, r.width + pad * 2);
          const height = Math.min(innerHeight - y, r.height + pad * 2);
          return { x, y, width, height, scale: 1 } })()`,
      )) as { x: number; y: number; width: number; height: number; scale: number } | null
      if (!rect) return null
      return captureJpeg(rawPage as ExtRawPage, rect)
    },
    // The navigation history is the browser's own record, kept by the NavigationController —
    // not something the page's JS can rewrite. (The extension ALSO re-checks the domain against
    // `chrome.tabs.get` before each mutating action; that check is closer to the browser still,
    // and this one exists so a caller holding only a Transport gets an honest answer too.)
    url: async (rawPage) => {
      const h = (await (rawPage as ExtRawPage).cdp('Page.getNavigationHistory')) as
        | { currentIndex?: number; entries?: Array<{ url?: string }> }
        | undefined
      return h?.entries?.[h.currentIndex ?? -1]?.url ?? ''
    },
    // 用 CDP 的 Page.bringToFront 而不是给扩展加一条 `activateTab` 命令：这条命令走的是已有的
    // debugger 通道（扩展侧对 CDP 命令是纯透传），前置一个**自己开的、已在会话标签组里的**标签
    // 不需要新的协议面。它激活标签并把所在窗口提到前面。
    //
    // **采集链路不调它**——一次都不。唯一的调用方是 `RecipeSessionManager.focusFacilityTab`，
    // 也就是用户点「带我去看登录页」的那一下：抢屏只在他显式要求时发生。
    bringToFront: async (rawPage) => {
      await (rawPage as ExtRawPage).cdp('Page.bringToFront')
    },
  }
}

async function captureJpeg(
  rawPage: ExtRawPage,
  clip?: { x: number; y: number; width: number; height: number; scale: number },
): Promise<Buffer | null> {
  const res = (await rawPage.cdp('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 60,
    ...(clip ? { clip } : {}),
  })) as { data?: string } | undefined
  return res?.data ? Buffer.from(res.data, 'base64') : null
}
