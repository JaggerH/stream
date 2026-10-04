import type { RecipeSessionSpec } from './recipe.ts'
import type { RecipeSessionLease } from './session-manager.ts'
import { makeExtPageDriver, makeExtRawPage } from './browser-ext-drive.ts'
import { actWithConfirm } from './run-action.ts'
import { needsConfirmation, classifyAction, type ActResult, type LaneAction, type LaneMode } from './interactive-gate.ts'
import {
  evalInFrame,
  frameOfRef,
  inventoryAcrossFrames,
  listFrames,
  makeFrameRawPage,
  resolveFrame,
  type FrameRelay,
} from '../../shared/browser-relay/frames.ts'
import { inventoryExpression, refFromSelector } from '../../shared/browser-relay/page-inventory.ts'
import type { FrameSession, TabOpened } from '../../shared/browser-relay/relay.ts'

/**
 * AI 交互 lane（CP3）——ext-cdp 上一条**持久、前台**的通道，让 AI 在用户自己的 Chrome 里
 * 多步走流程 / 接管用户已开的 tab，全程用户看得见、可控。
 *
 * 与采集那条线的分工（用户拍板的切分）——两条现在骑同一个浏览器，分的是可见性不是浏览器：
 * - **后台静默** → 采集那条（active:false 的后台标签，采完即关，用户不必看见）。
 * - **给人看的** → 这条交互 lane（开在用户眼前的标签组里）。
 *
 * 关键语义：
 * - **close 是命令，不是每次求值的强制 finally**。AI 一轮流程走完觉得没有后续任务了可以
 *   主动 close；用户觉得交互做完了也可以手动关。两者不冲突（同一动作的两个触发源）。
 *   都不发也不会泄漏：tab 就在用户眼前的会话标签组里，一眼看得见、随手关得掉——对"给人看的"
 *   tab 而言，可见性本身就是防泄漏机制。SW 重启只与浏览器对账、不回收它（后端抖一下不该把
 *   用户正看着的 tab 关掉）；真正被兜底回收的是没人看的后台探针（probe）。
 * - **默认 act-without-asking**：非高危自主直行，只有高危停下等确认（见 interactive-gate）。
 * - mutating 动作带 expectDomain 下去，扩展侧做逐动作域名校验兜底。
 */

/**
 * 保留命名空间：AI 会话不是某个 facility 的采集，但 session manager 按 facility 键控。
 * 用 `_agent` 挂进去，白蹭 lane 的串行尾链（多步操作不交错）和内存预算治理，且不与任何真
 * facility 冲突（真 facility 是站点 id，不会叫 `_agent`）。
 * 每个会话一条 lane（laneKey=会话 id），互不串行——这正是 lane 机制本来就支持的"一个 facility
 * 下多条 lane"，采集侧目前反而没用上（全走默认 laneKey）。
 */
export const AGENT_FACILITY = '_agent'

/** 一个 AI 会话对应一条持久前台 lane。laneKey=会话 id → 不同会话互不干扰。 */
export function agentLaneSpec(sessionId: string): RecipeSessionSpec {
  return {
    facility: AGENT_FACILITY,
    laneKey: sessionId,
    lifecycle: 'persistent', // 跨多步存活——不是 cdp_look(target:chrome) 那种 launch→eval→close 的一次性
    visibility: 'interactive', // 前台可见：这条 lane 的目的就是让用户看见 AI 在干活
  }
}

interface SessionsLike {
  acquire(spec: RecipeSessionSpec, entryUrl: string, waitUntil?: string): Promise<RecipeSessionLease>
}

interface RelayLike {
  list(): Promise<Array<{ tabId: number; url: string; title: string }>>
  sendCommand(tabId: number, method: string, params: unknown, expectDomain?: string, sessionId?: string): Promise<unknown>
  closeTab(tabId: number): Promise<void>
  /** iframe 那一套要它（OOPIF 子会话）。缺席 = 只有顶层（测试里的小假货）。 */
  frameSessions?(tabId: number): Promise<FrameSession[]>
  /** 点击回执里的「开出了新标签」要它。 */
  openedSince?(openerTabId: number, since: number, waitMs?: number): Promise<TabOpened[]>
}

/** 会开出新标签的动作（链接 / window.open 都要一次用户手势）。只对它们付等待的钱。 */
const MAY_OPEN_TAB: ReadonlySet<LaneAction['kind']> = new Set(['click', 'submit'])

/**
 * 点完之后等新标签露面的上界。`window.open` / `target=_blank` 的标签在点击被页面处理的那一刻
 * 就建出来，扩展收下后立刻报上来——这里等的是"点击被页面处理 + 一跳 WS"，第一条到就返回。
 * 代价只落在"没开新标签、也没带 expect 或 expect 没等到"的点击上：白等这么久。
 */
export const OPENED_WAIT_MS = 500

export class InteractiveLane {
  private lease: RecipeSessionLease | null = null

  /**
   * `sessions` 只有 open() 用得上（它要一条 session 租约）。list/act/look/close 作用在**已经
   * 存在的** tab 上——tabId 从 cdp_pages 认出来、或从 cdp_look 的 interactive:true 拿回来——
   * 只需要中继。所以它可以是 null：MCP 那条路只用后四个原语（开 tab 是 cdp_look 的活），传一个
   * 用不到的 session manager 进来只会让人以为它们之间有关系。
   */
  constructor(
    private readonly sessionId: string,
    private readonly sessions: SessionsLike | null,
    private readonly relay: RelayLike,
    private readonly mode: LaneMode = 'act-without-asking',
  ) {}

  /** 开这条 lane（前台可见 tab，入会话标签组），返回 tabId。多步复用它，不重开。 */
  async open(entryUrl: string): Promise<{ tabId: number }> {
    if (!this.sessions)
      throw new Error('interactive lane: 本 lane 没有 session manager，open 不可用（act/look 作用在已存在的 tab 上，不需要它）')
    if (!this.lease) {
      this.lease = await this.sessions.acquire(agentLaneSpec(this.sessionId), entryUrl, 'domcontentloaded')
    }
    const tabId = (this.lease.rawPage as { tabId?: number } | undefined)?.tabId
    if (tabId == null) throw new Error('interactive lane: ext-cdp rawPage carries no tabId')
    return { tabId }
  }

  /** 枚举会话标签组内的 tab（{tabId,url,title}）——AI 靠它认目标，不靠猜。 */
  list(): Promise<Array<{ tabId: number; url: string; title: string }>> {
    return this.relay.list()
  }

  /**
   * 执行一个动作。默认档下高危动作会被确认门拦下（返回 needs-confirmation，**绝不先斩后奏**）；
   * 用户确认后带 `{confirmed:true}` 再调一次才真执行。
   */
  async act(action: LaneAction, opts?: { confirmed?: boolean }): Promise<ActResult> {
    const cls = classifyAction(action)
    if (!opts?.confirmed && needsConfirmation(action, this.mode)) {
      return { status: 'needs-confirmation', reason: cls.reason }
    }
    // mutating 动作把发起时的域名带下去：扩展侧执行前再校验一次，页面若已跑到别的域名就拒。
    const expectDomain = cls.readOnly ? undefined : action.domain
    const driver = makeExtPageDriver(await this.rawPageFor(action, expectDomain))
    const since = Date.now()
    // action→observe：带了 expect 就点完确认它出现（confirmed / acted-unconfirmed），否则 done。
    const r = await actWithConfirm(driver, action)
    if (!MAY_OPEN_TAB.has(action.kind) || r.status === 'not-found' || !this.relay.openedSince) return r
    // 预期已经在原标签里兑现 → 只看已经到了的，不再等（页面显然是就地变的）。
    const opened = await this.relay.openedSince(action.tabId, since, r.status === 'confirmed' ? 0 : OPENED_WAIT_MS)
    if (!opened.length) return r
    return { ...r, opened: opened.map((o) => ({ tabId: o.tabId, url: o.url, target: `chrome:${o.tabId}` })) }
  }

  /**
   * 动作落在哪份文档上。没指 frame、也不是 `ref` → 顶层（原来的那条路，一次多余的往返都不加）。
   * 指了 frame → 按 id / URL 认出它；是 `ref` → 逐 frame 问谁有这个号（编号全 tab 唯一）。
   */
  private async rawPageFor(action: LaneAction, expectDomain: string | undefined) {
    const ref = refFromSelector(action.selector)
    if (!action.frame && ref == null) return makeExtRawPage(this.relay, action.tabId, expectDomain)
    const relay = this.frameRelay()
    if (!relay) {
      if (action.frame) throw new Error('frame: 这条中继不支持 iframe（缺 frameSessions）')
      return makeExtRawPage(this.relay, action.tabId, expectDomain)
    }
    if (action.frame && (action.kind === 'goto' || action.kind === 'setFiles')) {
      throw new Error(`${action.kind} 不支持 frame——它作用在整张标签 / 顶层文档上`)
    }
    const frames = await listFrames(relay, action.tabId)
    const f = action.frame ? resolveFrame(frames, action.frame) : await frameOfRef(relay, action.tabId, frames, ref!)
    if (!f.parentId) return makeExtRawPage(this.relay, action.tabId, expectDomain)
    return makeFrameRawPage(this.relay, action.tabId, frames, f, expectDomain)
  }

  private frameRelay(): FrameRelay | null {
    const r = this.relay
    return r.frameSessions ? (r as RelayLike & FrameRelay) : null
  }

  /**
   * 读一眼中间结果（求值），决定下一步。纯读，永不打断，也不做域名校验——读一个已经跳走的
   * 页面只会读到没用的东西，不会把动作落到非预期的站上（那是 mutating 才有的风险）。
   * 走 evalExpr：拆包成值本身（不是 CDP 原始回包），页内抛异常照实冒出来。
   * `frame` 给了就在那个 iframe 里求值（同进程 iframe 跑在隔离世界：DOM 可读，页面 JS 全局不可见）。
   */
  look(tabId: number, expression: string, frame?: string): Promise<unknown> {
    if (!frame) return makeExtRawPage(this.relay, tabId).evalExpr(expression)
    const relay = this.frameRelay()
    if (!relay) return Promise.reject(new Error('frame: 这条中继不支持 iframe（缺 frameSessions）'))
    return evalInFrame(relay, tabId, frame, expression)
  }

  /** 跨 iframe 的元素清单（编号全 tab 唯一，iframe 里的条目带 `frame`）。 */
  inventory(tabId: number): Promise<unknown> {
    const relay = this.frameRelay()
    if (!relay) return makeExtRawPage(this.relay, tabId).evalExpr(inventoryExpression())
    return inventoryAcrossFrames(relay, tabId)
  }

  /**
   * 收工——**命令式**。扩展侧按 tab 出身分流：AI 自建的回收，用户拖入的只 detach + 移出组
   * （绝不销毁用户自己的 tab）。不发 close 也不泄漏（SW 重启 reap 兜底）。
   */
  async close(tabId: number): Promise<void> {
    await this.relay.closeTab(tabId)
  }

  /** 整条 lane 收工（释放 session 租约）。同样是命令，不是自动清理。 */
  async release(): Promise<void> {
    await this.lease?.release()
    this.lease = null
  }
}
