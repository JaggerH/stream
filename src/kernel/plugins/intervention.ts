import type { Context } from 'cordis'
import { join } from 'node:path'
import { InterventionBroker } from '../../intervention/broker.ts'
import { InterventionRunStore } from '../../intervention/run-store.ts'
import { AGENT_ROW_ID, agentRowSchema, readAgentConfig } from '../../intervention/agent-config.ts'
import { latestFailureShots } from '../../intervention/failure-shots.ts'
import { RepairManager } from '../../intervention/repair-manager.ts'
import { ExploreManager } from '../../intervention/explore-manager.ts'
import { browserSurface, type CdpVerbs } from '../../intervention/explore-surface.ts'
import type { ProbeRunner, RepairSessionDeps } from '../../intervention/repair-session.ts'
import type { RepairRunner } from '../../replay/repair-runner.ts'
import type { StateGraph } from '../../replay/state-graph.ts'
import { ObservationLedger } from '../../replay/observation-ledger.ts'
import { StateGraphStore } from '../../replay/state-graph-store.ts'
import { lazyNotify } from '../../events/service.ts'

/**
 * 介入服务对外的那张脸（spec §3）。
 *
 * 两条边界，别在实现时改掉：
 *
 * - **`graphFor` 的键是 facility，不是 sourceId。** 状态是站点级的事：同一个站上的
 *   home / search / detail 三份 recipe 看到的是同一批状态，按 sourceId 分会把同一张图
 *   学成三份互不相识的碎片，而每一份单看都"正常"。
 * - **消费方一律调用时现取**（`ctx.intervention?.repairRunner` 而不是装配期存一份）。
 *   harvest 域比这个域装配得早，装配期取一次就是永久冻住一个 undefined，而症状是
 *   「介入从来没发生过」，没有任何一处会喊（AGENTS.md「装配期取的值 = 冻住的答案」）。
 */
export interface InterventionService {
  /** 每一次介入运行的账本（谁问的、花了多少、产出了什么）。 */
  store: InterventionRunStore
  /** 观测账本：某个状态在某一刻为真的特征键，喂区分度闸。 */
  observations: ObservationLedger
  /** 学到的那一层状态图的存放处（包自带那层由包扫描器给，合成在 `graphFor`）。 */
  graphs: StateGraphStore
  /** 引擎交提议的收件人。缺席 = 不介入。 */
  repairRunner: RepairRunner
  /** 活着的 agent 修复会话登记处（HTTP 动作面经它找到实例）。 */
  repairs: RepairManager
  /** 活着的探索会话登记处（五个 `graph_*` 建图工具经它按 runId 找到实例）。 */
  explorations: ExploreManager
  /**
   * 两档会话的**同一张动作面**（继续 / 取消 / 说一句 / 答审批 / 续）。HTTP 那一层只认 runId，
   * 不知道它是修复还是探索——分两个口就等于让路由去猜，猜错的表现是「按钮点了没反应」
   * （404 被当成 run 没了）。
   */
  sessions: AgentSessionActions
  /** 这个 facility 的**本地**状态图（包自带 ∪ 学到的）。内置的全局那张由 runner 自己并。 */
  graphFor(facility: string): StateGraph | undefined
}

/**
 * 一条 run 的五个动作，**先问修复、`'not-found'` 再问探索**。次序不重要（runId 全局唯一，
 * 一条 run 只可能在一处），要紧的是「两处都问过了才回 not-found」——只问一处的话另一档的
 * 每一次操作都变成 404，而 404 读起来完全像「这条 run 已经结束了」。
 */
export interface AgentSessionActions {
  answerPermission(runId: string, permissionId: string, optionId: string): 'ok' | 'not-found' | 'no-such-permission'
  continue(runId: string): 'ok' | 'not-found' | 'not-paused'
  cancel(runId: string): Promise<'ok' | 'not-found'>
  say(runId: string, text: string): 'ok' | 'not-found'
  resume(runId: string): 'ok' | 'not-found' | 'not-resumable' | 'busy'
}

declare module 'cordis' {
  interface Context {
    /** AI 介入这一域（spec 2026-09-11-ai-intervention-design）。键带域前缀，见 `src/kernel/context.ts` 头注。 */
    intervention: InterventionService
  }
}

export interface InterventionConfig {
  dataDir: string
  log: (...a: unknown[]) => void
  /** agent 用哪个 MCP 端点回头使唤我们（`/api/mcp` + api token）。**thunk**：serve.ts 才知道口和 token。 */
  mcpEndpoint?: () => { url: string; token: string } | undefined
  /**
   * 活体 probe 的执行器工厂。**两层 thunk 各有分工**：外层（这一格）在装配期可能还取不到
   * harvest 域；内层（返回值缺席）说的是「这一份 recipe 这条路跑不了」——两种都要如实落到
   * `skipped-no-executor`，补一个假执行器就会把「没验过」显示成「验过了」。
   */
  probe?: () => ProbeRunner | undefined
  /** 任务书里点名哪几个 MCP 工具可用。缺席 = 默认那四个看活页面的动词。 */
  mcpToolNames?: () => string[]
  /**
   * 探索面骑的那三个 cdp 动词。**thunk**：它们住 agent 域的 `mcpExtras`，而那个域比本域晚装配
   * ——装配期取一次就是永久冻住 undefined，症状是「探索永远起不来」且只有一句日志。
   * 三个不全就该缺席（`browserSurface` 三个都要），别补空实现。
   */
  cdp?: () => CdpVerbs | undefined
  /**
   * 怎么起一个 agent 子进程。生产缺省 = `spawnAcpAgent`（两个 manager 各自兜底）；**测试必须
   * 注入**——这个域的两条会话都会 spawn 真进程，而 qrun 的锁只管「同时只有一轮 vitest」，
   * 护不住比测试活得久的子进程（AGENTS.md 那条 20 个孤儿 npm 的事故）。
   */
  openAgent?: RepairSessionDeps['openAgent']
}

/** 任务书默认点名的工具：看一眼活着的页面那四个动词（`drive-live-ui`）。 */
const DEFAULT_MCP_TOOLS = ['cdp_look', 'cdp_shot', 'cdp_act', 'cdp_pages']

/** 探索那一档额外点名的五个建图工具（`src/mcp/tool-catalog.ts` 注册的就是这五个名字）。 */
const GRAPH_TOOLS = ['graph_frontier', 'graph_act', 'graph_record_state', 'graph_back', 'graph_mark_irrelevant']

/**
 * 介入域：run 存储 + 观测账本 + 状态图两层 + Broker + 修复会话登记处。
 * inject `llm` / `streamEvents` / `sources` / `settings`——
 * 但 Broker 里对 `ctx.llm.forTask`、状态图与 manager 对 `ctx.sources.recipePackages()`、
 * manager 对 `ctx.settings.rows.resolve(AGENT_ROW_ID)` 都是**调用时现取**
 * （用户运行期改配置、install 热挂载都不该冻住）。句柄一个（sqlite），登记成 effect。
 */
export const interventionPlugin = {
  name: 'intervention',
  inject: ['llm', 'streamEvents', 'sources', 'settings'],
  apply(ctx: Context, config: InterventionConfig): void {
    const store = new InterventionRunStore(join(config.dataDir, 'interventions.db'))
    ctx.effect(() => () => store.close())
    const observations = new ObservationLedger(join(config.dataDir, 'state-observations'))
    const graphs = new StateGraphStore(
      join(config.dataDir, 'state-graphs'),
      (facility) => ctx.sources.recipePackages().byFacility.get(facility)?.states,
    )
    // agent 档的配置行（`/api/config/ai-agent`）。注册走 effect：域卸载时注销，重挂不撞 duplicate。
    ctx.effect(() => ctx.settings.rows.register({ id: AGENT_ROW_ID, schema: agentRowSchema }))
    const repairs = new RepairManager({
      store,
      notify: lazyNotify(() => ctx.streamEvents),
      log: config.log,
      // 每一格都现取：用户随时在设置里填/改命令，包表随 `stream add` 热挂载。
      agentConfig: () => readAgentConfig(ctx.settings.rows.resolve(AGENT_ROW_ID)),
      packageFor: (sourceId) => {
        const pkg = ctx.sources.recipePackages().list.find((p) => p.sources.some((m) => m.id === sourceId))
        return pkg ? { dir: pkg.dir, facility: pkg.facility } : undefined
      },
      mcpEndpoint: () => config.mcpEndpoint?.(),
      mcpToolNames: () => config.mcpToolNames?.() ?? DEFAULT_MCP_TOOLS,
      // 原样转发那个 thunk（**不包一层 async**）：包了的话「取不到执行器」就变成一次抛错，
      // 而 `validateCandidate` 会把它记成「活体 probe 抛错」——一句看着像站点坏了的话，
      // 实际只是这台机器没开浏览器采集。缺席就该老实显示 `skipped-no-executor`。
      ...(config.probe ? { probe: config.probe } : {}),
      failureShotsFor: (local) => latestFailureShots(join(config.dataDir, 'failures'), local, 3),
      ...(config.openAgent ? { openAgent: config.openAgent } : {}),
      workRoot: join(config.dataDir, 'repair-work'),
    })
    // **回 Promise，别 `void`**：`dispose()` 要 cancel 每条活会话——关连接、SIGTERM，再等最多
    // 一个宽限期（`RepairSession.closeAgent`），没走开就 SIGKILL。丢掉这个 promise 就等于关停
    // 不等 agent 走开：进程退了，agent 子进程还在。
    ctx.effect(() => () => repairs.dispose())
    const broker = new InterventionBroker({
      store, observations,
      llm: () => ctx.llm?.forTask,
      notify: lazyNotify(() => ctx.streamEvents),
      log: config.log,
      repairs,
    })
    const explorations = new ExploreManager({
      store,
      notify: lazyNotify(() => ctx.streamEvents),
      log: config.log,
      agentConfig: () => readAgentConfig(ctx.settings.rows.resolve(AGENT_ROW_ID)),
      mcpEndpoint: () => config.mcpEndpoint?.(),
      ...(config.openAgent ? { openAgent: config.openAgent } : {}),
      // 探索那一档的工具名单 = 四个 cdp 动词 + 五个建图工具。
      // **今天追加 GRAPH_TOOLS 是个空动作，别把它读成"任务书靠这里点名"**：`explore-task-book.ts`
      // 只从这份名单里挑 `cdp_` 开头的那几个，五个建图工具的名字是散文里写死的。保留这一行是给
      // 将来真去消费整份名单的地方（任务书改成读名单、或 ACP 那边按名单限权）用的。
      mcpToolNames: () => [...(config.mcpToolNames?.() ?? DEFAULT_MCP_TOOLS), ...GRAPH_TOOLS],
      workRoot: join(config.dataDir, 'explore-work'),
      // 草稿与学到的图同一个目录（文件名由 `draftPath` 区分），并图那一步不用跨目录搬。
      draftDir: join(config.dataDir, 'state-graphs'),
      graphs,
      observations,
      llm: () => ctx.llm?.forTask,
      // **每起一条探索现取一次 cdp**：三个动词住 agent 域，装配期它还没在。取不到就如实抛
      // ——补一个假 surface 的话，探索会「成功」地在一张不存在的页面上点完一整轮。
      surface: (target) => {
        const cdp = config.cdp?.()
        if (!cdp) throw new Error('cdp 路由不可用（agent 域没起 / 这台机器没接采集浏览器）')
        return browserSurface(cdp, target)
      },
    })
    // 同 repairs 那行：**回 Promise 别 void**，关停要等每条活会话的 agent 子进程真走开。
    ctx.effect(() => () => explorations.dispose())
    ctx.provide('intervention', {
      store, observations, graphs, repairRunner: broker, repairs, explorations,
      sessions: {
        answerPermission: (runId, permId, optionId) => {
          const r = repairs.answerPermission(runId, permId, optionId)
          return r === 'not-found' ? explorations.answerPermission(runId, permId, optionId) : r
        },
        continue: (runId) => {
          const r = repairs.continue(runId)
          return r === 'not-found' ? explorations.continue(runId) : r
        },
        cancel: async (runId) => {
          const r = await repairs.cancel(runId)
          return r === 'not-found' ? explorations.cancel(runId) : r
        },
        say: (runId, text) => {
          const r = repairs.say(runId, text)
          return r === 'not-found' ? explorations.say(runId, text) : r
        },
        resume: (runId) => {
          const r = repairs.resume(runId)
          return r === 'not-found' ? explorations.resume(runId) : r
        },
      },
      graphFor: (facility) => graphs.graphFor(facility),
    } satisfies InterventionService)
  },
}
