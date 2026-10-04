import type { Context } from 'cordis'
import { join } from 'node:path'
import Schema from 'schemastery'
import type { SummaryPromptStatus } from '../../settings-store.ts'
import type { ChatEndpoint, ChatMessage } from '../../llm/client.ts'
import {
  llmContentQuiet,
  chatViaLlm,
  resolveLadderEndpoint,
} from '../../llm/task.ts'
import { WishlistStore } from '../../onboard/wishlist-store.ts'
import { SearchAgentService, surfaceRun } from '../../agent/search/service.ts'
import { SearchRunStore } from '../../agent/search/run-store.ts'
import { netdiskDomain } from '../../agent/search/domains/netdisk.ts'
import { catalogDomain, priceOf } from '../../agent/search/domains/catalog.ts'
import { buildMcpExtras } from '../../mcp/mcp-extras.ts'
import { pruneArtifacts } from '../../mcp/action-artifacts.ts'
import type { McpExtras } from '../../mcp/tool-catalog.ts'
import { IntentService } from '../../intent/service.ts'
import { IntentStore } from '../../intent/store.ts'
import { makeIntentLlm } from '../../intent/llm.ts'
import { webSearchLadder, type WebSearchLeg } from '../../search/web-search-ladder.ts'
import { parseShareLink } from '../../video/parse.ts'
import { slimContentSearchResults, communityByCategory } from '../../mcp/content-search-slim.ts'
import { runPurchaseDecision, type DecisionConstraints, type DecisionDeps } from '../../agent/purchase/job.ts'
import type { RunStatus } from '../../agent/search/types.ts'
import { makeCatalogUniverse, catalogsOf } from '../../agent/purchase/universe-catalog.ts'
import { makeUniverse, makeDiscoveryUniverse } from '../../agent/purchase/universe-discovery.ts'
import { makeSignalJoint } from '../../agent/purchase/signal-runner.ts'
import { makeReviewText } from '../../agent/purchase/review-text.ts'
import { resolveResidual } from '../../agent/purchase/resale-pick.ts'
import { settleWithin } from '../../mcp/extract-settle.ts'
import type { StreamService } from '../../mcp/tools.ts'
import type { StoredItem } from '../../item-store.ts'

declare module 'cordis' {
  interface Context {
    /** 对话 / 搜索 agent / 意图跟踪这一域（`src/kernel/plugins/agent.ts`）——一个聚合对象，
     *  不是十个 ctx key。 */
    agent: AgentDomain
  }
}

/** 一条网页搜索结果。三条腿（Google / Brave / 百度）取值同一段，形状必须一致。 */
export interface WebHit {
  title: string
  url: string
  snippet?: string
}

/**
 * agent 域的聚合对象。
 *
 * 八格全部必有：这一域没有条件装配，所以任何一格是 undefined 都是接线断了，
 * 而不是一档合法降级。
 */
export interface AgentDomain {
  /** 接不上的站记在这儿（见 `src/onboard/wishlist-store.ts`）。 */
  onboardWishlist: WishlistStore
  /** 摘要 prompt + LLM 梯子就绪状态（连接/模型的配置面在 Providers 页，不在这里）。 */
  summaryPromptStatus: () => SummaryPromptStatus
  /** persist + hot-apply 摘要 prompt。写路径 = `settings.rows.put('summary-prompt')`（配置 row
   *  引擎），热生效靠 row 的 apply 钩子回读——见下面 `summaryPrompt` 的头注。 */
  setSummaryPrompt: (prompt: string) => Promise<SummaryPromptStatus>
  /**
   * 摘要 prompt 的**原值 thunk**——转换域（summary converter）吃的就是这一格。
   *
   * 它和 `summaryPromptStatus` 读的是**同一份可变引用**（本域内的 `currentPrompt`），
   * 写路径（row 的 apply 钩子）回填它：热改之后两个消费端（设置页读回状态、summary
   * converter 组装 prompt）立刻都见效。分成两份状态的症状是「改完 prompt 得重启才算数」，
   * 而没有一处会报错。
   */
  summaryPrompt: () => string | undefined
  /** 「上网查一下」的唯一实现：三条腿的梯子（判据与回落语义见 `search/web-search-ladder.ts`）。
   *  MCP/对话的 `web_search` 工具和 search agent 的发现关节**吃的是同一条**。 */
  webSearch: (query: string) => Promise<{ hits: WebHit[]; note?: string }>
  /** 目标导向的搜索 agent（spec 2026-07-15）：起一轮 + 读它的轨迹。`enumerate` 是同一条
   *  发现循环的商品档（spec 2026-09-01）：吃结构化约束、回答"符合条件的有哪些"。 */
  searchAgent: {
    start: (goal: string) => unknown
    get: (runId: string) => unknown
    enumerate: (input: {
      category: string[]
      priceMin?: number
      priceMax?: number
      constraints?: string[]
    }) => unknown
  }
  /** 购买决策 job（spec 2026-09-02）：整条路线跑在代码里，出前沿 + 覆盖率。**异步**：立刻回
   *  {runId, status}，回执落 agent-runs.db（domain 'purchase'，`result` 格），`searchAgent.get`
   *  取。工具面是 `purchase_decide` + `get_agent_run`。见 `src/agent/purchase/job.ts`。 */
  purchaseDecide: (c: DecisionConstraints) => { runId: string; status: RunStatus }
  /** 意图跟踪服务面：create/list/dossier/recruit/digestNow/scanDue。 */
  intents: IntentService
  /** run 账本（`agent-runs.db`）+ 动作产物目录的保留期清理。开机跑一次，`agent-runs-prune` 任务每天一次。 */
  agentRuns: { prune: () => { removed: number; stripped: number; files: number; vacuumed: boolean } }
  /** MCP 工具面的 extras，**全进程只建这一份**：HTTP 的 MCP mount（serve.ts）与进程内对话
   *  agent 吃同一个对象，两面因此不会在「暴露了哪些能力」上漂。 */
  mcpExtras: McpExtras
}

export interface AgentConfig {
  /** 可写状态根目录（`conversations.db` / `agent-runs.db` / `intents/` 都在它下面）。 */
  dataDir: string
  log: (...args: unknown[]) => void
  /**
   * MCP/对话工具面骑的那个 `StreamService`（订阅、预览、搜目录）。**同一个实例**，不是副本
   * ——意图跟踪的 recruit 与工具面的 subscribe 必须看到同一份 scheduler 视图。
   */
  service: StreamService
  /**
   * `scheduler.readSource` 的薄壳（三条网页搜索腿全部经它 → registry → replay adapter →
   * 用户自己的 Chrome）。**收 thunk 不是实例**：Scheduler 进内核是批次 8，此刻它还挂在
   * bootstrap 的局部上。
   */
  readSource: (
    sourceId: string,
    params: Record<string, unknown>,
    opts?: { userInitiated?: boolean },
  ) => Promise<unknown>
  /**
   * 介入域（探索会话登记处在它上面，五个 `graph_*` 工具按 runId 现取）。**thunk 不是实例**，
   * 而且**经 config 从根 kernel 现取**：本域不 inject 它——介入域是这棵树上另一条腿，inject
   * 会让工具面等一个与它无关的域；而装配期取一次就是冻住一个 undefined，症状是建图工具永远
   * 不注册（同 harvest 域那条 `intervention` 的先例）。
   */
  intervention?: () => { explorations: Pick<import('../../intervention/explore-manager.ts').ExploreManager, 'get'> } | undefined
}

/**
 * 搜索 agent / 意图跟踪 / MCP 工具面这一域。
 *
 * 三条互不相干的腿住在一个域里，是因为它们**共用同一套上游**：`llm.chat` 调用点解析出来的
 * 端点、同一份 `mcpExtras` 工具面、同一条网页搜索梯子。分成三个域的话这三样要么复制三份、
 * 要么互相 inject 绕成环。
 *
 * **用户面的对话不在这里**：它在用户自己的宿主里（Claude Code / Codex / DSH），经 `/api/mcp`
 * 使唤这里，模型由外部网关直供（不经本进程）、工具走 MCP 面——本域产出的 `mcpExtras` 正是
 * 那张工具面的原料。
 *
 * 依赖全部经 inject 从内核取（**从 ctx 现取，不解构存快照**）：
 *  - `ctx.settings` —— 摘要 prompt 的落盘面。
 *  - `ctx.stores` —— `channels`（llm 梯子的 Provider 行 / 意图的流存在性）、`itemStore`
 *    （意图消化的材料 / 工具面的 item 补全）、`sourceHealth`（`list_sources` 的健康列）、
 *    `audioArchive`（`resolve` 工具歌词那一档的缓存）。
 *  - `ctx.credentials` —— `tokenProvider`（梯子成员的钥匙在哪一层）。
 *  - `ctx.provider` —— `providerBindings` / `netdiskShare` / `radarMatcher`
 *    / `intentResolver` / `resolveEngine`。
 *  - `ctx.llm` —— `forTask`（两个调用点：story-fold.semantic / llm.chat）——账本才有数，
 *    别绕过它直打 `ctx.provider.llmForTask`。
 *  - `ctx.sources` —— `registry`（`list_sources`）。
 *  - `ctx.harvest` —— cdp_* 的三档地址与 harvest_capability 那几格。
 *  - `ctx.search` —— `contentSearch` / `videoSearch` 两个工具。
 *  - `ctx.conversions` —— `conversions` / `speakerRegistry` / `readUrl` / `agentGetTranscript`。
 *  - `ctx.netdisk` —— netdisk_* 四个工具（没配 AList → 两格 undefined，工具自动不注册）。
 *  - `ctx.streamEvents` —— 通知中心（`get_events` 工具 + 意图消化的播报）。
 *
 * 句柄一条，登记成 effect：`SearchRunStore`（agent-runs.db）那条 sqlite 连接。
 * **`IntentStore` 不登记**：它是目录型的 JSON 账本（`<dataDir>/intents/intents.json`，每次
 * 写整份文件），没有任何句柄可关——现场核实过，不是漏了。
 */
/**
 * `mcpExtras` 那张逐项转发表**有多少格**。
 *
 * 这是本批的主险：`buildMcpExtras` 收的是一个逐项转发的对象，漏一格**不报错、不 404**——
 * 那个工具只是安静地不注册，而模型照样会把动作叙述成已完成（AGENTS.md「追到另一端」的原型
 * 事故）。单测证不了这个，因为它们注入的是自己捏的 extras。
 *
 * 所以这个数字有两道闸门：装配期的自检（对不上直接 throw，见 `apply` 里那段）+ `agent.test.ts`
 * 里钉住它的断言。往表里加一格 → 两处都得改，任一处没改都是当场红。
 */
export const MCP_EXTRAS_DEP_COUNT = 46

export const agentPlugin = {
  name: 'agent',
  inject: [
    'settings', 'stores', 'credentials', 'provider', 'llm', 'sources',
    'harvest', 'search', 'conversions', 'netdisk', 'streamEvents',
  ],
  apply(ctx: Context, config: AgentConfig): void {
    const { dataDir, log, service } = config
    const settings = ctx.settings
    const { channels, itemStore, sourceHealth, audioArchive } = ctx.stores
    const { tokenProvider } = ctx.credentials
    const events = ctx.streamEvents

    // 接不上的站记在这儿（JSON，无句柄）。
    const onboardWishlist = new WishlistStore(join(dataDir, 'onboard-wishlist.json'))

    // ── llm.chat 端点解析 ────────────────────────────────────────────────────────
    // 第一个「端点+钥匙+模型」齐全的成员；模型由 llm.chat 绑定的覆盖决定（没设覆盖就用那个
    // 成员自己的 model）。**两个消费者**：意图跟踪的 LLM 关节、以及设置页的「LLM 配好了没」
    // 判据。null → 未配置。
    const chatLadderDeps = () => ({
      getProvider: (id: string) => channels.getProvider(id) ?? null,
      bindings: ctx.provider.providerBindings,
      token: (n: string) => tokenProvider.token(n),
    })
    const resolveChatEndpoint = (): ChatEndpoint | null =>
      resolveLadderEndpoint('llm.chat', chatLadderDeps())

    // ── 摘要 prompt 的状态面：**一份可变引用，row 的 apply 钩子回填** ─────────────
    // summary-prompt 是一个配置 row（spec 2026-08-17-config-rows-slice1）：schema/校验/落盘
    // 在引擎里，本域只负责 (1) 注册它 (2) 持一份热引用给状态面和转换域的 thunk。
    // 旧键 `llm.prompt`（连同更老的 connections/tasks 残骸）经 legacy 投影垫底。
    const readPrompt = (): string | undefined => {
      const p = settings.rows.resolve('summary-prompt').prompt as string | undefined
      return p || undefined // 空串 = 用后端内置默认（既有语义）
    }
    ctx.effect(() =>
      settings.rows.register({
        id: 'summary-prompt',
        schema: Schema.object({
          prompt: Schema.string().role('textarea').default('').description('摘要 prompt；留空用后端内置'),
        }),
        legacy: (s) => (s.llm ? { prompt: s.llm.prompt } : undefined),
        apply: () => {
          currentPrompt = readPrompt() // 热闭包里的 prompt 立即生效（buildSummaryMessages 读它）
        },
      })
    )
    let currentPrompt = readPrompt()
    /** 摘要 prompt + LLM 就绪状态。`configured` 判的是**梯子**：llm.summarize / llm.chat 任一
     *  调用点能解析出一个端点齐全（baseUrl+key+model）的成员即为已配置。旧判据读的是
     *  LlmSettings.tasks——那张表已经不在调用路径上，配好了梯子它照样报"未配置"。 */
    const summaryPromptStatus = (): SummaryPromptStatus => ({
      prompt: currentPrompt ?? '',
      configured: !!(resolveChatEndpoint() || resolveLadderEndpoint('llm.summarize', {
        getProvider: (id) => channels.getProvider(id) ?? null,
        bindings: ctx.provider.providerBindings,
        token: (n) => tokenProvider.token(n),
      })),
    })
    /** Persist + hot-apply 摘要 prompt——写路径就是 row 引擎，apply 钩子负责回填热引用。 */
    const setSummaryPrompt = async (prompt: string): Promise<SummaryPromptStatus> => {
      await settings.rows.put('summary-prompt', { prompt })
      return summaryPromptStatus()
    }

    // ── 网页搜索的三条腿 ────────────────────────────────────────────────────────
    /**
     * 一条浏览器搜索腿 = 一个包的搜索源，借用户自己那个 Chrome 打开真的结果页。
     *
     * **走的是现成的路，没有新造执行路径**：recipe 自带 `meta` 就是一个 Source，于是
     * `config.readSource(<全名>, …)` 和 xhs-search / douyin-search 完全同一条
     * （registry → replay adapter → SessionRecipeExecutor → 用户的 Chrome）。限速闸门
     * （包 `package.json` 的 `stream.rateLimit`）也长在那条路上，在开标签之前。
     *
     * **query 必须自己编码**：recipe 里的 `{query}` 由 `substitute` 纯文本替换、不做转义，
     * 查询词里一个 `#` 就把 querystring 截断了——而截断之后搜索站照样回一页结果，于是
     * 「搜错了」长得和「搜到了」一模一样。
     *
     * 三条腿的 recipe 都把目标 URL 映射进 `link`（中文腿那家取的是卡片的 `mu` 属性、不是
     * 中转链，理由在它 recipe 的 `_why_link_is_mu_not_the_redirect`），所以取值共用这一段、不用特判。
     *
     * 抛错就抛出去，**这里不吞**：吞在这一层，上面就分不清「没查成」和「真没有」了；
     * 该软化的地方是梯子（`webSearchLadder`），它会把失败变成一句 note。
     *
     * `sourceRef` 写全名，不是裸名：宿主自己的调用不吃裸名解析——第三方装一个同名包就能把这一句
     * 推进歧义分支。
     */
    const browserLeg = (label: string, sourceRef: string): WebSearchLeg => ({
      label,
      search: async (query: string): Promise<WebHit[]> => {
        const raw = await config.readSource(sourceRef, { query: encodeURIComponent(query) })
        return (raw as Array<Record<string, unknown>>)
          .map((r) => ({
            title: String(r.title ?? ''),
            url: String(r.link ?? r.url ?? ''),
            snippet: r.snippet ? String(r.snippet) : undefined,
          }))
          .filter((h) => h.url)
      },
    })

    /**
     * **三条腿的角色与顺序是宿主的产品判断**（spec 2026-09-26 §2.5）：哪家当主腿、哪家当主腿没跑成
     * 才叫的备胎、哪家在查询含汉字时并联——这是「这台宿主上网页搜索该长什么样」的决定，不是哪个包
     * 能替自己声明的东西，所以站点只在这里以包全名各出现一次；梯子本身只认角色。选型的实测证据
     * （主腿切题率、备胎与主腿的重合度、中文腿的长尾覆盖）写在 `search/web-search-ladder.ts` 头注。
     * `label` 是日志与 note 里给人读的出处。
     */
    const primaryLeg = browserLeg('Google', '@streamapp/google/google-search')
    const fallbackLeg = browserLeg('Brave', '@streamapp/brave/brave-search')
    // `@streamapp/baidu-search` 是百度网页搜索；`@streamapp/baidu` 是百度网盘，别搞混。
    const cjkLeg = browserLeg('百度', '@streamapp/baidu-search/baidu-search')

    // 搜索结果分档的判据来自清单 categories（`communityByCategory`），registry 现取——
    // 热装一个社区平台包之后下一轮搜索就该认它。
    const isCommunity = communityByCategory(ctx.sources.registry)

    /** 各档合成一份能力（判据与回落语义见 `web-search-ladder.ts`）。**全站只有这一个网页搜索
     *  入口**：对话里的 `web_search` 工具和 search agent 的发现关节都吃它，所以改梯子改一处。 */
    const webSearchTiered = (query: string) =>
      webSearchLadder(query, {
        primary: primaryLeg,
        fallback: fallbackLeg,
        cjk: cjkLeg,
        onPrimaryFailure: (q, reason) => log(`[stream] web_search 主腿（${primaryLeg.label}）没跑成 "${q}": ${reason}`),
        onFallbackFailure: (q, reason) => log(`[stream] web_search 备胎（${fallbackLeg.label}）也没跑成 "${q}": ${reason}`),
        // 中文那条腿挂了对结果没有影响（主腿那半边照常给），**这条日志是它唯一的痕迹**。
        onCjkFailure: (q, reason) => log(`[stream] web_search 中文腿（${cjkLeg.label}）没跑成 "${q}": ${reason}`),
        // **内容级折叠的取正文能力**——和 `read_url` 是同一份实现（全后端只有转换域 `readUrl`
        // 一处）。接上之后，标题被改写过的转载也能折起来；`STREAM_SEARCH_TEXT_FOLD=0` 是它的
        // 关灯开关（关掉只是退回「只比链接和标题」，不影响搜索本身）。
        readUrl: process.env.STREAM_SEARCH_TEXT_FOLD === '0' ? undefined : ctx.conversions.readUrl,
        onReadUrlFailure: (url, reason) => log(`[stream] web_search 折叠取正文没成 ${url}: ${reason}`),
        // **折叠的第 3 档：问模型「这几篇是不是同一件事」**。治的是第 2 档治不了的那类——同一篇
        // 通稿被 AI 重写过（实测共享块只剩 17 字，和「各写各的」的 6–11 字挨在一起，字数门槛分
        // 不开）。走 `llmContentQuiet`：没配 LLM / 梯子全 decline / 调用抛错一律 null =「判不了」，
        // 那几条保持原样，绝不影响这次搜索。`STREAM_SEARCH_SEMANTIC_FOLD=0` 是它的关灯开关
        // （默认开：它一个网络抓取都不发，只吃第 2 档已经抓到的正文，一次搜索最多一发调用）。
        askLlm:
          process.env.STREAM_SEARCH_SEMANTIC_FOLD === '0'
            ? undefined
            : (messages) => llmContentQuiet(ctx.llm.forTask, 'story-fold.semantic', { messages, temperature: 0 }),
        onSemanticFailure: (q, reason) => log(`[stream] web_search 语义折叠没判成 "${q}": ${reason}`),
        // 折叠没在总预算里做完 → 这次给没折的。结果和 note 都不变，**这条日志是它唯一的痕迹**。
        onFoldTimeout: (q, ms) => log(`[stream] web_search 折叠 ${ms}ms 内没做完 "${q}"：这次不折了`),
      })

    // ── 目标导向的搜索 agent（spec 2026-07-15）────────────────────────────────────
    // 一个 T3 job，入口是一次通用网页搜索——它发现的是聚集地（TG 频道 / 社区帖 / 剧集站），
    // 不是一个窄的网盘索引。LLM 关节（分类/扩源/切题）+ 可复盘轨迹。LLM 关节 = 经 llm 梯子的
    // `llm.chat` 调用点发一次定 prompt 的调用。（pansou 是 §6 第 3 步的下游解析器，不是入口。）
    const searchRunStore = new SearchRunStore(join(dataDir, 'agent-runs.db'))
    // 句柄清欠：agent-runs.db 上的这条连接过去从没人关。
    ctx.effect(() => () => searchRunStore.close())
    // 动作 recipe 的文件产物（`output.files`）落这儿；账本只存路径（`RESULT_MAX_BYTES` 头注）。
    const actionArtifactsDir = join(dataDir, 'action-artifacts')
    // 保留期清理：开机跑一次（账本清了空洞多就 VACUUM）+ 每天一次（`agent-runs-prune` 任务）。
    // 开机那一次不能省——账本撑到 GB 是**几个月**攒出来的，而定时任务只在后端常驻时才转。
    const pruneAgentRuns = () => {
      const runs = searchRunStore.prune()
      const files = pruneArtifacts(actionArtifactsDir)
      return { ...runs, files }
    }
    try {
      const r = pruneAgentRuns()
      if (r.removed || r.stripped || r.files || r.vacuumed) log(`[agent] 开机清理 run 账本：删 ${r.removed} 行、抹掉 ${r.stripped} 条超限结果、${r.files} 个产物文件${r.vacuumed ? '、已 VACUUM' : ''}`)
    } catch (e) {
      // 清理失败不该让后端起不来；但要留痕，静默的清理等于没清理。
      log(`[agent] 开机清理 run 账本失败：${e instanceof Error ? e.message : String(e)}`)
    }
    // 乙档: fetch a hub page's raw text so the domain's parse can pull concrete candidates. Generic
    // GET with a browser UA + 12s cap; per-hub failures are swallowed by the flow (login-gated /
    // blocked hubs stay onboardable). Not platform-normalized on purpose — hubs are arbitrary web pages.
    // `okOnly`：非 2xx 抛错而不是把错误页当正文——网盘档 parse 的 Discourse .json 补抓据此回落原页
    // （Discourse 的 404 也回 JSON，不查状态码就会把一张错误 JSON 当成话题正文，抽到空）。
    const fetchHubText = async (url: string, opts: { okOnly?: boolean } = {}): Promise<string> => {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 12_000)
      try {
        const res = await fetch(url, {
          signal: ac.signal,
          headers: {
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        })
        if (opts.okOnly && !res.ok) throw new Error(`HTTP ${res.status}`)
        return await res.text()
      } finally {
        clearTimeout(timer)
      }
    }
    const searchAgentService = new SearchAgentService({
      store: searchRunStore,
      flowDeps: {
        // **和对话里的 `web_search` 吃同一条梯子**，不单吃第 0 档——第 0 档在这台机器上实际只有
        // 一家引擎在答。代价是一趟浏览器搜索：热的 12–14s、冷的 50s 级（梯子出口的折叠有 8s
        // 总预算兜着，见 `web-search-ladder.ts` 的 `FOLD_BUDGET_MS`）。
        //
        // 只取 hits、把 note 丢掉：它自己就在多轮扩源，一句「有引擎没应答」既没有地方摆，也改变
        // 不了它下一步做什么（继续换词扩源）。note 只喂对话/MCP 那条腿。
        webSearch: async (keyword: string) => (await webSearchTiered(keyword)).hits,
        // LLM 关节走 llm.chat 调用点（与聊天同一个调用点、同一份 model 覆盖），非流式故直接经梯子。
        chat: (messages) => chatViaLlm(ctx.llm.forTask, { messages, temperature: 0.2 }),
        fetchPage: fetchHubText,
        // 早停参数原样保住现状：够 5 条切题 / 甲档集齐 5 个窝就停（叠在「边际产出趋零」之上）。
        earlyStop: { topical: 5, hubs: 5 },
        // 网盘档 domain：把现状原样打包进四格（spec 2026-09-01 §2.1）。verify 走的是和影视频道
        // 「找资源」同一个 netdisk.share.verify 调用点——一份能力两个消费方；agent 不认识夸克，
        // 只问"这条链里装着什么"。fetchText 供 parse 补 Discourse 话题页的 .json（抓壳不抓正文），
        // 非 2xx 抛错让 parse 回落原页。
        domain: netdiskDomain({
          verifyShare: (netdisk, pwdId, opts) => ctx.provider.netdiskShare.verify(netdisk, pwdId, opts),
          parseShareLink,
          fetchText: (url) => fetchHubText(url, { okOnly: true }),
        }),
      },
    })
    const searchAgent = {
      start: (goal: string) => searchAgentService.start(goal),
      // Surface only topical (≥1) targets; the store keeps the full set (spec §11).
      get: (runId: string) => {
        const rec = searchAgentService.get(runId)
        return rec ? surfaceRun(rec) : null
      },
      /**
       * 商品档：同一条发现循环、换一个域（spec 2026-09-01 §2.1）。
       *
       * **约束序列化成 goal 是内部实现，不是接口形状**——工具入参是结构化的（这正是它
       * 不与 `search_agent` 合并的理由）。goal 只喂给循环里那几个 LLM 关节（搜什么词、
       * 这条切不切题），它们本来就吃自然语言；约束的**判定**走的是域里的纯代码
       * （价格区间）和 `price_search`（真在售），不靠这句话。
       *
       * 验证器复用现成的 `price_search`（spec §2.3）：不新增源、不新增 Provider 行。
       */
      enumerate: (input: { category: string[]; priceMin?: number; priceMax?: number; constraints?: string[] }) => {
        const range = [
          input.priceMin === undefined ? '' : `${input.priceMin} 元以上`,
          input.priceMax === undefined ? '' : `${input.priceMax} 元以内`,
        ]
          .filter(Boolean)
          .join('、')
        const goal = [input.category.join(' '), range, ...(input.constraints ?? [])].filter(Boolean).join('，')
        return searchAgentService.start(
          goal,
          catalogDomain({
            chat: (messages) => chatViaLlm(ctx.llm.forTask, { messages, temperature: 0.2 }),
            // **走和 `price_search` 工具同一个投影**，不直接吃 `ctx.search.priceSearch`。
            // 原始 `StoredItem` 上没有 `excerpt` 这一格（价格行在 `body_text`，由 slim 投影
            // 切出来），直接接过去的话，域里 `priceOf(r.excerpt)` 恒 undefined → 每个候选
            // 都被判成"没验上"并丢掉 → **清单恒空，且没有一处会报错**。共用一个投影同时
            // 保证两个消费端读的是同一行价格，不会各切各的。
            priceSearch: async (model) =>
              slimContentSearchResults(await ctx.search.priceSearch(model), { withImage: false, isCommunity }).items,
            constraints: {
              category: input.category,
              priceRange: { min: input.priceMin, max: input.priceMax },
            },
          }),
          // **显式关掉早停**（spec §2.5 ②：枚举档不传早停参数，只靠收敛）。装配时那份
          // `earlyStop` 是照网盘档配的——「够 5 条切题就收工」对"找到某个东西"是对的，
          // 对"枚举符合条件的有哪些"恰恰是错的：活体（2026-09-02）继承它之后跑一轮就
          // `stopped: 'early'`，73 个窝只开了 5 个，而一份提前收工的清单正是这个功能
          // 存在的理由要消灭的那个东西。关掉之后停止条件只剩收敛 / 跑满轮次，两者都
          // 如实进回执，下游据此判断覆盖范围。
          { earlyStop: undefined }
        )
      },
    }

    // ── 意图跟踪（spec 2026-08-01）────────────────────────────────────────────────
    // LLM 走 llm.chat 同一条梯子；消化材料 = item 文本，音视频优先已有转写（不主动触发转写
    // ——转写成本归转写自己的链路）。
    // **账本是目录型的 JSON（`<dataDir>/intents/intents.json`），不持句柄**——现场核实过，
    // 所以这一格没有 `ctx.effect`，不是漏登记。
    const intentStore = new IntentStore(join(dataDir, 'intents'))
    const intentLlm = makeIntentLlm(resolveChatEndpoint)
    const intents = new IntentService({
      store: intentStore,
      llm: intentLlm,
      digestDeps: {
        listItems: (sid) =>
          itemStore
            .recent({ stream: sid, limit: 200, order: 'desc' })
            .map((it) => ({ id: it.id, title: it.title, author: it.author, body_text: it.body_text, link: it.url })),
        transcriptTextOf: (itemId) => {
          const rec = ctx.conversions.conversions.transcriptOf(itemId)
          if (!rec || rec.status !== 'done') return null
          const r = rec.result as { text?: string } | undefined
          return r?.text ?? null
        },
        streamExists: (sid) => !!channels.getStream(sid),
        events: { append: (e) => events.emit(e) },
        log: (m) => console.log(m),
        windowSize: 200, // 与上面 listItems 的 limit 对齐——供 runDigestRound 判窗口是否饱和
        maxJudged: 100, // 显式传，不吃隐式默认——生产值可调
      },
      recruit: {
        search: (q) =>
          service.search(q, 30).map((c) => ({
            id: c.id,
            description: c.description,
            categories: c.categories,
            params_schema: c.params_schema,
            cadence_hint_seconds: c.cadence_hint_seconds,
          })),
        preview: async (sid, params) => {
          const pv = await service.previewSource(sid, params)
          return { items: pv.items }
        },
        // 查重：任一已订流的任一成员 source+等值 params 命中即复用。成员可能被 normalizeSource
        // 拆成 plugin_id+source_template_id（bare source_id 会被清掉），两种形状都要认。
        findExisting: (sourceId, params) => {
          const want = JSON.stringify(params, Object.keys(params).sort())
          for (const s of service.streamsResource()) {
            for (const m of s.sources) {
              const mid = m.source_id ?? (m.plugin_id && m.source_template_id ? `${m.plugin_id}:${m.source_template_id}` : null)
              if (mid !== sourceId) continue
              if (JSON.stringify(m.params ?? {}, Object.keys(m.params ?? {}).sort()) === want) return s.id
            }
          }
          return null
        },
        subscribe: (stream, channelId) => service.subscribe(stream, channelId),
        ensureChannel: (id, label) => {
          if (!channels.getChannel(id)) channels.putChannel({ id, label, present: 'timeline', stream_ids: [], options: {} })
        },
        unsubscribe: (streamId) => { service.unsubscribe(streamId) },
        removeChannel: (channelId) => { channels.removeChannel(channelId) },
      },
    })

    // ── 购买决策 job：阶段顺序在 `agent/purchase/job.ts` 里，这里只把四个依赖接上 ──────
    // spec `2026-09-02-purchase-decision-job-design.md`。它替代的是「brief 给素材、模型自己
    // 走九步」那条路——**模型跳步在这里结构上不成立**。
    // 横评正文的随手缓存：`reviews` 那一格已经把摘要拿回来了，`signal` 紧接着要用同一份。
    // 一次跑内有效，每次跑开头清空——**别让它跨跑存活**，那会拿上一次的正文去配这一次的全集。
    const reviewText = new Map<string, string>()
    /** 同一次跑里那批横评的**原始条目**——转写要 `content.media` / `url`，slim 投影里没有。 */
    const reviewItems = new Map<string, StoredItem>()
    const runDecision = (c: DecisionConstraints, onStage?: DecisionDeps['onStage']) =>
      runPurchaseDecision(c, {
        onStage,
        // ① 全集：两档。有包声明了产品库（recipe `meta.catalog`）的品类走直查（零 LLM、可复现）；
        //    声明表调用时从 liveRecipes 现取——包是后装的，装配期快照会把它冻成"没有"。
        //    **没有直查源的品类回落到
        //    发现循环**（catalog 域，`enumerate_candidates` 那条：品类找窝 → 抓窝 → 配对 →
        //    price_search 验在售）。
        //
        //    回落的**不是**"读到哪篇横评算哪篇"——那条仍然禁止，它正是这条线要根治的病。
        //    发现循环是一次真的枚举：有停止条件、有覆盖范围、每台候选都带出处，全部如实进回执。
        //    在它接上之前，除手机外的每个品类拿到的都是一份空全集 + `stopped: 'complete'`，
        //    也就是把**我们的能力缺口**讲成了**市场事实**（活体 2026-09-04：纸巾 universe:0）。
        universe: makeUniverse(
          makeCatalogUniverse(config.readSource, () => catalogsOf(ctx.sources.liveRecipes.current)),
          makeDiscoveryUniverse({
            chat: (messages) => chatViaLlm(ctx.llm.forTask, { messages, temperature: 0.2 }),
            webSearch: async (keyword: string) => (await webSearchTiered(keyword)).hits,
            fetchPage: fetchHubText,
            // 与 `enumerate_candidates` 走**同一个投影**：原始 StoredItem 上没有 `excerpt`
            // 那一格（价格行由 slim 投影从 body_text 切出来），直接接过去的话域里
            // `priceOf(r.excerpt)` 恒 undefined → 每个候选都被判成"没验上"并丢掉 →
            // **清单恒空，且没有一处会报错**。
            priceSearch: async (model) =>
              slimContentSearchResults(await ctx.search.priceSearch(model), { withImage: false, isCommunity }).items,
          }),
        ),
        // ② 横评：走 content_search 那条扇出（社区档优先）。
        reviews: async (cc) => {
          // **价格约束必须进检索词**。漏了它的表现极其像"没坏"：横评照样搜得到、6 篇也照样读成，
          // 只是回来的全是旗舰，而全集是"5000 以内"那一批——两边一台都对不上，`named` 恒 0，
          // 回执诚实地说"没有一台被点名"。活体撞到过：抽出来的是 vivo X300 Ultra / iPhone 17 Pro，
          // 全部落进 unmatched（逃生项工作正常），看起来像"横评不提便宜机"，实际是我们没问对。
          const band = [
            cc.priceRange.min === undefined ? '' : `${cc.priceRange.min}元以上`,
            cc.priceRange.max === undefined ? '' : `${cc.priceRange.max}元以内`,
          ].filter(Boolean).join('')
          const q = [...cc.category, band, ...cc.softCriteria, '横评'].filter(Boolean).join(' ')
          const r = await ctx.search.contentSearchDetailed(q)
          const slim = slimContentSearchResults(r.items as StoredItem[], { withImage: false, isCommunity }).items
          reviewText.clear()
          reviewItems.clear()
          for (const it of slim) if (it.excerpt) reviewText.set(it.id, it.excerpt)
          // 原始条目留一份：转写要它的 `content.media` / `url`（slim 投影里没有这两格）。
          for (const raw of r.items as StoredItem[]) if (raw?.id) reviewItems.set(raw.id, raw)
          return slim
            .filter((it) => it.url)
            .sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'community' ? -1 : 1))
            .map((it) => ({ id: it.id, title: it.title, url: it.url!, platform: it.source_id }))
        },
        // ② 抽取关节（模型仅有的三个位置之一）。取料三档见 `review-text.ts`：
        //    摘要 → **视频转写** → 抓原页。转写这一档不是可选的锦上添花：视频横评是社区档里
        //    最有料的那一批，跳过它等于整类证据消失，而本地 ASR 让它几乎是白拿的。
        signal: makeSignalJoint(
          (input) => chatViaLlm(ctx.llm.forTask, { messages: input.messages as ChatMessage[], tools: input.tools, temperature: 0.1 }),
          makeReviewText({
            excerptOf: (id) => reviewText.get(id) ?? '',
            hasMedia: (id) => {
              const it = reviewItems.get(id)
              const media = (it?.content as { media?: unknown[] } | undefined)?.media
              return Array.isArray(media) && media.length > 0
            },
            transcribe: async (item) => {
              const it = reviewItems.get(item.id)
              if (!it) return ''
              ctx.conversions.conversions.start('extract', item.id, {
                options: { media: (it.content as { media?: unknown })?.media, content: it.content, url: it.url },
                snapshot: { title: it.title ?? item.title, source: it.stream_id ?? 'search', url: it.url },
              })
              // 等它落定。预算 60s 远小于宿主那一侧的 tool 调用上限（`hosts/dsh/cordis.patch.yml`
              // 的 stream-mcp 行，由 `src/http/dsh-bundle.contract.test.ts` 钉着），而转换账本里
              // extract 的实测是 1.0–15.5 秒——留了一个量级的余量。
              const pending = () => {
                const rows = ctx.conversions.conversions.list({ item: item.id, kind: 'extract', limit: 1 }).items as
                  Array<{ status?: string }>
                return rows.some((r) => r.status === 'queued' || r.status === 'running')
              }
              await settleWithin({ pending, sleep: (ms) => new Promise((r) => { setTimeout(r, ms) }), now: Date.now }, 60_000)
              const latest = ctx.conversions.conversions.list({ item: item.id, kind: 'extract', limit: 1, expandResult: true })
                .items[0] as { status?: string; result?: { text?: string } } | undefined
              return latest?.status === 'done' ? (latest.result?.text ?? '') : ''
            },
            readUrl: async (url) => {
              const fetched = await ctx.conversions.readUrl(url).catch(() => null)
              return typeof fetched === 'string' ? fetched : ((fetched as { text?: string } | null)?.text ?? '')
            },
          }),
        ),
        // ③ 比价：和 `price_search` 工具**同一个投影**——两个消费端读的是同一行价格。
        price: async (model) => {
          const { items, warnings } = await ctx.search.priceSearchDetailed(model)
          const rows = slimContentSearchResults(items, { withImage: true, isCommunity }).items
          return {
            rows: rows.map((r) => ({
              platform: r.author ?? r.source_id ?? '未知平台',
              title: r.title,
              price: r.excerpt ?? r.title,
              amount: priceOf(r.excerpt ?? r.title),
              ...(r.url ? { url: r.url } : {}),
            })),
            warnings: warnings.map((w) => `${w.member}: ${w.reason}`),
          }
        },
        // ③ 残值：走 `resale-search` 行（成员 provides=search-resale：转转回收…），型号 → 最高回收价。
        //    选代 + 精确对名都在 `resale-pick.ts`：持有一年查上一代、两年查上两代（平台只报今天的价，
        //    上两代今天值多少是"两年后值多少"最近的代理）；**按名字精确对，不拿第一行**（接口自带型号
        //    归一，「一加 Ace 6」会把 Ace 6T / Ace 5 一起回）。对不上 → null，job 整轮退到 purchase_only
        //    并逐台记进 gaps；⚠️ 别改成"对不上就取最像的"或"猜一个保值率"：支配关系会错得毫无征兆。
        residual: (model, holdDays) =>
          resolveResidual(model, holdDays, async (name) =>
            slimContentSearchResults(await ctx.search.resaleSearch(name), { withImage: false, isCommunity }).items
              .map((r) => ({ title: r.title, excerpt: r.excerpt, source: r.author ?? r.source_id })),
          ),
      })

    // ── MCP 工具面的 extras：**本批的主险，逐格登记** ────────────────────────────
    // 见本文件 `MCP_EXTRAS_DEP_COUNT` 的头注：格数在装配期自检，加格不改数字当场崩。
    // 一份装配，两个消费者（HTTP 的 MCP mount + 进程内对话 agent），所以两面永远暴露同一套能力。
    //
    // **每一格都写明来源域**。漏一格不会报错、不会 404——那个工具只是安静地不注册，模型照样会
    // 把动作叙述成已完成（AGENTS.md「追到另一端」的原型事故）。格数由 agent.test.ts 的
    // `MCP_EXTRAS_DEP_COUNT` 钉着：往这张表加一格必须同时改那个数字，否则测试当场变红。
    // **异步**：一次跑两三分钟，而宿主侧的 MCP 单次调用上限各不相同（DSH 的 stream-mcp 行
    // 200s、Claude Code 的默认约 120s）——同步等的下场是"任务没做完就被掐断、后端还在跑、重试再叠一个"（Sonnet 试跑
    // 连超 5 次）。所以和 search_agent 一样：立刻回 {runId, status}，阶段进度和最终回执都落
    // agent-runs.db（domain 'purchase'，回执在 `result`），`get_agent_run` 取。
    const purchaseDecide = (c: DecisionConstraints): { runId: string; status: RunStatus } => {
      const goal = `${c.category.join('、')} ${c.priceRange.min ?? 0}–${c.priceRange.max ?? '∞'} 元` +
        `${c.softCriteria.length ? `，看 ${c.softCriteria.join('、')}` : ''}，持有 ${c.holdDays} 天${c.willResell ? '，会转手' : '，不转手'}`
      const rec = searchRunStore.create(goal, 'purchase')
      searchRunStore.put(rec.runId, { status: 'running' })
      void runDecision(c, (stage, note) => searchRunStore.appendStep(rec.runId, { kind: 'stage', decision: stage, note }))
        .then((receipt) => {
          searchRunStore.put(rec.runId, {
            status: 'done',
            result: receipt,
            // 复用发现类的 stopped 语义：截断 = 清单不全；interrupted = 中途挂了按已攒下的收尾。
            stopped: receipt.coverage.stopped === 'complete' ? 'converged' : receipt.coverage.stopped,
          })
        })
        .catch((e: unknown) => {
          searchRunStore.put(rec.runId, { status: 'error', error: e instanceof Error ? e.message : String(e) })
        })
      return { runId: rec.runId, status: 'queued' }
    }

    const mcpExtrasDeps = {
      // ctx.harvest（采集运输面）：cdp_* 的三档地址 + harvest_capability
      desktopDriver: ctx.harvest.desktopDriver,
      makeSee: ctx.harvest.makeSee, // run_action_recipe 的桌面档：`see` 的识别层（与采集同一个工厂）
      recipeOverrides: ctx.harvest.recipeOverrides, // 同上：本机学到的落地方式（与采集同一份存储）
      sessionRecipes: ctx.harvest.sessionRecipes, // run_action_recipe 的浏览器档（与采集同一个执行入口）
      extLauncher: ctx.harvest.extLauncher,
      extRelay: ctx.harvest.extRelay, // cdp_pages(target:chrome) rides the relay's list/closeTab ops
      browserCapability: ctx.harvest.browserCapability, // harvest_capability 的 everSeen 那一半（落盘缓存）
      harvestBrowser: ctx.harvest.harvestBrowser, //     harvest_capability 的 chrome 块（候选发现 + 当前选择）
      pageLook: ctx.harvest.pageLook, // cdp_*(target:facility:<name>) rides that facility's harvest lane look/act/shot
      pageShot: ctx.harvest.pageShot,
      pageAct: ctx.harvest.pageAct,
      // ctx.search（搜索扇出）：content_search / price_search / video_search
      contentSearch: ctx.search.contentSearch,
      contentSearchDetailed: ctx.search.contentSearchDetailed,
      priceSearch: ctx.search.priceSearch,
      videoSearch: ctx.search.videoSearch,
      // ctx.provider（解析面）：resolve_intent / classify / resolve_target / video_resolve
      radarMatcher: ctx.provider.radarMatcher,
      intentResolver: ctx.provider.intentResolver,
      resolveEngine: ctx.provider.resolveEngine,
      resolveDownloads: ctx.provider.resolveDownloads, // video_resolve 的脑（与 GET /api/download-options 共用）
      // stream_fetch_url 的 resolveByLink：content.enrich 按 <platform>-link 派发（与 GET /api/media/from-url 共用）
      providerBindings: ctx.provider.providerBindings,
      providerExecutor: ctx.provider.providerExecutor,
      // ctx.sources（Source 目录）：list_sources
      registry: ctx.sources.registry,
      // capability_status / provision_capability_key 的两条腿：「这一格配了没」（只报层）
      // 与「谁能替他去申请」。两个都是函数，调用时现查——用户刚配完一把 key 答案就变了。
      keyState: ctx.sources.keyState,
      configProvisionerFor: ctx.sources.configProvisionerFor,
      // 跑完之后回头核对那一格填上了没。**这一步是 provision_capability_key 存在的全部理由**：
      // 这类 recipe allowEmpty、不产 item，「建成功了」和「抽取没命中」在 runner 回执里一字不差。
      configSlotStatus: (ref: string) =>
        settings.rows.status(`source:${ref}`) as { secrets?: Record<string, { configured: boolean }> },
      // 真去跑那条自助申请 recipe。`userInitiated` 陈述的是"这次是谁发起的"——它只由那个
      // 带二次确认的工具触发，没有任何调度 / 定时路径走得到这里（与 serve.ts 那个消费方同一条论证）。
      runProvisionRecipe: (sourceId: string, params: Record<string, unknown>) =>
        config.readSource(sourceId, params, { userInitiated: true }),
      // run_action_recipe 的脑：按 sourceId 找**原始** recipe（带 meta.action/params_schema）。
      liveRecipes: ctx.sources.liveRecipes,
      // ctx.stores（落盘状态）：list_sources 的健康列 / 转成文字与出现账的 item 补全
      sourceHealth,
      itemStore,
      // inbox_search 的 channel 过滤：频道 → 它引用的 stream 集合（频道表是唯一知道这个的地方）
      channels,
      // `resolve` 工具歌词那一档的缓存。**与 HTTP 的 `/api/resolutions` 是同一个实例、同一份壳**
      // （`src/audio/lyrics-cache.ts`）——漏这一格不报错，只是模型那条路每次播放都去打一次上游。
      audioArchive,
      // ctx.conversions（转换底座）：get_conversions / extract / identify / 声纹三工具 / read_url
      conversions: ctx.conversions.conversions,
      speakerRegistry: ctx.conversions.speakerRegistry,
      readUrl: ctx.conversions.readUrl,
      // ctx.netdisk（AList 对齐层）：netdisk_* 四个工具（没配 AList → undefined，工具不注册）
      netdisk: ctx.netdisk.netdisk,
      netdiskRoutes: ctx.netdisk.netdiskRoutes,
      // ctx.streamEvents（通知中心）：get_events
      events,
      // 本域自己的产物
      searchAgent,
      webSearch: webSearchTiered,
      intents,
      // 「接不上的站」清单：`note_unonboardable` 是它**唯一**的写入者，漏这一格 = 那个工具
      // 安静地不注册，而模型照样会说「我已经记下了」。
      onboardWishlist,
      // ctx.llm(梯子):extract 窄回执的压缩腿(llm.extract_digest 调用点)
      llmForTask: ctx.llm.forTask,
      // 购买决策 job（spec 2026-09-02）：**整条路线跑在代码里**的那一格。它自己已经把
      // 枚举源 / 横评 / 抽取关节 / 比价四样接好了，这里只递一个入口进去。
      purchaseDecide,
      // 动作 recipe 的 run 库：与搜索 / 购买 run 同一本 `agent-runs.db`（`domain:'action'`），
      // `run_action_recipe confirmed:true` 靠它变成异步（spec 2026-09-12 action-recipe-async-run），
      // `get_agent_run` 读。漏了这一格的表现是发消息退回同步等——宿主 60s 一到就"报失败其实成功"。
      actionRunStore: searchRunStore,
      // 文件产物落盘目录。漏了这一格的表现是 photopea 那类 recipe 每次都报「文件没处落」。
      actionArtifactsDir,
      // 介入域的探索会话登记处：五个 `graph_*` 建图工具按 runId 现取活会话。**两层都是现取**
      // ——外层这个 thunk 在工具调用那一刻才问根 kernel 有没有介入域，内层 `get()` 才问那条 run
      // 还活着没。任一层写死都是「工具在、但永远找不到会话」，而工具面上看不出任何异样。
      //
      // 注意这一格**永远是函数**，所以生产里五个 graph_* 恒注册（注册门只看这一格在不在）。
      // 「介入域没起」不表现为工具消失，而是每次调用回一句「这条 run 已结束 / 不存在」——
      // 这正是要的：工具面稳定，不活的理由由调用时说清楚。
      explorations: () => config.intervention?.()?.explorations,
    }
    // 格数自检（见 MCP_EXTRAS_DEP_COUNT 的头注）。**故意是 throw 不是日志**：这张表漏一格
    // 的症状是某个工具安静地不注册，没有任何一处会喊——所以只能在装配期就把它变响。
    const depCount = Object.keys(mcpExtrasDeps).length
    if (depCount !== MCP_EXTRAS_DEP_COUNT) {
      throw new Error(
        `[agent] mcpExtras 的转发表现在有 ${depCount} 格，登记的数字是 ${MCP_EXTRAS_DEP_COUNT}——` +
        '改了这张表就同步改 MCP_EXTRAS_DEP_COUNT（并在 agent.test.ts 里改那个断言），' +
        '别让新格子有机会静默漏接',
      )
    }
    const mcpExtras = buildMcpExtras(mcpExtrasDeps)

    ctx.provide('agent', {
      onboardWishlist,
      summaryPromptStatus,
      setSummaryPrompt,
      summaryPrompt: () => currentPrompt,
      webSearch: webSearchTiered,
      searchAgent,
      purchaseDecide,
      intents,
      mcpExtras,
      agentRuns: { prune: pruneAgentRuns },
    } satisfies AgentDomain)
  },
}
