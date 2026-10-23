import {
  getConfig, setConfig, mergeDomains, matchesSyncedDomain, PROBE_CANDIDATES,
  LOCAL_BINDING, allowedDomains, getBinding, getBindings, setBinding, storageKey, type Binding,
} from './config.ts'
import { serializeCookie } from './cookie-shape.ts'
import { setNotifySocket } from './relay-notify.ts'
// sync.ts 只依赖 config / stream-api / relay-notify，不依赖本文件——加这条不会成环。
import { runSync } from './sync.ts'
import { nativeHostToken } from './native-host.ts'
import { verifyBackend } from './backend-identity.ts'
import { getNode, nodeQuery } from './node.ts'
import { handleClaimReply } from './claim.ts'
import { findPairedPeer } from './pairing.ts'
import { RELAY_PROTOCOL as EXT_RELAY_PROTOCOL } from '@browser-relay/wire.ts'

/** 中继线协议（与 shared/browser-relay/wire.ts 一致——两侧唯一真相源）。 */
export type Inbound =
  // CDP 命令。expectDomain：动作发起时 captured 的域名——执行前若 tab 已导航到别的域名则拒
  // （逐动作域名校验）。读类动作/旧后端可不带，不带则不校验。
  // sessionId：打给这张标签里某个 OOPIF 的 CDP 子会话（见 frames op）。缺席 = 标签主会话。
  | { id: number; tabId: number; method: string; params: unknown; expectDomain?: string; sessionId?: string }
  // 这张标签里跨站 iframe（OOPIF）的子会话清单——后端要在 iframe 里读/点，靠它找到会话。
  | { id: number; op: 'frames'; tabId: number }
  | { id: number; op: 'newTab'; url: string; waitUntil?: string; background?: boolean }
  | { id: number; op: 'closeTab'; tabId: number }
  // 「打开一个页面」这件事本身——find-or-open，**不挂 debugger、不注入脚本**。
  // 正因为什么都不挂，它开得了 `chrome://*` 这类特权页（newTab 那条路会在 attach 一步炸
  // `Cannot access a chrome:// URL`，而 tab 其实已经建出来了——留下一个没人管的空窗口）。
  // 新建的标签**照样入会话组**（用户自己早开着、被 find 命中的那张不动）：组是"这张标签是
  // Stream 开的"的归属与可见边界，不是"可不可被驱动"的判据。
  | { id: number; op: 'openTab'; url: string }
  | { id: number; op: 'subscribe'; tabId: number; domains: string[] }
  | { id: number; op: 'unsubscribe'; subscriptionId: number }
  | { id: number; op: 'list' } // 枚举会话组内 tab（AI 靠它认目标，不靠猜）
  // login detect 便宜的那一半：某个域下现在有哪些 cookie **名字**。会话 cookie 一个都不在
  // ⇒ 一定没登录，后端据此直接 decline，连 tab 都不用开。反过来不成立（名字在不代表服务端
  // 还认），所以它只用来否定；肯定判据仍是页面上的 loginCheck 选择器。
  | { id: number; op: 'cookieNames'; domain: string }
  // 后端主动来取登录态（值）。取代了扩展定时往后端推的那条路——**调度权归后端**：它知道
  // 什么时候要采集、手里那份多旧、刚刚是不是吃了个 401，扩展不知道任何一件。
  // 范围由扩展这边闸死（见 dispatch 里的实现），不是后端说哪个域就给哪个域。
  | { id: number; op: 'cookiePull'; domains: string[] }
  // 前台采集把用户的 active 标签抢走了，跑完要还回去。分两步：动手前 `activeTab` 记下他原来
  // 在哪，跑完 `activateTab` 切回。还回去带一道礼貌闸门——见下面 dispatch 里的说明。
  | { id: number; op: 'activeTab' }
  | { id: number; op: 'activateTab'; tabId: number }
  // 被 Stream 静默唤起的 profile（browser-identity D8）：执行期间按住它（关最后一张标签不关窗——关了窗
  // Chrome 就卸载这个 profile，执行还没完），执行完放掉（关自己的标签与窗，换来卸载）。见 releaseProfile。
  | { id: number; op: 'holdProfile' }
  | { id: number; op: 'releaseProfile' }

const OWNED_KEY = 'ownedTabs'
const GROUP_KEY = 'tabGroup'
/** 「本次扩展加载已判过账本时效」的标记，存 storage.session —— 见 ensureLedgerFresh。 */
const LEDGER_CHECKED_KEY = 'tabGroupChecked'
/** 第一次 hydrate 给 onStartup 留的宽限期（只在真有账本时等，每次扩展加载至多一次）。 */
const STARTUP_GRACE_MS = 2000
/** 会话标签组在标签栏上的名字 —— 用户认边界靠它。 */
const GROUP_TITLE = 'Stream'
/** 旧版在主组以外的窗里另建的组的名字前缀（「Stream 独立窗」/「Stream 独立窗 · <配对名>」）。
 *  新版不再建这种组（一条绑定只有一个组，见 adoptOpenedTab），留着它只为醒来时认出旧组、收编掉
 *  （见 absorbLegacyGroups）。 */
const LEGACY_WINDOW_GROUP_PREFIX = 'Stream 独立窗'
const DEBUGGER_VERSION = '1.3'

/**
 * 把一件**关键低频**的生命周期事件记进后端 debug bus（`GET /api/debug/log?channel=ext-cdp`）。
 *
 * 为什么必须有：SW 的 console 只在用户亲手打开那个 devtools 窗口时才有人看，而这里要记的三件事
 * （onStartup 触发、账本作废、认领旧组）全发生在没人看着的那一刻——2026-08-02 的红线验证想找它们
 * 的字面证据，只能靠读代码反推。
 *
 * **走 HTTP 不走中继的 WS**：这三件事都发生在 connect 之前（reconcile 先于连线），走 WS 等于
 * 永远记不到最需要的那一刻。
 *
 * **绝不抛、绝不等**：日志通道自己不能把主流程弄挂。后端没起、没配 baseUrl → 静默算了；
 * console.warn 那一份照留，本地开 devtools 时仍然一眼可见。
 *
 * **只给低频事件用**。每个 tab 的 add/remove 这类高频路径不许打——那会把 200 条的环形缓冲
 * 冲干净，等于把这条通道废掉。
 */
function debugLog(
  event: string,
  summary: string,
  fields: Record<string, unknown> = {},
  opts: { ok?: boolean } = {},
): void {
  console.warn(`[ext-cdp] ${event}: ${summary}`, fields)
  void (async () => {
    const { baseUrl } = await getConfig()
    if (!baseUrl) return
    await fetch(baseUrl.replace(/\/$/, '') + '/api/ext/debug-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event,
        summary,
        // 生命周期事件不是故障 → 缺省 true。慢命令那两条报 false，好让 DebugBox 的
        // "只看失败"能同时留下它和后端侧配对的 relay-slow / relay-timeout（少一半就会
        // 把人引到"命令没送到 SW"那个错结论上）。
        ...(opts.ok === false && { ok: false }),
        // `undefined` 的字段直接丢掉：缺席就是缺席，绝不让它变成 "undefined" 或 0
        // ——0 会被读成"这一跳很快"，那是个读起来毫无破绽的错误结论。
        fields: Object.entries(fields)
          .filter(([, value]) => value !== undefined)
          .map(([label, value]) => ({ label, value })),
      }),
    })
  })().catch(() => {})
}

// ── owned tab 集合：SW 内存副本为权威，chrome.storage.session 为 SW 回收后的恢复快照 ──
// 关键：MV3 的 message 处理器跨 await 交错，若用「读 storage → 改 → 写 storage」会因并发
// newTab/closeTab 交错而丢更新（违反多 tab 并行）。故所有读改写经 withOwned 串行化。
let ownedMem: Set<number> | null = null
let mutateQueue: Promise<unknown> = Promise.resolve()
let nextSubscriptionId = 1

/**
 * 一条扩展绑定的会话状态（design D7：一个扩展可以同时服务好几个 Stream）。今天模块级的那几样——
 * 会话标签组与它的串行队列、订阅、事件 socket、退避、在线标记——每条绑定一份：实例 A 的组里的标签，
 * 实例 B 碰不到。**按 tab 的状态不进来**（childSessions、autoAttached、closingTabs、memberBornAt、
 * owned 集合）：一张 tab 至多属于一条绑定，按 tabId 记本来就不会串。
 *
 * 本机那条（`local`）的存储键、组名与以前一字不差——升级后已有的组与账本原样认领。
 */
export class BindingRuntime {
  groupMem: GroupState | null = null
  // 组身份（groupId）是共享状态：慢操作 chrome.tabs.group 同时读它（要不要新建组）又写它，
  // 故整条 addTabToGroup 串行化，保证"一会话一组"不变量（不像 owned 那样把慢操作放 mutex 外）。
  groupQueue: Promise<unknown> = Promise.resolve()
  // once-guard：memoize in-flight hydrate promise（不只 memoize 结果 groupMem）。groupMem 冷时，
  // 队列内 hydrate 与队列外只读访问器（groupId/tabOrigin/groupMembers，不走 groupQueue）会并发
  // 触发两次「读 storage → 赋值 groupMem」，后写者用冷快照覆盖已立好 groupId 的单例 → 下一个
  // addTabToGroup 误判「无组」建出第二个组，破坏「一会话一组」。共享同一 in-flight promise 后，
  // 并发只 hydrate 一次、都拿到同一个 GroupState，杜绝覆盖。
  hydratingGroup: Promise<GroupState> | null = null
  readonly subscriptions = new Map<number, { tabId: number; domains: Set<string> }>()
  eventSocket: WebSocket | null = null
  backoff = 1000
  pendingRetry: { timer: ReturnType<typeof setTimeout>; run: () => void } | null = null
  relayUp = false
  /** 这条绑定的连接已经起过（本 SW 实例内）——同一条绑定只连一条，见 startExtCdp 头注。 */
  started = false
  /** 用户移除了这条绑定：断线后不再重连。 */
  stopped = false
  constructor(
    readonly id: string,
    /** 标签栏上的组名。本机是 `Stream`；配对绑定带上它的名字，好让用户分得清是哪个 Stream 在动。 */
    readonly groupTitle: string = GROUP_TITLE,
  ) {}
  get groupKey(): string {
    return storageKey(GROUP_KEY, this.id)
  }
  /** 这条绑定在旧版里那些「独立窗」组的名字：主组名把开头的 `Stream` 换成前缀，配对名的尾巴照留。 */
  get legacyWindowGroupTitle(): string {
    return LEGACY_WINDOW_GROUP_PREFIX + this.groupTitle.slice(GROUP_TITLE.length)
  }
}

const runtimes = new Map<string, BindingRuntime>()

/** 某条绑定的会话状态（没有就建）。缺省 = 本机那条。 */
export function runtime(id: string = LOCAL_BINDING, label?: string): BindingRuntime {
  let rt = runtimes.get(id)
  if (!rt) {
    rt = id === LOCAL_BINDING
      ? new BindingRuntime(id)
      : new BindingRuntime(id, `${GROUP_TITLE} · ${label ?? id}`)
    runtimes.set(id, rt)
  }
  return rt
}
// 本机那条永远在：遍历 runtimes 的那些监听（拖入/拖出、新开标签、CDP 事件）不能因为还没人问过它就漏掉它。
runtime()

function domainOf(method: string): string {
  return method.split('.')[0] ?? ''
}

async function clearSubscriptions(rt: BindingRuntime = runtime()): Promise<void> {
  const subscriptions = rt.subscriptions
  const entries = [...subscriptions.values()]
  subscriptions.clear()
  for (const { tabId, domains } of entries) {
    for (const domain of domains) {
      const stillUsed = [...subscriptions.values()].some((s) => s.tabId === tabId && s.domains.has(domain))
      if (!stillUsed) await chrome.debugger.sendCommand({ tabId }, `${domain}.disable`).catch(() => {})
    }
  }
}

/** 一张 tab 至多属于一条绑定，但它的订阅挂在哪条上不必知道——每条都清一遍。 */
async function clearTabSubscriptions(tabId: number): Promise<void> {
  for (const rt of runtimes.values()) {
    const subscriptions = rt.subscriptions
    const ids = [...subscriptions.entries()].filter(([, sub]) => sub.tabId === tabId).map(([id]) => id)
    for (const id of ids) {
      const sub = subscriptions.get(id)
      subscriptions.delete(id)
      if (!sub) continue
      for (const domain of sub.domains) {
        const stillUsed = [...subscriptions.values()].some((s) => s.tabId === tabId && s.domains.has(domain))
        if (!stillUsed) await chrome.debugger.sendCommand({ tabId }, `${domain}.disable`).catch(() => {})
      }
    }
  }
}

/** 正在被我们关闭、要替它按掉「离开此网站？」的标签（见 removeAcceptingUnload）。 */
const closingTabs = new Set<number>()

// ── iframe 子会话（OOPIF）──────────────────────────────────────────────────────────
// 跨站 iframe 跑在另一个渲染进程里，标签主会话上的 Runtime.evaluate 够不到它。attach 时开
// `Target.setAutoAttach`（flatten），浏览器就把每个 OOPIF 作为一条子会话挂上来
// （`Target.attachedToTarget`，带 sessionId），之后命令带 `{tabId, sessionId}` 就打进那个 iframe。
// 嵌套的 OOPIF 要在子会话上再开一次——auto-attach 不递归。
// 同站 iframe 不在这里：它们和主文档同进程，后端在主会话里用 Page.createIsolatedWorld 够得到。
type ChildSession = { sessionId: string; targetId: string; url: string; parentSessionId?: string }
const childSessions = new Map<number, Map<string, ChildSession>>()
/** 已经开过 auto-attach 的标签。detach 时清掉（下次 attach 要重开）。 */
const autoAttached = new Set<number>()
// filter 只要 iframe：不然专用 worker 之类也会各挂一条子会话，白占着。
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }] }

/** 给一张已 attach 的标签开 auto-attach（每次 attach 一次）。失败不挡主流程——没有它只是够不到 OOPIF。 */
async function ensureAutoAttach(tabId: number): Promise<void> {
  if (autoAttached.has(tabId)) return
  autoAttached.add(tabId)
  await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', AUTO_ATTACH).catch((e) => {
    autoAttached.delete(tabId)
    console.warn('[ext-cdp] Target.setAutoAttach 失败（iframe 子会话不可用）:', e)
  })
}

/** 导出为测试缝。 */
export function frameSessionsOf(tabId: number): ChildSession[] {
  return [...(childSessions.get(tabId)?.values() ?? [])]
}

function trackChildSession(tabId: number, parentSessionId: string | undefined, method: string, params: unknown): boolean {
  if (method === 'Target.attachedToTarget') {
    const p = params as { sessionId?: string; targetInfo?: { type?: string; targetId?: string; url?: string } }
    if (!p?.sessionId || p.targetInfo?.type !== 'iframe' || !p.targetInfo.targetId) return true
    let m = childSessions.get(tabId)
    if (!m) childSessions.set(tabId, (m = new Map()))
    m.set(p.sessionId, {
      sessionId: p.sessionId,
      targetId: p.targetInfo.targetId,
      url: p.targetInfo.url ?? '',
      ...(parentSessionId ? { parentSessionId } : {}),
    })
    void chrome.debugger.sendCommand({ tabId, sessionId: p.sessionId }, 'Target.setAutoAttach', AUTO_ATTACH).catch(() => {})
    return true
  }
  if (method === 'Target.detachedFromTarget') {
    const p = params as { sessionId?: string }
    if (p?.sessionId) childSessions.get(tabId)?.delete(p.sessionId)
    return true
  }
  return false
}

chrome.debugger.onDetach?.addListener?.((source) => {
  if (source.tabId == null) return
  autoAttached.delete(source.tabId)
  childSessions.delete(source.tabId)
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId
  if (tabId == null) return
  if (trackChildSession(tabId, source.sessionId, method, params)) return
  // 子会话里的事件不转给后端的订阅：订阅按标签主会话的语义建的（网络/页面事件），
  // iframe 那边的同名事件混进来只会让消费者把别的文档当成这一页。
  if (source.sessionId) return
  if (method === 'Page.javascriptDialogOpening' && closingTabs.has(tabId)) {
    // 我们正在关它，页面拦了一道 beforeunload → 替用户按「离开」。这是自建标签，关就是关。
    const p = params as { type?: string; message?: string } | undefined
    debugLog('close-dialog-accepted', '关自建标签时页面弹了对话框，已替它按掉', { tabId, type: p?.type, message: p?.message })
    void chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
    return
  }
  const domain = domainOf(method)
  // 订阅挂在哪条绑定上，事件就从那条绑定的连接回去——别的 Stream 收不到这张 tab 的事件。
  for (const rt of runtimes.values()) {
    const eventSocket = rt.eventSocket
    if (!eventSocket) continue
    for (const [subscriptionId, sub] of rt.subscriptions) {
      if (sub.tabId !== tabId || !sub.domains.has(domain)) continue
      try {
        eventSocket.send(JSON.stringify({ type: 'cdp-event', subscriptionId, tabId, method, params }))
      } catch {
        /* reconnect cleanup drops subscriptions */
      }
    }
  }
})

// once-guard：memoize in-flight hydrate promise（不只 memoize 结果 ownedMem）。否则 ownedMem
// 冷时两个并发调用会各跑一遍「读 storage → 赋值 ownedMem」，后写者用旧快照覆盖先写者的新集合。
// 共享同一 in-flight promise 后并发只 hydrate 一次、拿到同一个 Set。
let hydratingOwned: Promise<Set<number>> | null = null
async function hydrateOwned(): Promise<Set<number>> {
  if (ownedMem) return ownedMem
  if (!hydratingOwned)
    hydratingOwned = (async () => {
      const s = await chrome.storage.session.get(OWNED_KEY)
      ownedMem = new Set<number>((s[OWNED_KEY] as number[] | undefined) ?? [])
      return ownedMem
    })()
  return hydratingOwned
}

/** 串行化 owned 的一次读改写并持久化快照；仅覆盖集合变更（不含 tabs.create/waitForNav 等慢操作）。 */
function withOwned<T>(fn: (owned: Set<number>) => T): Promise<T> {
  const run = mutateQueue.then(async () => {
    const owned = await hydrateOwned()
    const out = fn(owned)
    await chrome.storage.session.set({ [OWNED_KEY]: [...owned] })
    return out
  })
  mutateQueue = run.then(
    () => {},
    () => {},
  ) // 无论成败都推进队列，不让一次失败卡死后续
  return run
}

/** 只读判定（内存权威副本，读 Set 是同步的，无 race）。 */
async function isOwned(tabId: number): Promise<boolean> {
  return (await hydrateOwned()).has(tabId)
}

// ── 会话级标签组（CP3 归属边界：从隐形 owned Set 升为浏览器原生可见标签组）──
// 对齐 Anthropic「Claude in Chrome」的 TabGroupManager：一个会话 = 一个 chrome 标签组，
// 组是"AI 可操作范围"的边界；组成员表 + 每个 tab 的出身标记持久化，SW 回收后可 hydrate 恢复。
//
// 账本存 **chrome.storage.local**（键 tabGroup），不是 session。ownedTabs 留在 session，
// 理由与去处见 ensureLedgerFresh 的头注。
//
// 出身标记同时编码两条正交的轴，别把它们混成一条：
//   ① 红线轴「可否 remove」：adopted 绝不 remove，created/probe 可回收。
//   ② 生命周期轴「SW 醒来是否兜底回收」：只有 probe 回收。
// 'created' 与 'probe' 在红线轴上同类、在生命周期轴上相反 —— 这正是三值而非布尔的原因。
type TabOrigin =
  /** AI 自建·给人看的交互 tab（cdp_look target:'chrome' interactive:true）。close 是命令时可回收；
   *  但 SW 醒来绝不动它 —— 用户可能正看着，"SW 恰好重启了一次"不是关它的理由。 */
  | 'created'
  /** AI 自建·后台静默探针（interactive:false）。没人看着它，泄漏了也无人察觉，
   *  所以 SW 醒来必须兜底回收 —— 正常路径由调用方 finally 关闭，这是崩溃时的网。 */
  | 'probe'
  /** 用户亲手拖入 = 授权。只 detach + ungroup 撤销，**绝不 remove**：
   *  那是用户自己的 tab、可能有未保存数据，销毁它是红线。 */
  | 'adopted'

/** 红线判据：这个出身的 tab 可否被我们 chrome.tabs.remove。用户拖入的永远不可。 */
function mayRemove(origin: TabOrigin): boolean {
  return origin !== 'adopted'
}
// **一条绑定只有一个组（groupId）。** 标签组不能跨窗，旧版为别的窗里开出的新标签在那扇窗另建组，
// 交互标签又不回收，窗和组只增不减（用户攒了近 50 个）。现在别的普通窗里的新标签一律挪回主组那扇窗
// （见 adoptOpenedTab），浏览器里永远至多一个我们的组——用户认边界只需认这一个。
// popups:开在 popup 窗里的在册标签(被 Stream 自己的标签 `window.open(…,'popup')` 开出来的)。
// popup 窗放不了标签组,也不能把标签挪出去,所以它们是"在册但不在组"的唯一一类——归属判据
// 对它们退回"账本有 ∧ 浏览器里还在 ∧ 窗口仍是 popup"。
// legacyGroups:旧版账本里记着的「独立窗」组 id，只在水合时从旧快照读出来，供醒来收编用，
// **不再写回**——下一次 persistGroup 之后它就从存储里消失了。
type GroupState = {
  groupId: number | null
  popups: Set<number>
  members: Map<number, TabOrigin>
  legacyGroups?: number[]
}
/** windowGroups 是旧版字段：只读（升级后的第一次醒来要靠它认出旧组），不写。 */
type GroupSnapshot = { groupId: number | null; windowGroups?: number[]; popups?: number[]; members: [number, TabOrigin][] }

/** 这个 groupId 是不是我们的组。 */
function isOurGroup(g: GroupState, gid: number | undefined): boolean {
  return gid != null && gid !== -1 && gid === g.groupId
}

// 组状态与它的串行队列、水合闸按绑定各一份，住在 BindingRuntime 上（理由见那边的注释）。
async function hydrateGroup(rt: BindingRuntime = runtime()): Promise<GroupState> {
  if (rt.groupMem) return rt.groupMem
  if (!rt.hydratingGroup)
    rt.hydratingGroup = (async () => {
      await ensureLedgerFresh() // 先判时效：上一次浏览器会话的账本必须在这里就死掉
      const s = await chrome.storage.local.get(rt.groupKey)
      const snap = s[rt.groupKey] as GroupSnapshot | undefined
      rt.groupMem = {
        groupId: snap?.groupId ?? null,
        popups: new Set(snap?.popups ?? []),
        members: new Map(snap?.members ?? []),
        ...(snap?.windowGroups?.length ? { legacyGroups: snap.windowGroups } : {}),
      }
      return rt.groupMem
    })()
  return rt.hydratingGroup
}

async function persistGroup(g: GroupState, rt: BindingRuntime = runtime()): Promise<void> {
  const snap: GroupSnapshot = {
    groupId: g.groupId,
    ...(g.popups.size ? { popups: [...g.popups] } : {}),
    members: [...g.members],
  }
  await chrome.storage.local.set({ [rt.groupKey]: snap })
}

// ── 账本的时效：存哪儿、什么时候作废 ──────────────────────────────────────────
//
// **为什么不能存 storage.session**：session 在**扩展一重载**时就被清空（Chrome 文档：
// "cleared if the extension is disabled, reloaded, updated, and when the browser restarts"）。
// 清空后 reconcileOnWake 只剩 findExistingGroup 那条路认领遗留组，认不出出身，于是一律标
// 'adopted'。那是"我不知道，往安全方向猜"的默认值，不是"我看见用户拖进来"的观测事实——
// 而开发期天天重载扩展，于是组里所有 probe 永久免疫回收，reclaimOrphanTabs 形同虚设。
//
// **搬到 storage.local 之后，新问题是记录活得太久**：local 跨浏览器重启存活，而 **tabId 只在
// 一次浏览器会话内有意义**（重启后会复用给完全无关的标签）。拿着过期账本动手 = 对陌生标签
// 下手，比原来的缺口更危险。所以搬家必须配一个失效判据。
//
// **判据 = chrome.runtime.onStartup**。文档写死它 "Fired when a profile that has this
// extension installed first starts up" —— 只在浏览器 profile 启动时触发，**扩展重载不触发**
// （重载走的是 onInstalled）。于是两条路各自到位：重载 → 没有 onStartup → 账本原样留着，
// 出身保住；浏览器重启 → onStartup → 账本作废，退回"认领现存组 + 一律 adopted"的保守老行为
// （红线不动：认不出出身就绝不 remove）。
//
// **还有一道时序闸门。** 浏览器启动时 SW 顶层代码与 onStartup 派发几乎同时发生，谁先谁后
// 不由我们决定；不等一下就可能"拿着上一次会话的账本先把探针收了、onStartup 随后才到"。所以
// 本次扩展加载的第一次 hydrate 会给 onStartup 留一个短暂宽限期。两处便宜：只在**真有账本**
// 时才等（全新会话零成本），且判定结果记进 storage.session ——它活得比 SW 长、又恰好在扩展
// 重载/浏览器重启时清空，正是"每次扩展加载判一次"的作用域，SW 被回收重启不会重等。
//
// **ownedTabs 仍留在 storage.session，别跟着搬。** 它驱动的是 reconcileOnWake 末尾那段**无条件
// 的 chrome.tabs.remove**（旧版残留清理）；那段没有出身可分流，一旦跨浏览器重启存活，复用的
// tabId 就会让它去关用户的标签。它本来就只需要活到 SW 回收，session 的时效正合适。
//
// **已知残余缺口**（判据不成立的两格，都只会让"上一次会话的账本被当成本次的"）：
//   ① 整个浏览器会话里从头到尾没有 onStartup —— 扩展在浏览器已经跑着的时候才被启用
//      （上一次会话结束前被禁用、跨过一次重启、本次会话中途才启用）。
//   ② onStartup 迟到超过宽限期。故意**不**补一个"迟到也作废"的处理器：它得在这中间已经建好的
//      组/出身还活着的时候动手删账本，换来的新故障（刚建好的组连同出身一起被抹掉）比它堵的洞更常见。
// 两格的代价都止于"可能 remove 一个复用了旧 tabId、且恰好落在同一个 groupId 里的标签"——
// adopted 红线仍然拦着用户拖入的那一类。要彻底堵上得有一个能**同步**读到的"本次浏览器会话"
// 标识，Chrome 没有提供（storage.session 在重载时也清，区分不了重载与重启）。
let startupSeen = false
let announceStartup: (() => void) | null = null
const startupFired = new Promise<void>((resolve) => {
  announceStartup = resolve
})

/** onStartup 这个信号在本环境里到底存不存在。不存在就既不等它、也不据它作废——
 *  等一个永远不会来的信号只是白等，而"没等到"在那种环境里也不构成"这是同一次浏览器会话"的证据。
 *  真实 MV3 扩展里它必定存在；为 false 只发生在没有 chrome.runtime 的替身环境。 */
let startupWatchable = false

/** 注册 onStartup 监听（顶层同步注册——MV3 只认这个时机）。 */
;((): void => {
  const ev = (chrome as { runtime?: { onStartup?: { addListener?: (fn: () => void) => void } } }).runtime?.onStartup
  if (!ev?.addListener) return
  startupWatchable = true
  ev.addListener(() => {
    startupSeen = true
    announceStartup?.()
    // 「这是新一次浏览器会话」的唯一信号，整套账本时效判定都挂在它身上；它没来是已知缺口
    // （见 ensureLedgerFresh 头注的两格），所以它来没来必须留下字面证据。
    debugLog('onStartup', 'onStartup 触发——新一次浏览器会话')
  })
})()

let ledgerCheck: Promise<void> | null = null

/** 账本时效判定：本次扩展加载至多跑一次实体逻辑，之后由 storage.session 里的标记短路。 */
function ensureLedgerFresh(): Promise<void> {
  ledgerCheck ??= (async () => {
    const mark = await chrome.storage.session.get(LEDGER_CHECKED_KEY)
    if (mark[LEDGER_CHECKED_KEY]) return // 本次扩展加载已判过（SW 回收不清 session）
    const stored = await chrome.storage.local.get(GROUP_KEY)
    // 配对绑定的账本同一个时效：tabId 只在一次浏览器会话内有意义，与是哪个 Stream 的组无关。
    const pairedKeys = (await getBindings())
      .filter((b) => b.kind === 'paired')
      .map((b) => storageKey(GROUP_KEY, b.id))
    const pairedStored = pairedKeys.length ? await chrome.storage.local.get(pairedKeys) : {}
    const pairedLedgers = pairedKeys.filter((k) => pairedStored[k])
    if (startupWatchable && (stored[GROUP_KEY] || pairedLedgers.length)) {
      // 有账本才值得等 onStartup：等的是"这到底是重载还是重启"这一个问题的答案。
      if (!startupSeen)
        await Promise.race([startupFired, new Promise((r) => setTimeout(r, STARTUP_GRACE_MS))])
      if (startupSeen) {
        if (stored[GROUP_KEY]) {
          await chrome.storage.local.remove(GROUP_KEY) // 新一次浏览器会话 → 旧账本作废
          const snap = stored[GROUP_KEY] as { members?: unknown[] } | undefined
          debugLog('ledger-cleared', '上一次浏览器会话的账本已作废', {
            members: Array.isArray(snap?.members) ? snap.members.length : '未知',
          })
        }
        for (const k of pairedLedgers) await chrome.storage.local.remove(k)
      }
    }
    await chrome.storage.session.set({ [LEDGER_CHECKED_KEY]: true })
  })()
  return ledgerCheck
}

/**
 * 给刚建好的组起名 + 上色。
 *
 * 这不是装饰：整套归属模型的前提是这个组**对用户可见可辨**——拖进去=授权、拖出来=撤销。
 * 一块灰色无字的组用户认不出那是"AI 正在操作的范围"，边界就没长在他眼里。
 *
 * 只在**建组时**叫一次：用户要是把它改名了，那是他的组，我们不该每加一个 tab 就覆写回去。
 *
 * 整段 try/catch 而非 `?.` + `.catch()`：没有 tabGroups 权限时（旧构建、或权限被撤），
 * `chrome.tabGroups` 或它的 `update` 压根不存在，那是一个**同步** TypeError —— `.catch()`
 * 接不住它，而且 `?.` 短路出的 undefined 上再调 `.catch` 本身又是一个 TypeError。
 * 归属判据靠的是 groupId 不是标题：命名失败是装饰失败，绝不能拖垮建组。
 */
async function nameGroup(groupId: number, title = GROUP_TITLE): Promise<void> {
  try {
    await chrome.tabGroups.update(groupId, { title, color: 'blue' })
  } catch (e) {
    // 不抛 ≠ 不吭声：静默 catch 会让"组为什么还是灰的"变成一个只能靠猜的问题（真踩过）。
    // 组照样能用，但把失败留在 SW 控制台里，下次一眼看见。
    console.warn('[ext-cdp] 会话标签组命名失败（组仍可用，只是没名字）:', e)
  }
}

/**
 * 找浏览器里现存的会话组（按标题）——账本里没有 groupId（浏览器重启作废了它、或从未建组）
 * 时据此认领旧组、别另建。
 * 返回第一个匹配组的 id + 它当前的 tab ids；无匹配 / 无 tabGroups 权限 → null。
 * 多个同名组（历史残留）只取第一个——醒来时 mergeMainGroups 已先把它们并成一个。
 */
async function findExistingGroup(rt: BindingRuntime = runtime()): Promise<{ groupId: number; tabIds: number[] } | null> {
  try {
    const groups = await chrome.tabGroups.query({ title: rt.groupTitle })
    if (!groups.length) return null
    const groupId = groups[0].id
    const tabs = await chrome.tabs.query({ groupId })
    return { groupId, tabIds: tabs.map((t) => t.id).filter((id): id is number => id != null) }
  } catch {
    return null
  }
}

/** 本 SW 实例里各 tab 的建档时刻，**只在内存**、不进 storage。
 *  用途只有一个：`reclaimOrphanTabs` 的宽限期——采集刚建完标签、后端那边 lane 还没登记好的
 *  那一瞬间，对账会看到"后端不认"。建标签的就是这个 SW，所以它自己知道谁是刚生的。
 *  **刻意不持久化**：跨 SW 生命周期的标签根本构不成这个竞态（它要么已被后端登记、要么真是孤儿），
 *  持久化只会让宽限期在重启后继续护着真孤儿。 */
const memberBornAt = new Map<number, number>()

/** 把一个 tab 归入会话标签组（首个 tab 建新组，其后追加进同一组），记出身标记并持久化。返回 groupId。 */
export async function addTabToGroup(tabId: number, origin: TabOrigin, rt: BindingRuntime = runtime()): Promise<number> {
  memberBornAt.set(tabId, Date.now())
  return inGroupQueue(rt, async () => {
    const g = await hydrateGroup(rt)
    const groupId = await groupIntoMain(g, tabId, rt)
    g.members.set(tabId, origin)
    await persistGroup(g, rt)
    return groupId
  })
}

/** 把一段读改写组状态的活排进这条绑定的 groupQueue（理由见 BindingRuntime.groupQueue 的注释）。 */
function inGroupQueue<T>(rt: BindingRuntime, fn: () => Promise<T>): Promise<T> {
  const run = rt.groupQueue.then(fn)
  rt.groupQueue = run.then(
    () => {},
    () => {},
  ) // 无论成败都推进队列，一次失败不卡死后续
  return run
}

/**
 * 把一张标签放进**主组**——这条绑定唯一的组。不记出身、不排队：调用方已在 groupQueue 里。
 * 主组不在了（从未建过 / 用户解散 / 主组那扇窗被关了）就在这张标签所在的窗里重建，
 * 所以「至多一个组」与「随时有组可进」两头都成立。
 */
async function groupIntoMain(g: GroupState, tabId: number, rt: BindingRuntime): Promise<number> {
  // g.groupId=null（浏览器重启作废了账本、或从未建组）但浏览器里旧 "Stream" 组可能还在。
  // 先认领它（绑 id + 把它现有的 tab 当 adopted 收回账本），别无视后另建 —— 否则每次都攒一个
  // 新组、旧组的 tab 全孤儿化。恢复的 tab 认不出原始出身，一律 adopted（红线:绝不 remove）。
  if (g.groupId == null) {
    const existing = await findExistingGroup(rt)
    if (existing) {
      g.groupId = existing.groupId
      for (const t of existing.tabIds) if (!g.members.has(t)) g.members.set(t, 'adopted')
      await persistGroup(g, rt)
      // 认领来的 tab 一律 adopted（红线：绝不 remove），所以这条分支走没走过、收回了几个，
      // 直接决定之后 reclaimOrphanTabs 还能不能动它们。低频（每次浏览器会话至多一次）。
      debugLog('group-adopted', `认领了浏览器里遗留的 ${rt.groupTitle} 组`, {
        groupId: existing.groupId,
        tabs: existing.tabIds.length,
      })
    }
  }
  let groupId: number
  let created = g.groupId == null // 本次是否新建了组（决定要不要命名）
  try {
    groupId = await chrome.tabs.group(
      g.groupId != null ? { groupId: g.groupId, tabIds: [tabId] } : { tabIds: [tabId] },
    )
  } catch (e) {
    // 用户手动解散组后 g.groupId 陈旧，带它 group() 会 reject —— 作为新组重建，别让陈旧 id
    // 永久自锁（否则 `g.groupId=groupId` 那行永不到达，之后每次 addTabToGroup 都撞死这个 id）。
    // 无 groupId 的建组失败无从重建，照抛。
    // 主组那扇窗被用户关掉也走这里：组随窗没了，新组就建在这张标签此刻所在的窗里。
    if (g.groupId != null) {
      groupId = await chrome.tabs.group({ tabIds: [tabId] })
      created = true // 重建出的也是新组，同样要命名（否则解散一次就永久退化成无名灰块）
    } else throw e
  }
  if (created) await nameGroup(groupId, rt.groupTitle)
  g.groupId = groupId
  return groupId
}

/** 主组此刻在哪扇窗（主组不在了 → undefined）。组只能待在一扇窗里，问它任意一张标签就够。 */
async function mainGroupWindow(g: GroupState): Promise<number | undefined> {
  return g.groupId == null ? undefined : groupWindowOf(g.groupId)
}

/** 某个组此刻在哪扇窗（组没了 → undefined）。 */
async function groupWindowOf(gid: number): Promise<number | undefined> {
  const [t] = await chrome.tabs.query({ groupId: gid }).catch(() => [] as chrome.tabs.Tab[])
  return t?.windowId
}

/**
 * 把一张别的普通窗里的标签挪进主组那扇窗（还没入组——入组由调用方 groupIntoMain）。
 * 不靠 `tabs.group` 顺带搬窗：那是实现细节，文档没写死；显式 move 一步，行为才说得清。
 * 挪不了（主组已不在、目标不是普通窗、标签刚好被关）就留在原地——groupIntoMain 会在那扇窗里
 * 重建主组，仍然只有一个组。
 */
async function moveToMainWindow(g: GroupState, tabId: number, fromWindowId: number | undefined): Promise<void> {
  const target = await mainGroupWindow(g)
  if (target == null || target === fromWindowId) return
  try {
    await chrome.tabs.move(tabId, { windowId: target, index: -1 })
  } catch {
    /* 挪不了 → 留在原地，见上 */
  }
}

/**
 * 窗里一张标签都不剩了就关掉它。只给「我们刚把自己的标签挪走 / 关掉」之后的那扇窗用：
 * 空了说明窗里本来只有我们的标签（站点 window.open 随新标签一起开出来的那种）；用户自己的窗里
 * 还有他的标签，空不了，碰不到。Chrome 多半已经在最后一张标签离开时自己关了窗，这里是兜底。
 */
async function closeWindowIfEmpty(windowId: number | undefined): Promise<void> {
  if (windowId == null) return
  try {
    const left = await chrome.tabs.query({ windowId })
    if (left.length === 0) await chrome.windows.remove(windowId)
  } catch {
    /* 窗已经没了 */
  }
}

// ── 唤起的 profile：按住与放掉（browser-identity D8）──
// Chrome 实测（spike S2 之后的 Cortana 复核）：`--no-startup-window` 静默加载的 profile 不会自己卸载；给它开一扇窗、
// 再关掉最后一扇窗，5 秒内就卸载。所以「收回去」= 让它的最后一扇窗关掉；而执行**中途**关最后一扇窗（一张探测
// 标签用完就关）同样会卸载它，节点随之断开，后半程无处可跑。按住期间，关最后一扇窗里最后一张自建标签时把它
// 换成 about:blank 留着；放掉时一并关。按绑定记：一个 profile 里两个 Stream 实例各按各的。
/** 按住着的绑定。只在内存里：SW 在执行中途重启的代价是这一次可能提前卸载，下一次执行会再唤起。 */
const holding = new Set<string>()

/** 关掉这张标签会不会关掉这个 profile 的最后一扇窗。 */
async function isLastTabOfProfile(tabId: number): Promise<boolean> {
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal', 'popup'] })
  return wins.length === 1 && wins[0]!.tabs?.length === 1 && wins[0]!.tabs[0]!.id === tabId
}

/**
 * 执行完了，把 Stream 在这个 profile 里留下的东西收干净，并让 Chrome 卸载它（如果它只装着我们的东西）。
 *
 * - 会话组里出身 created / probe 的标签关掉；adopted（用户拖进组的）一根毛都不碰——拖进来是他的授权，
 *   收尾不替他撤销，它所在的窗自然也算用户窗口。
 * - 一扇窗里全是我们的标签 → 它随最后一张关掉（就是为这次执行造的那扇，D13）。
 * - 窗里有任何不属于 Stream 的标签（用户自己的、别的扩展弹出来的 What's new）→ 那扇窗不碰，计为用户窗口；
 *   后端据此清掉 `woken_at`：用户在用这个 profile，它不再是「Stream 在后台开着的」。
 * - 一扇窗都没有（纯 HTTP 的执行从没开过窗）→ 造一扇不聚焦的空窗再关掉。从没开过窗的 profile 不会卸载，
 *   这是唯一能让它卸载的办法；代价是任务栏上闪一下。
 *
 * `unloading` = 不剩用户窗口，Chrome 会在几秒内卸载这个 profile（扩展也随之断开）。
 */
export async function releaseProfile(rt: BindingRuntime = runtime()): Promise<{ closedTabs: number; userWindows: number; unloading: boolean }> {
  holding.delete(rt.id)
  const members = new Map((await groupMembers(rt)).map((m) => [m.tabId, m.origin]))
  const ours = (id: number | undefined) => id != null && members.has(id) && mayRemove(members.get(id)!)
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal', 'popup'] })
  let closedTabs = 0
  let userWindows = 0
  for (const w of wins) {
    const tabs = w.tabs ?? []
    if (!(tabs.length > 0 && tabs.every((t) => ours(t.id)))) userWindows++
    for (const t of tabs) {
      if (!ours(t.id)) continue
      await releaseTab(t.id!, members.get(t.id!)!, rt)
      closedTabs++
    }
    // 只装着我们的标签的那扇：Chrome 多半已随最后一张关了，兜底。用户的窗里还有他的标签，空不了。
    await closeWindowIfEmpty(w.id)
  }
  if (wins.length === 0) {
    const w = await chrome.windows.create({ focused: false, url: 'about:blank' }).catch(() => undefined)
    if (w?.id != null) await chrome.windows.remove(w.id).catch(() => {})
  }
  return { closedTabs, userWindows, unloading: userWindows === 0 }
}

/** 当前会话组 id（未建组时 null）。 */
export async function groupId(rt: BindingRuntime = runtime()): Promise<number | null> {
  return (await hydrateGroup(rt)).groupId
}

/** 某 tab 的出身（不在组内则 undefined）——close/reap 按它分流。 */
export async function tabOrigin(tabId: number, rt: BindingRuntime = runtime()): Promise<TabOrigin | undefined> {
  return (await hydrateGroup(rt)).members.get(tabId)
}

/**
 * 结束对某 tab 的操作，**按出身分流**（CP3 关闭语义）：
 * - created/probe（AI 自建）→ detach + chrome.tabs.remove，正常回收。
 * - adopted（用户拖入）→ 只 detach + chrome.tabs.ungroup，**绝不 remove**：那是用户自己的
 *   tab、可能有未保存数据，销毁它是红线。移出组 = 撤销授权，等价于用户亲手拖出。
 * 关闭是命令（AI 一轮走完主动发 / 用户手动关），不是每次求值的强制 finally 清理。
 *
 * ungroup 不是可有可无的收尾：只从账本删、不 ungroup，tab 会继续显示在会话组里 —— 用户看
 * 到的是"还授权着"，AI 一碰却报"不在组内"。撤销这件事必须让用户看见，视觉与账本得一致。
 * （created/probe 走 remove，tab 没了，自然无所谓组。）
 *
 * **自建标签一律关，不判「用户是不是接管了」。** 会话组本来就是 AI 和用户共同操作的地方，AI 自己
 * 开的标签 AI 就有权关；用户想留住一张，拖出组就是（拖出 = 撤销 = 我们不再碰它）。曾经按
 * 「此刻 active / 被选中过 / 账本不认识」三条猜「接管」再交还（ungroup 不 remove），结果三条里
 * 两条是猜的、还带一本会丢条目的账本——探针莫名飘在组外、没人说得清为什么。别把它加回来。
 */
async function releaseTab(tabId: number, origin: TabOrigin, rt: BindingRuntime = runtime()): Promise<void> {
  if (mayRemove(origin)) {
    await clearTabSubscriptions(tabId)
    await removeAcceptingUnload(tabId)
    await chrome.debugger.detach({ tabId }).catch(() => {}) // 标签已没了，通常是空操作
  } else {
    // 用户拖入的 → 只交还：移出组、忘掉，标签本身一根毛都不动。
    await detachTab(tabId)
    await chrome.tabs.ungroup(tabId).catch(() => {})
  }
  await forgetMember(tabId, rt)
}

/**
 * 关一张自建标签，**页面弹「离开此网站？」也照关**。
 *
 * 用户在探针里改过东西（2026-09-19 活体：Photopea 的 lane 标签被拿去改 PSD），页面注册了
 * beforeunload，`tabs.remove` 会停在那个对话框上直到有人点——扩展这边就是一条挂满 30s 超时的
 * closeTab，之后每一轮都弹。对话框由 debugger 的 `Page.javascriptDialogOpening` 报上来，
 * 我们在 remove 期间盯着这张标签，一来就 `Page.handleJavaScriptDialog({accept:true})`。
 * 所以 remove 必须在 detach **之前**做（detach 了就收不到事件）。
 *
 * attach 不上（chrome:// 页、或已被别的 debugger 占着）就裸 remove——那类页面本来也不会弹。
 */
async function removeAcceptingUnload(tabId: number): Promise<void> {
  let watching = false
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION).catch((e) => {
      if (!String(e).includes('already attached')) throw e
    })
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable')
    watching = true
    closingTabs.add(tabId)
  } catch {
    /* 盯不上就裸关 */
  }
  try {
    await chrome.tabs.remove(tabId).catch(() => {})
  } finally {
    if (watching) closingTabs.delete(tabId)
  }
}

/**
 * 撤销一条授权：只放掉控制、绝不销毁 tab —— 它要么已被用户关掉、要么还在用户手里。
 * 拖出撤销（onTabGroupChange）与醒来对账（reconcileOnWake）都走它：两者面对的都是
 * "这个 tab 已经不归我管了"，区别只在于是当场听见的还是事后补上的。
 */
async function dropMember(tabId: number, rt: BindingRuntime = runtime()): Promise<void> {
  await detachTab(tabId)
  await forgetMember(tabId, rt)
}

/** 放掉对某 tab 的控制（清订阅 + detach）。不动 tab 本身，也不动账本。 */
async function detachTab(tabId: number): Promise<void> {
  await clearTabSubscriptions(tabId)
  await chrome.debugger.detach({ tabId }).catch(() => {})
}

/** 把一个 tab 从账本抹掉。组成员表与 owned 快照两处都要清 —— 任一处残留都会骗过后续判据。 */
async function forgetMember(tabId: number, rt: BindingRuntime = runtime()): Promise<void> {
  const g = await hydrateGroup(rt)
  g.members.delete(tabId)
  g.popups.delete(tabId)
  await persistGroup(g, rt)
  await withOwned((o) => o.delete(tabId))
}

/** 组成员快照（{tabId, origin}[]，插入序）——供 list 用。 */
export async function groupMembers(rt: BindingRuntime = runtime()): Promise<Array<{ tabId: number; origin: TabOrigin }>> {
  const g = await hydrateGroup(rt)
  return [...g.members].map(([tabId, origin]) => ({ tabId, origin }))
}

/**
 * 归属边界判据（CP3）：AI 可操作某 tab ⟺ 该 tab 在会话标签组内。
 * 取代旧的 isOwned（"只碰自建"）——组内含两类：AI 自建（created）与用户拖入（adopted）。
 * 红线没拆、只是平移：不是无差别 attach 任意 tab，而是"只碰组里的"，而进组必须经一次
 * 用户看得见的显式动作（AI 建 tab 入组 / 用户亲手拖入），拖出即撤销。
 * isOwned 保留：它现在只表示"出身自建"，供 close/reap 分流用（绝不 remove 用户拖入的 tab）。
 *
 * **两个条件都要满足：账本有 ∧ 浏览器认。** 账本（storage.local）只是出身的缓存，会过期：
 * MV3 SW 一空闲就死，它死着时用户拖出 tab 的 onUpdated 没人听见（丢事件同理），醒来后账本
 * 里就残留着一条用户其实已经收回的授权。拿账本当准 = 对用户已撤销的 tab 动手。浏览器进程
 * 维护的 groupId 才是组归属的真相，且页面伪造不了它。reconcileOnWake 会在醒来时补账，这里
 * 再逐次现场核一遍 —— 撤销授权这件事不能只靠"事件没丢"。
 */
async function inGroup(tabId: number, rt: BindingRuntime = runtime()): Promise<boolean> {
  // 按绑定判：别的 Stream 组里的标签对这条绑定来说就是「组外」——实例 A 驱动不了实例 B 的 tab。
  const g = await hydrateGroup(rt)
  if (!g.members.has(tabId)) return false
  try {
    const tab = await chrome.tabs.get(tabId)
    if (g.popups.has(tabId)) return await isPopupWindow(tab.windowId)
    return isOurGroup(g, tab.groupId)
  } catch {
    return false // tab 已不存在 → 不在组
  }
}

// ── 拖入授权 / 拖出撤销监听（CP3「进组/出组」）──
// 对齐 Anthropic「Claude in Chrome」：把 tab 拖进会话组 = 授权 AI 操作它、拖出 = 撤销。
// 可靠信号是 chrome.tabs.onUpdated 的 changeInfo.groupId（tab 组归属变化才带此字段；
// tabGroups.onUpdated 只报组自身属性 title/color/collapsed，拿不到成员进出）。
// 全程走 groupQueue 串行化，与 addTabToGroup 共享一条队列：既杜绝并发读改写丢更新，又保证
// 程序化 chrome.tabs.group() 触发的 onUpdated 回声排在 addTabToGroup 的 members.set 之后
// （否则回声会把刚建的 'created' tab 误标 'adopted'）。
// 每条绑定各判一遍：拖进 A 的组 = 授权给 A（同时对 B 而言是"离开"，B 若在册就撤销）。
function onTabGroupChange(tabId: number, newGroupId: number): Promise<void> {
  return Promise.all([...runtimes.values()].map((rt) => onTabGroupChangeFor(rt, tabId, newGroupId))).then(() => {})
}

function onTabGroupChangeFor(rt: BindingRuntime, tabId: number, newGroupId: number): Promise<void> {
  const run = rt.groupQueue.then(async () => {
    const g = await hydrateGroup(rt)
    if (isOurGroup(g, newGroupId)) {
      // 进入本会话组：用户拖入 → 采纳为可操作成员，出身 'adopted'。已是成员则不动
      // （程序化建组的事件回声会走到这里，绝不能把 'created' 覆写成 'adopted'）。
      if (!g.members.has(tabId)) {
        g.members.set(tabId, 'adopted')
        await persistGroup(g, rt)
      }
      return
    }
    // 离开本会话组（groupId 变走 / 变 -1）：仅对在册成员生效 = 撤销授权。
    if (g.members.has(tabId)) await dropMember(tabId, rt)
  })
  rt.groupQueue = run.then(
    () => {},
    () => {},
  ) // 无论成败都推进队列，一次失败不卡死后续
  return run
}

// changeInfo.groupId 仅在 tab 组归属变化时出现；返回 promise（真 chrome 忽略返回值）便于测试等待。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) =>
  changeInfo.groupId !== undefined ? onTabGroupChange(tabId, changeInfo.groupId) : undefined,
)

/** 这扇窗是不是 popup（放不了标签组的那种）。窗口没了 → false。 */
async function isPopupWindow(windowId: number | undefined): Promise<boolean> {
  if (windowId == null) return false
  try {
    return (await chrome.windows.get(windowId)).type === 'popup'
  } catch {
    return false
  }
}

/**
 * **Stream 自己开的标签又开出来的标签，也是 Stream 的。**
 *
 * 场景（2026-09-29 活体）：AI 在一张自建标签里点「前往管理」，页面 `window.open` / `target=_blank`
 * 开了一张新标签。那张新标签不在账本里，于是 `cdp_pages` 列不出它、`chrome:<tabId>` 驱动不了它，
 * 点击的回执也什么都没说——AI 继续盯着旧标签，得出"点了没反应"。
 *
 * 判据是**浏览器记的 `openerTabId`**（页面伪造不了），且**只认 AI 自建的开启者**（created/probe）：
 * 自建标签里发生的一切本来就是 AI 驱动的，它开出来的标签归 AI 顺理成章；而用户拖进来的
 * （adopted）是他自己的活页面，他在里面点开的东西不该被我们收进组——那等于替他做了"拖入=授权"。
 * 出身沿用开启者的：交互标签开出的是给人看的（created），后台探针开出的照样没人看（probe，
 * 照样被兜底回收）。
 *
 * 放到哪（不变式：一条绑定至多一个组，绝不另建）：
 * - 主组那扇窗 → 进主组；
 * - 另一扇普通窗（站点 `window.open` 开了新窗、或 Chrome 把它放进了用户别的窗）→ `tabs.move` 挪进
 *   主组那扇窗再入组；那扇窗因此空了就关掉（空了 = 它是随这张标签开出来的）。`window.opener` 不受
 *   标签换窗影响，页面照常工作。**别退回「在那扇窗里另建一组」**：组不能跨窗，交互标签又不回收，
 *   旧版就是这样攒出了近 50 扇窗、50 个组。只挪开启者在组内的标签——用户自己开的窗、标签不碰；
 * - popup 窗 → 放不了组、也挪不出去（站点还依赖它是弹窗），记进 `popups`，照样可驱动（见 GroupState 头注）；
 * - 主组已不在（用户把那扇窗关了）→ 在这张标签所在的窗里重建主组（groupIntoMain），仍只一个组。
 *
 * 收下之后往后端报一声 `tab-opened`：点击的回执靠它说出"这一下开了新标签 tabId=…"。
 */
async function adoptOpenedTab(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id
  const openerTabId = tab.openerTabId
  // 事件发生那一刻它在哪扇窗：挪走之后要回头看那扇窗空没空，不能再读 tab.windowId
  const bornInWindow = tab.windowId
  if (tabId == null || openerTabId == null) return
  // 开启者在哪条绑定的组里，新标签就归哪条绑定（一张 tab 至多属于一条）。
  let rt: BindingRuntime | undefined
  let origin: TabOrigin | undefined
  for (const r of runtimes.values()) {
    origin = (await hydrateGroup(r)).members.get(openerTabId)
    if (origin) { rt = r; break }
  }
  if (!rt || !origin || !mayRemove(origin)) return
  const owner = rt
  const openerOrigin = origin
  memberBornAt.set(tabId, Date.now())
  // owned 只记本机绑定的自建标签：醒来对账拿它兜底回收「不在本机组里」的残留，配对绑定的标签进去会被误收。
  if (owner.id === LOCAL_BINDING) await withOwned((o) => o.add(tabId))
  const run = inGroupQueue(owner, async () => {
    const g = await hydrateGroup(owner)
    // 已在册只可能是 Chrome 自动进组的回声抢先把它记成了 adopted——出身以开启者为准，覆写掉。
    if (g.members.has(tabId)) {
      // 什么都不用挪
    } else if (await isPopupWindow(bornInWindow)) {
      g.popups.add(tabId)
    } else if (isOurGroup(g, tab.groupId)) {
      // Chrome 自己已经把它放进开启者的组了（从组内标签开出的链接常这样）——只补账。
    } else {
      await moveToMainWindow(g, tabId, bornInWindow)
      await groupIntoMain(g, tabId, owner)
      // 挪走之后它出生的那扇窗若空了，那扇窗就是随这张标签开出来的
      await closeWindowIfEmpty(bornInWindow)
    }
    g.members.set(tabId, openerOrigin)
    await persistGroup(g, owner)
  })
  try {
    await run
  } catch (e) {
    // 没收成（入组失败）：owned 里那一笔得撤掉，否则醒来对账会把这张"在 owned、不在组"的标签当旧版
    // 残留 remove 掉——那是一张用户可能正看着的交互标签。
    if (owner.id === LOCAL_BINDING) await withOwned((o) => o.delete(tabId))
    throw e
  }
  try {
    owner.eventSocket?.send(
      JSON.stringify({ type: 'tab-opened', tabId, openerTabId, url: tab.pendingUrl ?? tab.url ?? '' }),
    )
  } catch {
    /* 连接正在断——点击回执少一句提示，cdp_pages 照样列得出它 */
  }
}

/** 导出为测试缝（真 chrome 忽略监听器返回值）。 */
export function onTabCreated(tab: chrome.tabs.Tab): Promise<void> {
  return adoptOpenedTab(tab).catch((e) => console.warn('[ext-cdp] 收编新开标签失败:', e))
}
chrome.tabs.onCreated?.addListener?.((tab) => void onTabCreated(tab))

/**
 * 同名的多个主组（历史残留：修「认领旧组」之前每次浏览器会话都可能另建一个）并成一个。
 * 并进谁：账本里的主组还活着就并进它（出身记在它名下），否则并进第一个——findExistingGroup
 * 随后认领的正是它。别的组里的标签挪进那扇窗、入组；因此空了的窗关掉。
 * 这里不记出身：之后的主组对账（或认领）会把账本里没有的成员一律补成 adopted（红线：绝不 remove）。
 */
async function mergeMainGroups(g: GroupState, rt: BindingRuntime): Promise<void> {
  let found: number[]
  try {
    found = (await chrome.tabGroups.query({ title: rt.groupTitle })).map((x) => x.id)
  } catch {
    return // 没有 tabGroups 权限 —— 认不出同名组，什么都不做
  }
  if (found.length === 0) return
  const target = g.groupId != null && (await groupWindowOf(g.groupId)) != null ? g.groupId : found[0]
  const others = found.filter((id) => id !== target)
  if (others.length === 0) return
  const targetWindow = await groupWindowOf(target)
  const emptied = new Set<number>()
  for (const gid of others) {
    const tabs = await chrome.tabs.query({ groupId: gid }).catch(() => [] as chrome.tabs.Tab[])
    const ids = tabs.map((t) => t.id).filter((id): id is number => id != null)
    if (!ids.length) continue
    for (const t of tabs) {
      if (t.id == null || t.windowId == null || t.windowId === targetWindow || targetWindow == null) continue
      emptied.add(t.windowId)
      await chrome.tabs.move(t.id, { windowId: targetWindow, index: -1 }).catch(() => undefined)
    }
    await chrome.tabs.group({ groupId: target, tabIds: ids as [number, ...number[]] }).catch(() => undefined)
  }
  for (const w of emptied) await closeWindowIfEmpty(w)
  debugLog('groups-merged', `把 ${others.length + 1} 个同名的 ${rt.groupTitle} 组并成了一个`, { groupId: target })
}

/**
 * 升级收编：旧版在主组以外的窗里另建的「Stream 独立窗」组，一个都不留。
 * 认组两条路：旧账本里记着的 id（legacyGroups），加上按名字认（账本作废后只剩名字认得出）。
 * 组里每张标签按出身处理——认不出出身的一律当 adopted（红线：认不出就绝不 remove）：
 * - probe → 关。没人看的后台探针，本来就该回收；
 * - created → 挪进主组那扇窗、入主组。它是给人看的，换个窗照样看得见、照样驱动；
 * - adopted → 只解组、忘掉，标签原地不动。**绝不 remove**——那是用户拖进来的东西。
 * 收编完因此空了的窗关掉（窗里还有用户的标签就空不了，不会误关）。
 * 每次醒来都跑，但只有第一次有活干：之后浏览器里已经没有这种名字的组了，就是一次空查询。
 */
async function absorbLegacyGroups(g: GroupState, rt: BindingRuntime): Promise<void> {
  let named: number[] = []
  try {
    named = (await chrome.tabGroups.query({ title: rt.legacyWindowGroupTitle })).map((x) => x.id)
  } catch {
    /* 没有 tabGroups 权限 —— 只收编账本里记着的 */
  }
  const legacy = new Set([...(g.legacyGroups ?? []), ...named])
  const hadLedgerField = g.legacyGroups != null
  delete g.legacyGroups
  if (legacy.size === 0) return
  const windows = new Set<number>()
  const counts = { probe: 0, created: 0, adopted: 0 }
  for (const gid of legacy) {
    if (gid === g.groupId) continue // 万一主组 id 混进了旧字段，别把主组自己收编掉
    const tabs = await chrome.tabs.query({ groupId: gid }).catch(() => [] as chrome.tabs.Tab[])
    for (const t of tabs) {
      if (t.id == null) continue
      if (t.windowId != null) windows.add(t.windowId)
      const origin = g.members.get(t.id) ?? 'adopted'
      counts[origin]++
      if (origin === 'created') {
        await moveToMainWindow(g, t.id, t.windowId)
        await groupIntoMain(g, t.id, rt).catch(() => undefined)
      } else {
        await releaseTab(t.id, origin, rt) // probe → remove；adopted → 只 ungroup，绝不 remove
      }
    }
  }
  for (const w of windows) await closeWindowIfEmpty(w)
  // 旧字段要从存储里消失：没有任何标签要动时也写一次（否则下次醒来又从旧快照读出来）
  if (hadLedgerField || counts.created) await persistGroup(g, rt)
  if (counts.probe + counts.created + counts.adopted)
    debugLog('legacy-groups-absorbed', `收编了 ${legacy.size} 个旧的 ${rt.legacyWindowGroupTitle} 组`, counts)
}

/**
 * SW 复活：**与浏览器对账**，只回收没人看的探针 —— 不是无差别回收。
 *
 * 为什么不能无差别回收：MV3 SW 一空闲就死、随手一个命令又活，这是常态而非异常。而账本
 * （storage.local）活得比 SW 久。旧版在每次醒来时把组内自建 tab 全 remove 掉，于是
 * "后端重启了一下"就等于把用户正看着的交互 tab 从眼皮底下关掉、把用户拖入的授权静默撤销。
 * 泄漏兜底是对的，但它只对**没人看的**东西成立：
 * - probe（后台探针）→ 回收。没人看，泄漏无人察觉，必须有网。
 * - created（交互 tab）→ 不动。用户可能正看着；它就在可见的标签组里，用户一眼看得见、
 *   随手关得掉 —— 可见性本身就是这类 tab 的防泄漏机制。
 * - adopted（用户拖入）→ 不动。授权是用户给的，SW 重启不是撤销它的理由。
 *
 * 同时补上 SW 死着时漏掉的 onUpdated：以浏览器真实组成员为准双向对账（账本有·浏览器无
 * → 撤销；浏览器有·账本无 → 采纳为 adopted）。
 */
export async function reconcileOnWake(rt: BindingRuntime = runtime()): Promise<void> {
  const g = await hydrateGroup(rt)
  // 先把浏览器里的组收拢成一个（同名主组合并、旧版独立窗组收编），再按主组对账。
  await inGroupQueue(rt, async () => {
    await mergeMainGroups(g, rt)
    await absorbLegacyGroups(g, rt)
  })
  if (g.groupId != null) {
    const live = new Set(
      (await chrome.tabs.query({ groupId: g.groupId }).catch(() => []))
        .map((t: { id?: number }) => t.id)
        .filter((id): id is number => id != null),
    )
    const inMain = new Set(live)
    // popup 窗里的在册标签不在任何组里——还活着（且窗口仍是 popup）就算 live，否则按撤销处理。
    for (const id of g.popups) {
      const t = await chrome.tabs.get(id).catch(() => undefined)
      if (t && (await isPopupWindow(t.windowId))) live.add(id)
    }
    // ① 账本有、浏览器无 = 用户趁 SW 死时拖出或关掉了它 → 撤销，绝不 remove
    //    （拖出的还在用户手里；关掉的 remove 也只是空操作。分不清也不必分——处理一样）。
    for (const { tabId } of await groupMembers(rt)) {
      if (!live.has(tabId)) await dropMember(tabId, rt)
    }
    // ② 浏览器有、账本无 = 用户趁 SW 死时拖了进来 → 拖入即授权，补记为 adopted
    for (const tabId of inMain) {
      if (!g.members.has(tabId)) await addTabToGroup(tabId, 'adopted', rt)
    }
    // ③ 对完账再回收探针（没人看的泄漏兜底）
    for (const { tabId, origin } of await groupMembers(rt)) {
      if (origin === 'probe') await releaseTab(tabId, origin, rt)
    }
  } else {
    // groupId=null（账本被浏览器重启作废，或从未建组）。若浏览器里旧 "Stream" 组还在，认领它
    // + 把它的 tab 收回账本（一律 adopted，红线:绝不 remove），让旧 tab 继续 list/close 得到。
    // 没有就是全新会话。**这里的 adopted 是"认不出出身"的保守默认，不是观测事实**——所以它
    // 现在只该发生在真正跨浏览器会话的那一格；扩展重载不再走到这条路（账本活着，出身还在）。
    const existing = await findExistingGroup(rt)
    if (existing) {
      g.groupId = existing.groupId
      for (const t of existing.tabIds) g.members.set(t, 'adopted')
      await persistGroup(g, rt)
    }
  }
  // 兜底：在 owned 快照里但不在组内的 tab —— 旧版扩展（无组概念）建的残留。owned 历来只记
  // AI 自建的 tab，故一律回收；不会误伤用户 tab（用户 tab 从不进 owned）。少了这条，升级后
  // 那批遗留自动化 tab 会永远留在浏览器里没人清。组内成员由上面按出身处理，这里跳过。
  // owned 只记本机绑定的自建标签，所以只在本机那条的对账里做。
  if (rt.id !== LOCAL_BINDING) return
  const owned = await hydrateOwned()
  const stale = [...owned].filter((tabId) => !g.members.has(tabId))
  for (const tabId of stale) {
    await chrome.debugger.detach({ tabId }).catch(() => {})
    await chrome.tabs.remove(tabId).catch(() => {})
  }
  await withOwned((o) => stale.forEach((tabId) => o.delete(tabId)))
}

/**
 * 照后端的认领名单回收孤儿采集标签。
 *
 * **为什么需要**：lane→tab 的映射只在后端进程内存里。后端一重启，用户 Chrome 里还开着的采集
 * 标签就没人认了——新进程不知道它、`closeFacilityTabs` 够不着。而 `reconcileOnWake` 只在 SW
 * **启动**时跑一次：后端重启时 SW 往往还活得好好的，于是那一刻永远等不到对账。开发期后端重启
 * 频繁，一次漏一个（2026-08-01 活体：`cdp_pages` 列出雪球采集标签，而后端 `facility:xueqiu`
 * 报 `live:false`）。
 *
 * **只回收 `probe`。** 三条红线：
 * - 问不到后端（网络错 / 非 200）→ 什么都不做。宁可漏关不可误关；**空集合和"问不到"是两回事**，
 *   空集合是「一个都不认」（后端刚重启的常态，该收），非 200 是「不知道」。
 * - `adopted`（用户亲手拖入）→ 永不 remove，与后端认不认无关。授权是用户给的。
 * - `created`（给人看的交互标签）→ 不动。用户可能正看着，而且它就在可见的标签组里、随手关得掉。
 */
export async function reclaimOrphanTabs(
  baseUrl: string,
  opts: { minAgeMs?: number } = {},
  rt: BindingRuntime = runtime(),
): Promise<void> {
  const minAgeMs = opts.minAgeMs ?? 60_000
  let claimed: Set<number>
  try {
    // 每个 Stream 只答它在这条绑定上认领的标签。本机带 `node`（不是 `binding=local:…`）：老后端不认
    // 这个参数，回的是它的本机全集——要是问它一个它不认识的绑定，它会答「一个都不认」，在跑的标签就被当孤儿收了。
    const node = rt.id === LOCAL_BINDING ? await getNode().catch(() => undefined) : undefined
    const q = rt.id !== LOCAL_BINDING ? `?binding=${encodeURIComponent(rt.id)}` : node ? `?node=${encodeURIComponent(node.nodeId)}` : ''
    const res = await fetch(`${baseUrl}/api/ext/claimed-tabs${q}`)
    if (!res.ok) return // 「不知道」≠「一个都不认」——见头注红线
    const body = (await res.json()) as { tabIds?: unknown }
    if (!Array.isArray(body?.tabIds)) return
    claimed = new Set(body.tabIds.filter((x): x is number => typeof x === 'number'))
  } catch {
    return // 后端没起 / 断网 —— 一个都不动
  }
  const now = Date.now()
  for (const { tabId, origin } of await groupMembers(rt)) {
    if (origin !== 'probe') continue
    if (claimed.has(tabId)) continue
    const bornAt = memberBornAt.get(tabId)
    if (bornAt != null && now - bornAt < minAgeMs) continue // 刚建出来，后端可能还没登记
    await releaseTab(tabId, origin, rt)
    memberBornAt.delete(tabId)
  }
}

/**
 * best-effort 缓解后台节流：只发 `setWebLifecycleState('active')`，防止短命 tab 在使用
 * 窗口内被冻结/丢弃。
 *
 * **这里不发 `Emulation.setFocusEmulationEnabled`，但理由不是原来写的那个。** 原注释称
 * 它「让后台标签谎称一直被聚焦……正是风控的 bot tell（实测 xhs 据此作废会话）」。
 * 2026-07-29 复查：**那条"实测"查无实据**——它只以注释形式出现在 commit 9abced11
 * (2026-07-11)，commit 正文只字未提，specs / research / skill 全仓无记载；而同仓的录制
 * launcher (`src/replay/browser-ext.ts`) 现在**明确开着它**，因为实测它把隐藏 tab 的一次
 * 可信点击从 39.8–41.6s 压到 162–185ms（数字与病理见那边的注释）。
 *
 * 这里不发它，纯粹是**用不上**：本路径是页内 fetch（`Runtime.evaluate` 直发），不渲染、
 * 不用可信输入，帧的有无与它无关。开关的家在采集 lane 那边，一处发就够。
 */
async function mitigateThrottle(tabId: number): Promise<void> {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.setWebLifecycleState', { state: 'active' })
  } catch {
    /* ignore */
  }
}

/** 确保对某组内 tab 已 attach（幂等）。组外一律拒 —— 未经授权的 tab 绝不 attach。 */
async function ensureAttached(tabId: number, rt: BindingRuntime = runtime()): Promise<void> {
  if (!(await inGroup(tabId, rt)))
    throw new Error(`refuse to attach tab ${tabId}: not in the session tab group (拖入组即授权)`)
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION)
    await mitigateThrottle(tabId)
  } catch (e) {
    // 已 attach 会抛 "Another debugger is already attached" —— 视为成功
    if (!String(e).includes('already attached')) throw e
  }
  await ensureAutoAttach(tabId)
}

/**
 * 逐动作域名校验（CP3）——红线从「只碰自建」松到「只碰组内」之后补回的那道安全。
 * 一个 mutating 动作发起时记下目标域名；执行前若该 tab 已被导航到别的域名（页面自己跳转、
 * 或有人在中途把 AI 引到别处），就拒掉这个动作，绝不把它落到非预期的站上。
 * 对齐 Anthropic「Claude in Chrome」的 domain verification。
 * 主机名精确比对：子域算不同域（evil.a.example ≠ a.example）——放宽到后缀匹配等于给
 * 子域接管开门。
 *
 * **探针必须走浏览器进程自己的记录（chrome.tabs.get），绝不在页面里求值。**
 * 曾经用 `Runtime.evaluate('JSON.stringify({href: location.href})')` —— 那是个可确定性
 * 绕过的洞：不带 contextId 的 evaluate 跑在页面主世界，`location.href` 虽不可伪造，但
 * `JSON.stringify` 页面能随手覆写，返回一个假的 href 就骗过校验；更糟的是**被调用即预言机**
 * ——页面精确知道「AI 正要对我动手」，能把本来盲赌的 TOCTOU 变成按需触发（同步启动跳转
 * 再返回假 href）。这道门本就是防「页面自己跳转」的，却对它要防的那个 actor 失效。
 * tabs.get 的 url 由浏览器进程维护，页面碰不到。残余 TOCTOU（校验通过→命令送达之间的
 * IPC 窗口）无法靠校验消灭，但已缩回「盲赌」，可接受。
 */
async function assertDomain(tabId: number, expected: string): Promise<void> {
  const tab = await chrome.tabs.get(tabId)
  let host = ''
  try {
    host = new URL(tab.url ?? '').hostname
  } catch {
    /* 非法/空 url → host 留空，必然不等于 expected → 拒 */
  }
  if (host !== expected)
    throw new Error(
      `refuse action on tab ${tabId}: domain changed（域名不匹配）— expected ${expected}, tab is now on ${host || tab.url || '<unknown>'}`,
    )
}

/**
 * 轮询 document.readyState 到满足 waitUntil（§6：attach 在 navigate 之后，Page 事件可能已错过）。
 * 走已 attach 的 chrome.debugger Runtime.evaluate 读取 readyState —— 免 `scripting` 权限。
 * 调用前该 tab 必须已 attach。超时兜底：不抛，让上层命令自己在页面上失败（fail-as-miss 而非挂死）。
 * 连续多次 target 级错误（tab 崩溃/关闭）则提前返回，省掉 30s 空转。
 */
async function waitForNav(tabId: number, waitUntil = 'domcontentloaded', timeoutMs = 30_000, url?: string): Promise<void> {
  // 目标**就是**空白页时没有什么可等的：下面那条判据等的是"已经离开 about:blank"，
  // 而这里 about:blank 是落点本身，等下去必然空转满 30 秒。
  //
  // 采集 lane 现在故意落空白页（后端会紧接着自己导航一次，见 session-recipe-executor 的
  // landing 注释：这样一次搜索只加载一次页面，而不是"建标签载一遍、observer 挂好再载一遍"）。
  // 2026-07-29 活体：漏了这一条，用户搜索后看到两个空白标签、永不跳转 —— 因为 newTab 命令
  // 自己就卡在这儿没返回，后端那句 goto 压根没机会执行。
  if (url === 'about:blank') return
  const want = waitUntil === 'load' ? ['complete'] : ['interactive', 'complete']
  const deadline = Date.now() + timeoutMs
  let consecutiveErrors = 0
  while (Date.now() < deadline) {
    try {
      const r = (await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        // 竞态根治：tabs.create(url) 返回时 tab 里还是初始空文档（about:blank），
        // 而空文档的 readyState 天生 === 'complete' —— 只看 readyState 会在目标页
        // 提交前放行，后续 in-page fetch 就在 about:blank 源上跨域执行，直接
        // "Failed to fetch"。所以必须同时确认 location 已离开 about:blank。
        expression: 'JSON.stringify({ rs: document.readyState, href: location.href })',
        returnByValue: true,
      })) as { result?: { value?: string } }
      consecutiveErrors = 0
      const { rs, href } = JSON.parse(r.result?.value ?? '{}') as { rs?: string; href?: string }
      if (href && href !== 'about:blank' && want.includes(rs as string)) return
    } catch {
      // tab 崩溃/关闭会连续抛错（导航瞬间的 context 销毁也会抛，属预期，会被下轮
      // 轮询覆盖）；连续 10 次（~1s）就放弃等待，让上层命令去失败
      if (++consecutiveErrors >= 10) return
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

/**
 * 造一个"铺满屏幕但绝不抢焦点"的窗口（仅在一个窗口都没有时用），**直接开在目标地址上**，
 * 返回它那张初始标签的 id 供调用方接着用。
 *
 * **别退回"造一张 about:blank 的窗、再 tabs.create 一张目标标签"。** 那样窗口自带的那张
 * about:blank 会永远留下：它不在会话组里、没有出身标记、reconcileOnWake 也不认领它，
 * 于是用户标签栏里多出一张组外的空白页，只能他自己动手关。窗口本来就要一张标签，用它。
 *
 * 造窗失败（或旧 Chrome 不回 `tabs`）→ 返回 null，调用方退回 `chrome.tabs.create`。
 *
 * **别改回 `state: 'maximized'`。** Chrome 的 `windows.create` 文档写死：`focused: false`
 * 不能与 state `'maximized'` / `'fullscreen'` 同传 —— 这是非法参数组合，调用直接抛错。
 * 抛错被吞掉之后窗口压根没造出来，后面的 `tabs.create` 照样炸 "No current window"，
 * 比"窗口没最大化"糟得多（等于回退到修之前的 bug）。
 *
 * 也别改成"先造普通窗口，再 `windows.update({ state: 'maximized' })`"：Windows 上
 * maximize 会顺带激活窗口，把用户的屏幕抢过去，正好废掉 `focused: false` 的用意。
 *
 * 所以走**显式 bounds**：从 `system.display` 取主显示器的 workArea 当窗口位置尺寸，
 * 效果等同最大化又不碰焦点。bounds 与 state 互斥，因此不传 state。
 * 取不到显示器信息就降级成不带 bounds 的 create —— 尺寸是 Chrome 默认值（偏窄），
 * 但窗口造得出来，采集不至于整条挂掉。
 */
async function createUnfocusedFullscreenWindow(url: string): Promise<number | null> {
  let bounds: { left: number; top: number; width: number; height: number } | undefined
  try {
    const displays = await chrome.system.display.getInfo()
    const primary = displays.find((d) => d.isPrimary) ?? displays[0]
    const area = primary?.workArea
    if (area) bounds = { left: area.left, top: area.top, width: area.width, height: area.height }
  } catch {
    /* 没有 system.display 权限 / 取不到显示器 —— 降级为默认尺寸窗口 */
  }
  const win = await chrome.windows.create({ focused: false, url, ...bounds }).catch(() => undefined)
  return win?.tabs?.[0]?.id ?? null
}

/**
 * 两个地址「指的是不是同一个页面」——openTab 的 find 那一半用它。
 *
 * 严格字符串相等在这里必然误判：`chrome://extensions` 和 `chrome://extensions/` 是同一页，
 * 但字符串不等；判错的代价是每喊一次就多开一个重复标签。所以按 URL 的结构比：
 * - scheme / host（含端口）大小写不敏感（URL 解析本身就归一化了）；
 * - path 末尾斜杠不计（`/x` ≡ `/x/`，空 path ≡ `/`）；path 其余部分大小写敏感（服务端就这么认）；
 * - query 与 hash 照算——`#privacy` 这类 hash 在 chrome:// 设置页里就是"哪一屏"，不是装饰。
 * 解析不了的（扩展自己的伪地址之类）退回去掉首尾空白的原样比较，宁可多开一个也不认错。
 */
export function sameUrl(a: string, b: string): boolean {
  const x = a.trim()
  const y = b.trim()
  if (x === y) return true
  let ua: URL
  let ub: URL
  try {
    ua = new URL(x)
    ub = new URL(y)
  } catch {
    return false
  }
  const path = (u: URL) => (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''))
  return (
    ua.protocol === ub.protocol &&
    ua.host === ub.host &&
    path(ua) === path(ub) &&
    ua.search === ub.search &&
    ua.hash === ub.hash
  )
}

/**
 * openTab 的回执。刚建出来的 tab 常常还没有 title（文档没提交），而调用方要拿 title 去拼原生
 * 窗口的 a11y 地址 `app:chrome.exe/<title>`——空 title 等于地址拼不出来。所以轮询到 title 有值，
 * 至多约 2s。超时就回当时的值：**字段一定在**（title 可为空串），让调用方自己决定退不退。
 */
async function openReceipt(tabId: number, created: boolean): Promise<{ tabId: number; title: string; url: string; created: boolean }> {
  const deadline = Date.now() + 2000
  let tab = await chrome.tabs.get(tabId)
  while (!tab.title && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    try {
      tab = await chrome.tabs.get(tabId)
    } catch {
      break // 用户当场把它关了——回手里这份就够了
    }
  }
  return { tabId, title: tab.title ?? '', url: tab.url ?? '', created }
}

/**
 * 超过这个数就认为这条命令"不正常地慢"——正常一条是毫秒到几百毫秒级。
 *
 * **和后端的 `RELAY_SLOW_COMMAND_MS` 是同一个数，别单边改**：两侧同时越线才配得起对，
 * 一侧记一侧不记，"慢在哪一跳"就又没法读了（两条记录靠 command + 时间邻近对齐）。
 * 导出是给测试当缝用——测试要拿它推进假时钟，写死一个字面量就会在改这个数时静默失效。
 */
export const SLOW_COMMAND_MS = 5_000

/**
 * `Page.captureScreenshot` 的上界。
 *
 * **为什么单给它一道闸**：它等的是合成器**真的产出一帧**，而一个不显示在屏幕上的 Chrome
 * 窗口（被别的窗口盖住 / 最小化 / 锁屏）根本不产帧，于是这条命令就挂在那儿——实测
 * 12.0s / 18.5s / 26.1s / 30.0s（30s 那档是后端中继的闸门兜底，不是命令自己回来了）。
 * `Emulation.setFocusEmulationEnabled` **救不了它**：那个开关给的是"页面被当成有焦点"这个
 * 谎，可信输入等的正是这个谎；帧由 OS 那层"这个窗口到底显不显示"说了算，页面撒的谎管不着。
 *
 * **为什么必须比 2 秒严**：后端那侧逼帧 2 秒就放手了（`FLUSH_FRAME_BUDGET_MS`），此后
 * 挂在 Chrome 里的这条命令**已经没人要**。上界定得比它宽就等于没有这道闸。
 *
 * **1.5s 的来历**：正常一次整帧 JPEG 实测 286–392ms，逼帧那种 1×1 更快——1.5s 是最慢那次
 * 的约 4 倍，够宽到不误伤真在画的页面，又留出 500ms 让**明确的失败**先于后端自己的 2s 预算
 * 到达。到点回失败而不是静默成功：取图的消费端本来就要处理拿不到图（`session-manager.ts`
 * 的 `shot`：`null = unsupported / no frame`），分不出"截到了"和"没截到"才是真问题。
 *
 * **超时不写 debug bus**：settle/scroll 会连着截很多张，一挂就是一串，写进那个 200 条的
 * 环形缓冲等于把通道冲干净（见 `debugLog` 头注：只给低频事件）。失败照原样回给后端，
 * 落在 recipe 的 outcome / 失败现场里——那儿本来就是排查这类步骤的地方。
 */
export const SCREENSHOT_BUDGET_MS = 1_500

/** 要合成器真的产出一帧才回执的命令——只有这类需要上面那道上界。 */
const NEEDS_REAL_FRAME = new Set(['Page.captureScreenshot'])

/**
 * **发了就算，不等 Chrome 的回执。** 只有可信鼠标事件在这张名单上。
 *
 * 为什么（2026-09-03 活体实测，靶子 example.org、后台标签、焦点模拟开着）：
 *
 * | 量的东西                                  | 数字            |
 * |-------------------------------------------|-----------------|
 * | 一次 `Runtime.evaluate` 往返（同一条通道） | **36ms**        |
 * | 一次可信点击（11 个事件，逐个等回执）      | **5.9 / 9.7 / 6.5 s** |
 * | 同类事件不等回执（`scrollOnce` 那条路）    | **0.04–0.16 s** |
 * | 11 个事件**送达页面**的总跨度（页内探针）  | **262ms**（间隔 6–111ms）|
 *
 * 最后一行是判据：事件全都按时到了页面，页面侧的轨迹节奏也正是我们设计的那个。慢的**只有
 * 回执**——鼠标事件要做命中测试，命中测试要一帧，而 Chrome 不给看不见的标签画帧。约 0.5–0.9s
 * 一个事件 × 11 = 那 6–10 秒。键盘事件不在名单上，因为它不做命中测试（实测 2–27ms），
 * 它的回执又便宜又有意义。
 *
 * **顺序仍然是保的。** 后端逐条 `await`（一条回来才发下一条），回执一快，那个串行就变成
 * 真的串行；而 `chrome.debugger.sendCommand` 一被调用消息就已经进了到浏览器进程的那条管子，
 * 同一个 debuggee 上按调用序送达。改的是"等多久拿到回音"，不是"谁先谁后"。
 *
 * **代价，说清楚**：回执从此只意味着"已交给 Chrome"，不意味着"Chrome 处理了"。所以
 * Chrome 那一侧的派发失败在这条路上是看不见的——判据落在消费者那边（recipe 的 `expect`
 * / `settle`，模型面的 `expect` 选择器）。这跟 `scrollOnce` 早就成立的那条理由是同一条
 * （见 `shared/browser-relay/ext-page.ts`），只是那时只有滚轮享受到。attach 失败、
 * 域名校验不过仍然照常抛——那两道在发命令**之前**。
 */
const FIRE_AND_FORGET = new Set(['Input.dispatchMouseEvent'])

/**
 * 遮挡/最小化/锁屏的窗口截不到图，**但这不是物理限制**——是渲染器在"这个窗口反正没人看"
 * 时不再产帧，而默认那条截图路径正好在等这一帧。
 *
 * `captureBeyondViewport: true` 走的是**另一条捕获路径**：它本来是给"截超出视口的内容"用的，
 * 因此不依赖可见表面那一帧，遮挡的标签照样出图。
 *
 * **走过的死路，别再走一遍**（2026-09-02 活体实测）：
 * - `Emulation.setFocusEmulationEnabled` —— 给的是"页面被当成有焦点"这个谎；帧归合成路径管，
 *   页面撒的谎管不着（上面那段头注说的就是它）。
 * - `Emulation.setDeviceMetricsOverride` —— 思路对（切离屏合成面），但**这条命令自己也要
 *   渲染器应答**，而不干活的正是那个渲染器：实测它挂住不回，一路挂到中继的 30s 才断。
 *   给它套上界也只是把 3s 变成"确定失败"，救不回图。
 */
const BEYOND_VIEWPORT = { captureBeyondViewport: true }

function withBudget(cmd: Promise<unknown>, method: string): Promise<unknown> {
  cmd.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${method} 在 ${SCREENSHOT_BUDGET_MS}ms 内没有回执：这个标签没有产出帧` +
              `（Chrome 窗口没有真的显示在屏幕上——被盖住/最小化/锁屏都算）`,
          ),
        ),
      SCREENSHOT_BUDGET_MS,
    )
  })
  return Promise.race([cmd, budget]).finally(() => clearTimeout(timer))
}

/**
 * 发一条 CDP 命令；要真帧的那几条带上界，其余原样等到底。
 *
 * 超时之后底下那条命令**仍然挂着**（CDP 没有"撤回"），所以给它挂一个空 catch：没人接的
 * 失败会变成 unhandled rejection，把 SW 的控制台刷成噪音。
 *
 * **撞上界之后带 `captureBeyondViewport` 再试一发**（见 `BEYOND_VIEWPORT`）。为什么是回落
 * 而不是常开：正常那条路（窗口看得见）今天就好用、286–392ms，而 beyond-viewport 走的是另一条
 * 捕获路径、语义不完全等同（它按整个可滚动区域取，clip 的坐标系仍是页面坐标，但代价更高）。
 * 回落只在"本来就要失败"的那一刻发生，代价上界是多花一个 SCREENSHOT_BUDGET_MS（最坏 3s，
 * 远在中继那道 30s 闸门里）。
 *
 * **回落这一发同样套上界**：这条链上每一条要渲染器应答的命令都可能挂住——挂住而没有上界，
 * 表现就是一路挂到中继的 30s，而那个错误只会说"命令没回"，分不出是哪一步没回。
 */
async function sendCdpCommand(
  tabId: number,
  method: string,
  params?: { [key: string]: unknown },
  sessionId?: string,
): Promise<unknown> {
  // 子会话只接受这张标签自己挂上来的那几条——别让一个任意 sessionId 替后端去碰别的东西。
  if (sessionId && !childSessions.get(tabId)?.has(sessionId))
    throw new Error(`session ${sessionId} is not an iframe session of tab ${tabId}（iframe 可能已被移除/导航走——重新列 frame）`)
  const target: chrome.debugger.DebuggerSession = sessionId ? { tabId, sessionId } : { tabId }
  if (FIRE_AND_FORGET.has(method)) {
    // 空 catch 是必须的：没人接的拒绝会变成 unhandled rejection，把 SW 控制台刷成噪音。
    // 但**别把它读成"失败被吞了"**——见 FIRE_AND_FORGET 头注最后一段：这条路上的判据本来
    // 就在消费者那边，而 attach / 域名校验的失败仍在上游照常抛。
    chrome.debugger.sendCommand(target, method, params).catch(() => {})
    return {}
  }
  if (!NEEDS_REAL_FRAME.has(method)) return chrome.debugger.sendCommand(target, method, params)
  try {
    return await withBudget(chrome.debugger.sendCommand(target, method, params), method)
  } catch {
    return await withBudget(
      chrome.debugger.sendCommand(target, method, { ...params, ...BEYOND_VIEWPORT }),
      method,
    )
  }
}

/**
 * dispatch 一条 inbound，返回要回传给后端的 {id, result} | {id, error}。
 * （导出为测试缝：协议行为须按真实路径验。）
 *
 * **看门狗**：后端那侧的命令超时是 30s，超了只知道"这条命令没回"，分不出三种情况——
 * 命令压根没送到扩展、送到了但 `chrome.debugger.sendCommand` 的 promise 永不兑现、
 * 还是兑现了只是晚。三者的修法完全不同，靠后端那个超时永远分不出来。
 *
 * 所以这里在扩展侧留两条记号：慢命令 5s 时先记一条"还在跑"（证明它送到了），
 * 真跑完再记一条带总耗时的（证明 promise 最终兑现了、以及晚了多少）。
 * 只有第一条没有第二条 = 永不兑现；两条都有 = 回了但晚。
 *
 * 这条通道**已知会被触发**：背景标签下 `Input.dispatchMouseEvent` 的 ack 实测就永不返回
 * （见 `browser-ext-drive.ts` scrollOnce 的注释），而 `Page.navigate` 偶发挂满 30s 是同一个形状。
 */
/**
 * 这条绑定的实例能拿走哪些域的 cookie。本机 = `cfg.domains`（用户填的）∪ `cfg.requiredDomains`
 * （Stream 按已装 manifest 推出来、上次同步缓存下来的），与以前一字不差；配对绑定还要过用户批准
 * 那一道（`allowedDomains`）。绑定没了（刚被移除）= 空范围，fail closed。
 */
async function scopeOf(rt: BindingRuntime): Promise<string[]> {
  if (rt.id === LOCAL_BINDING) {
    const cfg = await getConfig()
    return mergeDomains(cfg.domains, cfg.requiredDomains ?? [])
  }
  const b = await getBinding(rt.id)
  return b ? allowedDomains(b) : []
}

/**
 * 配对绑定的实例这次来要了哪些域——记进它的 `requiredDomains`，没批准的就是 popup 里的「待批准」。
 * 本机绑定从 sync-config 得到这份名单；远处的实例那一口要 API token，扩展拿不到，于是它的请求本身
 * 就是名单。记下不等于给：给不给只看 `approvedDomains`（scopeOf）。
 */
async function noteRequested(id: string, wanted: string[]): Promise<void> {
  const b = await getBinding(id)
  if (!b) return
  const merged = mergeDomains(b.requiredDomains ?? [], wanted)
  if (merged.length !== (b.requiredDomains ?? []).length) await setBinding(id, { requiredDomains: merged })
}

/** 处理一条中继命令。`rt` = 命令从哪条绑定的连接上来：所有按组判的闸都只认这条绑定的组。 */
export async function dispatch(msg: Inbound, rt: BindingRuntime = runtime()): Promise<{ id: number; result?: unknown; error?: string; swMs: number }> {
  const label = 'op' in msg ? msg.op : msg.method
  const started = Date.now()
  // 分段用的记号，全部盖 **SW 自己的钟**（跨侧的减法一律不做，见 HopMarks 头注）。
  const marks: HopMarks = {}
  /** 两段拆开：`preCdpMs` = attach/域校验花掉的，`cdpMs` = tab 那侧回话花掉的。 */
  const segments = () => ({
    cdpIssued: marks.cdpSentAt != null,
    ...(marks.cdpSentAt != null && { preCdpMs: marks.cdpSentAt - started }),
    ...(marks.cdpSentAt != null && marks.cdpDoneAt != null && { cdpMs: marks.cdpDoneAt - marks.cdpSentAt }),
  })
  const watchdog = setTimeout(() => {
    // 5 秒过去了、命令还在跑。**这条记录最值钱的一格是 `cdpIssued`**：底层 CDP 命令到底发出去
    // 了没有。false = 还卡在 ensureAttached / assertDomain，压根没到 tab——当场砍掉一半嫌疑。
    debugLog('slow-command', `命令跑了 ${SLOW_COMMAND_MS / 1000}s 还没完 —— ${label}`, {
      command: label,
      tabId: 'tabId' in msg ? msg.tabId : undefined,
      waitedMs: SLOW_COMMAND_MS,
      ...segments(),
    }, { ok: false })
  }, SLOW_COMMAND_MS)
  try {
    const reply = await dispatchInner(msg, marks, rt)
    // `swMs` 随每一条回执回后端（不只是慢的那些）：后端拿它减出 WS 那两段，不去猜。
    return { ...reply, swMs: Date.now() - started }
  } finally {
    clearTimeout(watchdog)
    const elapsed = Date.now() - started
    if (elapsed >= SLOW_COMMAND_MS)
      debugLog('slow-command-done', `${label} 最终返回了，耗时 ${elapsed}ms`, {
        command: label,
        elapsedMs: elapsed,
        ...segments(),
      }, { ok: false })
  }
}

/**
 * 一条命令在 SW 内部的分段记号。**三个时刻全盖 SW 自己的钟**，只和同侧的时刻相减。
 *
 * 后端和 SW 是两个进程、两个钟（后端跑在 WSL 里，墙钟还会偶发回退），所以
 * 「后端发出 → SW 收到」这一跳**算不出来**——硬算就是耗时 + 两钟偏差，一个读起来
 * 毫无破绽的假数。跨侧那段由后端用 `backendTotalMs - swMs`（两个同侧时长相减）得到，
 * 本侧的义务只有一个：把 `swMs` 如实带回执里。设计见
 * `docs/superpowers/specs/2026-08-19-ext-cdp-slow-command-hop-timing-design.md` §2。
 *
 * **没走到的那一段就让它缺席，不要填 0**——0 会被读成"这一跳很快"。
 */
interface HopMarks {
  /** 底层 CDP 命令真正发出的时刻（ensureAttached + assertDomain 之后）。不走 CDP 的 op 没有。 */
  cdpSentAt?: number
  /** 底层 CDP 命令回执/抛错的时刻。 */
  cdpDoneAt?: number
}

async function dispatchInner(msg: Inbound, marks: HopMarks = {}, rt: BindingRuntime = runtime()): Promise<{ id: number; result?: unknown; error?: string }> {
  const subscriptions = rt.subscriptions
  try {
    if ('op' in msg) {
      switch (msg.op) {
        case 'newTab': {
          // 两档采集标签，由后端 background 标志选择：
          // - background:true（eval/state 被动采集）→ 后台标签（active:false，不抢焦点、不弹窗、
          //   采完即关）。页内 fetch 不受可见性/节流影响，无需专用窗口。
          // - background:false（interactive：给人看的交互 lane / DOM 渲染 / 可信输入）→
          //   **当前窗口的活动标签**，随后入会话标签组。采用 Anthropic「Claude in Chrome」模型：
          //   标签组就在用户眼前那一栏、能看能拖（拖出即撤销），比飘在旁边的独立 focused:false
          //   窗口更可见也更可控——而「让用户真的看见 AI 在干活」正是这条 lane 的目的。
          // 没有任何窗口时先造一个 —— 否则 `chrome.tabs.create` 抛 "No current window"。
          //
          // 这不是理论情况，是**唤起 Chrome 的常态**：host-agent 用 `--no-startup-window` 拉起
          // 浏览器（那是为了不抢屏，见 host-agent/src/launch.rs），于是进程活着、扩展也连上了，
          // 却一个窗口都没有。活体实测过：定时采集在 Chrome 关着时触发，Chrome 被拉起来、SW 连上，
          // 然后建标签当场炸在这一行。
          //
          // 造窗口用 `focused: false`：进程要有窗口才放得下标签，但不该把用户的屏幕抢过去。
          // 而且非聚焦窗口里的 active 标签**照常满帧渲染、可信输入照常落地**（2026-07-28 实测），
          // 所以这既满足"有地方放标签"，也不牺牲采集能力。
          //
          // 造窗时**直接开在目标地址上**，用它自带的那张标签，不再另建一张——否则那张
          // about:blank 会留在组外没人管（见 createUnfocusedFullscreenWindow 头注释）。
          let tabId: number | null = null
          if ((await chrome.windows.getAll({})).length === 0) {
            // **铺满屏幕，不要钉死像素。** 这是用户自己的浏览器，窗口尺寸本来就随他变；给一个固定
            // 尺寸既不像真实窗口，也未必装得下 feed（Chrome 的默认值实测是竖长条约 1384×1856，
            // xhs 只排得下 2 列，同样滚动距离拿到的卡片少一半）。跟着屏幕走最省心也最像人。
            // 怎么在不抢焦点的前提下铺满（以及为什么不能用 state:'maximized'）见函数头注释。
            // 注意这只在**一个窗口都没有**时才发生；用户自己开着窗口时我们用他那个，不碰尺寸。
            tabId = await createUnfocusedFullscreenWindow(msg.url)
          }
          if (tabId == null) tabId = (await chrome.tabs.create({ url: msg.url, active: msg.background !== true })).id ?? null
          if (tabId == null) throw new Error('failed to create harvest tab')
          // 出身=自建（供 close/reap 分流；不再是可操作判据）。只记本机绑定的——见 adoptOpenedTab。
          if (rt.id === LOCAL_BINDING) await withOwned((o) => o.add(tabId))
          // 入会话组：现在"可操作"的判据是组成员（inGroup），自建 tab 不入组会被自己的
          // ensureAttached 拒、且 list 看不到它。
          // background 同时决定生命周期轴：后台档没人看着（probe，SW 醒来兜底回收），
          // 前台档是给人看的（created，SW 醒来不动，只由 close 命令或用户亲手关）。
          await addTabToGroup(tabId, msg.background === true ? 'probe' : 'created', rt)
          await ensureAttached(tabId, rt) // attach 先于 waitForNav（readyState 走 debugger 通道）
          await waitForNav(tabId, msg.waitUntil, undefined, msg.url) // 慢操作在 mutex 之外，不阻塞其他 tab
          return { id: msg.id, result: { tabId } }
        }
        case 'openTab': {
          // find-or-open：先在**所有**窗口里找同一个页面，找到就激活复用（并把它那扇窗抬到前台），
          // 没有才建。查全体 tab 而不是会话组：用户自己早就开着的那一份也算数——"打开
          // chrome://extensions" 的正解就是切过去，而不是再开一张一模一样的。
          //
          // **刻意不 attach debugger、不注入脚本**——这是它和 newTab 唯一的分界，也正因如此
          // chrome://* 特权页开得了（newTab 会在 attach 一步炸 `Cannot access a chrome:// URL`）。
          // 但**新建的标签照样入会话组**：组是"这张标签是 Stream 开的"这件事的归属与可见边界
          // （用户拖出即撤销），不是"可不可被驱动"的判据。开出来却飘在组外，用户只能自己收拾。
          // chrome:// 依旧驱动不了，那是 chrome:// 自身的限制——真去 attach 时它会诚实报错；
          // 要动这类页得走原生窗口那一档（app:chrome.exe/<title>，回执里的 title 就是这座桥）。
          const all = await chrome.tabs.query({})
          const hit = all.find((t) => t.id != null && sameUrl(t.url ?? '', msg.url))
          if (hit?.id != null) {
            // 命中的是**用户自己的**标签：只切过去，不拽进会话组——把它编入组等于替他做了
            // "拖入 = 授权"那个动作。回执里的 created:false 就是这个分界。
            await chrome.tabs.update(hit.id, { active: true })
            if (hit.windowId != null) await chrome.windows.update(hit.windowId, { focused: true }).catch(() => undefined)
            return { id: msg.id, result: await openReceipt(hit.id, false) }
          }
          // 一个窗口都没有是唤起 Chrome 的常态（host-agent 用 --no-startup-window 拉起），
          // 此时 tabs.create 会炸 "No current window"——先造一扇窗，且直接开在目标地址上
          // （见 newTab 的长注释与 createUnfocusedFullscreenWindow 头注释）。
          let tabId: number | null = null
          if ((await chrome.windows.getAll({})).length === 0) tabId = await createUnfocusedFullscreenWindow(msg.url)
          if (tabId == null) tabId = (await chrome.tabs.create({ url: msg.url, active: true })).id ?? null
          if (tabId == null) throw new Error(`failed to open tab for ${msg.url}`)
          if (rt.id === LOCAL_BINDING) await withOwned((o) => o.add(tabId!)) // 出身=自建（close 时才 remove 得掉）
          // 出身记 'created' 而不是 'probe'：这是开给人看的页面，SW 醒来不该把它回收掉。
          await addTabToGroup(tabId, 'created', rt)
          // 建完把窗抬前台：这条命令的语义就是"给用户打开一个页面看"，藏在后面等于没开。
          const win = (await chrome.tabs.get(tabId).catch(() => undefined))?.windowId
          if (win != null) await chrome.windows.update(win, { focused: true }).catch(() => undefined)
          return { id: msg.id, result: await openReceipt(tabId, true) }
        }
        case 'closeTab': {
          // 组内才可关（组外拒）；关法按出身分流——自建才 remove，用户拖入的只 detach+移出组。
          const origin = await tabOrigin(msg.tabId, rt)
          if (!origin) throw new Error(`refuse to close tab ${msg.tabId}: not in the session tab group`)
          // 按住着的 profile（见 releaseProfile 上面那段）：这是它最后一扇窗里的最后一张，关了 profile 就卸载了。
          // 换成空白页留着，放掉时再关。后端那边它已经关了（lane 照常结束）。
          if (holding.has(rt.id) && mayRemove(origin) && (await isLastTabOfProfile(msg.tabId))) {
            await detachTab(msg.tabId)
            await chrome.tabs.update(msg.tabId, { url: 'about:blank' }).catch(() => undefined)
            return { id: msg.id, result: { kept: true } }
          }
          await releaseTab(msg.tabId, origin, rt)
          return { id: msg.id, result: {} }
        }
        case 'list': {
          // 枚举组内 tab 供 AI 认目标（对齐 Anthropic tabs_context）。逐个 chrome.tabs.get 取
          // url/title；成员已被用户关掉则跳过它、不让整条 list 失败（陈旧成员下次拖出/close 时清）。
          // 带 origin：后端要分得清「用户拖进来的（adopted）」和「我们自己开的（created/probe）」——
          // 前者是用户正看着的活页面，可以直接骑；后者是上一轮停下的旧渲染，骑它读到的是旧答案。
          // 带 grouped：账本说它是成员 ≠ 它真的在 Chrome 的会话标签组里（用户拖出、组被解散、
          // group() 失败后账本还留着都会分叉）。拿 Chrome 自己的 tab.groupId 和账本的 groupId 对一下，
          // 让「标签飘在组外」这件事能从列表上直接看出来，而不是靠人眼数标签。
          const g = await hydrateGroup(rt)
          // openerTabId：它是被哪张标签开出来的（点一下开了新标签，从这里认出来）。
          // active：它是不是那扇窗当前显示的标签——原生窗口档按窗口标题寻址，只有 active 那张对得上。
          const tabs: Array<{
            tabId: number
            url: string
            title: string
            origin: TabOrigin
            grouped: boolean
            active: boolean
            openerTabId?: number
            popup?: boolean
          }> = []
          for (const { tabId, origin } of await groupMembers(rt)) {
            try {
              const t = await chrome.tabs.get(tabId)
              tabs.push({
                tabId,
                url: t.url ?? '',
                title: t.title ?? '',
                origin,
                grouped: isOurGroup(g, t.groupId),
                active: t.active === true,
                ...(t.openerTabId != null ? { openerTabId: t.openerTabId } : {}),
                ...(g.popups.has(tabId) ? { popup: true } : {}),
              })
            } catch {
              /* tab 已不在（用户关了）—— 跳过，不整条失败 */
            }
          }
          return { id: msg.id, result: { tabs } }
        }
        case 'holdProfile': {
          holding.add(rt.id)
          return { id: msg.id, result: {} }
        }
        case 'releaseProfile': {
          return { id: msg.id, result: await releaseProfile(rt) }
        }
        case 'activeTab': {
          // 前台采集动手**之前**问一次：用户这会儿在看哪个标签。没有窗口时 tabId=null 而不是
          // 报错——一个窗口都没有是唤起 Chrome 的常态（host-agent 用 --no-startup-window 拉起）。
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
          return { id: msg.id, result: { tabId: tab?.id ?? null } }
        }
        case 'activateTab': {
          // 把焦点还回去，带一道礼貌闸门：**只有当前 active 标签是会话组成员**（= 采集正骑着的
          // 那个标签），才说明焦点确实是我们抢来的，这时候还回去才叫"还"。用户中途自己切走了
          // 就一个字都不动——再把他拽回来是第二次打扰。
          //
          // 闸门判据是"组内"而不是后端传过来的某个 tabId：后端在**抢焦点之前**就记下用户原来
          // 在哪（那时候采集标签可能还没建出来，它的 id 无从谈起），所以判据只能由扩展这边、
          // 在还的那一刻自己看。组成员这个判据也更准——一次搜索会同时骑好几个采集标签，抢到
          // 焦点的未必是发起这次"还"的那一个。
          //
          // 还不回去（目标标签被用户关了）不是错误：用户当下在看的东西比我们的礼貌重要。
          // 一律回 {restored} 让调用方知道结果，但不抛。
          const [cur] = await chrome.tabs.query({ active: true, currentWindow: true })
          if (cur?.id == null || !(await tabOrigin(cur.id, rt))) return { id: msg.id, result: { restored: false } }
          try {
            await chrome.tabs.update(msg.tabId, { active: true })
            return { id: msg.id, result: { restored: true } }
          } catch {
            return { id: msg.id, result: { restored: false } }
          }
        }
        case 'cookieNames': {
          // **只回名字。** 不是因为值不能过中继（`cookiePull` 就在下面，同一条通道同一把
          // token），而是最小权限：登录探测只需要"会话 cookie 在不在"，那就只给这一点。
          // 后端拿名字按 manifest 声明的 sessionCookies 匹配就够了，所以扩展也不必知道
          // 哪个 cookie 算会话 cookie（那是 Stream 的知识，不是浏览器的）。
          //
          // 不做归属校验：这里读的是**域**不是 tab，没有"用户私人 tab"那条边界要守；而域本身
          // 由后端按 manifest 指定，用户没登过的域自然就是空列表。
          // **配对绑定例外**：远处的实例不该能探测任意站点"登没登录"——只答它的范围之内的域。
          if (rt.id !== LOCAL_BINDING && !matchesSyncedDomain(msg.domain, await scopeOf(rt)))
            return { id: msg.id, result: { names: [] } }
          const all = await chrome.cookies.getAll({ domain: msg.domain })
          return { id: msg.id, result: { names: all.map((c) => c.name) } }
        }
        case 'cookiePull': {
          // **范围闸在扩展这边，不在后端。** 后端是请求方，让请求方自己定范围等于没有范围；
          // 而且这条通道的对端将来可能不是我们那个后端（身份校验挡的是常态，不是全部）。
          // 判据用扩展自己申报过的同步域——`cfg.domains`（用户填的）∪ `cfg.requiredDomains`
          // （Stream 按已装 manifest 推出来、上次同步缓存下来的）。范围外的域一个字都不回，
          // 并且**明说拒了哪些**：静默丢弃会让后端把"没权限"读成"用户没登录"。
          // 配对绑定的范围还要过用户批准那一道（见 config.ts allowedDomains）。
          const wanted = [...new Set(msg.domains ?? [])]
          if (rt.id !== LOCAL_BINDING) await noteRequested(rt.id, wanted)
          const allowed = await scopeOf(rt)
          const granted = wanted.filter((d) => matchesSyncedDomain(d, allowed))
          const refused = wanted.filter((d) => !granted.includes(d))
          const cookies: Record<string, Array<Record<string, unknown>>> = {}
          for (const domain of granted) {
            const all = await chrome.cookies.getAll({ domain })
            if (all.length) cookies[domain] = all.map(serializeCookie)
          }
          return { id: msg.id, result: { cookies, refused } }
        }
        case 'subscribe': {
          if (!(await inGroup(msg.tabId, rt)))
            throw new Error(`refuse to subscribe tab ${msg.tabId}: not in the session tab group`)
          const domains = new Set(msg.domains.filter((d) => /^[A-Z][A-Za-z]+$/.test(d)))
          if (domains.size === 0) throw new Error('subscribe requires at least one valid CDP domain')
          await ensureAttached(msg.tabId, rt)
          for (const domain of domains) {
            await chrome.debugger.sendCommand({ tabId: msg.tabId }, `${domain}.enable`)
          }
          const subscriptionId = nextSubscriptionId++
          subscriptions.set(subscriptionId, { tabId: msg.tabId, domains })
          return { id: msg.id, result: { subscriptionId } }
        }
        case 'frames': {
          // 组外一律拒（ensureAttached 自己会拒）。刚开 auto-attach 的那一刻，已存在的 OOPIF 的
          // attachedToTarget 事件还在路上——等一小会儿再答，不然第一次问总是"没有 iframe"。
          const fresh = !autoAttached.has(msg.tabId)
          await ensureAttached(msg.tabId, rt)
          if (fresh) await new Promise((r) => setTimeout(r, 300))
          return { id: msg.id, result: { sessions: frameSessionsOf(msg.tabId) } }
        }
        case 'unsubscribe': {
          const sub = subscriptions.get(msg.subscriptionId)
          if (!sub) return { id: msg.id, result: {} }
          subscriptions.delete(msg.subscriptionId)
          for (const domain of sub.domains) {
            const stillUsed = [...subscriptions.values()].some((s) => s.tabId === sub.tabId && s.domains.has(domain))
            if (!stillUsed) await chrome.debugger.sendCommand({ tabId: sub.tabId }, `${domain}.disable`).catch(() => {})
          }
          return { id: msg.id, result: {} }
        }
      }
    }
    // CDP 命令
    await ensureAttached(msg.tabId, rt)
    // 逐动作域名校验：带 expectDomain 的（mutating）动作，执行前确认 tab 还在那个域名上。
    // 必须在 sendCommand 之前——校验通过才允许动作落到页面。
    if (msg.expectDomain) await assertDomain(msg.tabId, msg.expectDomain)
    // 分段的分界就在这里：上面两步（attach + 域校验）也会打进 Chrome、也会挂，而这一格
    // 此前完全是黑的。盖在它们**之后**，`preCdpMs` 就直接回答了"是不是 attach 挂了"。
    marks.cdpSentAt = Date.now()
    try {
      const result = await sendCdpCommand(msg.tabId, msg.method, msg.params as { [key: string]: unknown } | undefined, msg.sessionId)
      return { id: msg.id, result }
    } finally {
      // finally 而不是成功分支：挂满 30s 那次多半是以失败收场的，正是要量的那一次。
      marks.cdpDoneAt = Date.now()
    }
  } catch (e) {
    return { id: msg.id, error: String(e instanceof Error ? e.message : e) }
  }
}

// ── WS 连接：心跳给 MV3 SW 续命，断线指数退避重连（reconnect 去重、心跳按连接隔离）──
// 退避、在线标记、排着的重试都按绑定各一份（BindingRuntime）：一条绑定反复失败不拖慢别的绑定。
const BACKOFF_MAX = 30_000

// relay 连接状态（SW 内存即可：popup 查询会唤醒 SW，唤醒即重走 startExtCdp 连接流程，
// 状态随 open/close 事件实时翻转，无需持久化）。
/** popup 健康检查用：某条绑定到它的 Stream 的 WS 是否在线。缺省 = 本机。 */
export function isRelayUp(id: string = LOCAL_BINDING): boolean {
  return runtimes.get(id)?.relayUp ?? false
}

/**
 * 排着的那一次重试。**每条绑定同一时刻只有一个**——三处失败路径（配对失败、握手前验身份失败、
 * 连接断开）以前各自裸 `setTimeout` 并各自把 `backoff` 翻一倍，谁也不知道谁；这里把它们
 * 收成一个句柄，为的是能被"立刻重连"取消并提前引爆。
 */
function scheduleRetry(run: () => void, rt: BindingRuntime = runtime()): void {
  if (rt.pendingRetry) clearTimeout(rt.pendingRetry.timer)
  const timer = setTimeout(() => {
    rt.pendingRetry = null
    run()
  }, rt.backoff)
  rt.pendingRetry = { timer, run }
  rt.backoff = Math.min(rt.backoff * 2, BACKOFF_MAX) // 指数退避
}

/**
 * 「立刻重连」——弹窗那个按钮的落点。
 *
 * 自动重连本来就一直在跑（退避最坏 30s），所以这个按钮**不是恢复的前提**，只是把等待
 * 折叠掉：把退避复位到 1s 并把排着的那一次重试提前引爆。返回值如实说发生了什么，好让
 * 弹窗照着说人话——**不假装"已重连"**：这里只能保证"这就去试"，连没连上要等 open 事件。
 */
export function forceReconnect(id: string = LOCAL_BINDING): 'connected' | 'reconnecting' {
  const rt = runtime(id)
  if (rt.relayUp) return 'connected'
  rt.backoff = 1000
  const p = rt.pendingRetry
  if (p) {
    clearTimeout(p.timer)
    rt.pendingRetry = null
    p.run()
  } else if (id === LOCAL_BINDING) {
    // 没有排着的重试：SW 刚被这次查询唤醒、顶层那次 start() 还没走到失败，或者一次连接
    // 正在飞。走正常入口即可（`starting` 闸保证不会开出第二条连接）。
    void startExtCdp().catch(console.error)
  } else {
    void startBinding(id).catch(console.error)
  }
  return 'reconnecting'
}

/** 实例撤销了这条绑定（与设备撤销同一个关闭码）。收到它就别再重连——那把 token 已经作废了。 */
export const REVOKED_CLOSE_CODE = 4003

/**
 * 这条配对绑定属于另一个 profile（browser-identity D1）：实例记着它第一次连上时的节点，这个 profile 的
 * `nodeId` 对不上——token 是从别的 profile 拷过来的（复制了用户数据目录之类）。重连只会一直被拒，停下来，
 * popup 里说清楚；要在这个 profile 里用，就在这里重新配对。
 */
export const FOREIGN_NODE_CLOSE_CODE = 4004

async function connect(wsUrl: string, baseUrl: string, rt: BindingRuntime = runtime(), binding?: Binding): Promise<void> {
  // 每次（重）连都重走这两步，不缓存：token 从 native host 现取（后端轮换 secret 后自愈），
  // 身份现验（上一次验过不代表这一次连的还是同一个进程——后端重启、端口易主都在这中间）。
  // 配对绑定的 token 是配对时实例发的、存在绑定上；身份照样现验（带 binding，key 是 token 的哈希）。
  //
  // **顺序不能反，也不能省。** 先拿正确的 token，再让对端证明它也知道这个 token，最后才把
  // token 放进握手交出去。跳过验证直接握手 = 把 secret 白送给任何抢到这个口的进程。
  let token: string
  try {
    if (binding?.kind === 'paired') {
      if (!binding.token) throw new Error('这条绑定没有 token——重新配对')
      token = binding.token
      await verifyBackend(baseUrl, token, { binding: binding.id })
    } else {
      token = await nativeHostToken()
      await verifyBackend(baseUrl, token)
    }
  } catch (e) {
    // 停在原地重试，**绝不降级去问后端要 token**——那条路就是这次要拆掉的东西。
    // 日志要吵：这两类失败（没配对 / 对端不是我们）用户看不见任何症状，只会觉得"采集不动了"。
    debugLog('pairing-refused', '没连——token 取不到或对端身份验不过', {
      binding: rt.id,
      reason: e instanceof Error ? e.message : String(e),
    })
    scheduleRetry(() => void connect(wsUrl, baseUrl, rt, binding), rt)
    return
  }
  // 握手带上节点 id（browser-identity D1）：本机 Stream 据此给每个 profile 各一条中继、互不顶替；
  // 配对实例据此认出 token 是不是被拷到了别的 profile。存储读不出来就不带——退回兼容槽，照旧能连。
  const node = await getNode().catch(() => undefined)
  // token 走 Sec-WebSocket-Protocol（不进 URL/日志）；服务端只回选协议名
  const sock = new WebSocket(node ? `${wsUrl}?${nodeQuery(node)}` : wsUrl, [EXT_RELAY_PROTOCOL, token])
  let hb: ReturnType<typeof setInterval> | null = null
  let settled = false // error 与 close 会双发 —— 保证只重连一次、只清一次心跳

  const scheduleReconnect = (ev?: Event) => {
    if (settled) return
    settled = true
    rt.relayUp = false
    if (rt.eventSocket === sock) {
      rt.eventSocket = null
      if (rt.id === LOCAL_BINDING) setNotifySocket(null)
      else setNotifySocket(null, rt.id)
    }
    void clearSubscriptions(rt)
    if (hb) {
      clearInterval(hb)
      hb = null
    }
    if (rt.stopped) return
    // 实例撤销了这条绑定：token 已作废，重连只会一直被拒。标记出来，popup 里让用户移除。
    if (rt.id !== LOCAL_BINDING && (ev as CloseEvent | undefined)?.code === REVOKED_CLOSE_CODE) {
      debugLog('binding-revoked', '这条扩展绑定被它的 Stream 撤销了，不再重连', { binding: rt.id })
      void setBinding(rt.id, { revoked: true })
      return
    }
    if (rt.id !== LOCAL_BINDING && (ev as CloseEvent | undefined)?.code === FOREIGN_NODE_CLOSE_CODE) {
      debugLog('binding-foreign-node', '这条扩展绑定属于另一个 profile，不再重连', { binding: rt.id })
      void setBinding(rt.id, { foreignNode: true })
      return
    }
    scheduleRetry(() => void connect(wsUrl, baseUrl, rt, binding), rt)
  }

  sock.addEventListener('open', () => {
    rt.relayUp = true
    rt.eventSocket = sock
    // 「cookie 变了」那条通知也从这条连接走（见 relay-notify.ts），按绑定各走各的。
    if (rt.id === LOCAL_BINDING) setNotifySocket(sock)
    else setNotifySocket(sock, rt.id)
    rt.backoff = 1000 // 连上即复位退避
    // 连上即对账，回收上一个后端进程留下的孤儿采集标签。**时机必须是这里，不能只在 SW 启动时**：
    // 后端重启是最常制造孤儿的事件，而那一刻 SW 往往还活得好好的（reconcileOnWake 根本不会跑）。
    // 不 await —— 对账是兜底，不该挡住这条连接开始收命令；失败一律静默（见 reclaimOrphanTabs 红线）。
    void reclaimOrphanTabs(baseUrl, {}, rt)
    /**
     * 连上即刷新同步域名单（`requiredDomains`）。**这是它唯一的主动更新路径**。
     *
     * 在此之前它只在 `runSync` 里更新，而 `runSync` 唯一的触发是"某个**已在名单里**的域
     * cookie 变了"——于是后端新增一个需要的域之后，扩展这份缓存永远等不到更新（新域不在
     * 名单里，它的 cookie 变更进不了那道门），只能靠碰巧有别的域变动。鸡生蛋。
     *
     * 而漏一个域的表现是**静默且会误导**：那个域被 `cookiePull` 的范围闸拒掉，后端只看到
     * "一条 cookie 都没有"，报成"用户没登录"。活体撞到过（eastmoneysec 刚进名单那次）。
     *
     * 时机选这里而不是 SW 启动：后端**重启**才是名单变化的时刻（config 是那会儿读的），
     * 而那一刻 SW 往往活得好好的，启动钩子根本不会跑——和上面 reclaimOrphanTabs 同一个理由。
     * 不 await：它是兜底，不该挡住这条连接开始收命令。
     */
    // 配对绑定没有这一步：远处那个实例的 sync-config 要 API token，扩展拿不到。它要哪些域，
    // 由它发来的 cookiePull 本身说出来（见 dispatchInner 的 cookiePull：记成待批准）。
    if (rt.id === LOCAL_BINDING) void runSync().catch(() => {})
    // WS 消息活动给 MV3 非持久 SW 续命（~20s 一次）；心跳是这条连接私有的
    hb = setInterval(() => {
      try {
        sock.send(JSON.stringify({ type: 'ping' }))
      } catch {
        /* 关闭中，close 处理器会重连 */
      }
    }, 20_000)
  })

  sock.addEventListener('message', async (ev) => {
    let msg: Inbound
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    } catch {
      return
    }
    if ((msg as { type?: string }).type === 'ping') return // 忽略自己的心跳回声（若后端回传）
    // 认领回话不是命令，不回执（browser-identity D3，见 claim.ts）。
    if (handleClaimReply(rt.id, msg)) return
    const reply = await dispatch(msg, rt)
    sock.send(JSON.stringify(reply))
  })

  sock.addEventListener('close', scheduleReconnect)
  sock.addEventListener('error', scheduleReconnect)
}

/** 本 SW 实例里已经拉起过的那次启动。SW 一被回收它就跟着没了，正好是我们要的作用域。 */
let starting: Promise<void> | null = null

/**
 * 连接中继端点并 dispatch；WS 心跳给 MV3 SW 续命，断线指数退避重连。
 *
 * **同一个 SW 实例里只连一条**：入口不止一个（SW 冷启的顶层调用、`chrome.runtime.onStartup`、
 * 以后可能还有别的事件），而它们在浏览器启动时会**同时**发生——顶层脚本先跑，紧接着
 * onStartup 派发。不去重就会开出两条中继连接，两条都收后端下发的 CDP 命令，同一个动作被
 * 执行两遍。`connect` 自己带断线重连，所以这里只需保证"启动"这件事每个 SW 实例一次。
 */
export function startExtCdp(): Promise<void> {
  starting ??= start()
  return starting
}

async function start(): Promise<void> {
  // 配对绑定各自起各自的连接，不等本机这条配没配上——远处的 Stream 与本机有没有 Stream 无关。
  void startPairedBindings().catch(console.error)
  await reconcileOnWake() // SW 启动即与浏览器对账（补漏掉的拖入/拖出），并回收没人看的探针
  const cfg = await getConfig()

  // 候选表：用户配的那个优先，其次是本机默认口。**每次启动都重走配对**，不是"配过就直连"——
  // 这也是"代装扩展"那条链路（AI 把扩展装进用户 Chrome，用户什么都不用点）的修法：刚装上的
  // 扩展 baseUrl 是空的，而它也在候选表里（`PROBE_CANDIDATES` 兜底），不必等用户打开 popup。
  // 而配过的那个地址同样可能已经易主（后端换端口、别的进程抢了这个口），配对失败在这里是
  // 静默的：连不上而已，两端各自看起来都正常（实测 2026-08-31，win-test：卡片在、native host
  // 也给得出 token，debug bus 却一条都没有，因为 `debugLog` 自己也要 baseUrl 才发得出去）。
  // 让它每次都用证明说话，比记住一个可能过期的地址可靠。
  // 去重：常见情形 cfg.baseUrl 本来就是 PROBE_CANDIDATES 里那个默认本机口，原样拼进候选表会
  // 打两次一模一样的挑战应答——白多一次网络往返，debug bus 与 console 也把同一个结论记两遍。
  // 按去掉尾斜杠后的地址判"是不是同一个候选"，不同大小写/路径细节的地址仍各自保留。
  const seen = new Set<string>()
  const candidates = [cfg.baseUrl, ...PROBE_CANDIDATES].filter(Boolean).filter((c) => {
    const key = c.replace(/\/$/, '')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const peer = await findPairedPeer(candidates, {
    token: nativeHostToken,
    verify: verifyBackend,
    log: (event, detail) => debugLog(event, '配对', detail),
  })
  if (!peer) {
    // 一个都证明不了：native host 没登记、后端没起、或者这个口上坐着别人。
    //
    // 闸先放回去，好让别的事件（配置改动、浏览器唤醒）也能触发重试——但**不能只指望别的事件**：
    // Chrome 随 Windows 登录自启动、后端 40s 后才就绪，这中间没有任何别的事件会来敲门（周期性
    // 闹钟已经退役，见 background.ts 头注），配对失败在这里原样 return 就等于从此再也没人叫醒
    // 它，采集静默地永远不跑。所以失败必须自带一次退避重试——退避沿用 `connect()` 已经在用的
    // 那把 `backoff`/`BACKOFF_MAX`（同一个变量、同一套上限，不另起一份计数），连上一次就复位。
    //
    // 走 `startExtCdp()` 而不是直接再调 `start()`：前者会重新经过 `starting` 这道闸——这样
    // 定时重试和别的事件（比如浏览器唤醒）同时触发时仍然只跑一个 start()，不破坏"同一个 SW
    // 实例只连一条"的不变量。
    starting = null
    scheduleRetry(() => void startExtCdp().catch(console.error))
    return
  }
  // 只在用户**没配过**地址时才把配对结果写回去。`cfg.baseUrl` 本来就是空串 ⇒ 这是首次配对
  // 或"代装扩展"，写回去省得用户手填。但用户一旦填过一个地址（哪怕它此刻连不上——比如配的
  // 是内网 NAS，NAS 恰好在重启），这里绝不能拿"另一个也证明成功的候选"去覆盖它：候选表里
  // 还有兜底的 127.0.0.1:8900，共享同一把 token 的本地 Stream 一样能通过配对；一旦覆写，
  // 用户配置的 NAS 地址就无声消失，之后每次启动都只会去连本机、再也不会试那台 NAS。
  if (!cfg.baseUrl) await setConfig({ baseUrl: peer.baseUrl })

  // wsUrl 用配对拿到的地址，token 不传给 connect ——它只用于这次发现，connect 每轮重连仍会
  // 自己重取 token、重验身份（后端轮换 secret 后能自愈、端口易主也能发现，见 connect 头注）。
  const wsUrl = peer.baseUrl.replace(/^http/, 'ws') + '/api/ext'
  void connect(wsUrl, peer.baseUrl)
}

async function startPairedBindings(): Promise<void> {
  for (const b of await getBindings()) if (b.kind === 'paired' && !b.revoked && !b.foreignNode) await startBinding(b.id)
}

/**
 * 起一条配对绑定的连接（SW 启动时、popup 刚配对成功时）。**每条绑定每个 SW 实例只起一次**——
 * 与本机那条的 `starting` 闸同一个理由：两条连接都收命令，同一个动作就被执行两遍。
 * 断线重连由 `connect` 自己管；被撤销的、已移除的不起。
 */
export async function startBinding(id: string): Promise<void> {
  const b = await getBinding(id)
  if (!b || b.kind !== 'paired' || b.revoked || b.foreignNode) return
  const rt = runtime(id, b.label)
  if (rt.started) return
  rt.started = true
  rt.stopped = false
  await reconcileOnWake(rt)
  const base = b.baseUrl.replace(/\/$/, '')
  void connect(base.replace(/^http/, 'ws') + '/api/ext', base, rt, b)
}

/** 用户在 popup 里移除了一条绑定：断开、不再重连。它组里的标签留给用户（不关、不解组）。 */
export function stopBinding(id: string): void {
  const rt = runtimes.get(id)
  if (!rt || id === LOCAL_BINDING) return
  rt.stopped = true
  rt.started = false
  if (rt.pendingRetry) clearTimeout(rt.pendingRetry.timer)
  rt.pendingRetry = null
  try { rt.eventSocket?.close() } catch { /* 已经断了 */ }
}
