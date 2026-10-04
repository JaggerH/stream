import { z } from 'zod'
import type { StreamServiceLike } from './tools.ts'
import type { VideoSearchResult } from '../video/types.ts'
import type { LaneAction, ActionSpec, ActionKind, ActionIntent, ActResult } from '../replay/interactive-gate.ts'
import { fetchUrl, type FetchUrlDeps } from '../http/fetch-url.ts'
import type { IntentService } from '../intent/service.ts'
import { readContent } from '../conversions/read-content.ts'
import type { StoredItem } from '../item-store.ts'
import { slimContentSearchResults, CONTENT_SEARCH_MAX_ITEMS } from './content-search-slim.ts'
import { cdpToolSpec, type CdpParamSpec } from '../../shared/browser-relay/tool-specs.ts'
import { ACTION_RUN_DOMAIN, projectActionRun } from './action-run.ts'

/** 五个 `graph_*` 工具真正调的那一面（`ExploreManager.get()` 拿回来的活会话）。 */
type ExploreLive = NonNullable<ReturnType<import('../intervention/explore-manager.ts').ExploreManager['get']>>

/**
 * 四个 cdp 动词的描述文本与参数表**按宿主真有的档位生成**（`shared/browser-relay/tool-specs.ts`）。
 * Stream 后端三档齐全，所以这里不传 tiers 走默认全集；没有后端的宿主（DSH 插件）只传 `['chrome']`，
 * 拿到的那份说明书里就不会出现 `facility:` / `desktop`——照抄整段等于给模型一份
 * **说了谎的说明书**，它会去试根本不存在的面。
 */
const cdpParamToZod = (p: CdpParamSpec): z.ZodTypeAny => {
  const base =
    p.type === 'string'
      ? z.string()
      : p.type === 'number'
        ? z.number()
        : p.type === 'boolean'
          ? z.boolean()
          : p.type === 'string[]'
            ? z.array(z.string())
            : z.enum(p.values as [string, ...string[]])
  return p.optional ? base.optional() : base
}
const cdpSchema = (name: 'cdp_look' | 'cdp_shot' | 'cdp_act' | 'cdp_pages'): Record<string, z.ZodTypeAny> =>
  Object.fromEntries(cdpToolSpec(name).parameters.map((p) => [p.name, cdpParamToZod(p)]))

/**
 * Single source of truth for the tool surface. **今天只有一面**：MCP server
 * （`createMcpServer`），对话工作台（DSH）和外部 agent 吃的都是它。进程内那条自研聊天路径
 * 已于 2026-08-17 退役，`buildAgentTools` 与它的 include 名单随之消失——所以这里不再有
 * 「两面选择不同」这回事，条目要么在、要么不在。
 */
export interface McpExtras {
  /**
   * 能力包（`stream.capability` 槽位）此刻注册了哪些工具——**必须是 thunk，不许是数组**。
   *
   * `/api/mcp` 是每请求现建一个 `McpServer`，而能力包的装载发生在启动的另一个时刻（可选包从
   * `<dataDir>/recipes/` 动态 import，用户还能在运行期装卸）。写成字段就是把「装配那一刻有
   * 哪些工具」冻住：晚一步挂上的包**永远不出现在 `tools/list` 里**，而 `/api/plugins` 那一列
   * 照样诚实地列着它的动词——没有任何一处会喊（AGENTS.md「装配期取的值 = 冻住的答案」；
   * 同一个病 `identify_speakers` 犯过一次）。守卫在 `server.test.ts`。
   */
  capabilityTools?: () => import('../../shared/capability/types.ts').ToolDef[]
  /** cross-platform content retrieval over the user's configured searchable sources;
   *  when present, exposes content_search (the same core behind HTTP /api/content/search) */
  contentSearch?: (q: string, opts?: { nsfw?: boolean }) => Promise<unknown[]>
  /** 搜索结果分档（社区平台 / 网页搜索）的判据：manifest `categories` 含 `social-media` 就是
   *  社区档，由 `communityByCategory(registry)` 造、每次调用现查 registry。**必填、没有默认**：
   *  `content_search` / `price_search` 的瘦身层靠它排序，漏了它全部结果判成 web 档、排序等于
   *  没排且没有一处会喊——所以由 tsc 替我们数，别用 `() => false` 兜。 */
  isCommunitySource: import('./content-search-slim.ts').CommunityPredicate
  /** 购买决策 job（spec 2026-09-02）：**整条路线跑在代码里**，一次调用出前沿 + 覆盖率。
   *  present 时暴露 `purchase_decide`——**购买这条线在工具面上只有这一个入口**。以前还有
   *  「素材工具 + 手工组装终稿工具」那一对，模型会把 job 的回执逐字段手抄进后者、抄错口径
   *  （2026-09-03 活体），所以拆了。见 `src/agent/purchase/job.ts`。 */
  purchaseDecide?: (
    c: import('../agent/purchase/job.ts').DecisionConstraints,
  ) => { runId: string; status: string }
  /** 商品比价搜索：并发扇出 provides=search-price 的比价源（慢慢买…）→ 各平台报价；
   *  present 时暴露 `price_search`（HTTP /api/search?scope=price 同核）。与 contentSearch 独立成档。 */
  priceSearch?: (q: string) => Promise<unknown[]>
  /** 读**已经采集进库**的条目（ItemStore 的过滤查询 + 瘦身投影）；present 时暴露 `inbox_search`。
   *  和 `contentSearch` 是两条完全不同的路：那条是现搜（联网扇出、结果不落库），这条只读库。
   *  见 `src/mcp/inbox-search.ts`。 */
  inboxSearch?: (
    args: import('./inbox-search.ts').InboxSearchArgs,
  ) => import('./inbox-search.ts').InboxSearchResult
  /** faceted film/TV/anime download search; when present, exposes video_search */
  videoSearch?: (q: string, opts?: { nsfw?: boolean }) => Promise<VideoSearchResult>
  /** 「下载页引用 → 下载项」（ProviderService.resolveDownloads，与 `GET /api/download-options` 同一个
   *  脑）；present 时暴露 video_resolve。不许在这里直调站点实现——那会漏掉用户从 Provider
   *  管理页加的成员。 */
  videoResolve?: (url: string) => Promise<import('../video/resolve.ts').DownloadOption[]>
  /** 取一条 item 的正文（转写 / OCR / 抓网页由后端按 archetype 判）；在场即暴露 `extract`。
   *  `opts.diarize` 是唯一一个**调用方能挑**的东西——它不是分支选择（分支由 archetype 判），
   *  而是转写分支上的一档额外处理（声纹归名）；用户那个「识别发言人」开关的落点就是它。
   *  `opts.rerun` 是无视缓存重跑（透传成 `conversions.start` 的 `force`）：缓存命中**不看
   *  options**，所以一条已经取过正文的 item 再带 `diarize:true` 调一次只会原样退回旧记录——
   *  没有说话人、也没有任何一处报错。要让「拨开开关再取一次」真的生效，只有这一条路。
   *  `opts.focus` 是窄回执压缩腿的镜头（spec 2026-08-24-extract-narrow-receipt）：长文经
   *  digest 层压成带出处的要点。**没有 full 开关**——那个决策权曾经开给模型,活体证明必被
   *  滥用(spec 2026-08-24-digest-authority);全文归卡片(人眼直读 API)与 get_conversions。
   *  返回类型仍是 `unknown`（不收紧成 Promise<unknown>）：`extractImpl` 的「未找到」分支是
   *  同步返回，其余测试文件里的假件也还是同步形状。 */
  extract?: (
    itemId: string,
    opts?: { diarize?: boolean; rerun?: boolean; focus?: string },
  ) => unknown
  /** 把一段长文过 extract 同一个 digest 压缩器(同一份缓存,key=itemId+'')。`read_content`
   *  的结构性收口用它:三档提示词(PERSONA/描述/返回体 note)在活体上全被绕过(2026-08-24,
   *  三条对比每轮都串行读全文),省上下文不能赌模型自觉,只能在返回体上闸住。短文原样退回
   *  (压缩器自己判门槛)。 */
  digestLongText?: (itemId: string, text: string) => Promise<unknown>
  /** 起一条「补说话人」（`identify` kind：只跑 diarization + 认名，**不重跑 STT**）。
   *  和 `extract` 是**两条独立的轴**：转写答「说了什么」，这条答「谁说的」——所以对一条已经
   *  转写过的 item 补名不用再付一次 whisper 的钱。转写不是它的前提（没有转写就只做纯
   *  diarization，见 converters/identify.ts 头注）。
   *  `opts.rerun` 透传成 `conversions.start` 的 `force`——缓存只按 (item, kind) 认，不 force
   *  就是静默退回上一次的结果。 */
  identify?: (itemId: string, opts?: { rerun?: boolean }) => unknown
  /** 读已产出的转换（转写 / OCR / 补说话人 / 摘要）；present 时暴露 `get_conversions`。
   *  取代了原来的 list_transcripts / get_transcript / list_parses / get_parse——四个纯读取工具
   *  之间没有意图差异，合并不损失可用性（**触发**工具 transcribe/parse 仍分开具名，因为
   *  「转写这个视频」和「识别这张图的文字」是两个不同意图，具名的选中率明显更高）。 */
  conversions?: {
    list: (q: { item?: string; kind?: string; limit?: number; expandResult?: boolean }) => { items: unknown[] }
  }
  /** 「接不上的站」清单的写入面（`src/onboard/wishlist-store.ts`）。**它是这份清单唯一的
   *  写入者**——`resolve_intent` 空手之后那条线索只有经 `note_unonboardable` 才留得下来。 */
  wishlist?: { add: (e: { url: string; goal: string; note?: string }) => { id: string } }
  /** 「这个 item 谁在说话」的读口（src/voiceprint/view.ts 的现算投影）。read_content 用它给
   *  稿子标名字；absent = 声纹域没配。 */
  speakers?: (itemId: string) => { segments: import('../transcribe/client.ts').TranscriptSegment[]; hasSpeakers: boolean }
  /** 「这条链接有没有具名行认领」（`content.enrich` 按 `<platform>-link` 派发）。缺席 = 只走宿主分支。 */
  resolveByLink?: FetchUrlDeps['resolveByLink']
  /** target-resolve model surface (additive): one-shot resolve/intent/sources tools.
   *  Standing subscription lives in the Channel+Stream path (stream_subscribe), not here. */
  resolve?: {
    resolveIntent: (input: string) => unknown
    classifyIntent: (input: string) => { targetType: string; key: string }
    resolveTarget: (targetType: string, key: string) => Promise<unknown>
    listSources: (targetType?: string) => unknown[]
  }
  /** netdisk (AList) match-rule editing — the external-agent surface (the app has an
   *  equivalent button path). An agent lists bindings, reads a binding's residue, authors a
   *  MatchSpec, dry-runs it, and applies it. Same primitives the HTTP routes call; no invokeLlm
   *  (the agent IS the model). When present, exposes netdisk_bindings/residue/preview_spec/apply_spec. */
  netdisk?: {
    bindings: () => unknown
    /** 列网盘目录（spec 2026-08-25-reconcile-as-conversation §4.1）。形状层见 `netdisk-browse.ts`。 */
    browse: (path: string, recursive: boolean) => Promise<unknown>
    residue: (setId: string) => Promise<unknown>
    previewSpec: (setId: string, spec: unknown) => Promise<unknown>
    applySpec: (setId: string, spec: unknown) => Promise<unknown>
    /** 就地开一次整理（spec 2026-08-25 §4.2）。未装配 → 缺席，工具不注册。 */
    reconcileOpen?: (input: { streamId: string; sourceDirs: string[]; label?: string }) => Promise<unknown>
    /** 听一段网盘音频（`netdisk_transcribe`）。独立原语，**不和 `extract` 耦合**：那条按 item id
     *  转成文字，而网盘散文件压根没有 item id。未装配 → 缺席，工具不注册。 */
    transcribeFile?: (input: { path: string; windowS?: number }) => Promise<unknown>
    /** 整理裁决面（spec 2026-08-24-conversational-reconcile §3.1）：状态 / 裁决 / 执行。 */
    reconcileStatus: (
      showId?: string,
      opts?: { expandDir?: string; offset?: number; limit?: number; deletesOffset?: number },
    ) => Promise<unknown>
    reconcileDecide: (input: {
      verdict?: 'is-episode' | 'not-episode' | 'prefer' | null
      leftKey?: string; path?: string; keptPath?: string; loserPath?: string
      decisions?: Array<{
        verdict?: 'is-episode' | 'not-episode' | 'prefer' | null
        leftKey?: string; path?: string; keptPath?: string; loserPath?: string
      }>
    }) => unknown
    reconcileExecute: (showId: string, opts?: { expectFingerprint?: string }) => Promise<unknown>
    /** 整轮撤销（`reconcile_undo_run`）：把一次 execute 写下的溯源行倒序走回去，再重同步绑定。 */
    reconcileUndoRun: (runId: string) => Promise<unknown>
    /** 重新认盘（`netdisk_sync`）：文件变了之后重跑一次匹配，按季汇总回来。不动任何文件。 */
    sync: (setId: string) => Promise<unknown>
    /** 验一条分享（`netdisk_share_verify`）。追更未装配 → 缺席，工具不注册。 */
    shareVerify?: (input: { link?: string; netdisk?: string; pwdId?: string; passcode?: string }) => Promise<unknown>
    /** 追更开关 / 看一眼 / 手动跑一轮（`netdisk_follow`）。追更未装配 → 缺席，工具不注册。 */
    follow?: (setId: string, action: 'view' | 'enable' | 'disable' | 'run') => Promise<unknown>
    /** 轮末裁决器手动入口（spec 2026-09-03-netdisk-llm-adjudicator §3 触发点 2）——「现在就裁」
     *  一次归档待定卡。裁决器未装配 → 缺席，工具不注册。 */
    adjudicate?: (show: string, opts?: { losers?: boolean; force?: boolean }) => Promise<unknown>
    /** 整批撤回一轮模型裁的决定（按 `note` 前缀 `llm:<runId>`）。裁决器未装配 → 缺席，工具不注册。 */
    revokeAdjudication?: (runId: string) => Promise<unknown>
  }
  /** Unified CDP facade — one set of verbs over N transports; the operation carries its
   *  `target` (chrome[:tabId] / facility:<name> / desktop / app:<process>[/<title>])。
   *  见 cdp-router.ts。 */
  cdpLook?: (a: import('./cdp-router.ts').LookArgs) => Promise<unknown>
  cdpShot?: (a: { target: string }) => Promise<{ shot: string | null; via?: 'window'; target?: string; note?: string }>
  cdpAct?: (a: import('./cdp-router.ts').ActArgs) => Promise<ActResult | { live: false }>
  cdpPages?: (a: { target: string; close?: number }) => Promise<unknown>
  /**
   * 活着的探索会话登记处（spec 2026-09-12-phase3 §6）——五个 `graph_*` 建图工具经它按 runId
   * 现取会话。**必须是 thunk**：介入域与 `/api/mcp` 每请求现建的 server 不是同一时刻的东西，
   * 写成实例就是把「装配那一刻有没有介入域」冻住（同 `capabilityTools` 那条头注）。
   *
   * **图由 Stream 持有**：这五个工具只把 agent 的主意递进去，点、认、记边、算 frontier 全在
   * `ExploreSession` 里——模型自报的边一条都不收。
   */
  explorations?: () => Pick<import('../intervention/explore-manager.ts').ExploreManager, 'get'> | undefined
  /** 目标导向的发现循环（spec 2026-07-15；泛化成两个域见 spec 2026-09-01）：起一轮 + 读轨迹。
   *  present 时暴露 search_agent（网盘档，找**某个具体东西**的获取渠道）+ get_agent_run
   *  （轮询 + 复盘，只读）；`enumerate` 那格在时再多一个 enumerate_candidates（商品档，
   *  按约束回答**"符合条件的有哪些"**）。同一条循环、同一份轨迹、同一个 run 库。 */
  searchAgent?: {
    start: (goal: string) => unknown
    get: (runId: string) => unknown
    /**
     * 按**结构化约束**枚举候选清单（`enumerate_candidates`）。同一条发现循环、换一个域。
     *
     * **为什么不是给 `search_agent` 加个参数**（spec §2.6 ①）：入参形状不同。`search_agent`
     * 吃一句自由描述（专名 + 隐含约束），枚举吃的是**已经是结构**的约束（品类 + 区间 +
     * 硬性条件）。塞进同一个 `goal: string` 等于把结构拍平成散文、再让 parse 用 LLM 猜回去；
     * 而加参数躲不掉默认值问题——漏传就安静地跑成另一个域。
     */
    enumerate?: (input: {
      category: string[]
      priceMin?: number
      priceMax?: number
      constraints?: string[]
    }) => unknown
  }
  /** 通用网页搜索（借用户的浏览器打真结果页）。present 时暴露 `web_search`。
   *
   *  **和 `searchAgent` 分得清清楚楚**：那一条是网盘资源获取（多轮扩源、夸克优先、返回获取
   *  目标），这一条只是"上网查一下"。名字像、用途不像——助手拿 `search_agent` 去找一个
   *  GitHub 仓库是用错工具，所以这个能力必须有自己的名字，不能指望它从 `stream_read` +
   *  某个源 id 拼出来（那个源 id 没有任何一处描述提过，等于对模型隐形）。 */
  webSearch?: (
    query: string,
  ) => Promise<{ hits: Array<{ title: string; url: string; snippet?: string }>; note?: string }>
  /** 把一个网页读成正文文字（打 `article-extract` 那条成本阶梯：本地 Defuddle 在前、付费档在后）。
   *  present 时暴露 `read_url`。
   *
   *  **它是 `web_search` 的另一半**：搜索给回的是一串 URL，没有这一条就只能干看着。
   *  和 `stream_fetch_url` 分工不同——那条是**媒体**导向（平台页 / 直链的可下载媒体），
   *  对一个普通网页返回的是空 media，不是正文。 */
  readUrl?: (url: string) => Promise<{ text?: string } | null>
  /** 采集能力诊断：扩展现在连着吗 / 以前装过吗 / 采集该骑哪个 Chrome。present 时暴露
   *  `harvest_capability`。返回的就是 `POST /api/browser-capability/diagnose` 那个结构
   *  （快判字段 + `chrome` 块），**MCP 侧不另造形状**（spec 2026-07-29 §5）。 */
  harvestCapability?: () => Promise<import('../browser/capability-store.ts').BrowserCapabilityDiagnosis>
  /** read access to the backend event log (notification center); when present, exposes
   *  get_events — the pull channel for async outcomes (transcribe settle, auth loss, harvest
   *  failures). Push over MCP notifications is deliberately v2. */
  events?: { list: (opts?: { since?: number; types?: string[] }) => unknown[] }
  /** cross-content voiceprint query — "who appears where". Backed by the appearances ledger
   *  (written at identify 归名 time, keyed by person_id). When present, exposes
   *  list_person_appearances. See spec 2026-07-24-person-appearances-ledger-design. */
  appearances?: {
    query: (person: string, minSeconds?: number) => Array<{
      itemId: string
      title?: string
      source?: string
      seconds: number
      segments: number
      firstAt: number
      nameAtTime: string
    }>
  }
  /** 意图跟踪服务面（spec 2026-08-01）：立意图 / 列意图 / 读档案。when present, exposes
   *  intent_create + intent_list + intent_dossier。招源/主动消化不在 MCP 面（那是后台调度/HTTP
   *  的事，这里只给外部 agent 读写「跟踪什么」这一层）。 */
  intents?: IntentService
  /** 动作型 recipe 的唯一调用入口（`meta.action:true` 才能被跑，二次确认闸，见
   *  `src/mcp/action-recipe.ts`）。present 时暴露 `run_action_recipe`。 */
  runActionRecipe?: (
    args: import('./action-recipe.ts').ActionRecipeArgs,
  ) => Promise<import('./action-recipe.ts').ActionRecipeResult>
  /** 桌面 recipe 的单步调试会话（`src/mcp/recipe-debug.ts`）。present 时暴露
   *  `recipe_debug_start` / `recipe_debug_next` / `recipe_debug_abort`。 */
  recipeDebug?: ReturnType<typeof import('./recipe-debug.ts').createRecipeDebugSessions>
  /** 「这件事为什么做不了、谁能修」。present 时暴露 `capability_status`。判据在
   *  `src/mcp/capability-gaps.ts`；**每次调用现算**（用户刚配完一把 key 答案就变）。 */
  capabilityStatus?: () => { capabilities: import('./capability-gaps.ts').CapabilityView[] }
  /** 「替他去申请一把」——跑那条自助申请 recipe 并**回头核对那一格填上了没**。present 时
   *  暴露 `provision_capability_key`。核对那一步是它存在的全部理由，见
   *  `src/credentials/provision-slot.ts` 头注。 */
  provisionConfigSlot?: (
    ref: string,
    params: Record<string, unknown>,
  ) => Promise<import('../credentials/provision-slot.ts').ProvisionSlotOutcome<{ secrets?: Record<string, { configured: boolean }> }>>
  /** 反查「这一格谁能替我申请」——二次确认那一步要把它原样念给用户听。 */
  configProvisionerFor?: (ref: string) => import('../credentials/provision-slot.ts').ProvisionerLike | null
}

/** A catalog entry: a canonical tool declaration whose `run` already closes over the
 *  `service`/`extras` it needs, so each face only adapts the schema and result shape. */
export interface ToolEntry {
  name: string
  description: string
  /** raw zod shape (what MCP `registerTool` wants); the agent wraps it in `z.object`. */
  schema: z.ZodRawShape
  run: (args: Record<string, unknown>) => unknown | Promise<unknown>
}

// （原来这里有个 pickMeta：list_transcripts/list_parses 各自在工具层把正文投影掉。现在精简是
// ConversionStore.list 的 expandResult 在服务端做的——一处，HTTP 与 MCP 共享同一个保证。）

/** 一次 `web_search` 最多带回几条。实测一次搜索的原始产出可达 ~90KB——整份灌进对话就是撑爆
 *  上下文（用户当天正好在撞「长度超限」）。10 条足够回答"这个项目的仓库在哪"这类问题，
 *  真要往下读有 `stream_fetch_url`。 */
const WEB_SEARCH_MAX_HITS = 10

/** 一次 `read_url` 最多带回多少字。理由同上：一整篇长文能有几万字，而对话里通常只需要开头
 *  那几屏就够判断。截断会**显式说出来**，不做无声删减。 */
const READ_URL_MAX_CHARS = 12_000

const NETDISK_SPEC_DOC =
  'A MatchSpec is `{ "version": 2, "stages": [...] }` — an ordered pipeline where each stage only ' +
  'sees left items still unmatched + right files not yet used. Closed set — stages may ONLY be:\n' +
  '• { "by": "epnum", "epNumRegex": string (1st capture group = episode number), "titleStrip": string[] ' +
  '(regexes stripped before comparing — channel prefixes / 【watermarks】), "threshold": 0..1 (title similarity), "margin": 0..1 (lead over 2nd-best on a number collision) }\n' +
  '• { "by": "title", "titleStrip": string[], "threshold": 0..1 (keep high, ~0.85, to avoid mis-match), "margin": 0..1 } — pure title similarity, rescues no-episode-number items (e.g. year specials).\n' +
  'Usually keep a trailing title stage. Regexes must compile. Invalid specs are rejected server-side.'

/** Build the gated tool catalog for a live `service`/`extras`. Entries whose backing
 *  capability is absent from `extras` are simply not pushed (mirrors the old `if (extras.x)`
 *  registration guards), so the returned list is already the set of tools that can run. */
export function toolCatalog(service: StreamServiceLike, extras: McpExtras): ToolEntry[] {
  const entries: ToolEntry[] = [
    {
      name: 'stream_list',
      description: 'List the curated Streams — the subscribed feed units (the default vocabulary).',
      schema: {},
      run: () => service.list(),
    },
    {
      name: 'stream_search',
      description:
        'NAVIGATE the source tree — discover WHICH sources exist and how to call them. Returns SOURCES (id + category + capabilities + call schema), NOT their content. To actually retrieve content from the user\'s configured sources, use content_search instead. Narrow by `categories` (one or MANY — a site/question can span several branches; use stream_categories to see them) and/or an `intent` string; set searchable=true to get only query-capable sources vs any source (to browse/subscribe). Either intent or categories should be given.',
      schema: {
        intent: z.string().optional(),
        categories: z.array(z.string()).optional(),
        k: z.number().optional(),
        searchable: z.boolean().optional(),
      },
      run: ({ intent, categories, k, searchable }) =>
        service.search((intent as string) ?? '', k as number | undefined, {
          searchable: searchable as boolean | undefined,
          category: categories as string[] | undefined,
        }),
    },
    {
      name: 'stream_sources',
      description:
        'BROWSE the source catalog ACROSS ALL plugins — faceted, grouped by plugin. Returns SOURCES (id + pluginId + capabilities + call schema), NOT their content, and NOT ranked by relevance. Use this to enumerate/filter what sources exist everywhere (optionally narrowed by `query` substring, `category`, or `capability`/`searchable`); use stream_search instead when you want the few sources most relevant to an intent, and content_search to retrieve actual items.',
      schema: {
        query: z.string().optional(),
        category: z.string().optional(),
        capability: z.string().optional(),
        searchable: z.boolean().optional(),
        limit: z.number().optional(),
        cursor: z.string().optional(),
      },
      run: ({ query, category, capability, searchable, limit, cursor }) =>
        service.searchAllPluginSources({
          query: query as string | undefined,
          category: category as string | undefined,
          capability: capability as string | undefined,
          searchable: searchable as boolean | undefined,
          limit: limit as number | undefined,
          cursor: cursor as string | undefined,
        }),
    },
    {
      name: 'stream_categories',
      description:
        'Top of the search tree — content categories (finance / programming / social-media / news …) with how many sources and how many are searchable. Pick the branch a question belongs to, then stream_search({ category, searchable: true }).',
      schema: {},
      run: () => service.categories(),
    },
    {
      name: 'stream_read',
      description:
        'FETCH LIVE from a Stream id (every source in that Stream is pulled again, right now) OR from a single source id with ad-hoc params. Either way this is a live network fetch: nothing is read from what Stream already collected, and nothing is stored. ' +
        '**Do not use it to answer "what is in my timeline / what did I already collect"** — it re-runs the harvest instead of reading the inbox, so it is slow (a busy Stream means one fetch per member source) and it can return items the user has never seen while missing older ones they have. ' +
        'Examples: stream_read({id:"reddit-sub", params:{subreddit:"selfhosted"}}) direct-fetches the reddit-sub source; stream_read({id:"my-tech"}) re-fetches every source of that subscribed Stream. Source direct-fetch returns normalized items. Params are validated against the source schema; invalid params throw before any fetch.',
      schema: { id: z.string(), params: z.record(z.string(), z.unknown()).optional() },
      run: ({ id, params }) => service.read(id as string, (params as Record<string, unknown>) ?? {}),
    },
    {
      name: 'stream_unsubscribe',
      description: 'Remove a Stream by id.',
      schema: { id: z.string() },
      run: ({ id }) => ({ unsubscribed: id, existed: service.unsubscribe(id as string) }),
    },
    {
      name: 'stream_status',
      description: 'Per-Stream last tick time and item counts.',
      schema: {},
      run: () => service.status(),
    },
    {
      name: 'stream_fetch_url',
      description:
        'Fetch a URL and return normalized content (title, author, media list with download links, text). Handles the platforms the installed packages claim (their declared links) plus direct image/video links. Returns structured media for downstream transcoding/OCR.',
      schema: { url: z.string().describe('The URL to fetch (a supported platform page, or a direct image/video link)') },
      // resolveByLink 现读（getter 透传，别拍成死值）：extras 那一格本身是每次调用现派发的闭包，
      // 装/卸包、改绑定都跟得上。
      run: ({ url }) => fetchUrl(url as string, {
        get resolveByLink() { return extras.resolveByLink },
      }),
    },
  ]

  // 已采集进库的条目——「用户自己那批内容」的读口。**它和 content_search 是两条路，不是两个
  // 近义词**：这条只读库、不联网；那条现搜、结果不落库。实测（2026-08-19）没有这个工具时，
  // 「总结时间线里 X 近期的发言」会走成 content_search（回来一堆刚搜的网页）→ 猜源 id 调
  // stream_read（4 次 Unknown id）→ read_url 抓整页（416K token，上游 400）。所以描述里那句
  // 对比不是修辞，是这个工具能不能被选中的全部。
  if (extras.inboxSearch) {
    const inboxSearch = extras.inboxSearch
    entries.push({
      name: 'inbox_search',
      description:
        "Search the items ALREADY HARVESTED into the user's Stream inbox — their subscribed feeds' stored content. Offline: reads the local store, never fetches, never triggers a harvest. " +
        'THIS is the tool for "what did <person/account> post recently", "summarize my timeline", "what have I collected about X" — anything about content the user already follows. ' +
        'Contrast: content_search searches LIVE over configured searchable sources (fresh web/platform results, not the user\'s stored items) — using it for "my timeline" returns things the user never subscribed to; stream_read re-fetches one stream/source from upstream; web_search is the open web. ' +
        'Filters (all optional, ANDed): {q} keyword over title/body, {author} substring, {stream} one id or a list (get ids from stream_list), {channel} a channel by its id OR its display name as the user says it (e.g. "时间线") — a channel is a view over several streams; if the name is not recognized the receipt lists the existing channels, so pick from there rather than guessing again. {since}/{until} ISO timestamps on publish time, {limit} default 20 / max 100, {order} "desc" (newest first, default) or "asc". Give at least one filter — an unfiltered call just returns the newest items. ' +
        'Returns {items: [{id, stream_id, title, author, timestamp, url, excerpt, excerpt_truncated, full_text}], returned, matched, note?}. `matched` is the total hit count before the limit — say so when it exceeds `returned` instead of implying you saw everything. ' +
        'About the body text, and this decides whether you should call another tool: `full_text: true` means the excerpt IS the whole body — do NOT call extract on that item, it would only re-fetch the same text you already have. ' +
        'Only when `excerpt_truncated: true` (and that item\'s full body actually matters for the answer) call extract({item: <id>}) for that one item. Neither flag set = a plain-text body is not what this item is (video / audio / images): extract on it starts a transcription or OCR, so do it only when the answer needs that content.',
      schema: {
        q: z.string().optional(),
        stream: z.union([z.string(), z.array(z.string())]).optional(),
        channel: z.string().optional(),
        author: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.number().optional(),
        order: z.enum(['asc', 'desc']).optional(),
      },
      run: (args) => inboxSearch(args as import('./inbox-search.ts').InboxSearchArgs),
    })
  }

  // Content retrieval over the user's configured searchable sources — the tool to ANSWER a
  // question with real items (distinct from stream_search, which only navigates the registry).
  if (extras.contentSearch) {
    const contentSearch = extras.contentSearch
    entries.push({
      name: 'content_search',
      description:
        'Run a LIVE keyword search RIGHT NOW across the searchable content sources the user has enabled. It goes out to the network on every call and returns whatever those sources answer at this moment. ' +
        '**This does NOT read the content Stream has already collected for the user.** Nothing here comes from their inbox or their subscriptions; results are ephemeral and are not stored, and every `fetched_at` is the instant of this call. If the user asks about "my timeline", "what X posted recently", "the stuff I follow", or anything else phrased as already-collected content, this is the WRONG tool — it will hand back freshly-scraped web hits that merely match the keyword, and passing those off as the user\'s own feed is a silent lie. ' +
        'Contrast the three search tools: stream_search only navigates the source registry (what sources exist + their call schema — it returns SOURCES, not content); content_search searches the enabled sources live; video_search is for film/TV/anime DOWNLOADS (magnet/netdisk), not general content. ' +
        'The participating set is exactly the sources enabled in the channel settings — disabling one removes it from these results. ' +
        `Returns {items, total, note?} — slim items (id / title / author / url / timestamp / tier / a truncated excerpt / media_count), at most ${CONTENT_SEARCH_MAX_ITEMS}. ` +
        'To go deeper on one hit, call `extract` with its `id` (works for ~30 minutes after this search — a snapshot keeps the hit addressable; video/audio hits get TRANSCRIBED, which read_url cannot do). For plain web pages, opening the `url` with read_url also works.',
      schema: { query: z.string() },
      // **截断和瘦身都落在这一层**，不在扇出那一层：前端搜索页吃的是同一个扇出，它要完整条目
      // 去渲染卡片。同一个能力，两个消费方的胃口不同（同 web_search 的 hits 上限）。
      run: async ({ query }) =>
        slimContentSearchResults((await contentSearch(query as string)) as StoredItem[], { isCommunity: extras.isCommunitySource }),
    })
  }

  // 商品比价搜索。**必须和 content_search 分开的名字**：比价是「一个商品 → 各平台报价」，与
  // 跨平台资讯/笔记/视频是两种意图；混进 content_search 只会让价格行被网页搜索结果淹没（正是
  // 归到独立一档的理由）。瘦身复用 content 那套（title/author/excerpt 就是商品/平台/价格）。
  if (extras.priceSearch) {
    const priceSearch = extras.priceSearch
    entries.push({
      name: 'price_search',
      description:
        'Compare a product\'s price ACROSS e-commerce platforms RIGHT NOW. Give a product name (the more specific — model / capacity / color — the better it pins the same SKU) and it fans out over the enabled 比价 (price-comparison) sources and returns, one row per platform offer, each platform\'s current price for that product. ' +
        'It goes to the network on every call; results are ephemeral, not stored, every `fetched_at` is this instant. ' +
        'This is NOT general content/web search: for news, reviews, posts, or "what X said" use content_search / web_search — this tool answers only "how much does this product cost, where". ' +
        `Returns {items, total, note?} — slim rows where **title = the product, author = the platform/店铺 (京东自营 / 天猫旗舰店 / …), excerpt = the price line** (含促销/国补口径), plus url (the deal link). At most ${CONTENT_SEARCH_MAX_ITEMS}. ` +
        'To open one offer, follow its `url` with read_url. Do NOT call extract on an id from here — these rows are not written to the inbox.',
      schema: { query: z.string().describe('商品名，越具体越能锁定同一款（含型号/容量/颜色）') },
      // withImage:商品首图是对比卡的原料,在这层丢了下游就无米可炊。
      run: async ({ query }) => {
        const slim = slimContentSearchResults((await priceSearch(query as string)) as StoredItem[], {
          withImage: true,
          isCommunity: extras.isCommunitySource,
        })
        // 指令放在离决策点最近处(docs/AGENT-TOOLING.md)。条件句式,单型号直查价的场景不受扰。
        const reminder =
          'If the user is choosing WHAT to buy (a category, several candidates) rather than checking one known model\'s price, do not assemble the comparison by hand from these rows — call purchase_decide and let it enumerate, read reviews, price and rank in one closed run.'
        return { ...slim, note: slim.note ? `${slim.note} ${reminder}` : reminder }
      },
    })
  }

  // 购买决策 job:把「枚举候选集 → 深读横评 → 逐个比价 → 支配运算 → 终稿」这条路线从提示词
  // 搬进代码。**模型跳步在这里结构上不成立**——它只提供约束，拿回的是算好的前沿。
  // 这是购买线在工具面上**唯一**的入口:回执就是终稿,工作台直接把它画成对比卡。
  if (extras.purchaseDecide) {
    const purchaseDecide = extras.purchaseDecide
    entries.push({
      name: 'purchase_decide',
      description:
        'The ONE tool for "what should I buy" — a category, a budget, maybe a few things the user cares about. It runs the whole decision as a closed job: enumerate the candidate universe under the hard constraints, read reviews to see which models get named for the soft criteria, price each, and compute the Pareto frontier (斩杀线). Do not assemble a comparison by hand from content_search / price_search rows: the step that gets skipped by hand is the enumeration, and a domination verdict over an arbitrary subset is MISLEADING rather than merely incomplete. ' +
        'CALL IT IMMEDIATELY with what the user already gave. Do NOT interview the user first: every field except category has a sensible default (softCriteria [] = rank on price alone; holdDays 730 if unstated; willResell false if unstated), and the receipt itself reports what was missing. One run with defaults plus "here is what I assumed" beats a table of questions — the user came for an answer, not a form. Ask a follow-up only AFTER showing a result, and only if the receipt says the missing input would change it. ' +
        'ASYNC: returns {runId, status} immediately — the job takes 2–3 minutes (enumerate, read 6 reviews, price each model), longer than most hosts allow one tool call. Poll get_agent_run(runId) every 20–30 seconds; while running it reports which stage it is at; when status is done, `receipt` holds {frontier, dominated, products, unranked, unrankedCounts, coverage, residual, gaps, legend, note}. Never start a second run for the same question while one is running. ' +
        'That receipt IS the final deliverable: narrate it, do not re-enter it into any other tool and do not re-rank it by your own judgement. READ `legend` before interpreting field names — in particular softCriteria are NOT filters ("no_mention" means no review named the model for that point, not that the model lacks it), and `residual.mode` says whether costs are true holding costs or purchase-price-only (never describe purchase_only as "residual defaulted to 0"). ' +
        'CARRY `coverage` INTO YOUR ANSWER: universe size, how many models the reviews named, how many were mentioned but are NOT in the universe, and whether the list was truncated — a truncated run must never be described as "what is on the market". Every model you name MUST appear in this receipt; the domination relation is computed and the user can check it, your opinion cannot be checked.',
      schema: {
        category: z.array(z.string()).describe('品类词,如 ["手机"]——枚举全集用'),
        priceMin: z.number().optional().describe('价格下限(元)'),
        priceMax: z.number().optional().describe('价格上限(元)'),
        softCriteria: z
          .array(z.string())
          .default([])
          .describe('用户在乎的点,如 ["拍照"]。它决定"横评里为什么被点名"算数——**不是规格筛选项**。用户没说就给空数组,别为了填它去问'),
        holdDays: z
          .number()
          .default(730)
          .describe('打算持有多少天——日均持有成本的分母。用户说了"用两年"就 730;没说就用默认 730 并在答案里说明这是假设'),
        willResell: z
          .boolean()
          .default(false)
          .describe('到期会不会真的转手。没说就 false(残值按 0 算,这一档本来就对);说了会转手就 true——残值来源缺席时回执会退到按买入价比并明说'),
      },
      run: (args) => {
        const a = args as unknown as {
          category: string[]
          priceMin?: number
          priceMax?: number
          softCriteria: string[]
          holdDays: number
          willResell: boolean
        }
        // 默认值在这里再兜一次:schema 的 .default() 只在经 zod parse 的路径上生效,而调用方
        // 不止一条(server.ts / disk 模式 / 测试直调 run)。缺一格就问用户,正是要拆掉的那种行为。
        return purchaseDecide({
          category: a.category,
          priceRange: { min: a.priceMin, max: a.priceMax },
          softCriteria: a.softCriteria ?? [],
          holdDays: a.holdDays ?? 730,
          willResell: a.willResell ?? false,
        })
      },
    })
  }

  // 通用网页搜索。**必须有自己的名字**：这个能力一直在栈里，但只能经
  // `stream_read` + 一个没人提过的源 id 触达，等于对模型隐形——实测助手会答「我没有搜索
  // 网页的功能」然后停住。
  if (extras.webSearch) {
    const webSearch = extras.webSearch
    entries.push({
      name: 'web_search',
      description:
        'Search the WEB and return the top hits as {title, url, snippet}. This is the tool for questions the user\'s own content cannot answer — finding a project\'s GitHub URL, an official site, documentation, who someone is, what a term means. ' +
        'Contrast: content_search searches only the content the USER has configured/subscribed; search_agent is NOT a web search — it is a netdisk资源获取 agent (multi-round hub discovery, 夸克-first, returns acquisition targets), wrong tool for looking something up. ' +
        'Returns {hits: [{title, url, snippet, alsoAt?}], note?} — at most 10 hits (a raw web search is tens of thousands of characters — the cap is what keeps it usable in a conversation). ' +
        '`alsoAt`, when present, lists other sites carrying the SAME story (reprints) that were folded into this hit — they are not extra evidence, do not count them as independent corroboration; open one only if the main URL is unreachable. ' +
        'It runs the search by opening a real results page in the user\'s own browser, so one call takes a few seconds. Nothing to pass — retries and fallbacks (Brave when Google fails, 百度 in parallel for Chinese queries) are handled inside; do NOT re-issue the same query. ' +
        '`note`, when present, says one of the tiers did not go through this time (some engines did not answer / the browser tier could not run): an EMPTY hits list then means "this search did not go through", NOT "this thing does not exist" — say so instead of asserting absence. It is not an invitation to retry the same query. ' +
        'To READ a promising hit, use read_url — NOT stream_fetch_url, which only extracts downloadable media from platform pages / direct links and returns nothing for an ordinary web page.',
      schema: { query: z.string().describe('what to look up, in natural language or keywords') },
      // **截断在这一层**，不在数据源那一层：search agent 那条腿要完整结果集去扩源判切题，
      // 对话这条腿多一条都是白烧上下文。同一个能力，两个消费方的胃口不同。
      // note 原样带出：它就是为这条腿存在的（模型要靠它分清「没搜到」和「没查成」）。
      run: async ({ query }) => {
        const { hits, note } = await webSearch(query as string)
        return { hits: hits.slice(0, WEB_SEARCH_MAX_HITS), note }
      },
    })
  }

  // 读一个网页。**web_search 的另一半**：搜索给回一串 URL，没有这条就只能干看着——实测助手
  // 会拿 stream_fetch_url 去读 github 页面，每次拿回 {platform:'unknown', media:[]} 的空成功、
  // 每次不知道为什么，连打三次直到步数用尽，答案始终没给出来。
  if (extras.readUrl) {
    const readUrl = extras.readUrl
    entries.push({
      name: 'read_url',
      description:
        'Read a web page as TEXT (article extraction: local reader first, paid fallback only if it declines). This is how you follow up a web_search hit. ' +
        'Returns {url, text, chars, truncated} — or {error} when the page yields no article text (paywall, JS-only app, login wall, a bare file). ' +
        'NOT the same as stream_fetch_url: that one extracts downloadable MEDIA from platform pages / direct links and returns nothing useful for an ordinary web page.',
      schema: { url: z.string().describe('the page URL to read') },
      run: async ({ url }) => {
        const got = await readUrl(url as string)
        const text = got?.text?.trim() ?? ''
        // 抓不到就说抓不到。回一段空文本冒充成功，模型会当成「这页没内容」而不是「我没读到」，
        // 然后要么编、要么原地重试——两种都比一句实话贵。
        if (!text) return { url, error: '这个页面没抓到正文（可能是付费墙 / 纯前端渲染 / 需要登录 / 不是文章页）' }
        const truncated = text.length > READ_URL_MAX_CHARS
        return {
          url,
          chars: text.length,
          truncated,
          // 截断也要**说出来**：半篇文章被无声吃掉，模型会拿前半截当全文下结论。
          text: truncated ? `${text.slice(0, READ_URL_MAX_CHARS)}\n…（已截断，全文 ${text.length} 字）` : text,
        }
      },
    })
  }

  // Film/TV/anime DOWNLOAD search — faceted, for the AI to filter over.
  if (extras.videoSearch) {
    const videoSearch = extras.videoSearch
    entries.push({
      name: 'video_search',
      description:
        'Search film/TV/anime DOWNLOAD sources (magnet/torrent) by name. Returns a FACETED tree, not a flat list — "aggregation" is explicit dimensions you filter over, not a fixed grouping:\n' +
        '• shows[]: groups per (source, show, season). Each has qualities[] and a season `total` (episode count, null if unknown).\n' +
        '• qualities[]: one per resolution (2160p/1080p/720p/sd/unknown), each with releases[] and a `coverage` summary.\n' +
        '• release: one download — fields: quality, coverage ({kind: pack|single|range with episode numbers}|unknown), sourceType (magnet/quark/baidu/aliyun/ed2k), sizeBytes, codec, hdr, group, link, parsed.\n' +
        '• coverage summary per quality: {total, episodes[], missing[], hasPack}. `missing` = gap episodes for THAT quality vs the season total (best-effort; empty when total unknown). Completeness is never guaranteed.\n' +
        '• parsed=true → facets were regex-extracted from the title (fuzzy); weigh accordingly.\n' +
        '• needsResolve=true → `link` is a page on the source site, not a direct download; call video_resolve with it to get the download options.\n' +
        '• loose[]: ungrouped releases (movies / flat sources). sources[]: per-source timing+status.\n' +
        'nsfw=true searches the adult source set INSTEAD (disjoint from the regular set — two separate intents).',
      schema: { query: z.string(), nsfw: z.boolean().optional() },
      run: ({ query, nsfw }) => videoSearch(query as string, { nsfw: nsfw as boolean | undefined }),
    })
    if (extras.videoResolve) {
      const videoResolve = extras.videoResolve
      entries.push({
        name: 'video_resolve',
        description:
          'Resolve a release whose needsResolve=true — its `link` is a page on the source site, not a direct download. Returns { downloads: [{url, type, password?, name?}] } where type is magnet/ed2k/quark/baidu/aliyun/http; usually one entry, first is preferred.',
        schema: { url: z.string() },
        run: async ({ url }) => ({ downloads: await videoResolve(url as string) }),
      })
    }
  }

  // 取一条 item 的正文。**一个工具**：调用方不需要先判断这是图、是视频还是网页——那是后端
  // 按 archetype 判的分支。（2026-07-25 的设计曾保留 transcribe/parse 两个具名工具，理由是
  // 具名比带 kind 参数的通用工具选中率高；那条反对的是「让模型多填一个 kind」，前提是两者
  // 是两个意图。它们不是——是一个意图加一个后端可自行判定的分支，所以这里没有参数可挑。）
  if (extras.extract) {
    const extract = extras.extract
    entries.push({
      name: 'extract',
      description:
        "Get an item's text content. Input: `item` is a HANDLE, and it has three namespaces — (1) an inbox item id; (2) the id of a hit you just got back from content_search, which is NOT in the inbox but stays addressable here for ~30 minutes; (3) a netdisk-bound movie/episode key `tmdb:<id>` or `tmdb:<id>:SxxExx`, which is not an item at all — that is the only way to read a netdisk-bound episode. The backend picks how by itself (speech-to-text for video/audio, OCR for images/PDF, article fetch for links, or the post's own text) — you do not choose. Served from a persistent cache: a second call returns the cached text without re-running (no re-charge). Returns {status: running|done|error, result?: {text, format: markdown|plain, branch, detail?}}. `detail.segments` (a timed transcript) exists only for the speech branch, and is stripped when the result comes back digested (see below). This call WAITS for the work to finish (up to ~90s) rather than returning early, so a settled answer is normally the first thing you get back — do not call it again to poll unless the answer itself tells you to. " +
        'The cache is matched on the item alone, NOT on the options: a cached result comes back even if you now ask for diarize. So when the user asks to 重跑 / 重新取一次 / 重新识别发言人 (re-run, redo, extract it again, identify the speakers this time), pass rerun:true — otherwise nothing at all happens and no error is reported. ' +
        'For a VIDEO there is a SECOND layer the transcript does not carry: the text ON SCREEN (slides, news banners, burned-in subtitles, chart numbers), often the bulk of the content while the transcript is a scrap. It is extracted automatically and arrives here — you never call another tool for it. This layer is slow and heavy-tailed (seconds to many minutes), so the call waits for it too. If it is STILL running when the answer comes back, that means minutes more: DO NOT call extract again to poll it — tell the user the on-screen text is still being extracted and let them come back to it. You then get either the transcript plus `on_screen_text: {status: "running"}` (when the transcript stands on its own), or `status: "running"` with `waiting_for: "on_screen_text"` AND NO RESULT (when the content is essentially all on screen) — in that second case you have nothing to summarize, so do not try. When it is ready it comes back as `on_screen_text.text` (timestamped) beside the transcript — any summary of the video must cover BOTH. ' +
        'Long texts (>4000 chars) ALWAYS come back as a DIGEST — sourced bullet points instead of the full body — with `digested: true`, `full_text_chars`, and a `next_step`. Pass `focus` (one line: what you are looking for) to aim the digest. There is no full-text switch here: the user reads the full text on the card, and when YOUR task itself requires the complete text (e.g. translating a whole transcript), read it via get_conversions({item}). ',
      // `diarize` 不是分支选择：转写分支上要不要顺带把「谁在说」标出来。
      // `rerun` 是缓存旁路——见 McpExtras.extract 的头注（缓存不看 options）。
      // `focus` 是窄回执层（digest）的压缩镜头——见 extract-digest.ts。
      // **模型面刻意没有 full 开关**（spec 2026-08-24-digest-authority）：活体连续四轮证明
      // 这个决策权交给模型就会被滥用（读什么都带 full:true）。全文流向人眼（卡片自己从
      // /api/conversions 取）和 get_conversions（模型真需要整篇时的绕路），不流向这里。
      schema: {
        item: z.string(),
        focus: z.string().optional().describe('你在找什么（一句话）——长正文会按这个镜头压成带出处的要点'),
        diarize: z.boolean().optional(),
        rerun: z.boolean().optional(),
      },
      run: ({ item, focus, diarize, rerun }) =>
        extract(item as string, {
          diarize: diarize as boolean | undefined,
          rerun: rerun as boolean | undefined,
          focus: focus as string | undefined,
        }),
    })
  }

  // Read produced conversions (transcript / OCR / speaker-identification / summary). ONE tool
  // with two modes, because they are the same question at two zoom levels:
  //   - no `item` → a LIGHTWEIGHT index (bodies stripped) so browsing never pollutes context
  //   - with `item` → that item's bodies, because naming an item IS the ask for its content
  // Read-only: it never triggers a (re-)conversion — that's what `extract` is for.
  if (extras.conversions) {
    const conversions = extras.conversions
    entries.push({
      name: 'get_conversions',
      description:
        "Read what has been derived from items — extracted text (kind:'extract'; its `result.branch` says how: stt/ocr/article/inline), speaker identification (kind:'identify'), on-screen text pulled from video frames (kind:'frames'; `result.track` is [{at,text}] holding ONLY what the transcript could not carry — slides, code, chart numbers; an EMPTY track does not mean it never ran, read `result.probe.stop` for which of the five stops it took) and summaries (kind:'summary'). " +
        "When `extract` returned a digest (`digested: true`), THIS is where the full text lives — call it with the item id. " +
        'Named-item mode returns FULL bodies that stay in this conversation — to compare 2 or more long items, fan out one `subagent` per item (bullets back, never raw text) instead of pulling every full body in here. ' +
        'Two modes: WITHOUT {item} it lists recent conversions newest-first as a LIGHTWEIGHT index (no transcript text, no markdown) — use it to see what exists; WITH {item} it returns that item\'s conversions INCLUDING their bodies (text/segments/markdown/summary). ' +
        'Optional {kind} filters to one type, {limit} caps the index (default 10), and {expand:false} forces the lean shape even when an item is named. ' +
        'Every record carries `timing` — total wall clock plus per-stage (取音频/语音识别/声纹归名 for stt, 取原件/文字识别 for parse) — so "why was this slow" is answerable from the record. Records migrated from before 2026-07-25 have no timing. ' +
        'Read-only: this NEVER starts a conversion; use transcribe(item) or parse(item) for that. An item that was never converted returns an empty list.',
      schema: {
        item: z.string().optional(),
        kind: z.enum(['extract', 'identify', 'frames', 'summary']).optional(),
        limit: z.number().optional(),
        expand: z.boolean().optional(),
      },
      run: ({ item, kind, limit, expand }) =>
        conversions.list({
          item: item as string | undefined,
          kind: kind as string | undefined,
          limit: (limit as number | undefined) ?? (item ? undefined : 10),
          // 点名了某个 item = 要的就是它的正文；只有浏览时才默认精简。expand 可显式压回精简。
          expandResult: (expand as boolean | undefined) ?? !!item,
        }),
    })
  }

  // 把三条轨（底座正文 / 谁在说 / 屏幕上写着什么）合成一份按时刻排好的稿子。**帧文字轨在
  // 模型这一侧的唯一到达路径**——`get_conversions` 给的是逐条原始记录，不是稿子。判据与
  // 每层的 state 语义在 `src/conversions/read-content.ts`。
  if (extras.conversions) {
    const conversions = extras.conversions
    const speakers = extras.speakers
    entries.push({
      name: 'read_content',
      description:
        "Read what is already known about an item's content, as ONE time-ordered script. " +
        'It combines up to three separate layers: the base text (speech-to-text / OCR / article), WHO is speaking, and WHAT IS WRITTEN ON SCREEN (slides, code, charts — text the speech never says out loud). ' +
        'This tool only READS what has already been produced; it never starts work and returns immediately. To produce a layer, call `extract` (base text) or `identify_speakers` — those wait. ' +
        // 活体教训(2026-08-24):扇出指令铺满三档(PERSONA/这里的描述/返回体 note),模型对
        // "对比深读三条"照样每轮串行读全文——省上下文不能赌模型自觉,于是长文在这里也走
        // digest 档(结构性收口,与 extract 同一个压缩器)。扇出指令保留,但它管的是墙钟
        // (并行),不再背着"省上下文"的指望。
        'Long base texts (>4000 chars) ALWAYS come back as a sourced DIGEST (`digested: true`) — there is no full-text switch; when your task itself requires the complete text, read it via get_conversions({item}). To deep-read several items in parallel, spawn one `subagent` per item (bullets back, never raw text). ' +
        'Ask for the layers you actually need: screen text can be dozens of lines, so leave include_screen_text off unless the question is about what was shown, demonstrated, or written. ' +
        'EVERY layer comes back with a `state`, and when a layer is empty the state IS the answer — never report "there was nothing on screen" unless frames.state is "empty"; "absent" means nobody has run that layer yet, "running" means ask again shortly, "error" means the backend failed. Report those three as what they are, do not turn them into a statement about the content.',
      schema: {
        itemId: z.string(),
        include_speakers: z.boolean().optional(),
        include_screen_text: z.boolean().optional(),
      },
      run: async ({ itemId, include_speakers, include_screen_text }) => {
        const composed = readContent({ list: conversions.list, speakers }, itemId as string, {
          speakers: !!include_speakers,
          screen: !!include_screen_text,
        })
        // 长正文无条件过 digest(结构性收口,见 description 旁注)。压缩器自己判门槛,短文
        // 原样退回。**这里刻意没有 full 开关**——上一版有,活体第一轮模型就学会了全带
        // full:true(spec 2026-08-24-digest-authority);全文归卡片(人眼)和 get_conversions。
        if (!extras.digestLongText || typeof composed.text !== 'string') return composed
        const rec = (await extras.digestLongText(itemId as string, composed.text)) as {
          result?: { text?: string; digested?: boolean; digest_failed?: boolean; full_text_chars?: number }
        }
        const r = rec?.result
        if (!r?.digested || typeof r.text !== 'string') return composed
        const { note: _fullBodyNote, ...rest } = composed
        return {
          ...rest,
          text: r.text,
          digested: true,
          ...(r.digest_failed ? { digest_failed: true } : {}),
          full_text_chars: r.full_text_chars,
          next_step:
            `This is a digest — the full text (${r.full_text_chars} chars) is stored. ` +
            'The user can read it on the card; call get_conversions({item}) only when your task itself requires the complete text.',
        }
      },
    })
  }

  // 补说话人：只跑 diarization + 归名，**不重跑 STT**。和 extract 一样是「起了就回」的轮询式
  // 契约（起一条 conversion，status:running 就再调一次）。
  if (extras.identify) {
    const identify = extras.identify
    entries.push({
      name: 'identify_speakers',
      description:
        'Identify WHO is speaking in an item: runs diarization + voiceprint naming over the existing transcript (it does NOT re-run speech-to-text, and it works even when there is no transcript yet). ' +
        'Returns {status: running|done|error, ...}; if status is running, call again to poll, then use read_content to read the named script. ' +
        'The cache is matched on the item alone: when the user asks to 重跑 / 重新识别 (redo, identify again), pass rerun:true — otherwise the old record comes back and nothing happens, with no error.',
      schema: { item: z.string(), rerun: z.boolean().optional() },
      run: ({ item, rerun }) => identify(item as string, { rerun: rerun as boolean | undefined }),
    })
  }

  // 接不上的站记一笔。**这是心愿单（`/api/onboard/wishlist`）唯一的写入者**——没有它，
  // resolve_intent 空手之后那条线索就彻底消失了，而模型照样会说"我已经记下了"。
  if (extras.wishlist) {
    const wishlist = extras.wishlist
    entries.push({
      name: 'note_unonboardable',
      description:
        'Record a site that the user wanted to follow but Stream cannot ingest yet (resolve_intent returned no matches). ' +
        'Call this right after telling the user the site cannot be onboarded — do NOT silently drop it, and do NOT substitute a different source. ' +
        'Include what the user was actually after in `goal`: without it the entry is just a URL nobody can act on later.',
      schema: { url: z.string(), goal: z.string(), note: z.string().optional() },
      run: ({ url, goal, note }) => ({
        noted: wishlist.add({ url: url as string, goal: goal as string, note: note as string | undefined }).id,
      }),
    })
  }

  // Cross-content voiceprint query: "which items does this person appear in, and for how long".
  // Reads the appearances ledger (person_id-keyed, written at identify time) — never triggers work.
  if (extras.appearances) {
    const appearances = extras.appearances
    entries.push({
      name: 'list_person_appearances',
      description:
        'List the content a person appears in, by voiceprint identity. Input: {person} (a registered person name or alias — exact match preferred, else substring) and optional {minSeconds} (default 30, filters out brief interjections). Returns items sorted by speaking time descending: [{itemId, title, source, seconds, segments, firstAt, nameAtTime}]. Read-only — reads the appearances ledger, never re-transcribes.',
      schema: { person: z.string(), minSeconds: z.number().optional() },
      run: ({ person, minSeconds }) => appearances.query(person as string, minSeconds as number | undefined),
    })
  }

  // target-resolve model (additive): one-engine resolve over the derived source ladder.
  if (extras.resolve) {
    const rx = extras.resolve
    entries.push({
      name: 'resolve_intent',
      description:
        'Resolve a pasted URL into the candidate Stream sources (RSSHub catalog + native plugins) that can ingest it, each with extracted params. ' +
        'An EMPTY `matches` means Stream cannot ingest this site today (`fallback: generic-url` is NOT a subscribable source): say so plainly, do not substitute a different source.' +
        (extras.wishlist ? ' When there are no matches, call note_unonboardable to record it (with what the user was after).' : ''),
      schema: { input: z.string() },
      run: async ({ input }) => {
        const out = await rx.resolveIntent(input as string)
        // 空手时把"下一步要干什么"塞进**工具结果**里，不只写在描述里。
        //
        // 活体实测（2026-08-13）：只写描述 + 系统提示词时，模型在自己的推理里复述了
        // 「我需要调 note_unonboardable」，然后**没调就直接回答"我已经记录了您的需求"**——
        // 清单里一条没有。漏记只是能力缺失，谎报已记是骗用户，后者严重得多。
        // 指令放在它刚读到的那份数据里，比放在几千 token 之前的描述里更靠近决策点
        // （docs/AGENT-TOOLING.md §3）。
        const matches = (out as { matches?: unknown[] } | null)?.matches
        if (!extras.wishlist || !Array.isArray(matches) || matches.length > 0) return out
        return {
          ...(out as object),
          next_step:
            'No source can ingest this URL. Tell the user plainly that it cannot be onboarded, then CALL note_unonboardable (url + what the user was after). Do not claim you recorded it unless that call actually ran.',
        }
      },
    })
    entries.push({
      name: 'resolve',
      description:
        'One-shot resolve a Target via the exclusive (failover) source ladder — first source that answers wins. Pass {target_type,key}, or {input} to classify first.',
      schema: {
        target_type: z.string().optional(),
        key: z.string().optional(),
        input: z.string().optional(),
      },
      run: async ({ target_type, key, input }) => {
        let tt = target_type as string | undefined
        let k = key as string | undefined
        if (input && (!tt || !k)) {
          const r = rx.classifyIntent(input as string)
          tt = r.targetType
          k = r.key
        }
        if (!tt || !k) return { error: 'target_type+key or input required' }
        return { targetType: tt, key: k, result: await rx.resolveTarget(tt, k) }
      },
    })
    entries.push({
      name: 'list_sources',
      description: 'List sources in the resolve pool (optionally by target-type) with priority + live health.',
      schema: { target_type: z.string().optional() },
      run: ({ target_type }) => rx.listSources(target_type as string | undefined),
    })
  }

  // netdisk (AList) match-rule editing — the external-agent surface. Read residue, author a
  // closed-set MatchSpec, dry-run it, apply it. Deterministic runtime; the agent does the
  // reasoning the app's built-in LLM would otherwise do.
  if (extras.netdisk) {
    const nd = extras.netdisk
    entries.push({
      name: 'netdisk_bindings',
      description:
        'List netdisk (AList) bindings with their last-sync coverage — use this to find a binding\'s setId and see which have residue (unmatched left / orphan right) worth optimizing. Returns a compact projection (no per-entry dump).',
      schema: {},
      run: () => nd.bindings(),
    })
    entries.push({
      name: 'netdisk_browse',
      description:
        "List a directory on the user's netdisk (AList). This is how you SEE the disk — every other netdisk tool addresses things by binding id or by a path you already know; this is the only one that answers \"what is actually in here\". Use it when the user names a folder in words (\"我夸克里那个播客合集\") instead of giving a path, and to confirm a path before anything writes to it. `path` is an absolute AList path (`/quark/…`, mount root first); omit it to list the roots. IT TAKES A PATH, NOT A BINDING: to see a binding's folder, read `dirPath` off netdisk_bindings and pass that as `path` — a `setId` here is rejected. `recursive:true` walks the whole subtree (names come back as relative sub-paths) — use it to judge what a folder actually holds, not just its top level. " +
        'RESPONSE SHAPE CHANGES WITH SIZE, read it before concluding: small directories come back as `entries[]` (one row per item); big ones come back as `shape` (file/dir counts, extension histogram, size range) plus a `sample` of names and NO entries[] — that is not a failure and not an empty directory, it means listing every name would not fit in the conversation. `total` is always the true count; `truncated:true` means even the shape only covers the first 5000. Read-only — it never creates, moves or deletes anything.',
      schema: {
        path: z.string().optional(),
        recursive: z.boolean().optional(),
        // **不是多余的一格。** 这条工具住在一条以 setId 为轴的流水线中间（netdisk_bindings →
        // reconcile_*），传 `setId` 是最自然的手滑；而未知键被 zod 静默剥掉之后，`path` 缺席
        // 就列了网盘根——不报错，只是答非所问，活体里差点被当成"绑定目录下只有两项"写进报告。
        // 声明成 never 才让它响：schema 层直接拒，并且报错本身说清该传什么。
        setId: z
          .never({ error: 'netdisk_browse takes path, not setId — get dirPath from netdisk_bindings' })
          .optional(),
      },
      run: ({ path, recursive }) => nd.browse((path as string | undefined) ?? '/', recursive === true),
    })
    entries.push({
      name: 'netdisk_residue',
      description:
        'Read one binding\'s residue: current coverage + the left items the rule failed to place (unmatchedLeft) + the right files nothing used (orphanRight) + human corrections (corrected, a labelled set: rightFile set = should match that / null = should stay empty). This is everything you need to author a better MatchSpec. ' +
        NETDISK_SPEC_DOC,
      schema: { setId: z.string() },
      run: ({ setId }) => nd.residue(setId as string),
    })
    entries.push({
      name: 'netdisk_preview_spec',
      description:
        'Dry-run a candidate MatchSpec against a binding — computes, persists nothing. Returns before/after coverage, `changed` (rows that would move: {leftKey, from, to}), and `correctedConflicts` (where the rule disagrees with a human correction — those stay pinned to the human on apply). Author the spec from netdisk_residue, preview here, then netdisk_apply_spec. ' +
        NETDISK_SPEC_DOC,
      schema: { setId: z.string(), spec: z.record(z.string(), z.unknown()) },
      run: ({ setId, spec }) => nd.previewSpec(setId as string, spec),
    })
    entries.push({
      name: 'netdisk_apply_spec',
      description:
        'Validate + persist a MatchSpec onto a binding and resync (human corrections stay pinned). Returns the post-sync coverage summary. Preview with netdisk_preview_spec first. Same closed-set schema as preview.',
      schema: { setId: z.string(), spec: z.record(z.string(), z.unknown()) },
      run: ({ setId, spec }) => nd.applySpec(setId as string, spec),
    })
    // 整理裁决面（spec 2026-08-24-conversational-reconcile）。判读该怎么下的分层判据写在
    // reconcile_decide 的描述里——指令放在最靠近决策点的地方（docs/AGENT-TOOLING.md）。
    if (nd.reconcileOpen) {
      const open = nd.reconcileOpen
      entries.push({
        name: 'reconcile_open',
        description:
          "Point a subscription at netdisk folders so reconcile can run on them — the setup step BEFORE reconcile_status/decide/execute. Use it when the user says \"整理这个目录到<某档节目>\" and reconcile_status does not already list a show for that subscription. `streamId` is the subscription (stream_list / stream_search to find it — never guess it from a display name, the files that move are real). `sourceDirs` are absolute AList paths holding the loose files to be sorted; confirm them with netdisk_browse first. " +
          'ONE ATOMIC ACTION, deliberately: it creates the two shelf folders, creates or reuses the binding, gives the subscription the "下架" source that scans the offline shelf, and writes the config — in that order, rolling everything back if any step fails. Do NOT try to assemble this from other tools; a half-built setup silently sends offlined files into a folder nothing scans, which reads to the user as the files vanishing. ' +
          'Idempotent: calling it again for the same subscription reuses the existing binding/shelf and REPLACES the source dirs with the ones you pass (they describe this run, not a standing list). It never enables auto-execute — nothing moves until you call reconcile_execute. Returns {showId, bindingId, shelves, created} — `created` says what was actually new, report it.',
        schema: {
          streamId: z.string(),
          sourceDirs: z.array(z.string()),
          label: z.string().optional(),
        },
        run: (a) => open(a as { streamId: string; sourceDirs: string[]; label?: string }),
      })
    }
    if (nd.transcribeFile) {
      const listen = nd.transcribeFile
      entries.push({
        name: 'netdisk_transcribe',
        description:
          "LISTEN to a loose audio file on the user's netdisk: returns a speech transcript of a SAMPLE — about the first two minutes and the last two minutes, NOT the whole file. `path` is an absolute AList path (get it from reconcile_status's pending cards or from netdisk_browse). " +
          'USE IT when you must decide WHICH EPISODE a netdisk file is and the filename/duration do not settle it — the opening minutes name the topic, and the ending tells you whether the file is complete (a proper sign-off) or was cut short (a sentence stopping mid-word). Those are the two questions metadata cannot answer, and "truncated file" vs "the listing\'s duration is wrong" have OPPOSITE fixes. ' +
          'THE SAMPLE IS ALL YOU GET: the middle of the episode is never transcribed (a full hour of ASR costs real money and would not fit in this conversation anyway). Never summarise the episode from it, and never say something is absent from the episode because it is absent here. `windowS` widens/narrows each window and is CAPPED — there is no way to ask for the whole file. ' +
          'Only mp3/aac (mp4/mkv keep their index elsewhere in the container, so a byte slice of them decodes to nothing) and only when the duration is known; otherwise it returns {status:"unsupported", reason}. Results are cached per file (keyed to the file itself, so it survives reconcile moving it), but a cold call downloads ~10MB and runs two ASR requests — call it on the handful of files you actually need, not across a whole folder. ' +
          'NOT the same as `extract`/`transcribe`/`get_conversions`: those address items already in the inbox by item id, and a loose netdisk file has no item id — this is the only way to hear one. After you decide, write the verdict back with reconcile_decide.',
        schema: { path: z.string(), windowS: z.number().optional() },
        run: ({ path, windowS }) => listen({ path: path as string, windowS: windowS as number | undefined }),
      })
    }
    entries.push({
      name: 'reconcile_status',
      description:
        "Netdisk reconcile (归档整理) status. No args → list configured shows (id/label/bindingId). `show` accepts the show id, the SUBSCRIPTION id (what an `@` reference in the composer carries — `「name」(stream:<id>)`), or the show's display name; a miss reports the ids that do exist, so you never need a separate listing round-trip. With `show` → run a READ-ONLY preview and return {counts, pending[], pendingTotal, pendingTruncated, suspectDirs[]}. NOTHING HAS HAPPENED YET: every number in `counts` is a PLANNED action this preview would take, never a completed one — only reconcile_execute moves anything, so never report these as \"已移动\"/\"already moved\". Read `counts` as: `move` is the total planned moves and `moveClaimed` + `moveSecondary` + `movePureCut` (files whose name says 纯享 — a separate playlist, shelved under `<claimed>/纯享/S<nn>/`, never an episode) are its BREAKDOWN (they sum to `move` — reporting them alongside `move` as separate figures double-counts the same files); `deleteDup`/`deleteLoser`/`deleteRedundant`/`replace` are planned too; `pending` is how many cards await adjudication. EVERY PLANNED DELETE IS LISTED HERE, per file, in `plannedDeletes[]` — {kind:'delete-dup'|'delete-loser'|'delete-redundant'|'replace', path (the file that disappears), keptPath? (the copy that stays; absent for delete-redundant, where what stays is the source site itself), episode?, sizeBytes?/durationS? (the copy that disappears), keptSizeBytes?/keptDurationS? (the copy that stays), basis? (why the planner picked the keeper)} — that is the list reconcile_execute expects you to have checked, since a delete is the one action nothing walks back. CHECK IT ON `durationS`: two copies of the same episode have EXACTLY equal durations, so `durationS !== keptDurationS` means stop, and `keptSizeBytes < sizeBytes` (keeping the smaller file) means stop; a wildly implausible duration is a failed probe, not evidence about the content. A duration field is ABSENT when the planner had no candidate row for that path — absent is not zero. This list is paged on its OWN cursor `deletesOffset` (NOT `offset`, which belongs to `expandDir`): one page is at most 50 entries, and the reply carries `plannedDeletesTotal`, `plannedDeletesOffset` and `plannedDeletesTruncated` (true = call again with `deletesOffset: <offset + 50>` to get the rest). `planFingerprint` is a stable hash of the whole plan — pass it to reconcile_execute as `expectFingerprint` so the run you checked is the run that happens. Per-file details for the routine MOVES live in the panel, not here (a moved file can always be moved back). `pending[]` are the per-file cards that need adjudication, each with the file (path/size/durationS), the colliding episode (episode/leftKey/authorityDurationS), competing candidates, and the planner's reason — capped at `limit` (default 50, max 200); `pendingTotal`/`pendingTruncated` tell you whether you are holding the whole list, so never assume you are. " +
        "`suspectDirs[]` is DIFFERENT and you must not treat it as more cards: each entry is ONE directory-level finding ({dir, unrecognized, scanned, files, sample[], hint}) saying that directory looks mis-claimed, which pressed ALL `files` actions under it into pending. That is one question — \"is this directory even the right folder?\" — so ASK THE USER it first; a mis-pointed binding is fixed by re-pointing it, not by adjudicating hundreds of files one by one. Only after the user confirms the folder is right, call again with `expandDir:<that dir>` (plus `offset`/`limit`) to page through that group's files; the expanded reply carries {expanded:{dir,total,offset,returned,hasMore}} and each row's own `priorVerdict`. " +
        'Call this FIRST when the user asks to 整理/归位/认领 podcast or media files; decide the cards with reconcile_decide (it takes a `decisions` array — send them in ONE batched call, not one call per card), then reconcile_execute to move files. ' +
        "`show` ALSO accepts a netdisk BINDING: pass the setId from netdisk_bindings, or `binding:<setId>` to say so explicitly. That is the only way to reach a TV/movie binding — those have no show config, so they never appear in the no-arg listing above and a plain name will not find them. A binding runs in 原地模式: it plans inside the binding's own folder only (no staging shelf, no 下架 shelf), which for a TV binding means seasons folders, `SxxExx - ` rename prefixes and 纯享 shelving. A bare id is looked up as a show first, so nothing about the podcast path changes.",
      schema: {
        show: z.string().optional(),
        expandDir: z.string().optional(),
        offset: z.number().optional(),
        limit: z.number().optional(),
        deletesOffset: z.number().optional(),
      },
      run: ({ show, expandDir, offset, limit, deletesOffset }) =>
        nd.reconcileStatus(show as string | undefined, {
          expandDir: expandDir as string | undefined,
          offset: offset as number | undefined,
          limit: limit as number | undefined,
          deletesOffset: deletesOffset as number | undefined,
        }),
    })
    entries.push({
      name: 'reconcile_decide',
      description:
        "Record adjudications for pending reconcile cards. BATCH BY DEFAULT: pass `decisions` — an array of the shapes below — and settle every card you have decided in ONE call. Do not loop this tool one card per call; each call re-sends the whole conversation, so 28 cards one-by-one costs 28 round-trips for 28 sixteen-byte replies. Returns {ok, decided, failed, errors?}, where each error carries the offending `index` + `target` and the others still went through — resend only the failures. The single-decision shape (fields at the top level, no `decisions`) still works and is exactly the 1-element case. " +
        "Each decision has two shapes: {verdict:'is-episode'|'not-episode', leftKey, path} answers \"is this FILE that EPISODE\" (verdict:null + leftKey+path = 撤回); {verdict:'prefer', keptPath, loserPath} answers \"of these two copies keep the first\". Writes only the decision ledger — nothing moves until reconcile_execute. EVIDENCE POLICY (hard rule): decide directly WITHOUT asking the user only when the conclusion is a logical deduction, not a judgment — byte-identical duplicates (same size+duration), duration matching the episode listing to within seconds with a matching name, or a plainly broken filename. For everything softer — a compilation file (duration way over the listing), multiple candidates competing for one slot, name and duration contradicting each other — lay out the evidence in the conversation and let the user answer first; for those cards 'is-episode' means \"this file CONTAINS that episode\", which the user must see. After deciding without asking, report what you did and why in one line.",
      schema: {
        // 批量那一格。单条的四个字段留在顶层且都 optional——两种写法同时合法，服务端把单条
        // 当成 1 元素批处理，不存在"只修好了一边"的第二条路径。
        decisions: z
          .array(
            z.object({
              verdict: z.enum(['is-episode', 'not-episode', 'prefer']).nullable(),
              leftKey: z.string().optional(),
              path: z.string().optional(),
              keptPath: z.string().optional(),
              loserPath: z.string().optional(),
            }),
          )
          .optional(),
        verdict: z.enum(['is-episode', 'not-episode', 'prefer']).nullable().optional(),
        leftKey: z.string().optional(),
        path: z.string().optional(),
        keptPath: z.string().optional(),
        loserPath: z.string().optional(),
      },
      run: (a) => nd.reconcileDecide(a as Parameters<typeof nd.reconcileDecide>[0]),
    })
    entries.push({
      name: 'reconcile_execute',
      description:
        'Execute a show\'s reconcile plan: move claimed files onto the shelf, apply recorded decisions, delete byte-identical duplicates. THIS ONE REALLY MOVES AND DELETES FILES on the user\'s netdisk — everything before it was a preview. Returns {moved, deleted, renamed, removedDirs, runId, pending, errors}. Run reconcile_status first and settle the pending cards (reconcile_decide) — anything still pending is skipped, not forced. Decision rows follow moved files automatically (path migration), so a decided card never re-pends after the move. ' +
        "`show` takes the same values as reconcile_status, INCLUDING a binding setId (or `binding:<setId>`) — that is how a TV/movie binding is archived. For a TV binding the plan does more than move: it renames files with an `SxxExx - ` prefix and shelves 纯享 cuts as a separate playlist, so `renamed`/`removedDirs` are usually non-zero there. " +
        "BEFORE CALLING, read the reconcile_status preview and go through its `plannedDeletes[]` — every entry pairs the file that disappears (`path`) with the copy that stays (`keptPath`), so check they really are the same episode: `durationS` and `keptDurationS` must be EXACTLY equal, and `keptSizeBytes` must not be smaller than `sizeBytes`. A `delete-redundant` entry has no `keptPath` on purpose (what stays is the source site's own copy, not a file). If `plannedDeletesTruncated` is true you are not holding the whole list — page through the rest with `deletesOffset`, or say so; do not claim you checked it. A delete is the one action nothing here can walk back cleanly. " +
        "`expectFingerprint` is the `planFingerprint` from the reconcile_status reply you actually checked. Pass it: the plan is recomputed at execute time, so anything that touched this binding in between (a netdisk_follow round transferring new files, a manual upload) silently makes this a DIFFERENT plan from the one you approved. With it, a changed plan is refused and nothing runs. reconcile_decide ALSO changes the plan (decided cards become moves/deletes), so after deciding call reconcile_status again and pass the NEW fingerprint. " +
        'AFTER an execute that renamed anything, call reconcile_status AGAIN before you trust or report the tree: renames change the very filenames the planner reads as evidence, so a plan computed before the rename describes a folder that no longer exists. Keep `runId` — reconcile_undo_run takes it back (moves and renames only; deletes stay deleted).',
      schema: { show: z.string(), expectFingerprint: z.string().optional() },
      run: ({ show, expectFingerprint }) =>
        nd.reconcileExecute(show as string, { expectFingerprint: expectFingerprint as string | undefined }),
    })
    entries.push({
      name: 'reconcile_undo_run',
      description:
        "Undo ONE WHOLE reconcile run: replay that run's provenance rows backwards — files move back to where they came from, `SxxExx - ` renames revert, directories the run emptied and removed are recreated. `runId` comes from reconcile_execute's reply, or from netdisk_follow view's `lastRuns[].archived.runId` (a follow round archives too, and that is the runId to undo when a round filed episodes wrongly). " +
        'DELETES ARE NOT UNDONE HERE and never will be — they come back as `skipped`, not `undone`, so a reply of {undone:0, skipped:7} means the run was all deletions and nothing was restored. Say that plainly instead of reporting a successful undo; on quark the deleted copies sit in the netdisk trash for about ten days and the user can restore them there. ' +
        "Returns {undone, skipped, bindingId?, resync, resyncError?}. `resync` is one of THREE values, not a yes/no: 'done' = the binding was re-matched afterwards so the episode list points at the restored paths again (needed, because undo moves files just as execute did); 'skipped' = there was nothing to re-match (the run was not a TV binding); 'failed' = it was needed and did not happen, so the episode list still points at the paths the undo just abandoned and playback will 404 — report that and call netdisk_sync, `resyncError` says why. Safe to call once; calling it twice on the same runId is not a second undo, the rows are already spent. This is the whole-run twin of the per-file undo in the panel — use it when the run as a whole should not have happened.",
      schema: { runId: z.string() },
      run: ({ runId }) => nd.reconcileUndoRun(runId as string),
    })
    if (nd.adjudicate) {
      const adjudicate = nd.adjudicate
      entries.push({
        name: 'reconcile_adjudicate',
        description:
          "Ask a model to rule on the pending cards reconcile_status leaves behind for this `show` — the ones a rule cannot settle but a glance at the evidence can (evidence-conflict / duration-collision / no-duration; `season-unresolved`/`replace`/`suspect-dir` cards are NOT sent, those stay for a human). Its answers pass through a CODE GATE before anything is written — high confidence only, the candidate must be one this card actually offered, the episode number embedded in the filename must match, and duration must line up within tolerance — so a wrong guess gets rejected, not applied. THE MODEL NEVER DELETES: it can only mark a file 'is this episode' or 'not this episode'; any card whose answer would be a duplicate/replace decision is left for a human. Returns {runId, skipped?, asked, applied, rejected, unsure, failed?}. `skipped:'same cards'` means the exact same batch was already asked within the last 7 days and nothing was re-sent — that is normal throttling, not a bug — pass `force:true` when the user explicitly wants this batch re-asked now (the model's answers still go through the same gate); `skipped:'no cards'` means there was nothing to ask. `failed` means the whole batch was thrown out (no LLM configured, or its reply was not parseable JSON) — nothing was written either way. If `applied` > 0 for a TV binding, the archive step ran again automatically, so call reconcile_status again before trusting the tree. `losers` (default false) is the delete-confirmation-gate flag passed to that re-archive, same meaning as elsewhere. " +
          'reconcile_revoke_adjudication takes back everything one runId wrote, in one call.',
        schema: { show: z.string(), losers: z.boolean().optional(), force: z.boolean().optional() },
        run: ({ show, losers, force }) => adjudicate(show as string, { losers: losers as boolean | undefined, force: force as boolean | undefined }),
      })
    }
    if (nd.revokeAdjudication) {
      const revoke = nd.revokeAdjudication
      entries.push({
        name: 'reconcile_revoke_adjudication',
        description:
          "Undo everything ONE reconcile_adjudicate call decided — every is-episode/not-episode row it wrote, in one shot (they all carry the same `runId` as a marker). It does NOT undo a transfer: if the run also pulled a follow candidate onto the user's own netdisk, that file stays put — this only erases the model's verdict about which episode it is, so the next sync goes back to treating it as unmatched/pending. `runId` comes from the reconcile_adjudicate reply. Returns {ok, revoked} — `revoked` is how many decision rows were deleted; 0 is not an error, it means that run applied nothing (everything it proposed was rejected by the gate or came back unsure).",
        schema: { runId: z.string() },
        run: ({ runId }) => revoke(runId as string),
      })
    }
    entries.push({
      name: 'netdisk_sync',
      description:
        "Re-run recognition on one binding: rescan its netdisk folder and re-match the files against the episode list, then report what is matched and what is still missing, PER SEASON. Call it after the files on disk changed — a manual upload, a netdisk_follow run that transferred episodes, a reconcile_execute that renamed or moved them — because every other view reports the LAST sync, not the disk as it is now. `setId` comes from netdisk_bindings. " +
        'IT MOVES NOTHING. It only re-computes the pairing, so it is safe to call whenever you are unsure the picture is current. Returns {setId, title, bySeason:[{season, matched, total, unaired, missing:[{leftKey,title,airDate}], missingTruncated}], orphanFiles, orphanSample} — `total` counts only episodes that have AIRED (matched ones included); `unaired` is how many are still unaired or undated placeholders, and they are neither in `total` nor in `missing`, so "matched 97 / total 97, unaired 4" means nothing is missing — never report unaired episodes as gaps. `missing` is capped per season and `missingTruncated` tells you when there are more, so never read a capped list as the complete set of gaps. `orphanFiles` counts files on disk that no episode claimed (a sample of names is included): a big number there usually means the naming defeats the match rule, which is what netdisk_residue + netdisk_preview_spec/netdisk_apply_spec are for. ' +
        'NOT the same as netdisk_residue (that is the rule-authoring view: unmatched left, orphan right, human corrections) and not the same as reconcile_status (that is a PLAN of file moves awaiting execution). This one answers only "given what is on the disk right now, which episodes do I have".',
      schema: { setId: z.string() },
      run: ({ setId }) => nd.sync(setId as string),
    })
    if (nd.shareVerify) {
      const verify = nd.shareVerify
      entries.push({
        name: 'netdisk_share_verify',
        description:
          "Check whether a QUARK SHARE LINK (someone else's 夸克网盘 分享) is still alive and list what is inside it — READ-ONLY, nothing is transferred, nothing is written to the user's disk. QUARK ONLY: any other netdisk comes back as `validity:'unsupported'` with a reason, which is NOT a dead link — tell the user we cannot check that one and they can open it themselves. A link that is not a netdisk share at all comes back `unsupported` too: video_search releases marked `needsResolve:true` are landing pages, so run video_resolve on those first and verify the real link it returns. Pass `link` (the full share URL, parsed for you) or `netdisk` + `pwdId`; add `passcode` when the share is locked (without it a locked share can only be reported as 'needs-login'). " +
          "USE IT on the links video_search hands back, BEFORE you propose transferring one: `validity` is 'alive' (usable), 'not-usable' (deleted or taken down — for anything but a currently-airing show this is the NORMAL outcome, not an error, and it is not worth retrying), 'needs-login' (the account cannot open it: a passcode or the user's login is missing), 'unknown' (the check itself did not get an answer — do NOT report that as dead), or 'unsupported' (we cannot check this one at all — a non-quark netdisk, or not a share link; never report that as dead either). " +
          'Returns {netdisk, pwdId, validity, reason?, total, files:[{path,size}], truncated, seasonsSeen?}. `files` is capped at 200 and `truncated` says when there are more, so never conclude an episode is absent from a truncated listing. `seasonsSeen` is the season wording found in the file paths, verbatim and un-normalised — that is how you catch the common trap of a link that really holds 第二季 while the user is missing 第三季. ' +
          "NOT netdisk_browse: that lists the user's OWN disk. This one looks inside a stranger's share that the user does not have yet. Transferring what you find is netdisk_follow's `run`, which is a write.",
        schema: {
          link: z.string().optional(),
          netdisk: z.string().optional(),
          pwdId: z.string().optional(),
          passcode: z.string().optional(),
        },
        run: ({ link, netdisk, pwdId, passcode }) =>
          verify({
            link: link as string | undefined,
            netdisk: netdisk as string | undefined,
            pwdId: pwdId as string | undefined,
            passcode: passcode as string | undefined,
          }),
      })
    }
    if (nd.follow) {
      const follow = nd.follow
      entries.push({
        name: 'netdisk_follow',
        description:
          "追更 for one TV binding: the standing loop that watches for episodes the user is missing, finds shares for them, transfers them in and files them away. `setId` comes from netdisk_bindings (TV bindings only — a podcast or movie binding has no follow). `action` is one of: " +
          "`view` (read-only) → {follow:{enabled,dryRuns,lastCheckAt,nextCheckAt}, missingAired[] (leftKeys of episodes that HAVE AIRED and are still missing — this is the number that matters), upcoming (aired-in-the-future, nothing to fetch yet), shares[] (the links this binding already knows, with their validity), lastRuns[] (the last 5 rounds, newest first: {id, at, trigger, missingAired, saved (files transferred), synced:{matchedBefore,matchedAfter}, archived?:{runId,moved,deleted,renamed,gated?}, errors} — and `lastRuns[0]` additionally carries `errorList[]`, the per-error text, which is the only thing that explains a round that achieved nothing)}. `enable`/`disable` flip the standing loop and return the same view. A binding that cannot follow at all (not a TMDb TV binding) answers {error} instead of a view. " +
          "`run` STARTS THE ROUND, RIGHT NOW, AND THE ROUND WRITES: it revisits known shares, searches for new ones, TRANSFERS the chosen files into the user's own netdisk, re-matches them, and then archives with `losers:true` — which DELETES the losing duplicate copies into the netdisk trash. Tell the user what it will do and get their agreement BEFORE calling it with `run`; do not call it to 'have a look' — `view` is the look. " +
          'IT RETURNS IMMEDIATELY and the round keeps going in the background: the reply is {started:true, setId, note} — it says a round BEGAN, nothing about how it went. A round takes roughly 1–3 minutes (transfers, several sync passes, filing). DO NOT poll and do not send a second `run`: come back after about two minutes and call `view` ONCE, then read `lastRuns[0]` for the outcome. If a round for that binding is already in flight the reply is {started:false, alreadyRunning:true} and nothing new was launched — that is not an error, just wait and view. Read the finished row honestly: `saved` > 0 with `matchedAfter` unchanged means the files arrived but are not recognised as episodes yet (the netdisk is still copying, or the names carry no episode number) — that is not a failure and not a success, say so. `archived.gated` means a health gate blocked the filing step on purpose. Keep `archived.runId`: reconcile_undo_run takes that filing back. ' +
          'To check ONE share by hand instead, use netdisk_share_verify; to see what is on the disk after a round, netdisk_sync.',
        schema: { setId: z.string(), action: z.enum(['view', 'enable', 'disable', 'run']) },
        run: ({ setId, action }) => follow(setId as string, action as 'view' | 'enable' | 'disable' | 'run'),
      })
    }
  }

  if (extras.harvestCapability) {
    const cap = extras.harvestCapability
    entries.push({
      name: 'harvest_capability',
      description:
        "Whether harvesting can run on this machine at all — the FIRST thing to check when a cdp_*/harvest call says the extension is not connected, or when nothing is being collected from a logged-in source. Stream ships no browser of its own: it drives the user's OWN Chrome through the Stream extension, so this is the precondition for every browser-backed tool. Returns {state, connected, since, everSeen, lastSeenAt?, extVersion?, browser?, platform?, chrome:{selected, origin, candidates[], mustChoose}}. `state` is the whole verdict: 'ready' = harvest now; 'disconnected' = installed before but the extension is not connected (normal for a reclaimed MV3 service worker — tell the user to open Chrome / reload the unpacked extension, do NOT treat it as a source failure); 'never-seen' = Chrome + extension were never seen, so guide the install. The `chrome` block answers WHICH SIDE to install on: `candidates[]` are the chrome.exe paths found (windows entries first), `mustChoose:true` means nothing is selected yet and more than one candidate exists — picking wrong fails silently (harvest runs as a guest and collects nothing), so ask the user instead of guessing. Read-only; enumerates the filesystem for candidates, so call it when diagnosing, not in a loop.",
      schema: {},
      run: () => cap(),
    })
  }

  // 「缺一把 key」这条线的读那一半。写那一半是 provision_capability_key（下面）——两个描述
  // 里互相点名，否则模型挑不出该用哪个（AGENTS.md「同族工具的边界不写进描述，就等于没有」）。
  if (extras.capabilityStatus) {
    const capabilityStatus = extras.capabilityStatus
    entries.push({
      name: 'capability_status',
      description:
        "Why a Stream capability cannot run right now, and WHO can fix it. Call it the moment a request fails with 'branch_unavailable', '未配置', 'no transcription source' or similar — that error says WHAT is missing, this says whether YOU can fix it for the user or he has to. Read-only, no side effects. "
        + 'Returns {capabilities:[{id,label,state,available,why,keys[],keys_mode:"any",blockers[]}]} — today: transcribe (audio/video → text), ocr (images/PDF → text), article (a link → article text). '
        + '`state` is the whole verdict and each value has a DIFFERENT next move: '
        + "'ready' = it works, just go do the thing. "
        + "'needs-key-self-serve' = an API key is missing AND a recipe can go get one for the user — offer him the CHOICE: (a) you run provision_capability_key for him, which opens the vendor's page in HIS OWN Chrome and creates a key on HIS account, or (b) he goes to `help_url` himself and pastes the key into 设置 - 源配置. Never just do (a) silently. "
        + "'needs-key-manual' = an API key is missing and NOTHING can fetch it automatically — do not offer to do it, hand him `help_url` and say where to paste it. "
        + "'blocked-other' = NOT a key problem at all (a missing external program like ffmpeg, an empty Provider ladder, or a key that IS configured but the backend has not restarted since). Offering to apply for a key here is sending him down a dead end — read `blockers` and say the real reason. "
        + '`blockers` always carries EVERY obstacle, not just the headline one — a capability can need both a key and ffmpeg, and `state` only names the first move. Each blocker has `kind`: config (a missing key; `can_provision` says whether we can go get it, `ref` is what provision_capability_key takes), tool (a program the machine lacks), no-members (the ladder is empty), restart (the key is in, the backend needs a restart — do NOT apply for another key). '
        + '`keys` lists every config slot this capability knows, including the ones already configured; any ONE of them being configured is enough (they are a cost ladder, not an AND). '
        + 'NOT harvest_capability — that one answers whether the browser/extension side of harvesting is connected, a completely different precondition.',
      schema: {},
      run: () => capabilityStatus(),
    })
  }

  // 写那一半：**必须显式二次确认**，形状与 run_action_recipe / cdp_act 的高危动作同源。
  // 不带 confirmed 时一步都不执行——`provisionConfigSlot`（真去跑）只在下面那个分支里被调到。
  if (extras.provisionConfigSlot && extras.configProvisionerFor) {
    const provision = extras.provisionConfigSlot
    const provisionerFor = extras.configProvisionerFor
    entries.push({
      name: 'provision_capability_key',
      description:
        "Get an API key FOR the user, by driving his own browser: it opens the vendor's console in HIS Chrome, signs in as HIM (his existing session), creates a new key on HIS account, and writes the one-time plaintext straight into Stream's local config. `ref` is the slot id — take it from a capability_status blocker of kind 'config' with can_provision:true; never guess one. "
        + 'TWO-STEP CONFIRMATION, always: call WITHOUT `confirmed` first — NOTHING runs, and it returns {status:"needs-confirmation", ref, field, label, entryUrl, sourceId, params, effects[]} describing exactly what would happen. SHOW `effects` to the user verbatim-in-substance before asking: this is an ACCOUNT-LEVEL side effect on his real account, the plaintext is shown once and stored locally, and creating a key is NOT idempotent — running it twice leaves two look-alike keys sitting in his account forever. Only after he agrees, call again with the SAME `ref` and `params` PLUS `confirmed:true`. '
        + 'It runs in the user\'s visible browser and can take a minute (a captcha may have to solve itself). Statuses when confirmed: {status:"done", ref, field, label} — the slot is filled, and this is CHECKED, not assumed: the tool re-reads the config after the run and only says done when that field really reports configured. {status:"ran-but-empty"} — the recipe ran without throwing but the key never landed (login wall, captcha not passed, or the site changed its page): `error` says so and points at the failure screenshot under the data dir\'s failures/ — report that, do NOT tell the user the key was created. {status:"failed"} — it threw; `error` is the raw reason. {status:"no-provisioner"} — nothing can provision that ref; the user has to get the key himself. '
        + 'NEVER tell the user a key was applied for unless you actually called this with confirmed:true and got status:"done" back. Also note the capability may still report unavailable right after a successful run — some ladders are fixed at backend startup; re-check with capability_status and, if it now shows a `restart` blocker, say a restart is needed instead of applying again.',
      schema: {
        ref: z.string().describe('the config slot id, from a capability_status blocker (kind:"config", can_provision:true)'),
        params: z.record(z.string(), z.unknown()).optional().describe('recipe params; a key `name` is generated for you when omitted'),
        confirmed: z.boolean().optional(),
      },
      run: async ({ ref, params, confirmed }) => {
        const slotRef = ref as string
        const p = provisionerFor(slotRef)
        if (!p) return { status: 'no-provisioner', ref: slotRef, note: `没有任何 recipe 声明它产出 ${slotRef} 这一格配置——只能让用户自己去拿一把填进设置。` }
        // key 名带随机后缀：建 key 不幂等，同名会在用户账号里堆成一排看不出区别的条目
        // （recipe 自己的 params_schema 也是这么写的）。
        const effective = (params as Record<string, unknown> | undefined) ?? { name: `stream-auto-${Math.random().toString(16).slice(2, 8)}` }
        if (confirmed !== true) {
          return {
            status: 'needs-confirmation',
            ref: slotRef,
            field: p.field,
            label: p.label,
            sourceId: p.sourceId,
            entryUrl: p.entryUrl,
            paramsSchema: p.paramsSchema,
            params: effective,
            effects: [
              `会在用户自己的 Chrome 里打开 ${p.entryUrl}，用他已经登录的 ${p.label} 账号操作——不是我们的账号。`,
              `会在他的账号里**新建**一把 API key（名字 ${String(effective.name ?? '')}）。建 key 不幂等：再跑一次就再多一把，只能他自己去后台删。`,
              `只显示一次的明文会被直接写进本机的 ${p.label} 配置（${p.field}），不回显给任何人。`,
              '整个过程要他的浏览器在前台待一会儿（可能有人机验证），期间别关那个标签页。',
            ],
            next_step: `把上面这几条讲给用户听，问他要「我来帮你申请」还是「我自己去 ${p.entryUrl} 拿」。他同意之后，用同一个 ref 和 params 再调一次并带上 confirmed:true。他要自己弄就别再调这个工具。`,
          }
        }
        return await provision(slotRef, effective)
      },
    })
  }

  if (extras.cdpLook) {
    // Presence is all-or-nothing (buildMcpExtras sets all four together), so once cdpLook is
    // gated in above, the other three are guaranteed to be there too.
    const cdpLook = extras.cdpLook
    const cdpShot = extras.cdpShot!
    const cdpAct = extras.cdpAct!
    const cdpPages = extras.cdpPages!
    entries.push({
      name: 'cdp_look',
      description: cdpToolSpec('cdp_look').description,
      schema: cdpSchema('cdp_look'),
      run: ({ target, js, url, interactive, inventory, frame }) =>
        cdpLook({
          target: target as string,
          js: js as string | undefined,
          url: url as string | undefined,
          interactive: interactive as boolean | undefined,
          inventory: inventory as boolean | undefined,
          frame: frame as string | undefined,
        }),
    })
    entries.push({
      name: 'cdp_shot',
      description: cdpToolSpec('cdp_shot').description,
      schema: cdpSchema('cdp_shot'),
      run: ({ target }) => cdpShot({ target: target as string }),
    })
    entries.push({
      name: 'cdp_act',
      description: cdpToolSpec('cdp_act').description,
      schema: cdpSchema('cdp_act'),
      run: ({ target, kind, domain, ref, frame, selector, text, targetUrl, exe, args, x, y, px, paths, expression, expect, intent, confirmed, ownWindow }) =>
        cdpAct({
          target: target as string,
          kind: kind as ActionKind,
          domain: domain as string,
          ref: ref as number | undefined,
          frame: frame as string | undefined,
          selector: selector as string | undefined,
          text: text as string | undefined,
          targetUrl: targetUrl as string | undefined,
          exe: exe as string | undefined,
          args: args as string[] | undefined,
          x: x as number | undefined,
          y: y as number | undefined,
          px: px as number | undefined,
          paths: paths as string[] | undefined,
          expression: expression as string | undefined,
          expect: expect as string | undefined,
          intent: intent as ActionIntent | undefined,
          confirmed: confirmed as boolean | undefined,
          ownWindow: ownWindow as boolean | undefined,
        }),
    })
    entries.push({
      name: 'cdp_pages',
      description: cdpToolSpec('cdp_pages').description,
      schema: cdpSchema('cdp_pages'),
      run: ({ target, close }) => cdpPages({ target: target as string, close: close as number | undefined }),
    })
  }

  if (extras.explorations) {
    const ex = extras.explorations
    // run 不活时**回一句话，不抛**：抛出去模型只看到一句 tool error，读不出「这条 run 已经走完了」
    // 和「后端坏了」的差别，于是它会原样重试到烧完预算。
    const withSession = async <T>(
      runId: unknown,
      fn: (s: ExploreLive) => T | Promise<T>,
    ): Promise<T | { error: string }> => {
      const s = ex()?.get(String(runId))
      // **别指 `get_agent_run`**：那读的是搜索 agent 自己那本 run 库，探索 run 住 `interventions.db`，
      // 指错了库的下场是模型拿到一句「没这条 run」，然后把「已结束」读成「后端坏了」接着重试。
      if (!s) return { error: `这条探索 run ${String(runId)} 已结束 / 已暂停 / 不存在——不要重试；要看它的状态经 Stream 的 \`GET /api/interventions/${String(runId)}\`` }
      return fn(s)
    }
    entries.push({
      name: 'graph_frontier',
      description: '探索建图：当前状态下还能点什么（带编号）。exhausted=true 表示整张图都探够了。',
      schema: { runId: z.string() },
      run: ({ runId }) => withSession(runId, (s) => s.frontier()),
    })
    entries.push({
      name: 'graph_act',
      description: '探索建图：让 Stream 点 frontier 里的一个编号，回 {from,to,effect}。to 为 unknown 时先 graph_record_state 起名。',
      schema: { runId: z.string(), ref: z.number().int(), note: z.string().optional() },
      run: ({ runId, ref, note }) => withSession(runId, (s) => s.act(ref as number, note as string | undefined)),
    })
    entries.push({
      name: 'graph_record_state',
      description: '探索建图：给当前没见过的屏起名。id 必须 <facility>/<名>，features 只能 url / dom，要能只匹配这一屏。',
      schema: {
        runId: z.string(),
        id: z.string(),
        features: z.array(z.record(z.string(), z.unknown())),
        group: z.string().optional(),
        note: z.string().optional(),
      },
      run: ({ runId, id, features, group, note }) =>
        withSession(runId, (s) =>
          s.recordState({
            id: id as string,
            features: features as unknown[],
            ...(group === undefined ? {} : { group: group as string }),
            ...(note === undefined ? {} : { note: note as string }),
          }),
        ),
    })
    entries.push({
      name: 'graph_back',
      description: '探索建图：退到上一个状态。',
      schema: { runId: z.string() },
      run: ({ runId }) => withSession(runId, (s) => s.back()),
    })
    entries.push({
      name: 'graph_mark_irrelevant',
      description: '探索建图：这个状态与目标无关，不再展开。',
      schema: { runId: z.string(), state: z.string() },
      run: ({ runId, state }) => withSession(runId, (s) => s.markIrrelevant(state as string)),
    })
  }

  if (extras.searchAgent) {
    const sa = extras.searchAgent
    entries.push({
      name: 'search_agent',
      description:
        '启动一个目标导向的信息搜索 Agent 运行：给一个具体获取目标（如"怡楽播客"），它在网盘元搜索上多轮扩源、' +
        '判切题、夸克优先，返回具体网盘获取目标。异步——返回 {runId, status}，用 get_agent_run(runId) 轮询进度与结果。',
      schema: { goal: z.string().describe('a concrete acquisition goal, e.g. a specific audio/resource name') },
      run: ({ goal }) => sa.start(goal as string),
    })
    if (sa.enumerate) {
      const enumerate = sa.enumerate
      entries.push({
        name: 'enumerate_candidates',
        description:
          '按约束枚举一份**商品候选清单**：给品类 + 价格区间 + 硬性条件，它去找这类东西的聚集地（排行榜/导购/比价页），' +
          '从聚集地抽出「型号 ↔ 价格」，再逐个用比价数据核实"这个型号真在售、价格真在区间内"，返回一份带出处的清单。' +
          '异步——返回 {runId, status}，用 get_agent_run(runId) 轮询。' +
          '\n\n**用户要选型/做购买决策时，直接调 purchase_decide**——它自己会按品类挑枚举来源，这条不用你手动先跑。' +
          '这个工具留给**没有产品库、又要自己摸候选集**的场合。先有清单，才谈得上排除谁：' +
          '在一个碰巧读到的子集上算支配，结论不是"不完整"而是**误导**——真正划算的那台若不在候选集里，' +
          '"已排除 X"照样会自信地印出去。**没有出处的候选集不许进支配运算**：' +
          '回执里的 coverage 说明这一趟摸了多大一片、stopped 说明它是收敛了还是被轮次截断，两者含义相反，' +
          '转述给用户时要照说，不要把一份被截断的清单说成"市面上的选择"。' +
          '\n\n和 search_agent 的分工：那条吃一句自由描述、去找**某个具体东西**的获取渠道（网盘链）；' +
          '这条吃结构化约束、回答**"符合条件的有哪些"**。别拿 search_agent 去枚举商品。',
        schema: {
          category: z
            .array(z.string())
            .describe('品类词，从粗到细，如 ["手机"] 或 ["手机","拍照"]。这是找聚集地的种子，也是判切题的依据'),
          priceMin: z.number().optional().describe('价格下限（元），可省'),
          priceMax: z.number().optional().describe('价格上限（元），可省。用户说"5000 以内"就是 5000'),
          constraints: z
            .array(z.string())
            .optional()
            .describe('其它硬性条件，如 ["长焦","支持无线充电"]。只写用户明确要求的，别替他加'),
        },
        run: ({ category, priceMin, priceMax, constraints }) =>
          enumerate({
            category: category as string[],
            priceMin: priceMin as number | undefined,
            priceMax: priceMax as number | undefined,
            constraints: constraints as string[] | undefined,
          }),
      })
    }
    entries.push({
      name: 'get_agent_run',
      description:
        '读取一次 search_agent / enumerate_candidates / purchase_decide / run_action_recipe 运行。只读、不触发新运行。status 为 running 时隔 20–30 秒再调一次（action 档 10–15 秒）。' +
        '\n\n**action 档**（run_action_recipe 回 running 时给的 runId）返回 {domain:"action", status, sourceId, elapsedSec, result?, error?, note}：run 的 `status` 只说跑没跑完；' +
        '跑完后 `result` 就是 run_action_recipe 本来会回的那份（`result.status` 才是动作的成败：done / blocked / needs-login / …），照 run_action_recipe 描述里的方式读它。' +
        '`status:"error"` = 执行中途炸了或后端重启，**动作可能已经做了一部分**——先核目标应用的实际状态，别直接重跑。' +
        '\n\n**purchase 档**（purchase_decide 起的）返回 {domain:"purchase", status, stage, stages[], receipt?, error?}：`stage` 是当前走到哪一步的人话，' +
        '`receipt` 只在 status=done 时出现，就是那份决策回执（frontier / dominated / products / coverage / residual / legend / note）——按 purchase_decide 描述里说的方式读它。' +
        '\n\n**发现档**（search_agent / enumerate_candidates 起的）返回 {domain, status, stopped, coverage, trajectory[], targets[], onboardable[]}。' +
        '\n\n`domain` 说明这条 run 是哪一档，**targets 的形状随它变**：netdisk 档是网盘获取目标（link/netdisk/files）；' +
        'catalog 档是商品候选（model/price/hubUrls，hubUrls 就是这条候选的出处）。' +
        '\n`stopped` 是覆盖范围的关键，五个值含义不同：converged=候选集不再增长（摸到头了）；truncated=跑满轮次被掐断' +
        '（**清单不全，别当成全集转述**）；early=够数早停；dry=没有新搜索词了；' +
        'interrupted=中途某一轮挂了、按已攒下的收尾（**清单是残的，转述时必须说明**，可以再跑一次补齐）。' +
        '\n`coverage` = {rounds, hubsFetched, hubsSkipped, extracted, kept}。**hubsSkipped > 0 就是"还有窝没开"**；' +
        'kept 才是产出，extracted 只是抽出量（抽 200 条留 0 条的窝一样是空手）。' +
        '\n`trajectory` 是逐步轨迹（seed/search/classify/fetch/verify/score/expand/rank/result），用于复盘它卡在哪一步。',
      schema: { runId: z.string() },
      run: ({ runId }) => {
        const rec = sa.get(runId as string) as
          | { domain?: string; status?: string; error?: string; result?: unknown; trajectory?: Array<{ kind?: string; note?: string; at?: string }> }
          | null
        if (!rec) return { status: 'none' }
        // 动作档的投影（run_action_recipe 的异步壳，`action-run.ts`）：两层状态分开——run 的
        // status 是"跑没跑完"，`result.status` 才是"做没做成"。不带发现类那套格子，理由同购买档。
        if (rec.domain === ACTION_RUN_DOMAIN) {
          const r = rec as typeof rec & { goal?: string; updatedAt?: string; status: import('../agent/search/types.ts').RunStatus }
          return projectActionRun(runId as string, { goal: r.goal ?? '', status: r.status, updatedAt: r.updatedAt ?? '', result: r.result, error: r.error })
        }
        // 购买档的投影：阶段进度（人话）+ 最终回执。不带发现类的 targets/hubs/coverage 那套——
        // 那些格子在这一档恒空，摆出来只会让模型去猜"空是不是坏了"。
        if (rec.domain === 'purchase') {
          const stages = (rec.trajectory ?? []).filter((s) => s.kind === 'stage').map((s) => ({ note: s.note, at: s.at }))
          // 墙钟由工具报，不让模型自己算：Sonnet 试跑把后台 sleep 的名义秒数累加成"等了 22 分钟"，
          // 而 run 实际 2 分 18 秒就 done 了，据此报了一条不存在的"status 滞后"缺陷。
          const startedAt = stages[0]?.at
          const elapsedSec = startedAt ? Math.round((Date.now() - Date.parse(startedAt)) / 1000) : undefined
          const live = rec.status === 'running' || rec.status === 'queued'
          return {
            runId,
            domain: 'purchase',
            status: rec.status,
            stage: stages.at(-1)?.note,
            stages,
            ...(startedAt ? { startedAt, elapsedSec } : {}),
            ...(rec.error ? { error: rec.error } : {}),
            ...(rec.status === 'done' ? { receipt: rec.result } : {}),
            ...(live
              ? {
                  note:
                    elapsedSec !== undefined && elapsedSec > 300
                      ? `已经跑了 ${elapsedSec} 秒，远超常态（2–3 分钟），多半是卡住了：把当前 stage 报给用户、说这次没跑完，别再等也别再起一个。`
                      : `还在跑（已 ${elapsedSec ?? 0} 秒；一次完整的跑通常 2–3 分钟）。隔 20–30 秒再调一次，别连着轮询。elapsedSec 是工具报的墙钟，以它为准。`,
                }
              : {}),
          }
        }
        return rec
      },
    })
  }

  // intent_dossier is NOT in this catalog — it returns markdown that must reach the MCP client
  // as raw text, but every entry here goes through server.ts's `json(await entry.run(args))`,
  // which JSON.stringify's the result (quoting it, escaping newlines). That's the exact
  // "differs in more than the result wrapping → bespoke" case from the file header (the
  // stream_subscribe precedent): it's hand-registered in server.ts instead, alongside
  // intent_create/intent_list which stay here because a plain JSON envelope is correct for them.
  if (extras.intents) {
    const intents = extras.intents
    entries.push({
      name: 'intent_create',
      description:
        '立一个长期跟踪意图（不是一次性搜索）：给一句目标（如"追踪某播客的新一季"），LLM 生成判定标准（criteria——' +
        '什么算相关、什么明确排除）并持久化。之后的新内容会拿这份标准逐条判是否入选（消化在后台跑，不在这个工具里）。' +
        'LLM 未配置时抛错（意图不立）。返回新意图记录 {id, goal, criteria, streamIds, cadenceHours, status, createdAt}。',
      schema: { goal: z.string().describe('这个意图要跟踪什么，一句话说清') },
      run: ({ goal }) => intents.create({ goal: goal as string }),
    })
    entries.push({
      name: 'intent_list',
      description:
        '列出所有跟踪中的意图（含已退休的），每条附 ledgerCount（已消化过的 item 数，粗略反映活跃度）。',
      schema: {},
      run: () => intents.list(),
    })
  }

  // 动作型 recipe 的唯一调用入口。**必须显式二次确认**——第一次不带 confirmed 只回执"会做
  // 什么"，什么都不执行；同仓库 cdp_act 对高危动作是同一个形状。只跑 meta.action:true 的
  // recipe（见 action-recipe.ts 头注），别的一律拒并说清是哪一类拒（找不到/不是动作/没有
  // Stream Desktop）。
  if (extras.runActionRecipe) {
    const runActionRecipe = extras.runActionRecipe
    entries.push({
      name: 'run_action_recipe',
      description:
        'Run an ACTION recipe — a recipe that does not harvest content, it just DOES one thing with a side effect (e.g. `qq-send` sends a chat message). Most recipes in this system are harvest recipes (they feed the inbox); this tool is ONLY for the small opt-in set explicitly marked as actions — it refuses anything else. ' +
        'TWO-STEP CONFIRMATION, always: call WITHOUT `confirmed` first — it validates `params` and returns {status:"needs-confirmation", sourceId, params, description, targetApp?, screenTakeover?, targetSite?} describing EXACTLY what would happen, without doing anything. Exactly one physical-side-effect field comes back, depending on the recipe: a DESKTOP action returns `targetApp` (which window it acts on) + `screenTakeover` (it steals the foreground window and may fall back to real keyboard input); a BROWSER action returns `targetSite` (it opens a tab in the user\'s OWN Chrome and acts with their real logged-in session — it does not steal the screen, but the account-level side effect is real, e.g. logging into a brokerage kicks other sessions). SHOW whichever came back to the user alongside description/params, not just description: it is the whole point of the confirmation, and none of it is obvious from the recipe id alone. Only after the user agrees, call again with the SAME sourceId+params PLUS `confirmed:true` to actually execute — a side-effecting action (a real message sent, a real login performed, unrecoverable) must never run on your own say-so. ' +
        'ASYNC-CAPABLE: the confirmed call waits up to ~25s for the action to finish. Usually it finishes within that and you get the final status directly (plus `runId`). If it does not, you get {status:"running", runId} — the action is STILL EXECUTING on the machine: poll get_agent_run(runId) every 10–15s until its status is done, then read `result.status` (done/blocked/…) as the outcome. NEVER call run_action_recipe again to "retry" a running one: the same sourceId+params while in flight is folded onto the same run, and once it has finished a new call really performs the action a SECOND time (a second message sent). ' +
        'Other statuses: {status:"not-found"} — no recipe with that sourceId. {status:"not-action"} — that recipe exists but is not opted into actions (it is a harvest source; use stream_read / content_search instead). {status:"invalid-params"} — params failed the recipe\'s own schema, `reason` says which field. {status:"no-desktop"} — the recipe needs Stream Desktop (the local process that drives the OS) and it is not connected right now; start it on the target machine and retry. {status:"no-browser"} — a browser action, but the user\'s Chrome/extension is not connected (or this backend has no harvest surface); NOTHING ran, so this is never a statement about the site — ask the user to open Chrome with the Stream extension connected and retry. {status:"needs-login"} — the target app/site needs the user to log back in; for a LOGIN recipe this means the login itself did not take (wrong credentials, captcha misread), so report it as such rather than telling the user to go log in. {status:"blocked"} — it ran but could not confirm the action actually landed (`reason` has detail). {status:"done"} — executed; `items` carries whatever the recipe read back as delivery confirmation. ' +
        'Find a sourceId via stream_search / stream_sources (it is a normal source id, e.g. "qq-send") — this tool does not enumerate action recipes itself.',
      schema: {
        sourceId: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
        confirmed: z.boolean().optional(),
      },
      run: ({ sourceId, params, confirmed }) =>
        runActionRecipe({
          sourceId: sourceId as string,
          params: params as Record<string, unknown> | undefined,
          confirmed: confirmed as boolean | undefined,
        }),
    })
  }

  if (extras.recipeDebug) {
    const dbg = extras.recipeDebug
    entries.push({
      name: 'recipe_debug_start',
      description:
        'STEP-DEBUG a DESKTOP recipe: start a real run of it that PAUSES BEFORE EVERY STEP and waits for recipe_debug_next. Same runner, same driver, same recognition as run_action_recipe — nothing is simulated, every step that you release really happens on the user\'s machine (a released "send" really sends). Use it to walk a recipe with the user step by step: after each pause, look at the screen yourself (cdp_shot / cdp_look with target "app:<process>/<title>"), read `probes` (which recognition rung found the target, whether a branch held, how long each read took), decide, then call recipe_debug_next to release the next step or recipe_debug_abort to stop. ' +
        'Returns {sessionId, state, step?, probes}. state "paused" = stopped BEFORE `step` (index/total/kind/label/spec — spec is the step as written in the recipe); "running" = the step is still executing (reads can take a while) — call recipe_debug_next again to keep waiting; "finished" = the whole run ended, `outcome` is the run result; "aborted" = stopped (`reason`). A paused session auto-aborts after 10 minutes without a next — it holds the desktop session lease and every other recipe queues behind it, so do not leave one hanging. Params go through the recipe\'s own params_schema exactly like run_action_recipe (there is NO confirmation step here: starting a debug session IS the confirmation — ask the user before starting one for a recipe with side effects).',
      schema: {
        sourceId: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      },
      run: ({ sourceId, params }) => dbg.start({ sourceId: sourceId as string, params: params as Record<string, unknown> | undefined }),
    })
    entries.push({
      name: 'recipe_debug_next',
      description:
        'Release the step a recipe_debug_start session is paused before, run it, and pause before the following one. Returns the same {sessionId, state, step?, probes, outcome?} shape: `probes` are the runner\'s own trace lines for the step that just ran (recognition rung, branch verdict, expect result, timings) — read them before deciding on the next step. If state is "running" the step is still going; call again. Calling it on a "finished"/"aborted" session says so and does nothing.',
      schema: { sessionId: z.string() },
      run: ({ sessionId }) => dbg.next(sessionId as string),
    })
    entries.push({
      name: 'recipe_debug_abort',
      description:
        'Stop a step-debug session: the paused step is NOT run and no further input is sent (the run ends as drift "aborted-by-debugger@<step>"). A step that is mid-execution cannot be interrupted; the session stops right after it. Always abort a session you are not going to continue.',
      schema: { sessionId: z.string() },
      run: ({ sessionId }) => dbg.abort(sessionId as string),
    })
  }

  if (extras.events) {
    const ev = extras.events
    entries.push({
      name: 'get_events',
      description:
        'List recent backend events, newest first: auth.needed (a facility login died), transcribe.done / transcribe.error (a transcription settled), harvest.error (a scheduled harvest failed). Each: {id,type,at,title,body?,severity,ref?,readAt?}. `since` returns only events with id > since — poll with the last seen id after kicking off async work (e.g. transcribe) to learn its outcome. `types` is a comma-separated filter.',
      schema: { since: z.number().optional(), types: z.string().optional() },
      run: ({ since, types }) =>
        ev.list({
          since: since as number | undefined,
          types: types ? (types as string).split(',') : undefined,
        }),
    })
  }

  return entries
}
