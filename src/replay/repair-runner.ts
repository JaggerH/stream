import type { Scene } from './scene.ts'
import type { StateDef } from './state-graph.ts'

/**
 * The reserved seam for auto-repair. When a replay source is quarantined, the
 * adapter calls `requestRepair`. Today the default just LOGS it (the current
 * manual flow: you see the log, then run building-browser-recipes yourself).
 *
 * FUTURE: with enough budget, install a server-side Code Agent that implements
 * this interface — it consumes `RepairLedger.pending()`, runs the
 * building-browser-recipes skill under `budgetTokens`, writes v+1 back, and the
 * adapter auto-releases the quarantine on the new version. One-line swap in
 * bootstrap; nothing else changes.
 */
export interface RepairJob {
  sourceId: string
  reason: string
  /** 这次隔离连累了哪些 Source（全名，含 `sourceId` 本身）——见 `RepairState.affectedSources`。
   *  缺席 = 没算过。**被共用的 recipe 正是这条线上最容易漏掉的那种**：漂的是 detail，哑的是
   *  home 和 search，而它们各自的健康状态一切正常。 */
  affectedSources?: string[]
  /** hard token ceiling a future agent must respect when re-authoring */
  budgetTokens?: number
}

/**
 * 一条 **locator 提议**：某一步的 `expect` 没兑现，而它的靶子是缓存给的（陈旧模板 / 漂了的
 * 坐标 / 指错了的句柄）。作废之后把「它当时是怎么找到的、可能该改成什么」交出去。
 *
 * 和 `RepairJob` 的粒度不一样，两个都要：`RepairJob` 是**源级**的（连漂 K 次 → 隔离 → 重写
 * 整份 recipe），这条是**步级**的，而且只谈一个 locator。
 *
 * 三条边界，都是有意的：
 *
 * - **绝不自动改 recipe**（spec §5.3）。静默自愈会把「界面真的改了」和「这次没点中」混成
 *   同一件事，而后者自愈"成功"就等于把一个真 bug 每次都自动绕过去，于是永远没人知道。
 * - **范围锁死在 locator**：`see` 里装的永远是**动作那一步**的目标，不是判据里的那个。
 *   判据一旦能被改写，整套东西就退化成「模型自己说自己成了」。
 * - **它不代表这一步会重试**。runner 作废靶子之后**不在同一趟里重走**——这一趟已经点过一次，
 *   副作用可能已经发生了。提议是给下一趟（和给人）的。
 */
export interface RepairProposal {
  sourceId: string
  /** 出问题那一步的 label（recipe 里写的那句），没写就没有。 */
  stepLabel?: string
  /** **动作那一步**的 `see`（原样），不是 `expect` 里的那个。 */
  see: unknown
  /** 失败那一次的靶子是从梯子哪一档来的（`template` / `point` / `pinned`…）。 */
  wasVia: string
  /** 那一档留下的句柄或引用，有就带上——这是给人看的「它当时指的是这个」。 */
  wasRef?: string
  reason: string
  /** 这条 recipe 的设施键（`recipe.session.facility`）。**状态图与观测账本都按它分文件**（spec §9.1），
   *  缺席时 Broker 退回用 `sourceId`——那是老路径，会把同站的状态学散，所以新接线一律带上。 */
  facility?: string
  /** 触发那一刻的现场：截图 + 元素表 + 文字 + url（spec §4.1）。缺席 = 引擎没抓到（老路径 / driver 不支持）。 */
  scene?: Scene
}

/**
 * 一条**状态提议**：`expect` 落空之后引擎问「我在哪」，而本地答不上来。
 *
 * 和 `RepairProposal`（步级、只谈一个 locator）是并列的第三种粒度：这条谈的是**状态图本身**
 * 缺了什么。三条边界与 `RepairProposal` 完全一致，不重复解释：绝不自动改 recipe、范围锁死
 * （只加特征与转移，**永远不碰任何 `expect`**）、不代表这一步会重试。
 *
 * `kind` 决定 AI 被问的是哪一种问题：
 * - `state`         —— no-match：这是哪儿？→ 一组能认出当前状态的特征
 * - `discriminator` —— ambiguous：拿什么区分这几个？→ 一条区分性特征
 * - `transition`    —— 认出来了但无路：下一步点哪？→ 目标 + 操作方式
 *
 * `state` 与 `discriminator` 的产物**必须过 `checkDiscriminative` 那道闸**才允许被采纳。
 */
export interface StateProposal {
  sourceId: string
  kind: 'state' | 'discriminator' | 'transition'
  reason: string
  /** 此刻观测到的、可以当特征用的东西（特征键）。给人看的现场。 */
  observed: string[]
  /** `discriminator` 专用：同时命中的那几个。 */
  candidates?: string[]
  /** `transition` 专用。 */
  from?: string
  goal?: string
  /** 这条 recipe 的设施键（`recipe.session.facility`）。**状态图与观测账本都按它分文件**（spec §9.1），
   *  缺席时 Broker 退回用 `sourceId`——那是老路径，会把同站的状态学散，所以新接线一律带上。 */
  facility?: string
  /** 触发那一刻的现场：截图 + 元素表 + 文字 + url（spec §4.1）。缺席 = 引擎没抓到（老路径 / driver 不支持）。 */
  scene?: Scene
  /** 状态图里已知的状态（含特征）——让 AI 用我们的词汇答，也让它知道「已有哪些」。 */
  known?: StateDef[]
}

export interface RepairRunner {
  requestRepair(job: RepairJob): Promise<void>
  /** 见 `RepairProposal`。**和 `requestRepair` 一样是接缝，不是功能**——默认只打日志。 */
  proposeLocator(proposal: RepairProposal): Promise<void>
  /** 见 `StateProposal`。同样是接缝，默认只打日志。 */
  proposeState(p: StateProposal): Promise<void>
  proposeDiscriminator(p: StateProposal & { candidates: string[] }): Promise<void>
  proposeTransition(p: StateProposal & { from: string; goal: string }): Promise<void>
}

/** Default: log the repair request. No AI, no tokens — a human acts on the log. */
export class LoggingRepairRunner implements RepairRunner {
  constructor(private readonly log: (...args: unknown[]) => void = console.error) {}

  async proposeLocator(p: RepairProposal): Promise<void> {
    const ref = p.wasRef ? `（当时指的是 ${p.wasRef}）` : ''
    this.log(
      `[locator-proposal] ${p.sourceId}${p.stepLabel ? ` / ${p.stepLabel}` : ''}: ` +
        `${p.reason} — 靶子来自 ${p.wasVia}${ref}，已作废；目标 ${JSON.stringify(p.see)}。` +
        `**没有改 recipe**：界面真的变了就得人来改，只是没点中则下一趟重走梯子即可。`,
    )
  }

  async requestRepair(job: RepairJob): Promise<void> {
    // 连累到的其他源单独说一句。它们各自的健康状态是绿的（没人替它们跑过这份 recipe），
    // 所以不在这里点名，就没有任何一处会提到它们哑了。
    const others = (job.affectedSources ?? []).filter((id) => id !== job.sourceId)
    const also = others.length ? ` — 跟着哑的还有：${others.join('、')}` : ''
    this.log(
      `[repair-needed] ${job.sourceId}: ${job.reason} — run building-browser-recipes to re-author the recipe${also}`,
    )
  }

  async proposeState(p: StateProposal): Promise<void> {
    this.logProposal(p, '认不出这是哪个状态')
  }

  async proposeDiscriminator(p: StateProposal & { candidates: string[] }): Promise<void> {
    this.logProposal(p, `同时命中了 ${p.candidates.join('、')}，缺一条区分性特征`)
  }

  async proposeTransition(p: StateProposal & { from: string; goal: string }): Promise<void> {
    this.logProposal(p, `${p.from} 到 ${p.goal} 之间没有已知的路`)
  }

  private logProposal(p: StateProposal, what: string): void {
    const seen = p.observed.length ? `现场观测：${p.observed.join('、')}。` : ''
    this.log(
      `[state-proposal:${p.kind}] ${p.sourceId}: ${p.reason} — ${what}。${seen}` +
        `**没有改 recipe**：状态图要人来补，而特征入库前必须过区分度闸。`,
    )
  }
}

/**
 * 调用时才解的转发：adapters / harvest 域比介入域早装配，装配期取 `ctx.intervention` 就是冻住的
 * undefined（AGENTS.md「装配期取的值 = 冻住的答案」）。目标缺席（介入域没挂 / 还没挂）→ fallback。
 */
export function forwardingRepairRunner(resolve: () => RepairRunner | undefined, fallback: RepairRunner): RepairRunner {
  const pick = () => resolve() ?? fallback
  return {
    requestRepair: (j) => pick().requestRepair(j),
    proposeLocator: (p) => pick().proposeLocator(p),
    proposeState: (p) => pick().proposeState(p),
    proposeDiscriminator: (p) => pick().proposeDiscriminator(p),
    proposeTransition: (p) => pick().proposeTransition(p),
  }
}
