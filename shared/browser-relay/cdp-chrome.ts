/**
 * chrome 这一档面的四个动词（look / shot / act / pages）——**唯一一档只靠扩展中继就成立的面**，
 * 所以它住在这里而不是 `src/mcp/cdp-router.ts`：没有 Stream 后端的宿主（DSH 插件）也只有它。
 *
 * 边界怎么划的：`CdpRouterDeps` 里 `chrome*` 那七格全部依赖「一条通往扩展的中继」，
 * 不依赖 Stream 的任何域；`facility*`（采集会话）与 `desktop`（host agent 的 a11y 树）两档各自
 * 牵着 Stream 专属的运行时，一格都不能跟过来——`closure.test.ts` 会当场变红。
 *
 * 这里**只做 chrome 档内部的语义**，不做「target 是哪一档」的分流：分流是宿主自己的事
 * （Stream 有三档要选，插件只有一档），把它塞进来会逼着插件也认识 facility/desktop。
 */
import type { ActionSpec, LaneAction, ActResult } from './interactive-gate.ts'
import { inventoryExpression, REF_ATTRIBUTE } from './page-inventory.ts'

export interface ChromeSurfaceDeps {
  /** 开一张临时标签跑 js（`interactive` 时留着不关）。 */
  /** `inventory:true` 时不跑 `js`，要的是跨 iframe 的元素清单。 */
  chromeCdp: (url: string, js: string, opts?: { interactive?: boolean; inventory?: boolean }) => Promise<unknown>
  /** `frame` 给了就在那个 iframe 里求值（frame id 或 URL 片段）。 */
  chromeLook: (tabId: number, js: string, frame?: string) => Promise<unknown>
  /** 跨 iframe 的元素清单（编号全 tab 唯一）。 */
  chromeInventory: (tabId: number) => Promise<unknown>
  chromeShot: (tabId: number) => Promise<string | null>
  chromeAct: (action: LaneAction, confirmed?: boolean) => Promise<ActResult>
  /** find-or-open 一张标签（不 attach、不注入——所以 chrome://* 也开得了），回执带 title。 */
  chromeOpen: (url: string, opts?: { ownWindow?: boolean }) => Promise<{ tabId: number; title: string; url: string; created: boolean }>
  chromeTabs: () => Promise<Array<{ tabId: number; url: string; title: string; active?: boolean; openerTabId?: number }>>
  chromeCloseTab: (tabId: number) => Promise<void>
}

/** `chrome:<address>` 里的 address 必须是个 tabId。错误话术里带上「从 cdp_pages 拿一个」——
 *  模型手里没有 tabId 时唯一正确的下一步就是那个动词，不写出来它会去猜数字。 */
export const chromeTabId = (address: string | undefined, verb: string): number => {
  const n = Number(address)
  if (!address || !Number.isFinite(n)) {
    throw new Error(`chrome ${verb} needs a tabId, e.g. chrome:42 (get one from cdp_pages)`)
  }
  return n
}

/**
 * `inventory` 是 `js` 的一个**预制表达式**，不是它的修饰符：两个一起给意味着调用方以为能
 * "既跑我的脚本又拿清单"，而实际只会有一个生效——所以拒掉，别猜。
 *
 * 放在共享库而不是各宿主自己写一遍：这条判据一旦分家，同一个调用在两个宿主上一个报错一个静默
 * 丢掉 `js`，而两边单看都"正常"。
 */
export function resolveLookJs(a: { js?: string; inventory?: boolean }): string {
  if (a.inventory && a.js) throw new Error(`cdp_look: inventory 与 js 二选一（inventory 就是一段预制的 js）`)
  const js = a.inventory ? inventoryExpression() : a.js
  if (!js) throw new Error(`cdp_look needs js (an expression to evaluate) or inventory:true`)
  return js
}

/** `ref:<n>` 展开成 selector。**只在 chrome 档成立**（编号来自 `cdp_look({inventory:true})`
 *  往真实 DOM 上打的属性），所以展开逻辑跟着 chrome 档走。 */
export function expandRef<T extends { selector?: string }>(spec: T, ref: number): T {
  if (spec.selector) throw new Error(`cdp_act: ref 与 selector 二选一（ref 展开后就是一个 selector）`)
  return { ...spec, selector: `[${REF_ATTRIBUTE}="${ref}"]` }
}

export async function chromeLookVerb(
  deps: ChromeSurfaceDeps,
  a: { address?: string; js: string; url?: string; interactive?: boolean; inventory?: boolean; frame?: string },
): Promise<unknown> {
  // `inventory` 与 `frame` 互斥：清单本来就跨全部 frame，再指一个 frame 是自相矛盾。
  if (a.inventory && a.frame) throw new Error(`cdp_look: inventory 已经跨全部 iframe，不要再给 frame`)
  if (a.url) {
    if (a.frame) throw new Error(`cdp_look: frame 只能配已开着的标签（chrome:<tabId>）——带 url 的这一发连页面都还没有`)
    // exactOptionalPropertyTypes（`@streamapp/desktop` 那份更严的 tsconfig 会拿这一行较真，同
    // `relay.ts` 里那两处）：可选字段显式赋 `undefined` 与"没有这个键"在那个选项下是两回事——
    // 只在真有值时才铺进去。
    return deps.chromeCdp(a.url, a.js, {
      ...(a.interactive !== undefined ? { interactive: a.interactive } : {}),
      ...(a.inventory ? { inventory: true } : {}),
    })
  }
  if (a.address) {
    const tabId = chromeTabId(a.address, 'look')
    if (a.inventory) return { value: await deps.chromeInventory(tabId) }
    return { value: await (a.frame ? deps.chromeLook(tabId, a.js, a.frame) : deps.chromeLook(tabId, a.js)) }
  }
  throw new Error(`chrome look needs a url (to open a tab) or a tabId (chrome:<id> — from cdp_pages)`)
}

export async function chromeShotVerb(
  deps: ChromeSurfaceDeps,
  a: { address?: string },
): Promise<{ shot: string | null }> {
  return { shot: await deps.chromeShot(chromeTabId(a.address, 'shot')) }
}

export async function chromeActVerb(
  deps: ChromeSurfaceDeps,
  a: { address?: string; confirmed?: boolean; spec: ActionSpec },
): Promise<ActResult> {
  const spec = a.spec
  // open 是 chrome 这一档里唯一**不要 tabId** 的动作：它的输入是一个 URL，输出才是 tabId
  // （要 tabId 就成了先有鸡后有蛋——调用方只好从 bash 起 chrome.exe，没有任何回执，失败不可知）。
  //
  // 它也**不过高危确认门**：门在 chromeAct 里，这条路绕开它是故意的。开一张新标签与
  // `cdp_look({target:'chrome', url})` 同级，而后者从来不设门；goto 的门管的是"把一个
  // 已有 tab 劫持到别的站"，开新标签不是那件事（见 interactive-gate 的 classifyAction）。
  if (spec.kind === 'open') {
    if (!spec.targetUrl) throw new Error(`chrome open needs targetUrl (the page to open)`)
    return {
      status: 'done',
      result: await (spec.ownWindow ? deps.chromeOpen(spec.targetUrl, { ownWindow: true }) : deps.chromeOpen(spec.targetUrl)),
    }
  }
  return deps.chromeAct({ ...spec, tabId: chromeTabId(a.address, 'act') }, a.confirmed)
}

export async function chromePagesVerb(
  deps: ChromeSurfaceDeps,
  a: { close?: number },
): Promise<{ closed: number } | { pages: Array<{ tabId: number; url: string; title: string }> }> {
  if (typeof a.close === 'number') {
    await deps.chromeCloseTab(a.close)
    return { closed: a.close }
  }
  return { pages: await deps.chromeTabs() }
}
