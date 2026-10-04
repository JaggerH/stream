import type { Stores } from '../kernel/plugins/storage.ts'
import { makeResolveByLink } from '../http/fetch-url.ts'
import type { AgentDomain } from '../kernel/plugins/agent.ts'
import type { SourcesService } from '../kernel/plugins/sources.ts'
import type { EventsService } from '../events/service.ts'
import type { HarvestService } from '../kernel/plugins/harvest.ts'
import type { ProviderService } from '../kernel/plugins/provider.ts'
import type { NetdiskDomain } from '../kernel/plugins/netdisk.ts'
import type { ConversionsDomain } from '../kernel/plugins/conversions.ts'
import type { SearchFanoutService } from '../kernel/plugins/search-fanout.ts'
import type { McpExtras } from './server.ts'
import { publicSource } from '../registry/public.ts'
import { resolveBySourceId } from '../registry/source-id.ts'
import { InteractiveLane } from '../replay/interactive-lane.ts'
import { makeExtRawPage } from '../replay/browser-ext-drive.ts'
import { makeCdpRouter } from './cdp-router.ts'
import { runInboxSearch, type InboxSearchArgs } from './inbox-search.ts'
import { netdiskKeyFor } from '../transcribe/source.ts'
import { makeSearchSnapshot } from './search-snapshot.ts'
import type { StoredItem } from '../item-store.ts'
import { diagnoseCapability, summarizeCapability } from '../browser/capability-store.ts'
import { speakerViewOf } from '../voiceprint/view.ts'
import { makeExtractDigester } from './extract-digest.ts'
import { applyFramesLayer, type FramesLayer, type FramesState } from './extract-frames-layer.ts'
import { slimExtractReceipt } from './extract-receipt.ts'
import { communityByCategory } from './content-search-slim.ts'
import { settleWithin } from './extract-settle.ts'
import { transcriptStandsAlone } from './transcript-stands-alone.ts'
import { posterOf } from './item-poster.ts'
import { browseResult, BROWSE_MAX_DEPTH } from './netdisk-browse.ts'
import { projectTranscribeSample } from './netdisk-transcribe.ts'
import {
  projectReconcileStatus,
  applyReconcileDecisions,
  resolveReconcileRef,
  runReconcileExecute,
  type ReconcileDecisionInput,
  type PendingLike,
  type DeleteLike,
} from './reconcile-surface.ts'
import {
  projectShareInspect,
  projectFollowView,
  projectSync,
  resolveShareTarget,
  startFollowRun,
  type ShareValidity,
} from './netdisk-follow-surface.ts'
import { FollowService } from '../netdisk/follow/service.ts'
import { parseShareLink } from '../video/parse.ts'
import type { LlmForTask } from '../llm/task.ts'
import { runActionRecipe, prepareActionRecipe, type ActionRecipeArgs, type ActionRecipeDeps, type ActionRecipeResult } from './action-recipe.ts'
import { createActionRunService } from './action-run.ts'
import { createRecipeDebugSessions } from './recipe-debug.ts'
import { diagnoseCapabilities, slotOf, type ConfigSlotView } from './capability-gaps.ts'
import { provisionConfigSlot } from '../credentials/provision-slot.ts'
import { keyRefOf } from '../credentials/key-state.ts'
import { identityOf } from '../providers/identities.ts'
import { mediaToolAvailable, type MediaTool } from '../media/ffmpeg-bin.ts'
import { withLyricsCache } from '../audio/lyrics-cache.ts'

/** The live capabilities the tool-surface `extras` are assembled from — the single place both
 *  faces (MCP mount + in-app agent) and both MCP transports source `extras` from, so they never
 *  drift on which capabilities they expose.
 *
 *  **每一格都 Pick 自它真正住的那个域**（Boot 上已经没有它们了）：域上是必有字段的那些，漏接
 *  一格立刻是 typecheck 错误——这正是逐项转发表唯一能自动挡住的那道闸门。剩下那半（"加了新格
 *  子却忘了转发"）挡在 agent 域的 `MCP_EXTRAS_DEP_COUNT` 上。 */
export type McpExtrasDeps = Pick<AgentDomain, 'searchAgent' | 'webSearch' | 'intents' | 'onboardWishlist' | 'purchaseDecide'> & {
  /** 通知中心。**不从域 Pick**：它住内核的 `ctx.streamEvents`（`ctx.events` 是 cordis 本体
   *  占着的名字），是一个独立的域。 */
  events: EventsService
  /** LLM 梯子调用口(`llm.extract_digest` 调用点)——extract 窄回执的压缩腿。
   *  经 ctx.llm.forTask 进来,别绕过它直打 provider(账本要记数)。 */
  llmForTask: LlmForTask
  /** 一格配置此刻存了没（配置 row 引擎的 status，只报层不报值）。`provision_capability_key`
   *  跑完之后**回头核对**读的就是它——那一步是那个工具存在的全部理由。 */
  configSlotStatus: (ref: string) => { secrets?: Record<string, { configured: boolean }> }
  /** 真去跑那条自助申请 recipe（`scheduler.readSource(..., {userInitiated:true})` 的薄壳）。
   *  **thunk 不是实例**：调度域比本域晚建。 */
  runProvisionRecipe: (sourceId: string, params: Record<string, unknown>) => Promise<unknown>
  /** 活着的探索会话登记处——五个 `graph_*` 工具按 runId 现取会话。**thunk 不是实例**：
   *  介入域上的 manager 随域重挂会换，冻住一份就是让建图工具永远找不到活会话。 */
  explorations: McpExtras['explorations']
  /** 动作 recipe 的 run 库（就是 agent 域的 `searchRunStore`，`domain:'action'` 那些行）。
   *  `run_action_recipe confirmed:true` 经它变成"建 run → 最多等 25s → 没完回 runId"（`action-run.ts`），
   *  `get_agent_run` 读回。**缺席时 `run_action_recipe` 退回同步执行**——那是测试用假 extras 的
   *  形状，生产装配必须给（agent 域的转发表钉着格数）。 */
  actionRunStore: import('./action-run.ts').ActionRunStore
  /** 动作 recipe `output.files` 的落盘目录（`<dataDir>/action-artifacts`）。缺席 = 声明了文件的
   *  recipe 一律报错（`ActionRecipeDeps.artifactsDir` 头注）。 */
  actionArtifactsDir?: string
  // `channels` 是频道表（`inbox_search` 的 channel 过滤把频道解析成它的成员 stream 集合）。
  // `audioArchive` 只为 `resolve` 工具的歌词那一档当缓存（与 HTTP 那条路同一份壳）。
} & Pick<Stores, 'sourceHealth' | 'itemStore' | 'channels' | 'audioArchive'>
  // 转换底座住内核的 `ctx.conversions`——get_conversions / transcribe / parse / 声纹三工具 +
  // read_url 骑它。**这里能安心用 Pick**：域上 `conversions` / `readUrl` 是**必有**字段
  // （runner 与转成文字都无条件构造），所以漏接一格立刻是 typecheck 错误。Boot 时代它是可选属性，
  // 用 Pick 会让漏接线静默通过 —— 那正是当初把它单列成必填键的理由，现在由域的类型接管。
  & Pick<ConversionsDomain, 'speakerRegistry' | 'conversions' | 'readUrl'>
  // Source 目录住内核的 sources 域（`ctx.sources`），不再挂在 Boot 上。`liveRecipes` 是
  // run_action_recipe 的脑——它要的是**原始** recipe（带 meta.action/meta.params_schema），
  // `registry` 给的是投影过的 SourceManifest，没有这两格。
  // `configProvisionerFor` / `keyState`：`capability_status` 与 `provision_capability_key`
  // 的两条腿——「这一格配了没」和「谁能替他去申请」。两个都是**函数**（每次调用现查），
  // 别在这里求值：用户刚配完一把 key 答案就变了。
  & Pick<SourcesService, 'registry' | 'liveRecipes' | 'configProvisionerFor' | 'keyState'>
  // 采集运输面住内核的 harvest 域（`ctx.harvest`）——cdp_* 的三档地址（chrome / facility /
  // desktop）与 harvest_capability 全部骑它，Boot 上已经没有这几格。
  & Pick<
    HarvestService,
    'extLauncher' | 'extRelay' | 'browserCapability' | 'harvestBrowser'
    | 'pageLook' | 'pageShot' | 'pageAct' | 'desktopDriver' | 'makeSee' | 'recipeOverrides'
    // run_action_recipe 的浏览器档骑它——和采集同一个执行入口，凭据注入/限速/冷却全在里面。
    | 'sessionRecipes'
  >
  // 解析面住内核的 provider 域（`ctx.provider`）——resolve/intent/radar 三个 MCP 工具骑它；
  // resolveDownloads 是 video_resolve 的脑（与 HTTP `/api/download-options` 共用）。
  // `providerBindings` / `providerExecutor`：stream_fetch_url 的 `resolveByLink`（content.enrich
  // 按 `<platform>-link` 派发）骑它们——与 HTTP `/api/media/from-url` 同一份 `makeResolveByLink`。
  & Pick<ProviderService, 'radarMatcher' | 'intentResolver' | 'resolveEngine' | 'resolveDownloads' | 'providerBindings' | 'providerExecutor'>
  // 网盘住内核的 netdisk 域（`ctx.netdisk`）——netdisk_* 四个 MCP 工具骑它。两格本来就可为
  // undefined（没配 AList），语义与从 Boot Pick 时一字不差。
  & Pick<NetdiskDomain, 'netdisk' | 'netdiskRoutes'>
  // 搜索扇出住内核的 search 域（`ctx.search`）——content_search / price_search / video_search 三个工具骑它。
  & Pick<SearchFanoutService, 'contentSearch' | 'priceSearch' | 'videoSearch'>

/**
 * `run_action_recipe` 那一格。判断逻辑只有一份（`prepareActionRecipe`）；有 run 库就套异步壳
 * （建 run → 最多等 25s → 没完回 runId，`action-run.ts`），没有就同步跑到底——后者只是测试用假
 * extras 的形状，生产装配由 agent 域的转发表钉着一定给（`MCP_EXTRAS_DEP_COUNT`）。
 */
function makeRunActionRecipe(boot: McpExtrasDeps): (args: ActionRecipeArgs) => Promise<ActionRecipeResult> {
  const deps: ActionRecipeDeps = {
    // 裸名也认（`resolveBySourceId`）。**不能是裸 `Map.get`**：这张表的键是全名，而
    // `Registry.get` 那一侧有四级裸名解析——两条路对同一个 id 答案不一样，就会出现
    // "名字明明对着却 not-found"。动作 recipe 常常 `discoverable: false`，正确的全名
    // 在任何搜索面上都查不到，这个不对称因此格外伤人（见 resolveBySourceId 头注）。
    findRecipe: (id) => resolveBySourceId(boot.liveRecipes.current, id),
    desktopDriver: boot.desktopDriver,
    // 桌面档的识别层（`see`）——和采集共用 harvest 域那**同一个**工厂，别在这里另建一份：
    // 两份就是两个模板缓存目录、两个 model 预算，同一条 recipe 两条路的行为会静默分家。
    makeSee: boot.makeSee,
    // 本机学到的落地方式——同样是 harvest 域那**同一份**存储。另建一份 = 这条路学到的东西
    // 采集那条路看不见，而两条路每一步照样"成功"。
    recipeOverrides: boot.recipeOverrides,
    runBrowser: (recipe, params) => boot.sessionRecipes.execute(recipe, params),
    browserConnected: () => boot.extRelay.status().connected,
    artifactsDir: boot.actionArtifactsDir,
    // getter 式现算：recipe 表会因为装/卸包变化，装配期那一份是"冻住的答案"。
    listActions: () =>
      [...boot.liveRecipes.current].filter(([, r]) => r.meta?.action === true).map(([id]) => id).sort(),
    notify: (input) => boot.events.emit(input),
  }
  if (!boot.actionRunStore) return (args) => runActionRecipe(deps, args)
  const svc = createActionRunService({ store: boot.actionRunStore, prepare: (args) => prepareActionRecipe(deps, args) })
  return (args) => svc.run(args)
}

export function buildMcpExtras(boot: McpExtrasDeps): McpExtras {
  // 某种转换此刻可不可用（后端配没配）——工具的注册门就是它，别再各自判 deps 在不在。
  const hasKind = (kind: string) => !!boot.conversions?.kinds().some((k) => k.kind === kind && k.available)
  // 这条句柄的「画面文字」层此刻是什么样——extract 回执要靠它决定「能不能说齐了」
  // （见 extract-frames-layer.ts）。**现查不缓存**：frames 是转写落定之后才派生的，
  // 模型第二次轮询 extract 时它才刚出现；存成装配期的值就永远是 undefined
  // （「装配期取的值 = 冻住的答案」，见 AGENTS.md）。
  // `expandResult` 必须带上——落定之后要把轨**直接拼进回执**，只拿 status 就又退回
  // 「指路然后赌模型自己去取」，而那条路活体已经走死了两次。
  const framesLayerOf = (handle: string): FramesLayer | undefined => {
    const latest = boot.conversions?.list({ item: handle, kind: 'frames', limit: 1, expandResult: true }).items[0] as
      | { status?: string; result?: { track?: Array<{ at: number; text: string }>; probe?: { stop?: string; ocrTried?: number } } }
      | undefined
    if (latest?.status === undefined) return undefined
    // `probe` 不是可选的锦上添花：空轨有「判为不抽」和「逐帧看过没料」两种意思，只传
    // `track` 就会把前者讲成后者（见 extract-frames-layer.ts 的 `probe` 注释）。
    return { status: latest.status as FramesState, track: latest.result?.track, probe: latest.result?.probe }
  }
  /** 这条句柄还有没有没落定的转换——`settleWithin` 的谓词。extract 自己和它派生的画面
   *  文字层都算：任一还在跑，这次调用就还没有完整答案。 */
  const extractPending = (handle: string): boolean => {
    const rows = boot.conversions?.list({ item: handle, limit: 10 }).items as Array<{ kind?: string; status?: string }> | undefined
    return (rows ?? []).some(
      (r) => (r.kind === 'extract' || r.kind === 'frames') && (r.status === 'queued' || r.status === 'running'),
    )
  }
  const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })
  /** 等完之后重新读这条句柄最新的那条 extract。**返回 undefined = 没读到一条像样的记录**，
   *  调用方据此退回起跑时那份，别把一个说不出 `status` 的对象当回执用。 */
  const reread = (handle: string): unknown => {
    const row = boot.conversions?.list({ item: handle, kind: 'extract', limit: 1, expandResult: true }).items[0]
    return typeof (row as { status?: unknown } | undefined)?.status === 'string' ? row : undefined
  }
  // One lane for the whole MCP surface, with no session manager (hence `null`): act/look operate
  // on a tabId that already exists, so they never need a lease — only open() does, and over MCP
  // opening a tab is cdp_look's job (target:'chrome', with a `url`). Routing them through the
  // lane keeps the confirmation gate and the trusted-input driver in one place, shared with the
  // in-app agent, rather than growing a second copy behind the tool surface.
  const lane = new InteractiveLane('mcp', null, boot.extRelay)

  // 现搜结果的瞬时快照(extract 句柄第三命名空间,spec 2026-08-23-purchase-evidence-deepread)。
  // 喂入点就在这里——content_search 工具经这层包装天然吃到。price_search 不喂(比价条目无正文可深读)。
  const searchSnapshot = makeSearchSnapshot()
  // extract 窄回执的压缩腿(spec 2026-08-24-extract-narrow-receipt)——门槛/缓存/兜底全在
  // extract-digest.ts 里,这里只接线。
  const extractDigester = makeExtractDigester(boot.llmForTask)
  const feedSnapshot = <T extends { id?: unknown }>(items: T[]): T[] => {
    searchSnapshot.put(items as unknown as StoredItem[])
    return items
  }

  /** `show` 参数指的是一条整理 show 还是一条绑定（判据与理由见 `resolveReconcileRef`）。 */
  const reconcileRef = (ref: string): { kind: 'show' | 'binding'; id: string } =>
    resolveReconcileRef(ref, {
      hasShow: (r) => boot.netdiskRoutes!.reconcile!.hasShow(r),
      hasBinding: (r) => !!boot.netdiskRoutes!.store.get(r),
    })

  /**
   * 动完文件之后把那条绑定重新认一遍（同 `netdisk-routes.ts` 的 `resyncBinding`）。
   *
   * **只对 tmdb tv 那支做**，而且**失败不外抛**：文件已经动完了，回执讲的是那件事；同步炸了
   * 只由回执里那一格说话，别把一次成功的归档改写成一个错误。
   *
   * 回的是**三态**，不是布尔：`skipped`（这条绑定本来就不需要重同步）和 `failed`（需要、但没跑成，
   * 节目单还指着旧路径、点播会 404）是两件完全不同的事，压成一个 `false` 就分不出来了——而
   * "没做"和"做砸了"长得一模一样正是这类缺陷最爱藏的地方。
   */
  const resyncBinding = async (
    bindingId: string | undefined,
  ): Promise<{ status: 'done' | 'skipped' | 'failed'; error?: string }> => {
    if (!bindingId) return { status: 'skipped' }
    const set = boot.netdiskRoutes?.store.get(bindingId)
    if (!set || set.left.kind !== 'tmdb' || set.left.media !== 'tv') return { status: 'skipped' }
    try {
      await boot.netdiskRoutes!.service.sync(set)
      return { status: 'done' }
    } catch (e) {
      return { status: 'failed', error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * 「这条能力骑的那一行 Provider，成员各要哪一格配置」。
   *
   * 两个来源取并集：**声明的成本阶梯**（合并身份表（`src/providers/identities.ts`）里那条身份的 `defaultMembers`）
   * 和**用户库里现有的成员**。声明那一半不能省——`transcribe` 行是"哪些 key 在就写哪几档"
   * 建出来的（`ensureTranscribeRow`），一把 key 都没有时那一行**压根不存在**，只读库就会得到
   * 「没有成员」这个既真又没用的答案，而用户真正想知道的是"那我该去配哪一把"。
   *
   * **每次现扫、不缓存**：装配期取一次等于把「配没配」冻在启动那一刻（AGENTS.md
   * 「装配期取的值 = 冻住的答案」）。
   */
  const slotsOfRow = (row: string): ConfigSlotView[] => {
    const declared = (identityOf(row)?.defaultMembers ?? []) as Array<{ source?: string; params?: Record<string, unknown> }>
    const live = (boot.channels.getProvider(row)?.members ?? []) as Array<{ source?: string; params?: Record<string, unknown> }>
    const out = new Map<string, ConfigSlotView>()
    for (const m of [...declared, ...live]) {
      if (typeof m.source !== 'string') continue
      const rc = boot.registry.get(m.source)?.runtime_config
      if (!rc) continue
      const slot = slotOf(rc, keyRefOf(rc, m.params), boot.keyState(m.source, m.params), (ref) => boot.configProvisionerFor(ref))
      // 后到的不覆盖先到的：声明的阶梯排在前面，顺序就是成本阶梯的顺序。
      if (slot && !out.has(slot.ref)) out.set(slot.ref, slot)
    }
    return [...out.values()]
  }

  const base = {
    contentSearch: (q: string) => boot.contentSearch(q).then(feedSnapshot),
    // 搜索结果分档判据来自清单 categories；闭包每次调用都走 `boot.registry.get`，热重载换组跟得上。
    isCommunitySource: communityByCategory(boot.registry),
    // 「这件事为什么做不了、谁能修」。判据全在 capability-gaps.ts，这里只接三个读口——
    // 三个都是**函数**，调用时才现问（用户刚配完一把 key 答案就变了）。
    capabilityStatus: () =>
      diagnoseCapabilities({
        // 可用性的唯一真相源：extract 那一行自己报的 branches（后端选分支吃的就是它）。
        branchAvailable: (branch) =>
          !!(boot.conversions?.kinds().find((k) => k.kind === 'extract')?.branches?.[branch]),
        slotsOf: slotsOfRow,
        toolAvailable: (tool) => mediaToolAvailable(tool as MediaTool),
      }),
    // 「替他去申请一把」。跑 + **回头核对那一格填上了没**只有一份实现
    // （`credentials/provision-slot.ts`，配置卡那颗按钮走的 HTTP 端点吃的是同一个）。
    provisionConfigSlot: (ref: string, params: Record<string, unknown>) =>
      provisionConfigSlot(
        {
          provisioner: (r) => boot.configProvisionerFor(r),
          run: async (r, p) => {
            const provisioner = boot.configProvisionerFor(r)!
            await boot.runProvisionRecipe(provisioner.sourceId, p)
          },
          statusOf: (r) => boot.configSlotStatus(r),
        },
        ref,
        params,
      ),
    /** 反查那条 recipe（二次确认那一步要把它原样念给用户听）。 */
    configProvisionerFor: (ref: string) => boot.configProvisionerFor(ref),
    priceSearch: boot.priceSearch,
    // 已采集进库那批条目的读口。**无条件转发**：ItemStore 和频道库都是必有的（没有"配没配"
    // 这一档），所以这里没有 undefined 分支——漏了它 `inbox_search` 就安静地不注册，而模型
    // 会退回 content_search 现搜，给用户一堆他从没订过的东西（2026-08-19 实测的那一轮）。
    // 频道→stream 的解析放在这里而不是 ItemStore 里：ItemStore 不认识频道这个概念，
    // 频道是 `channels` 那张表上的一个视图（docs/ARCHITECTURE.md「Channel」）。
    inboxSearch: (args: InboxSearchArgs) =>
      runInboxSearch(
        {
          search: (q) => boot.itemStore.search(q),
          // 整份名录**每次现取**（频道会增删改，装配期取一次就是冻住的答案）。
          channels: () =>
            boot.channels.listChannels().map((c) => ({ id: c.id, label: c.label, stream_ids: c.stream_ids })),
        },
        args,
      ),
    resolve: {
      resolveIntent: (input: string) => boot.radarMatcher.match(input),
      classifyIntent: (input: string) => boot.intentResolver.resolve(input),
      // 歌词那一档经缓存壳，**与 HTTP 的 `/api/resolutions` 共用同一份**
      // （`src/audio/lyrics-cache.ts`）。缓存只在其中一条路上就是个安静的缺陷：
      // 模型这条路每次播放都去打一次上游，不报错、不显眼，两条路的单测还都绿。
      resolveTarget: (tt: string, key: string) =>
        tt === 'lyrics'
          ? withLyricsCache(boot.audioArchive, key, (k) => boot.resolveEngine.resolve(tt, k))
          : boot.resolveEngine.resolve(tt, key),
      listSources: (tt?: string) =>
        (tt ? boot.registry.providersOf(tt) : boot.registry.all().filter((m) => m.provides?.length)).map((m) => ({
          ...publicSource(m),
          provides: m.provides ?? [],
          priority: m.priority ?? 100,
          health: boot.sourceHealth.stateOf(m.id),
        })),
    },
    videoSearch: boot.videoSearch,
    // video_resolve 的脑（download-resolve 行的 decline-chain）。无条件转发——行是种子行,
    // 必有;漏了它工具安静地不注册,模型会退回把中转页 URL 当成品链接甩给用户。
    videoResolve: (url: string) => boot.resolveDownloads(url),
    searchAgent: boot.searchAgent,
    // 购买决策 job。无条件转发——它在 agent 域里是必有的一格（没有"配没配"这一档）。
    // **漏了这一行的表现活体撞到过**：deps 表加了、格数自检也过了（那个数只数 deps），
    // 而 `purchase_decide` 安静地不在 52 个工具里——不报错、不 404，只是不存在。
    purchaseDecide: boot.purchaseDecide,
    webSearch: boot.webSearch,
    readUrl: boot.readUrl,
    events: boot.events,
    intents: boot.intents,
    // 「这台机器到底能不能采」——纯 MCP 用户没有装机引导页可看，这个 tool 就是他那扇门。
    // 给的是**全量**那一档（快判 + chrome 候选）：他最需要知道的第二半是「该装在哪一侧」，
    // 而只有候选块答得了；HTTP 那边拆两档是因为快判要在引导页上秒回，一次工具调用没这个约束。
    // 三态判定与 `chrome` 字段的组装都不在这里——两面共用 summarizeCapability + diagnoseCapability。
    harvestCapability: async () =>
      diagnoseCapability(
        summarizeCapability(boot.extRelay.status(), boot.browserCapability.get()),
        await boot.harvestBrowser.status(),
      ),
    // 转换的读取面直接吃 runner 的 list——过滤/精简/分页的语义与 HTTP 端点是同一份实现，
    // 不在工具层再造一遍（原来 list_transcripts/list_parses 各自在工具层投影正文）。
    conversions: boot.conversions
      ? {
          list: (q: { item?: string; kind?: string; limit?: number; expandResult?: boolean }) =>
            boot.conversions!.list({
              item: q.item,
              kind: q.kind as import('../conversions/store.ts').ConversionKind | undefined,
              limit: q.limit,
              expandResult: q.expandResult,
            }),
        }
      : undefined,
    // 说话人读口：时间线（唯一存储）× 转写段现算投影，read_content 拿它给稿子标名字。
    speakers:
      boot.speakerRegistry && boot.conversions
        ? (itemId: string) =>
            speakerViewOf(
              {
                timeline: (id) => boot.speakerRegistry!.getItemTimeline(id),
                segments: (id) => boot.conversions!.segmentsOf(id),
              },
              itemId,
            )
        : undefined,
    // 跨内容声纹查询「谁出现在哪」：person 匹配（精确优先，无命中再子串）→ 出现账 → itemStore 补 title。
    appearances: boot.speakerRegistry
      ? {
          query: (person: string, minSeconds?: number) => {
            const persons = boot.speakerRegistry!.findPersonsByName(person)
            const rows = boot.speakerRegistry!.listAppearancesForPersons(persons.map((p) => p.id), minSeconds ?? 30)
            return rows.map((r) => {
              const it = boot.itemStore.get(r.itemId)
              return {
                itemId: r.itemId,
                title: it?.title,
                source: it?.stream_id,
                seconds: r.seconds,
                segments: r.segments,
                firstAt: r.firstAt,
                nameAtTime: r.nameAtTime,
              }
            })
          },
        }
      : undefined,
    // `handle` is a source handle, not necessarily an item id: a `tmdb:<id>[:SxxExx]` key names a
    // netdisk-bound movie/episode that has no inbox item at all. Resolution belongs to the
    // resolver (src/transcribe/source.ts), so this entry no longer hands over a media descriptor
    // — that is what used to make MCP transcription of netdisk videos impossible while the
    // browser (which had the serve-time resolve url) succeeded.
    // 转成文字：**一个**工具，不分转写/OCR/抓网页——那是后端按 archetype 判的分支，
    // 调用方（模型）不需要挑，因为没得挑。网盘绑定的 `tmdb:…` 句柄不是 item，它的
    // content 由句柄命名空间给出（见 app.ts resolveHandle 同款判断）。
    // **这两格（extract / identify）在下面的 return 里另立 getter**，这里不放：它们的注册门是
    // 「这个 kind 此刻配好了没」，而这个对象是装配期只建一次的。见 return 处那段头注。
    // 句柄解析序:库内 item → 现搜快照 → 网盘绑定。快照是第三命名空间(spec
    // 2026-08-23-purchase-evidence-deepread §2.1):现搜结果不落库,但模型刚在
    // content_search 回执里见过它的 id,TTL 内深读得用同一个句柄指到。
    // 返回 Promise<unknown>：record 拿到手之后还要过一遍 digest 层（门槛/缓存/兜底见
    // extract-digest.ts）——长文经它压成带出处的要点，短文/running/error 原样透传。模型面没有 full 开关(spec 2026-08-24-digest-authority)。
    // 交出去之前再过一遍**画面文字层**（extract-frames-layer.ts）：视频的正文在 frames
    // 落定之前是不完整的，所以那一层还在跑时回执报 running、不带 result；落定了就把画面上
    // 的字直接拼进来。**别改回「给半份 + 叮嘱一句」**——活体两次都证明模型会照着半份总结。
    extractImpl: (handle: string, opts?: { diarize?: boolean; rerun?: boolean; focus?: string }) => {
          const it = boot.itemStore.get(handle) ?? searchSnapshot.get(handle)
          const bound = !it && !!boot.netdisk?.lookup(netdiskKeyFor(handle))
          if (!it && !bound) return { status: 'error', error: 'item not found' }
          const { record } = boot.conversions!.start('extract', handle, {
            options: {
              media: it?.content?.media,
              content: it?.content ?? { archetype: 'video', resolvedByHandle: true },
              url: it?.url,
              // 「识别发言人」开关（详情页动作行那一格，经模型填 extract 工具的 diarize 参数下来）。
              // 这里不带的话用户拨了开关也无声无息地不生效——两边单看都正常，没有任何一处会报错。
              diarize: opts?.diarize,
            },
            // 缓存命中**不看 options**（runner.start：`latestFor(itemId, kind)` 非 error 就原样退回），
            // 所以「已经取过正文的条目 + 刚拨开的 diarize」不 force 就是静默失效。force 只在调用方
            // 明说重跑时给——第二次点转成文字，多数时候要的就是缓存那份，别替用户重新计费。
            force: opts?.rerun,
            snapshot: {
              title: it?.title ?? handle,
              source: it?.stream_id ?? 'netdisk',
              url: it?.url,
              // 缩略图：卡片认这一格（`ExtractCard` 的 ItemHead）。库里那条记录一直有这个位置，
              // 只是从来没人填——于是每张卡都只能画一行字。
              poster: posterOf(it?.content?.media),
            },
          })
          return (async () => {
            // 在这一侧等到好（`extract-settle.ts`）：DSH 一次工具调用只画一张卡、且结果
            // 落地时原地重画，所以「一张卡片更新状态」= 「一次不提前返回的调用」。反过来
            // 提前回 running 等于把等待推给模型，而模型没有 sleep——它只会立刻再问一遍，
            // 于是同一件事被调五次、刷五张卡。预算花光那一档**不再叫它重试**，见下。
            const settled = await settleWithin({ pending: () => extractPending(handle), sleep, now: Date.now })
            // **等完必须重新读一遍**：`record` 是起跑那一刻的快照，等的就是它变。
            // 读回来的东西**要验形状**：查不到、或返回的不是一条转换记录时退回原记录——
            // 拿一个说不出 `status` 的对象当回执，会投影出一份 `status:'unknown'` 的
            // 空壳，而调用方看不出这是"读岔了"还是"真是这个状态"。
            const latest = settled ? (reread(handle) ?? record) : record
            const digested = await extractDigester.apply(handle, latest, { focus: opts?.focus, bypassCache: opts?.rerun })
            // 画面文字层还在跑时给不给正文，看转写自己站不站得住（判据见
            // `transcript-stands-alone.ts`）。落定的那一档用不上这一格。
            const layered = applyFramesLayer(digested, handle, framesLayerOf(handle), transcriptStandsAlone(latest))
            // 现取 `registry.all()`，不是在装配这个闭包时读一次：用户随时会装新包/热重载
            // recipe，装配期的那份快照永远追不上，而且不报错——只是"能自助补"这一格恒空。
            return slimExtractReceipt(layered, handle, boot.registry.all())
          })()
        },
    // read_content 的结构性收口(见 tool-catalog McpExtras.digestLongText 头注):把一段长文
    // 过 extract 同一个压缩器。合成一个最小 record 形状喂进去——digester 只认这三格。
    digestLongText: (itemId: string, text: string) => {
          return extractDigester.apply(itemId, { status: 'done', result: { text } })
        },
    // 补说话人：和 extract 走同一套句柄解析与 snapshot（网盘绑定的 `tmdb:…` 不是 item），
    // 差别只有 kind 和「不需要 options」——identify 自己会去找上游那条转写，没有转写也能跑
    // （纯 diarization，见 converters/identify.ts 头注）。
    identifyImpl: (handle: string, opts?: { rerun?: boolean }) => {
      const it = boot.itemStore.get(handle) ?? searchSnapshot.get(handle)
      const bound = !it && !!boot.netdisk?.lookup(netdiskKeyFor(handle))
      if (!it && !bound) return { status: 'error', error: 'item not found' }
      return boot.conversions!.start('identify', handle, {
        force: opts?.rerun,
        snapshot: { title: it?.title ?? handle, source: it?.stream_id ?? 'netdisk', url: it?.url },
      }).record
    },
    // 动作型 recipe 的唯一调用入口。**无条件转发**：找不到 recipe / 不是动作 recipe / 没有
    // Stream Desktop（或浏览器没连）这几档失败全在 action-recipe.ts 内部区分，这里只接线
    //（findRecipe 骑 liveRecipes.current——原始 recipe，带 meta.action/meta.params_schema）。
    //
    // 浏览器档交给采集用的那同一个 executor：凭据注入的五道闸、facility 限速、退让冷却、
    // lane 租约都长在它身上，这里绝不另开一条直连 transport 的路。
    // 单步调试：同一条 runner、同一份 driver / 识别层，只是每一步之前停下来等人放行。
    // 四个键（findRecipe / desktopDriver / makeSee / recipeOverrides）和下面 runActionRecipe
    // 那份**必须同源**。
    recipeDebug: createRecipeDebugSessions({
      findRecipe: (id) => resolveBySourceId(boot.liveRecipes.current, id),
      desktopDriver: boot.desktopDriver,
      makeSee: boot.makeSee,
      recipeOverrides: boot.recipeOverrides,
    }),
    runActionRecipe: makeRunActionRecipe(boot),
    // 「接不上的站」清单的写入面。**无条件转发**：这份账本没有"后端配没配"这一档
    //（一个 JSON 文件），漏了它 note_unonboardable 就不注册，而模型照样会说「我已经记下了」。
    wishlist: boot.onboardWishlist,
    // netdisk rule-editing surface: only when the AList layer is wired (needs both the service
    // and its store). Bindings are projected compact (no per-entry dump); apply returns a summary.
    netdisk: boot.netdisk && boot.netdiskRoutes
      ? {
          bindings: () =>
            boot.netdiskRoutes!.store.list().map((s) => ({
              id: s.id,
              title: s.left.title,
              // 左侧来源不再只有订阅流：streamId 只对 kind:'stream' 有意义，tmdb 左侧没有它。
              // 报 left 本身而不是硬摊平，调用方据 kind 自己读——摊平会让 tmdb 绑定看起来像
              // 一个 streamId 丢了的 stream 绑定。
              left: s.left,
              dirPath: s.right.path,
              lastSyncAt: s.lastSyncAt,
              coverage: s.coverage,
            })),
          // 「让 AI 看见网盘」——它此前手里没有任何列目录的工具（spec 2026-08-25 §4.1）。
          // 不设深度上限（挑目录之前不知道要挖多深），条数与"读不读得完"的取舍在
          // `netdisk-browse.ts` 的形状层里，这里只负责取数。`refresh` 恒 false：这是浏览不是
          // 对账，吃 AList 的目录缓存正好（整理自己的扫描才强制回源）。
          browse: async (path: string, recursive: boolean) => {
            const all = recursive
              ? await boot.netdiskRoutes!.alist.listDirRecursive(path, BROWSE_MAX_DEPTH, false, true)
              : await boot.netdiskRoutes!.alist.listEntries(path, false)
            return browseResult(path, recursive, all)
          },
          residue: (setId: string) => boot.netdisk!.residue(setId),
          previewSpec: (setId: string, spec: unknown) => boot.netdisk!.previewSpec(setId, spec),
          applySpec: (setId: string, spec: unknown) =>
            boot.netdisk!.applySpec(setId, spec).then((set) => ({
              id: set.id,
              coverage: set.coverage,
              lastSyncAt: set.lastSyncAt,
              matchSpec: set.matchSpec,
            })),
          // 就地开一次整理（spec 2026-08-25 §4.2）。**装在 serve.ts**（那儿才同时够得着订阅
          // 成员表与调度器），这里只转发；没装配就让工具整个缺席——注册一个必然报错的动词
          // 比没有它更坏（模型会一直重试）。
          ...(boot.netdiskRoutes.openReconcile
            ? { reconcileOpen: boot.netdiskRoutes.openReconcile }
            : {}),
          // 听一段网盘音频。**投影在这一层做**，和 reconcileStatus 同构：取数腿（切片/转写/缓存）
          // 在内核的 netdisk 域，回执形状（每段封顶 + 截断自陈 + "这只是采样"）在
          // `netdisk-transcribe.ts`，那儿有测试钉着。取不到证据的那一档如实报 unsupported——
          // 它和"听了但判不出"是两件事，混成一格模型就会把系统限制当成一个判断结果。
          ...(boot.netdiskRoutes.transcribeSample
            ? {
                transcribeFile: async (input: { path: string; windowS?: number }) => {
                  const out = await boot.netdiskRoutes!.transcribeSample!(input)
                  if (!out.ok) return { status: 'unsupported', reason: out.reason }
                  return projectTranscribeSample(out)
                },
              }
            : {}),
          // ── 整理裁决面（spec 2026-08-24-conversational-reconcile）────────────────
          // 三个动词 = 状态 / 裁决 / 执行。骑 ReconcileService 同一套原语（HTTP 路由的孪生），
          // 决定经 service.setXxx 走——对照账本的回填接线在那一层（MATCHING.md「接线在写决定
          // 那一步」），绕过它直接写 DecisionStore 会让账本漏记 agent 的裁决。
          reconcileStatus: async (
            showId?: string,
            opts?: { expandDir?: string; offset?: number; limit?: number; deletesOffset?: number },
          ) => {
            const rec = boot.netdiskRoutes!.reconcile!
            const shows = rec.getConfigView().shows.map((s) => ({ id: s.id, label: s.label, bindingId: s.bindingId }))
            if (!showId) return { shows }
            const ref = reconcileRef(showId)
            const pv = ref.kind === 'binding' ? await rec.previewBinding(ref.id) : await rec.preview(ref.id)
            // 投影（归组 / 分页 / 截断自陈）全在 reconcile-surface.ts，那儿有测试钉着——
            // 这里只负责取数据。
            return projectReconcileStatus(
              {
                counts: pv.counts,
                pending: pv.plan.filter((a) => a.kind === 'pending') as unknown as PendingLike[],
                // 整份计划递下去只为抽将删清单——`reconcile_execute` 的描述要模型执行前核对
                // 每条删除留的是同一集的另一份，而在这之前它手里只有几个数字。
                plan: pv.plan as unknown as DeleteLike[],
              },
              opts,
            )
          },
          reconcileDecide: (input: ReconcileDecisionInput & { decisions?: ReconcileDecisionInput[] }) =>
            applyReconcileDecisions(boot.netdiskRoutes!.reconcile!, input),
          reconcileExecute: async (showId: string, opts?: { expectFingerprint?: string }) => {
            const rec = boot.netdiskRoutes!.reconcile!
            const ref = reconcileRef(showId)
            // 指纹闸在**执行之前**（`runReconcileExecute` 头注）：给了 expectFingerprint 就重新
            // 规划一次核对，对不上一步都不走；没给就照旧，也不白跑那次 preview。
            const res = await runReconcileExecute(
              {
                previewPlan: async () => {
                  const pv = ref.kind === 'binding' ? await rec.previewBinding(ref.id) : await rec.preview(ref.id)
                  return pv.plan as unknown as { kind: string; src?: { path?: string } }[]
                },
                execute: () => (ref.kind === 'binding' ? rec.executeBinding(ref.id) : rec.execute(ref.id)),
              },
              opts?.expectFingerprint,
            )
            // 影视那档的计划会**改名 + 搬进季目录**，而绑定里存的是相对路径——不重同步，节目单
            // 那一侧还指着旧路径，点播放 404 且没有一处会喊（同 HTTP 路由的 `resyncBinding`）。
            if (ref.kind === 'binding') await resyncBinding(ref.id)
            return {
              moved: res.moved,
              deleted: res.deleted,
              renamed: res.renamed,
              removedDirs: res.removedDirs,
              runId: res.runId,
              pending: res.pending,
              errors: res.errors,
            }
          },
          /** 整轮撤销 + 把绑定的路径同步回去（`POST /api/netdisk/reconcile/undo-run` 的孪生）。 */
          reconcileUndoRun: async (runId: string) => {
            const rec = boot.netdiskRoutes!.reconcile!
            const res = await rec.undoRun(runId)
            const bindingId = rec.bindingOfRun(runId)
            // **在撤销之后、且不影响回执**：文件已经搬回去了，同步的死活不许改写这次结论。
            const resync = await resyncBinding(bindingId)
            return {
              undone: res.undone,
              skipped: res.skipped,
              ...(bindingId ? { bindingId } : {}),
              resync: resync.status,
              ...(resync.error ? { resyncError: resync.error } : {}),
            }
          },
          // ── 轮末裁决器手动入口（spec 2026-09-03-netdisk-llm-adjudicator §3 触发点 2）──────
          // 未装配 → 两格缺席，两个工具都不注册。
          ...(boot.netdiskRoutes.adjudicate
            ? {
                adjudicate: async (show: string, opts?: { losers?: boolean; force?: boolean }) => {
                  const adj = boot.netdiskRoutes!.adjudicate!
                  const rec = boot.netdiskRoutes!.reconcile!
                  const ref = reconcileRef(show)
                  // 裁决器只对**绑定**生效（`AdjudicationService.run` 的 setId 就是 `MappingSet.id`）；
                  // `show` 那一侧（播客整理配置）要绕道 `bindingId` 字段——同 reconcile_execute 那支，
                  // 但那支直接调 `rec.preview/execute(showId)` 就够了，这支必须先落到真正的绑定 id。
                  const setId = ref.kind === 'binding' ? ref.id : rec.getConfig().shows.find((s) => s.id === ref.id)?.bindingId
                  if (!setId) throw new Error(`show '${show}' 没有对应的绑定——裁决器只对绑定生效`)
                  const res = await adj.run(setId, { trigger: 'manual', losers: opts?.losers ?? false, ...(opts?.force ? { force: true } : {}) })
                  if (res.applied > 0) await resyncBinding(setId)
                  return res
                },
                revokeAdjudication: (runId: string) => boot.netdiskRoutes!.adjudicate!.revoke(runId),
              }
            : {}),
          /** 重新认盘（`POST /api/netdisk/mappings/:id/sync` 的孪生）。逐条 entry 不进回执。 */
          sync: async (setId: string) => {
            const set = boot.netdiskRoutes!.store.get(setId)
            if (!set) throw new Error(`unknown binding: ${setId}`)
            return projectSync(await boot.netdiskRoutes!.service.sync(set), new Date().toISOString().slice(0, 10))
          },
          // ── 影视追更（spec 2026-09-03-work-follow-loop）──────────────────────────
          // 未装配 → 两格缺席，两个工具都不注册（"没有落点就不装这个工具"）。
          ...(boot.netdiskRoutes.follow
            ? {
                shareVerify: async (input: { link?: string; netdisk?: string; pwdId?: string; passcode?: string }) => {
                  const f = boot.netdiskRoutes!.follow!
                  // 「这条我们验不了」不抛异常，回一档 `unsupported`（判据与理由见
                  // `resolveShareTarget`）——抛出去模型只会当成"失败了"去重试。
                  const target = resolveShareTarget(input, { supports: (n) => f.supports(n), parseLink: parseShareLink })
                  if (!target.ok) return target.result
                  const r = await f.inspectShare(target.netdisk, target.pwdId, input.passcode)
                  return projectShareInspect({
                    netdisk: target.netdisk,
                    pwdId: target.pwdId,
                    validity: r.validity as ShareValidity,
                    reason: r.reason,
                    files: r.files,
                  })
                },
                follow: async (setId: string, action: 'view' | 'enable' | 'disable' | 'run') => {
                  const f = boot.netdiskRoutes!.follow!
                  // 不存在的绑定要在**开一轮之前**拦下：`run` 现在是 fire-and-return，抛在后台
                  // 就只剩日志里一行，模型手里却是一句 `started:true`。
                  const set = boot.netdiskRoutes!.store.get(setId)
                  if (!set) throw new Error(`unknown binding: ${setId}`)
                  // 非剧集绑定：`enable`/`disable` 由 `setEnabled` 抛（判据的正主在那儿），
                  // 只读的 `view` 和 `run` 回一句话——以前 `view` 对它答 `follow: undefined`，
                  // 一个"没开追更"的样子，而真相是这条绑定压根不能追更。
                  if (!FollowService.followable(set) && action !== 'enable' && action !== 'disable') {
                    return { setId, error: '只有 TMDb 剧集绑定能追更' }
                  }
                  if (action === 'run') {
                    return startFollowRun(f, setId, (e) =>
                      console.error(`[follow] ${setId} manual round failed:`, e instanceof Error ? e.message : e),
                    )
                  }
                  if (action === 'enable' || action === 'disable') f.setEnabled(setId, action === 'enable')
                  return projectFollowView(f.view(setId))
                },
              }
            : {}),
        }
      : undefined,
  }

  // Unified CDP facade: one router over three terminals — chrome (the user's own logged-in
  // Chrome, via the extension relay), facility:<name> (the harvest tab Stream drives), and
  // desktop/app:<process> (a native window, via Stream Desktop). See cdp-router.ts for the
  // target-dispatch logic — this just wires its deps.
  const router = makeCdpRouter({
    // ext-cdp ad-hoc eval: launch a tab in the user's own Chrome over the extension relay and
    // run in-page JS. The degenerate single-shot form of the interactive lane's open+act+close.
    //
    // Closing is CLEANUP, not part of the operation — so it is not forced:
    // - interactive:true  = work meant to be SEEN. The tab stays open; closing it would defeat
    //   the whole point (the user is supposed to watch the AI work). Returns a `target:
    //   'chrome:<tabId>'` string so the tab stays addressable in a follow-up cdp_* call — the AI
    //   can close it when a round is done, or the user closes it by
    //   hand. Both triggers are fine; they don't conflict. Nothing leaks either way: the tab sits
    //   in the session tab group, where the user can see it and close it with one click — for a
    //   tab meant to be watched, that visibility IS the anti-leak mechanism. The extension will
    //   NOT reap it on service-worker restart (a backend blip must never close a tab the user is
    //   looking at); it only reconciles the group against the browser's real membership.
    // - interactive:false = a silent background probe. Nobody is watching it, so it is closed as
    //   soon as the value is read, and the extension marks it 'probe' so a crashed round still
    //   gets reaped on the next service-worker wake — invisible work needs a real net.
    // On error the same rule holds: a silent probe still cleans up; a visible tab is left where
    // it broke, so the failure can be looked at.
    chromeCdp: async (url: string, js: string, opts?: { interactive?: boolean; inventory?: boolean }) => {
      const interactive = opts?.interactive === true
      const { rawPage, close } = await boot.extLauncher.launch(url, 'load', { interactive })
      const page = rawPage as { tabId?: number; evalExpr: (e: string) => Promise<unknown> }
      try {
        // 清单要跨 iframe——那不是一段 js 能做完的（每个 frame 各自一个执行上下文），交给 lane。
        const value = opts?.inventory && page.tabId != null ? await lane.inventory(page.tabId) : await page.evalExpr(js)
        return interactive ? { value, target: `chrome:${page.tabId}`, kept: true } : { value }
      } finally {
        if (!interactive) await close()
      }
    },
    // Read a value out of a tab that already exists (from cdp_pages / cdp_look's tabId) — the
    // read half of taking over a tab. Pure read: no domain check (reading a page that navigated
    // away just yields something useless; it cannot land an action on the wrong site).
    chromeLook: (tabId: number, js: string, frame?: string) => lane.look(tabId, js, frame),
    // 跨 iframe（含跨站 OOPIF）的元素清单：编号全 tab 唯一，`ref` 不带 frame 也能落到对的 frame 里。
    chromeInventory: (tabId: number) => lane.inventory(tabId),
    // Act on a tab that already exists. Without this, cdp_pages is a list you can look at but
    // never touch — the AI could identify the target tab and have no way to drive it.
    //
    // The confirmation gate here is an ALIGNMENT affordance, not a sandbox: `confirmed` is a
    // parameter the caller supplies, so a model that decides to set it has confirmed nothing.
    // Its job is to make a high-risk action stop and surface itself to the user in the normal
    // conversation, not to make a lying caller harmless. The boundaries that actually hold no
    // matter what the backend or the model claims are enforced extension-side: the tab must be
    // in the session tab group (which a user's visible drag put it in), every mutating action
    // re-checks the tab's domain against the browser's own record, and a tab the user dragged in
    // is never destroyed. Those survive a caller that lies; this gate does not.
    chromeAct: (action, confirmed) => lane.act(action, { confirmed }),
    // Enumerate the tabs the AI is allowed to touch = the ones inside the session tab group
    // (a real, visible Chrome tab group). This is how a target tab gets identified — by url /
    // title, never guessed. Tabs outside the group never appear here and cannot be driven.
    // Open a page for the user (kind:'open'). Deliberately the thin one: find-or-open, no
    // debugger, no injection — which is exactly why chrome://* privileged pages open at all.
    // A tab it creates still joins the session tab group (everything Stream opens is visible
    // and revocable there); a tab that was already open is the user's and is only activated.
    // The receipt's title is what turns an extension tabId into a native-window address
    // (`app:chrome.exe/<title>`), so the two address spaces meet here.
    chromeOpen: (url: string, opts?: { ownWindow?: boolean }) => boot.extRelay.openTab(url, opts),
    chromeTabs: () => boot.extRelay.list(),
    // Finish with a tab. Closing is a COMMAND (the AI sends it when a round is done; the user
    // can just as well close the tab by hand — the two don't conflict), never a forced cleanup
    // after every call. The extension splits by origin: a tab the AI created is reclaimed; a
    // tab the user dragged in is only detached and dropped from the group — never destroyed.
    chromeCloseTab: (tabId: number) => boot.extRelay.closeTab(tabId),
    // A JPEG of a tab in the user's own Chrome. The `look` half answers "what does the DOM say";
    // this answers "what does it LOOK like" — the question a selector that matches the wrong
    // element, or a page that rendered nothing, only ever gives up to an eye.
    chromeShot: async (tabId: number) => {
      const res = (await makeExtRawPage(boot.extRelay, tabId).cdp('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 60,
      })) as { data?: string } | undefined
      return res?.data ?? null
    },
    // ── The facility side of the same verbs ───────────────────────────────────────────────────
    // One set of ideas, two ways to address a page. Both are tabs in the user's Chrome; what
    // differs is how you name one — a facility names the harvest tab Stream is driving (there is
    // no tabId a caller could have learned, and nothing to pick from), where chrome names any tab
    // by id. 「这个 facility 此刻没有活 tab」由 look/shot/act 自己返回 null 表达（router 把它
    // 当作正常的未运行档）——接线本身不再可缺席：harvest 域一挂就有这三格。
    //
    // These reach the DEFAULT lane of the facility. A facility may hold several lanes, but the
    // unkeyed one is what recipes ride unless they ask otherwise — hence the useful one.
    facilityLook: boot.pageLook,
    facilityShot: boot.pageShot,
    // The gate here is the same alignment affordance it is on cdp_act — `confirmed` is a
    // caller-supplied parameter, so a model that sets it has confirmed nothing; the point is to
    // make a high-risk action stop and surface itself in the conversation. What does NOT depend
    // on the caller being honest is the domain re-check inside sessions.act: it reads the
    // browser's own record (Transport.url), so a wrong `domain` refuses instead of acting.
    facilityAct: boot.pageAct,
    // 原生窗口档：直接骑 harvest 域那个 desktopDriver（今天它只喂 kind:'desktop' 的 source）。
    // 没连 agent 时它返回 undefined，router 随即报 agent-disconnected。
    desktop: boot.desktopDriver,
  })

  return {
    ...base, // every non-browser field buildMcpExtras already returned
    // 下面的 getter 必须声明在 spread **之后**：spread 只拷贝求值结果，写进 base 里的 getter
    // 会在展开那一刻被拍成死值（`identify_speakers` 那一格为此红过一次）。
    // 「这条链接有没有具名行认领」：闭包在每次调用时才认领、才问 bindings.dispatch，装/卸包、改绑定
    // 都跟得上——这里只是把两个句柄递进去，不在装配期求任何值。
    resolveByLink: makeResolveByLink(boot.providerBindings, boot.providerExecutor, undefined),
    /**
     * 转成文字 / 补说话人的**注册门**：`hasKind` 问的是"这个 kind 此刻配好了没"，而这份 extras
     * 是装配期只建一次的——写成普通字段就等于把答案冻在开机那一刻。
     *
     * `kernel/plugins/conversions.ts` 里 identifyReady 的头注记的正是这条：声纹容器归 standby
     * 管，boot 那一刻多半还睡着，冻住的 false 会让 `identify_speakers` 在整个进程生命期里都
     * 不注册——而这类失败是安静的（工具只是不在工具面上，没有任何一处会喊）。
     *
     * 工具注册门读的就是这两格（`toolCatalog` 的 `if (extras.extract)` / `if (extras.identify)`），
     * 而 HTTP 那面每个请求现建一次 server，所以做成 getter 之后工具面自己就跟得上现实。
     * 守卫在 `mcp-extras.test.ts`「kind 的可用性每次现问」。
     */
    get extract() { return hasKind('extract') ? base.extractImpl : undefined },
    get identify() { return hasKind('identify') ? base.identifyImpl : undefined },
    // 原样转发那个 thunk（**不在这里求值**）：求了值就是把「此刻介入域在不在」冻住，
    // 而五个建图工具的注册门读的正是这一格——冻住的 undefined = 它们永远不注册，没有一处会喊。
    explorations: boot.explorations,
    cdpLook: (a) => router.look(a),
    cdpShot: (a) => router.shot(a),
    cdpAct: (a) => router.act(a),
    cdpPages: (a) => router.pages(a),
  }
}
