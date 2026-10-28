/**
 * HTTP + WS backend entry. Serves the REST API + live WS channel and runs the
 * scheduler in the background. The panel bundles (or any client) talk to this.
 * Logs to stdout.
 */
import '../load-env.ts' // make .env the backend secret source (RSSHub telegram session, etc.)
// owned-outbound 必须在任何 facility（尤其内嵌 RSSHub，其 request-rewriter 会 patch 全局 fetch /
// node:http）加载之前 import，才能在顶层同步快照到原始出站绑定。放在 load-env 之后、首位，收敛为
// 显式启动契约。时序保证来自 RSSHub 的运行时懒加载 + 本 import 首位（结构性早于任何补丁）；命门测试
// owned-outbound.sentinel.test.ts 锁死的是「捕获机制本身」（import 后再 patch，已存引用不受影响）。
// 别把它挪到其他 facility import 之后。
import '../http/owned-outbound.ts'
import { serve } from '@hono/node-server'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { resolveDataDir } from '../bootstrap.ts'
import { createStream, createRuntime, type Stream } from './index.ts'
import { createHttpApp, type HttpDeps } from '../http/app.ts'
import { writeFixtureFromItem } from '../content/ad-fixtures.ts'
import { WsHub, attachWs } from '../http/ws.ts'
import { toClientItem } from '../http/client-item.ts'
import { attachEventSourceRelay, EventSourceRelay } from '../event-source/relay.ts'
import { makeDrain } from '../event-source/drain.ts'
import { wireCookiesFeed } from '../event-source/cookies-feed.ts'
import { authorizeAccess, parseTrustedOrigins, isLoopbackAddress, peerAddress, lanBaseUrls } from '../http/access-guard.ts'
import { closeRelayServer } from '../http/ext-relay.ts'
import { deviceGateway, type DeviceGateway } from './device-gateway.ts'
import { summarizeCapability } from '../browser/capability-store.ts'
import { materializeExtension } from '../browser/extension-dir.ts'
import { installExtension } from '../browser/extension-install.ts'
import { uninstallExtension } from '../browser/extension-uninstall.ts'
import { reloadExtension } from '../browser/extension-reload.ts'
import { readExtensionConsole } from '../browser/extension-console.ts'
import { attachEnrichCommands } from '../http/enrich-ws.ts'
import { attachAuthLoginCommands } from '../http/auth-login.ts'
import { researchArtifactsDirFor } from './background.ts'

// 真相源在 src/ext-id.ts（扩展 id 的唯一定义处；access-guard 与 ext relay 都从那里读）。
import { STREAM_EXTENSION_ID as EXT_ID } from '../ext-id.ts'
import { DESKTOP_CAPABILITY_NAME, hostAgentSkipReason, mountHostAgent } from '../host-agent/mount.ts'
import { DebugLog } from '../http/debug-log.ts'
import { createFailureSink } from '../http/debug-sink.ts'
import { startLoopLagMonitor } from '../loop-lag.ts'
import { OpTracker, type TrackFn, type TrackSyncFn } from '../op-track.ts'
import { mountMcp } from '../http/mcp-mount.ts'
import { ACTION_RUN_DOMAIN, projectActionRun } from '../mcp/action-run.ts'
import type { RunStatus } from '../agent/search/types.ts'
import { withCapabilityTools } from '../mcp/capability-tools.ts'
import { mountConfigRows } from '../http/config-rows-routes.ts'
import { mountLiveRoutes } from '../http/live-routes.ts'
import { LiveStreamService } from '../live/service.ts'
import { mountResearchRoutes } from '../http/research-routes.ts'
import { localRecipesDir, mountLocalRecipeRoutes } from '../http/local-recipes-routes.ts'
import { mountImageGenerationRoutes, PRODUCES_IMAGES } from '../http/image-generation-routes.ts'
import { isCanonicalBrowserRecipe } from '../replay/recipe.ts'
import { mountSkillRoutes } from '../http/skills-routes.ts'
import { SKILLS_ROOT_REL } from '../skills/shipped.ts'
import { artifactsDirOf } from '../board/run-source.ts'
import { mountPanelAssets } from '../http/panel-mount.ts'
import { mountStandalonePage } from '../http/standalone-page.ts'
import { repoRoot, shippedRoot } from '../http/build-identity.ts'
import { mountTaskDashboard } from '../http/task-dashboard.ts'
import { mountPluginGateway } from '../http/plugin-gateway.ts'
import { mountTaskRoutes } from '../http/task-routes.ts'
import { mountWorkBuddyRoutes } from '../http/workbuddy-routes.ts'
import { helperClientFor } from '../workbuddy/runtime.ts'
import { mountInterventionRoutes } from '../http/intervention-routes.ts'
import { mountSourceHealthRoutes } from '../http/source-health-routes.ts'
import { SourceHealthIndex } from '../intervention/source-health-view.ts'
import { draftPath, readDraft } from '../intervention/explore-graph.ts'
import { AGENT_ROW_ID, readAgentConfig } from '../intervention/agent-config.ts'
import { localNameOf } from '../registry/source-id.ts'
import type { InterventionService } from '../kernel/plugins/intervention.ts'
import { errText } from '../err-text.ts'
import { ImportRunStore } from '../sharing/import-run-store.ts'
import { envCoveredFields } from '../kernel/plugins/runtime-config.ts'

/** 后端自己就是那扇门，默认口 = 唯一的对外口 8900（`DEFAULT_BACKEND_URL`、`GATEWAY_PORT`
 *  都是这个数）。曾经默认 4555 是容器时代的遗留：门在 Caddy 上，
 *  后端躲在网内，于是"起在 4555、探 8900"的默认组合让 spawn 必然超时（见 `mcp/spawn-backend.ts`
 *  的 C1 注释）。默认值对齐之后，那个坑连同它的补丁一起消失。
 *  compose 自托管旁支里后端仍躲在 Caddy 后面，那条路显式传 `STREAM_PORT=4555`（见
 *  `plugins/compose.ts`）——**显式的那一侧是特例，默认的这一侧是主路**。 */

/**
 * HTTP 面（D1）：实例的**全部**对外路由/挂载/中继接线。
 *
 * `routes(io)` 建并返回 Hono app（createHttpApp + 直连挂载 + 面板 + 任务面板）；调用方拿到它
 * 再去 listen。`attachRelayServers(server, io)` 把 ws 中继（扩展 / host / 事件源）与 Stream
 * Desktop 的宿主进程挂到**已监听**的 server 上——它们要的是在听的那个 socket，所以在
 * listen 之后调。实例的后台工作（调度中心、`scheduler.start()`、standby、research watchers、
 * `markInterruptedAtBoot`）不在路由里——它们归实例，`createStream()` 已经起好（design D1 附注）。
 *
 * io 只递 serve 独有的几样：实例本体、ws hub、debug 记录口、op 归因、端口与 restart 槽；
 * 其余一切从 `io.stream`（kernel / config / secrets / devices / capabilities）现取。
 */
import type { Hono } from 'hono'
import type { Server } from 'node:http'
import type { DebugEntry } from '../debug.ts'

export interface RouteIo {
  stream: Stream
  hub: import('../http/ws.ts').WsHub
  debugLog: import('../http/debug-log.ts').DebugLog
  track: TrackFn
  trackSync: TrackSyncFn
  port: number
  /** sidequest 面板的口（面板进程随 routes 起并只绑 127.0.0.1；缺省 8678）。 */
  dashboardPort?: number
  restart: NonNullable<import('../http/app.ts').HttpDeps['restart']>
  /**
   * 设备网关（openspec embeddable-device-gateway）。由调用方（serve.ts）用 serve 的口径建好
   * （isAdmin = 回环、backendUrls = 局域网地址），routes() 挂它的 HTTP 路由、attachRelayServers
   * 挂它的 upgrade——两处必须拿到**同一个**实例。
   */
  gateway: DeviceGateway
}

export async function routes(io: RouteIo): Promise<Hono> {
  const stream = io.stream
  const kernel = stream.kernel
  const config = stream.config
  const hub = io.hub
  const debugLog = io.debugLog
  const recordDebug: (e: DebugEntry) => void = (e) => { debugLog.put(e) }
  const { track, trackSync } = io
  const PORT = io.port
  const restart = io.restart
  // 域引用（serve 时代在 main 头部拆的那批）——全部从实例现取。
  const boot = stream
  const stores = kernel.stores
  const settingsStore = kernel.settings
  const pkgs = kernel.packages
  const sources = kernel.sources
  const harvest = kernel.harvest
  const { extToken, apiToken } = stream.secrets
  const { host: capabilityHost, loaded: loadedCapabilities } = stream.capabilities
  const { deviceStore, extBindings, facilityDevices, facilityBindings, nodes: browserNodes, identities: siteIdentities } = stream.devices
  const streamEvents = kernel.streamEvents
  /** 旧 /api/settings/video-sources 契约的状态投影（has* 布尔，key 永不回显）。 */
  const videoSourcesStatus = () => {
    const v = settingsStore.rows.resolve('video-sources')
    return {
      hasTmdbApiKey: !!v.tmdbApiKey,
      hasOmdbApiKey: !!v.omdbApiKey,
      language: (v.language as string | undefined) ?? 'zh-CN',
    }
  }

  // 归 harvest 域。
  const auth = kernel.auth
  // Provider 执行面住 `ctx.provider`（解析面 / 执行器 / 绑定 / 读模型 / 网盘两个 capability /
  // 视频详情 / 分集索引）。本域**全部**经 HttpDeps 下去，没有第二条直连接线。
  const provider = kernel.provider
  // 网盘（AList 对齐层）住 `ctx.netdisk`。**它有一条不走 HttpDeps 的直连**：下面调度中心
  // `taskDeps` 的三格（netdisk / netdiskStore / reconcile）。漏改那三格不报错——
  // netdisk-autosync 每轮「成功」实为 deps undefined 早退，网盘几天不同步零报警。
  const netdiskDomain = kernel.netdisk
  // 搜索扇出住 `ctx.search`（内容搜索 / 资源搜索批量与流式 / 两个归一化口）。本域全部经
  // HttpDeps 下去，没有第二条直连接线。
  const search = kernel.search
  // 转换底座住 `ctx.conversions`（转换资源 / 声纹库 / 引擎 / job 账本 / 转成文字）。**它有一条
  // 不走 HttpDeps 的直连**：下面调度中心 `taskDeps` 的 `capabilityJobs` 那一格。漏改不报错——
  // jobs-sweep 每轮「成功」实为 deps undefined 早退，卡住的 job 永远没人收。
  const conversionsDomain = kernel.conversions
  // 对话 / 搜索 agent / 意图跟踪住 `ctx.agent`（会话库 / 心愿单 / 摘要 prompt 状态面 /
  // 网页搜索梯子 / search agent / 意图服务 / mcpExtras）。**它有两条不走 HttpDeps 的直连**：
  // `mountMcp` 的第三个参数（mcpExtras）与调度中心 `taskDeps` 的 `intents` 那一格。前者漏改
  // 是 MCP 工具面整片消失，后者漏改不报错——intent 的定时消化每轮「成功」实为 deps undefined
  // 早退，意图几天不消化零报警。
  const agentDomain = kernel.agent
  // 采集调度住 `ctx.scheduling`（Scheduler / StreamService / baseAdRules / health /
  // lastHarvestAt）。**它有两条不走 HttpDeps 的直连**：下面 `mountMcp` 的第一个参数（service）
  // 与 `maybeStartScheduler`。关停不在这里——两步都是域内 effect，`quiesceKernel` 撤销。
  const scheduling = kernel.scheduling
  stores.downloadQueue.onJob((job) => hub.broadcast({ type: 'audio-download', job }))
  // 库存（频道 / Stream / 空间）变了就告诉所有前端一声，让它们自己重读。
  //
  // **这条通知的理由是"改配置的不止用户自己"**：对话里让 AI 去订阅一个源、改一个频道，走的是
  // MCP 工具、不经过任何一个网页里的按钮。没有它，页面上那份配置就停在打开时那一刻，而且
  // 不报错——用户会以为 AI 没做成，再做一遍。
  //
  // **合并成一拍**：一次「订阅」是好几次写（建 stream + 并进频道的引用表 …），逐次广播就是
  // 逐次让每个前端重拉一遍 `/api/channels`。`setTimeout(0)` 把同一轮里的写收成一次。
  // 不用 `queueMicrotask`：写是同步的，微任务在同一个 tick 末尾就跑，收不住跨 await 的那几次。
  kernel.effect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined
    const off = stores.channels.onChange(() => {
      if (pending !== undefined) return
      pending = setTimeout(() => { pending = undefined; hub.broadcast({ type: 'inventory' }) }, 0)
    })
    return () => { off(); if (pending !== undefined) clearTimeout(pending) }
  })
  // 前端「打开一条」的 WS 现取：派发到包交出的 enricher 表（`content.enrich.source` 指哪个就查哪个）。
  // thunk 而不是把 Map 冻进去：表随包装载填充，装配期取值就是那个"开机时不对、过一会儿才对"的形状。
  attachEnrichCommands(hub, { enrichers: () => pkgs.activated.enrichers })
  attachAuthLoginCommands(hub, { startLogin: auth.startLogin })

  /** 把扩展目录物化到 `<dataDir>/extension/`。**手动装和代装调的是同一个函数**——两条路指向
   *  同一个目录，出问题时排查只有一个路径（spec 2026-08-30-extension-onboarding §5）。
   *  发行形态下仓库产物不在场，落 npm 包那一档：`resolve` 拿的是包里 `package.json` 的位置，
   *  因为包根不一定是个可被 `require.resolve` 直接命中的模块。 */
  const materializeStreamExtension = () =>
    materializeExtension({
      // **两个锚**：源码跑时产物在仓库根下；打包产物里 `server.mjs` 住资源目录，那一份的锚
      // 是 cwd（和 `packages_dir=./packages` 同一个锚，见 build-server.mjs 里拷它的那一步）。
      // 挑"产物真在那儿"的那个，挑不出来就回落仓库根——让错误消息里出现的是熟悉的那条路径。
      repoRoot: shippedRoot('extension/.output/chrome-mv3'),
      dataDir: resolveDataDir(config),
      resolvePkg: (spec) => dirname(createRequire(import.meta.url).resolve(`${spec}/package.json`)),
    })

  // 动作 run 的读口（`runAction` 回 running 之后调用方等结果用）。读的是 MCP `get_agent_run`
  // 同一本库、同一份投影——只认 `domain:'action'` 那些行，别的 run 在这条路上是 404。
  // `/api/recipes/action/:runId` 与豆包生图口共用这一个。
  const actionRun = (runId: string) => {
    const rec = agentDomain.searchAgent.get(runId) as
      | { domain?: string; goal: string; status: RunStatus; updatedAt: string; result?: unknown; error?: string }
      | null
    return rec && rec.domain === ACTION_RUN_DOMAIN ? projectActionRun(runId, rec) : null
  }


  const app = createHttpApp({
    service: scheduling.service,
    restart,
    articles: stores.articles,
    favicons: stores.favicons,
    resolve: { registry: sources.registry, resolveEngine: provider.resolveEngine, intentResolver: provider.intentResolver, radarMatcher: provider.radarMatcher, sourceHealth: stores.sourceHealth, streams: () => scheduling.scheduler.list(), lyricsCache: stores.audioArchive },
    channelStore: stores.channels,
    sharing: {
      store: stores.channels,
      registry: sources.registry,
      identities: sources.identities,
      plugins: pkgs.plugins,
      // getter：install 热挂载后归并快照会整体换掉，分享路由每次请求经它读到最新（I-1）。
      recipePackages: () => sources.recipePackages().list,
      recipesUserDir: sources.recipesUserDir,
      runs: new ImportRunStore(join(dirname(config.item_db), 'import-runs.json')),
      bindings: provider.providerBindings,
      directory: provider.providerDirectory,
      mappingStore: netdiskDomain.netdiskRoutes?.store,
    },
    onboard: { wishlist: agentDomain.onboardWishlist },
    // 动作 recipe 的脚本入口，**递的就是 MCP 在用的那一个闭包**——不在这里重新装配一份
    // ActionRecipeDeps：那样两条路的 findRecipe / runBrowser / browserConnected 会各自演化，
    // 而"同一条 recipe 走两条路行为不一样"是查不出源头的那种坏法。
    runAction: agentDomain.mcpExtras.runActionRecipe,
    actionRun,
    providers: { executor: provider.providerExecutor, stats: provider.providerStats },
    resolveDownloads: provider.resolveDownloads,
    providerBindings: provider.providerBindings,
    videoDetails: provider.videoDetails,
    episodeIndex: provider.episodeIndex,
    netdisk: netdiskDomain.netdisk,
    // **原样传内核那一份，别在这儿往上加格子。** `openReconcile` 曾经装在这里，结果只喂饱了
    // HTTP 这一端：MCP 工具面读的是 `ctx.netdisk.netdiskRoutes`（另一个对象），模型手里因此
    // 压根没有那个工具，而且没有任何一处报错。要给这一域加能力就去 `kernel/plugins/netdisk.ts`。
    netdiskRoutes: netdiskDomain.netdiskRoutes,
    netdiskShare: provider.netdiskShare,
    netdiskPlay: provider.netdiskPlay,
    debug: { record: recordDebug, recent: (o) => debugLog.recent(o), clear: () => debugLog.clear() },
    track,
    baseAdRules: scheduling.baseAdRules,
    itemStore: stores.itemStore,
    // 归堆账本要在这里显式接上：bootstrap 建了不算数——HttpDeps 是三处接线
    // （app.ts 的类型 / bootstrap 的产出 / 这里的注入），漏了这一处的症状是
    // 单测全绿而真端点恒 503（`storyGroup` 也永远不出现）。
    storyFold: stores.storyFold,
    seenStore: stores.seenStore,
    health: scheduling.health,
    lastHarvestAt: scheduling.lastHarvestAt,
    authFacilities: auth.authFacilities,
    reconcileAuth: auth.reconcileAuthNow,
    focusLoginTab: harvest.focusLoginTab,
    events: streamEvents,
    pageLook: harvest.pageLook,
    closeFacilityTabs: harvest.closeFacilityTabs,
    pageShot: harvest.pageShot,
    normalizeSearchItem: search.normalizeSearchItem,
    renormalizeItems: search.renormalizeItems,
    links: sources.links,
    serving: sources.serving,
    recipePackageOps: sources.recipePackageOps,
    videoSearch: search.videoSearch,
    videoSearchStream: search.videoSearchStream,
    facetResources: search.facetResources,
    packageEnrichers: pkgs.activated.enrichers,
    packageConnect: pkgs.activated.connect,
    credentialProvider: boot.kernel.credentials.cookieProvider,
    // broker 的鉴权面：认包 token、按包申报的域放行（漏接这两个 → 端点 fail-closed 403）。
    speakerRegistry: conversionsDomain.speakerRegistry,
    conversions: conversionsDomain.conversions,
    pluginStatus: pkgs.pluginStatus,
    setPluginEnabled: pkgs.setPluginEnabled,
    packageInventory: pkgs.packageInventory,
    packagePending: pkgs.pending,
    containerOps: pkgs.containerOps,
    alist: { status: pkgs.alist.status, test: pkgs.alist.test, permanentToken: pkgs.alist.permanentToken },
    extSyncConfig: () => boot.kernel.credentials.extSyncConfig(),
    summaryPrompt: { status: agentDomain.summaryPromptStatus, set: agentDomain.setSummaryPrompt },
    // 这两格直接吃 `kernel.settings`——它们从来只是设置库的一层转调，没有 bootstrap 才有的
    // 知识，所以不必绕一趟 Boot。videoSources 的写路径已收进配置 row 引擎
    // （`rows.put('video-sources')`，密文保留/校验只有引擎那一份），这两格现在是
    // 旧 /api/settings/video-sources 端点的薄转发；status 形状（has* 布尔）保持旧契约。
    videoSources: {
      status: () => videoSourcesStatus(),
      set: async (next) => {
        await settingsStore.rows.put('video-sources', next as Record<string, unknown>)
        return videoSourcesStatus()
      },
    },
    // source family 转发（config-rows slice3）：分层/密文/校验只有引擎一份。
    sourceRuntimeConfig: {
      status: (ref) => settingsStore.rows.status(`source:${ref}`),
      set: (ref, values) => settingsStore.rows.put(`source:${ref}`, values),
      // 反查（哪条 recipe 产出这一格）归 Source 域；这里只是把它接到 HTTP 面上。
      provisioner: (ref) => sources.configProvisionerFor(ref),
      // 现取 registry：热装的包声明的格下一次问就算数。表外的 ref（含 perInstance 的 `llm:<名>`）回空。
      envCovered: (ref) => envCoveredFields(
        ref,
        Object.keys(sources.registry.all().find((m) => m.runtime_config?.ref === ref)?.runtime_config?.fields ?? {}),
        config.deployment?.env ?? {},
      ),
      // `userInitiated: true` 够格的依据：这个闭包**只有** `POST /api/source-runtime-config/provision`
      // 一个消费方，而那个端点只由配置卡上那颗需要用户先在弹窗里点第二下的按钮触发——没有任何
      // 调度 / 定时 / 批处理路径走得到这里。宿主自己直调 `scheduler.readSource` 并打这个标记的，
      // 今天只剩这一处；其余"用户当场点的动作"（如点赞 / 收藏）一律走 `runActionRecipe`，
      // 由它统一管这个标记。
      // 今天这条 recipe 不是 `meta.action:true`（标了反而会被 `readSource` 拒掉），但标记照打：
      // 它陈述的是"这次是谁发起的"，那是事实，不该等到闸门收紧那天才补。
      // **加第二个消费方之前回到这里重新论证一遍**，不够格就得去掉这个标记。
      provision: async (ref, params) => {
        const p = sources.configProvisionerFor(ref)
        if (!p) throw new Error(`没有任何 recipe 声明它产出 ${ref} 这一格配置`)
        await scheduling.scheduler.readSource(p.sourceId, params, { userInitiated: true })
      },
    },
    keyState: sources.keyState,
    adapters: kernel.adapters,
    audioArchive: stores.audioArchive,
    subtitleCacheDir: netdiskDomain.subtitleCacheDir,
    downloadQueue: stores.downloadQueue,
    collections: stores.collections,
    watchProgress: stores.watchProgress,
    // extId：扩展的 POST 带 `Origin: chrome-extension://<id>`，同源判据对它不成立，得单独认。
    // trustedHosts：自托管挂了域名/反代时用户自己登记（默认只认 IP 与 localhost，防 rebinding）。
    // trustedOrigins：**非本机口上的页面**要打这里的 `/api/*` 时登记（精确串匹配）。本机来源
    // （127.0.0.1 / localhost 任意口，用户 DSH 里那张 Stream 页就是）`isTrustedOrigin` 默认就认，
    // 不用登记；这份只留给后端和页面不在同一台机器的场景。默认空。
    accessGuard: {
      token: apiToken,
      extId: EXT_ID,
      trustedHosts: config.trusted_hosts,
      trustedOrigins: parseTrustedOrigins(process.env.STREAM_TRUSTED_ORIGINS),
    },
    extRelayAuth: { token: extToken, extId: EXT_ID, tokenHashOf: (id) => extBindings.tokenHashOf(id) },
    intents: agentDomain.intents,
    // 「组件」页那一列：这个包给了哪些工具。**thunk**——见 HttpDeps.capabilityTools 的头注。
    // 键是**包 id**（界面按包列行），值来自 host 按**能力名**分的那张表，装载回执里两者对得上。
    capabilityTools: () => {
      const byName = capabilityHost.toolsByCapability()
      return Object.fromEntries(loadedCapabilities.map((c) => [c.pkg.id, byName[c.name] ?? []]))
    },
    // 只读诊断探针 GET /api/ext/relay-status 的数据源（下方 attachExtRelay 挂的是同一个 relay 实例）。
    extRelayStatus: () => harvest.extRelay.status(),
    claimedTabs: harvest.claimedTabs,
    // GET /api/browser-capability 的数据源：relay 现状 + 落盘的 everSeen 缓存，纯读、不探测。
    browserCapability: () => summarizeCapability(harvest.extRelay.status(), harvest.browserCapability.get()),
    // 全量诊断 + 设置页的 Chrome 选择面。**摸文件系统**，所以只挂在这两条路上，不进快判。
    harvestBrowser: harvest.harvestBrowser,
    // 扩展安装引导（spec 2026-08-30-extension-onboarding）。物化只在真要装时才做——绝大多数
    // 启动都用不到，boot 期多拷几 MB 是纯浪费。
    extensionOnboarding: {
      state: () => settingsStore.extensionOnboarding(),
      materialize: () => materializeStreamExtension(),
      install: async () => {
        const driver = harvest.desktopDriver()
        // 抛，不回 blocked：`blocked` 的意思是"跑了、卡在某一步"，而这是**根本没跑**。
        // 两者的下一步完全不同（去看 Stream Desktop vs 去看 Chrome）。
        if (!driver) throw new Error('Stream Desktop 没连上，桌面这一档整个不可用——代装跑不了')
        // **代装前先物化一遍**：手动装那条路调的是同一个函数，两条路必须指向同一个目录。
        const { dir } = materializeStreamExtension()
        return installExtension({
          driver,
          extensionDir: dir,
          // 卡住时请 AI 介入，和采集那条路同一个收件人；现取——介入域装配得晚。
          repairRunner: (kernel.intervention as InterventionService | undefined)?.repairRunner,
          // 唯一的成功判据（spec §3）：扩展连上中继。上限 15s、间隔 500ms。
          waitForConnected: async () => {
            for (let i = 0; i < 30; i++) {
              if (harvest.extRelay.status().connected) return true
              await new Promise((r) => setTimeout(r, 500))
            }
            return harvest.extRelay.status().connected
          },
          // 会话租约（接管指示条 + Ctrl+Alt+Esc 中止）**不在这里接**：这一趟是一条 desktop
          // recipe，`runDesktopRecipe` 自己就把整趟包进 driver 的租约里（那是唯一的咽喉，
          // 三个调用方共用）。在这儿再包一层等于同一把锁要两次。
        })
      },
      uninstall: async () => {
        const driver = harvest.desktopDriver()
        if (!driver) throw new Error('Stream Desktop 没连上，桌面这一档整个不可用——卸载跑不了')
        return uninstallExtension({
          driver,
          // 判据和装的时候对称：**中继断开**才算卸掉了，不看页面上卡片还在不在。
          waitForDisconnected: async () => {
            for (let i = 0; i < 30; i++) {
              if (!harvest.extRelay.status().connected) return true
              await new Promise((r) => setTimeout(r, 500))
            }
            return !harvest.extRelay.status().connected
          },
        })
      },
      reload: async () => {
        const driver = harvest.desktopDriver()
        if (!driver) throw new Error('Stream Desktop 没连上，桌面这一档整个不可用——重载跑不了')
        return reloadExtension({
          driver,
          relaySince: () => harvest.extRelay.status().since,
          // 判据：中继以**新的** since 连上（扩展重启后重连）。上限 20s、间隔 500ms。
          waitForReconnect: async (before) => {
            for (let i = 0; i < 40; i++) {
              const s = harvest.extRelay.status()
              if (s.connected && s.since && s.since !== before) return s.since
              await new Promise((r) => setTimeout(r, 500))
            }
            return null
          },
        })
      },
      readConsole: async () => {
        const driver = harvest.desktopDriver()
        if (!driver) throw new Error('Stream Desktop 没连上，桌面这一档整个不可用——读不了扩展控制台')
        return readExtensionConsole(driver)
      },
      decline: () => settingsStore.declineExtensionOnboarding(new Date().toISOString()),
    },
    // 非广告 label → capture the false positive as a negative ad-fixture
    recordNegative: (item) => writeFixtureFromItem(item, 'negative', new Date().toISOString()),
  })

  // 接缝：`mcpExtras` 从 agent 域取（`service` 仍在 Boot，批次 8 才轮到它）。这一格**不走
  // HttpDeps**，漏改的症状是 MCP 工具面整片消失——它是那 25 格逐项转发表的唯一出口。
  // `withCapabilityTools` 而不是 `{...}` 展开：那份 extras 里有一批 getter，展开就冻住了。
  await mountMcp(app, scheduling.service, withCapabilityTools(agentDomain.mcpExtras, () => capabilityHost.toolDefs()))
  // 配置 row 的通用端点对（GET/PUT /api/config/:rowId）：同上直连挂 app，不进 HttpDeps。
  // row 由各归属域注册（settings/agent/harvest），这里只递引擎。
  mountConfigRows(app, { rows: settingsStore.rows })
  // live present 的取数面（spec 2026-08-25-research-present）：同款直连挂载，不进 HttpDeps。
  // 四格取法与 brief 草稿不同，均照本文件现场已有的同名变量/口径改写：
  //   - manifestOf 是 `sources.registry.get`，不是 `.source`（registry 只有 get 这个查法）。
  //   - adapterFor 用 `kernel.adapters`（本文件里已有的同一张 Map，见上面 `adapters: kernel.adapters`），
  //     bootstrap.ts 里的 `activated.adapters` 是 bootstrap 函数作用域局部变量，serve.ts 够不到。
  //   - runtimeConfigFor 用 `kernel.runtimeConfig`（runtime-config.ts 的 `runtimeConfigPlugin` 挂的
  //     ctx 提供值），不是穿一份 bootstrap 局部变量进来：bootstrap 只把 `runtimeConfigFor` 显式递给了
  //     四个「blessed」消费点（BuiltinAdapter / Scheduler / ResolveEngine / 分集索引），没有从
  //     `bootstrap()` 的返回值里带出来给 serve.ts；`ctx.runtimeConfig` 正是给这类新消费点用的公开口。
  const liveStreams = new LiveStreamService({
    getStream: (id) => stores.channels.getStream(id),
    manifestOf: (sourceId) => sources.registry.get(sourceId),
    adapterFor: (m) => kernel.adapters.get(m.adapter),
    runtimeConfigFor: (m) => kernel.runtimeConfig(m as never),
  })
  mountLiveRoutes(app, { live: liveStreams })
  // research present 的详情面（GET /api/research/streams/:streamId/runs/:runId[/artifacts/:name]）：
  // 同款直连挂载，不进 HttpDeps。streamId → artifacts 目录的解析与实例侧的 research watcher
  // 共用同一条（`researchArtifactsDirFor`，src/engine/background.ts）——两条路各写一遍，
  // 改一处漏一处就是「详情页有、推送没有」的那种分叉。只取该 stream 的第一个成员——
  // research present 一个 stream 只绑一个 research-runs 源。
  mountResearchRoutes(app, { dirForStream: researchArtifactsDirFor(stream) })
  // 「我自己写的 recipe 放哪 / 它装载了吗」。`mounted` 是**独立的那一端**——问活着的 registry，
  // 不是让这条路由自己再解析一遍盘上的文件（那样只能证明"我又读了一次"）。
  mountLocalRecipeRoutes(app, {
    recipesDir: localRecipesDir(resolveDataDir(config)),
    mounted: (id) => sources.registry.get(id) !== undefined,
  })
  // 动作 recipe → OpenAI images 形状的适配器（spec 2026-09-14-doubao-image-openai-bridge-design）。
  // 宿主不点名任何包：哪些 recipe 是"模型"由它们自己申报 `meta.produces:"images"`，这里只现算一张表。
  // 递的 runAction / actionRun 和 `/api/recipes/action` 那两格是同一个闭包——它只是动作 recipe
  // 的另一件外衣，不另装配一份 deps。
  mountImageGenerationRoutes(app, {
    targets: pkgs.targets,
    runAction: agentDomain.mcpExtras.runActionRecipe,
    actionRun,
    // 只有 canonical browser recipe 有 `output.targetCount`（一轮固定出几张）；模型 id = sourceId。
    models: () =>
      [...sources.liveRecipes.current]
        .filter(([, r]) => r.meta?.action === true && r.meta?.produces === PRODUCES_IMAGES)
        .map(([id, r]) => ({ id, perRun: isCanonicalBrowserRecipe(r) ? r.output.targetCount : 1 })),
  })
  // 「把 Stream 的 skill 装进我自己的 Claude Code / Codex」（spec 2026-09-05-skill-delivery-design）。
  // 同款直连挂载，不进 HttpDeps。根按"东西在不在"挑，和扩展物化同一个形状——发行形态下
  // `.claude/skills/` 住资源目录，dev 下住仓库根。
  mountSkillRoutes(app, {
    sourceRoot: shippedRoot(SKILLS_ROOT_REL),
    dataDir: resolveDataDir(config),
    home: homedir(),
  })
  // 设备面（openspec embeddable-device-gateway）：配对 / 设备 / 扩展绑定 / 节点 / 身份四组路由与
  // 两条中继的 upgrade 全部装在 deviceGateway 里，serve 与嵌入方用同一个入口。这里的口径就是
  // 历史行为：管理类端口只认本机回环，配对回执给局域网地址。
  // 网关实例由调用方（serve.ts）建好、随 io 递进来——attachRelayServers 挂 upgrade 要用同一份
  // （网关握着 ProfileClaims 的接线，两份实例就会双重登记认领钩子）。
  const gateway = io.gateway
  // 逐条挂（不是只挂 app）：网关可能还要在**扩展写死的** `/api/ext/*` 上答话，见 `mounts` 的头注。
  for (const m of gateway.mounts) app.route(m.path, m.app)
  // 任务面（store/ledger/编译口）的装配在实例后台（`src/engine/background.ts`）：store 与
  // 账本由实例打开（两边各开一份 sqlite 连接就是两套状态），路由经 `tasks.assembly` 只读。
  // 查询档（scheduler=false）下 `builtins` 缺席 → 内置任务清单诚实地报空；store/ledger 开不
  // 起来（罕见：文件锁/权限/磁盘满）时整个任务面缺席——TaskRoutesDeps 要求 store/ledger 非空。
  const assembled = stream.tasks.assembly
  mountWorkBuddyRoutes(app, helperClientFor(config.deployment?.workbuddy_helper_url))
  if (assembled.store && assembled.ledger && assembled.compileRow) {
    mountTaskRoutes(app, {
      store: assembled.store,
      ledger: assembled.ledger,
      builtins: () => (assembled.builtins ?? []).map((t) => ({
        id: t.id, label: t.label, schedule: t.schedule,
        ...(t.timezone === undefined ? {} : { timezone: t.timezone }),
        ...(t.group === undefined ? {} : { group: t.group }),
        ...(t.exclusiveOn === undefined ? {} : { exclusiveOn: t.exclusiveOn }),
        ...(t.whenBusy === undefined ? {} : { whenBusy: t.whenBusy }),
      })),
      actions: () => [...(assembled.actions?.keys() ?? [])],
      apply: (row) => stream.tasks.addTask(assembled.compileRow!(row)),
      unapply: async (id) => { await stream.tasks.removeTask(id) },
      runNow: (id) => stream.tasks.runTaskNow(id),
    })
  }
  // 源健康：三本账合成一个词（spec 2026-09-12）。介入域缺席时 run / 提议两格永远空，状态词最多到 quarantined。
  {
    // 调用时现取，别在装配期冻住答案（AGENTS.md「装配期取的值 = 冻住的答案」）：
    // 介入域可能在后端启动之后才被配置/重载，下面几个 thunk 与 repairs getter 都要看到那时的值。
    const intervention = () => kernel.intervention as InterventionService | undefined
    const ledger = kernel.repairLedger
    const quietManifest = (id: string) => { try { return sources.registry.get(id) } catch { return undefined } }
    const packageFor = (sourceId: string) => sources.recipePackages().list.find((p) => p.sources.some((m) => m.id === sourceId))
    const index = new SourceHealthIndex({
      manifest: quietManifest,
      site: (e) => sources.sites.lookup(e),
      health: (id) => stores.sourceHealth.get(id),
      healthIds: () => Object.keys(stores.sourceHealth.snapshot()),
      ledger: (id) => ledger.get(id),
      ledgerIds: () => Object.keys(ledger.snapshot()),
      runs: (id) => intervention()?.store.list({ sourceId: id, limit: 50 }) ?? [],
      runSourceIds: () => [...new Set((intervention()?.store.list({ limit: 1000 }) ?? []).map((r) => r.sourceId))],
      events: (runId) => intervention()?.store.events(runId, { limit: 2000 }) ?? [],
      // 草稿按 facility 分文件（与学到的图同目录），而视图那一层只有 sourceId——facility 在这儿解。
      draftFor: (sourceId, runId) => {
        const facility = packageFor(sourceId)?.facility
        return facility ? readDraft(draftPath(join(resolveDataDir(config), 'state-graphs'), facility, runId)) : undefined
      },
      proposals: (id) => intervention()?.store.proposals({ sourceId: id }) ?? [],
      channels: () => stores.channels.listChannels(),
      streams: () => scheduling.scheduler.list(),
      currentRecipe: (id) => {
        const pkg = packageFor(id)
        if (!pkg) return undefined
        try { return JSON.parse(readFileSync(join(pkg.dir, `${localNameOf(id)}.recipe.json`), 'utf8')) as unknown } catch { return undefined }
      },
      // `AgentConfig` 的限额住在 `limits.{turns,tokens,wallMs}`，视图那一格要的是分钟制的三个数。
      limits: () => {
        const cfg = readAgentConfig(kernel.settings.rows.resolve(AGENT_ROW_ID))
        return cfg
          ? { maxTurns: cfg.limits.turns, maxTokens: cfg.limits.tokens, maxWallMinutes: Math.round(cfg.limits.wallMs / 60_000) }
          : undefined
      },
    })
    mountSourceHealthRoutes(app, {
      index,
      get repairs() { return intervention()?.repairs },
      reasonFor: (id) => ledger.get(id)?.lastReason ?? stores.sourceHealth.get(id)?.lastError ?? 'manual',
      affectedFor: (id) => { try { return sources.registry.affectedSources(id).affected } catch { return [id] } },
    })
  }
  // 介入域缺席（没配 LLM / 关掉了）时这几口整条不挂：挂一个只会回空的读口，等于告诉界面
  // 「介入跑过、什么都没产出」，而实际是这台机器根本没开介入——缺席就该 404，别补空答案。
  if (kernel.intervention) {
    mountInterventionRoutes(app, {
      store: kernel.intervention.store,
      graphs: kernel.intervention.graphs,
      repairs: kernel.intervention.sessions,
      explorations: kernel.intervention.explorations,
      // 探索挂在 facility 上，而露面（run 列表 / 源健康）按源记账——拿这个包的第一个源当那一行。
      facilityOf: (f) => {
        const id = sources.recipePackages().byFacility.get(f)?.sources[0]?.id
        return id ? { sourceId: id } : undefined
      },
    })
  }
  // 面板产物（app/ 打出来的 IIFE bundle）的出口。必须在 dev 反代 / SPA 兜底之前挂，
  // 否则 /panel/* 被整段吞成 index.html。同上直连挂 app，不进 HttpDeps。
  // **根要挑，不能写死 `repoRoot`**：打包形态下整个后端是一个 `server.mjs`，`repoRoot` 算出来
  // 是资源目录的上两级（不存在），于是 `/panel/*` 恒 404 —— 工作台里报「bundle 加载失败」，
  // 而那句话给的两个猜测（后端没起 / 没 build:panel）都不是真因。同扩展目录那一处，见 `shippedRoot`。
  mountPanelAssets(app, { root: join(shippedRoot('app/dist-panel'), 'app', 'dist-panel') })
  // Sidequest 面板：经 /_p/sidequest 整路透传到本机回环的面板口。必须先于
  // mountPluginGateway 注册，因为两者都处理 /_p/* 路由，更具体的规则需要优先匹配。
  // 面板进程**在这里起、也只在这里起**（design D1 附注）：它是 HTTP 面，不挂路由的嵌入方
  // 不多一个端口；只绑 127.0.0.1（原状是随 tasks.start 起且绑全部网卡，同进程第二实例必撞口）。
  const dashboardPort = io.dashboardPort ?? 8678
  mountTaskDashboard(app, { port: dashboardPort })
  await stream.tasks.startDashboard(dashboardPort, (m) => console.log(m))
  // /_p 插件网关：与 mountMcp 同样直接挂在 app 上（不进 HttpDeps，避开三处接线陷阱——见
  // src/http/plugin-gateway.ts 头注）。descriptors 用包域加载后的那份描述符
  // （PluginDescriptor[]，sharing.plugins 已用同一字段）；mode 读
  // STREAM_PLUGIN_NETWORK。mode=none 或无插件能解析出 target 时自行 no-op，不注册路由。
  // descriptors 必须是**两层合并**（`pkgs.backendDirectory`）：只喂 `pkgs.plugins` 的话，
  // 第三方包的容器被建起来、被 standby 管着，`/_p/<包 id>` 却恒 404——建了没人打得到，
  // 而且一行日志都不会提（终审 Important 3）。同一份合并名单也喂给包域里的 target resolver。
  mountPluginGateway(app, {
    descriptors: pkgs.backendDirectory.all(),
    mode: config.deployment?.plugin_network ?? 'none',
    standby: pkgs.standby,
  })

  // 前端那一层：必须最后挂载——兜底 `*` 若挂在 mountMcp/mountPluginGateway/mountPanelAssets
  // 之前会抢先吞掉 /api/mcp、/_p/*、/panel/*。
  //
  // 这一层只有一种形态：8900 的独立正门（standalone-page.ts）——一张自包含页挂同一批面板
  // bundle。对话不在这里，对话在用户自己的宿主（Claude Code / Codex / DSH）里，经 MCP 使唤
  // 这个后端（spec 2026-09-05）。
  mountStandalonePage(app)

  return app
}

/** 把 ws 中继与 Stream Desktop 宿主挂到已监听的 server 上（listen 之后调；理由见文件头注）。 */
export function attachRelayServers(server: Server, io: RouteIo): void {
  const stream = io.stream
  const kernel = stream.kernel
  const config = stream.config
  const hub = io.hub
  const debugLog = io.debugLog
  const PORT = io.port
  const { extToken, apiToken } = stream.secrets
  const { host: capabilityHost, loaded: loadedCapabilities } = stream.capabilities
  kernel.effect(() => () => { server.close() })
  attachWs(server as unknown as Server, hub, (req, url) =>
    authorizeAccess({
      remoteAddress: req.socket.remoteAddress,
      bearer: req.headers.authorization,
      queryToken: url.searchParams.get('token'),
      token: apiToken,
    }) !== 'denied'
  )
  // 扩展中继（/api/ext）与 host 中继（/api/host）的握手都装在设备网关里（openspec
  // embeddable-device-gateway，与 routes() 挂的四组路由同一份实例）：这里把网关的认领函数挂到
  // 已监听的 server 上，`close()` 登记成内核 effect——`closeRelayServer` 先断连再关服务器
  // （interval 挂在连接上，光 close 服务器清不掉它），关停期没有常驻连接泄漏。
  // 事件源中继（/api/event-source）不在网关里：它是「外部子进程收信端」，不是设备面。
  const gateway = io.gateway
  kernel.effect(() => () => gateway.close())
  server.on('upgrade', (req, socket, head) => { gateway.handleUpgrade(req, socket, head) })
  // 外部事件源子进程的收信端 at /api/event-source（Spec 1 只装端点，spawn/看护留 Spec 2）。
  // 与上面两条中继同一把 `extToken`、同一个 teardown 形状。事件帧经 `drain` 触发已注册任务
  // （`EVENT_SOURCE_TASK_MAP` 现为空 → 每个事件都 mapToTask=null，drain 直接 ack；Spec 2 加
  // `{ xianyu: '<发货任务>' }`）；`hello` 帧按子进程声明的域名，把后端已有的 cookie 快照喂回去。
  // 喂 cookie 走**只读**接缝：直接读 `cookieProvider.cookiesFor`，不催新鲜度、不拉浏览器
  //（那条带 ensureFresh 的路是能力包热路径专用，见 src/engine/capabilities.ts 的 provideBrowserCookies 头注）。
  // 不变量（追到另一端）：outbox 是「至少一次」投递——崩溃前未 ack 的事件会在重连后被重推，
  // 且真 runTaskNow(id) 无条件 enqueue、drain 的防重只按 taskId 不按事件 id，都不足以防双发。
  // 所以这张表映射到的任务【必须按事件 id 幂等】（闲鱼＝按 order_id）。往表里加映射前先读这条。
  const EVENT_SOURCE_TASK_MAP: Record<string, string> = {}
  kernel.effect(() => {
    const esRelay = new EventSourceRelay(
      (frame, sock) => void drain(frame, sock),
      (hello, _sock) => void cookiesFeed.onHello(hello.domains),
      (line) => console.log(line),
    )
    const drain = makeDrain({
      mapToTask: (ev) => EVENT_SOURCE_TASK_MAP[ev.source] ?? null,
      runTaskNow: (id) => stream.tasks.runTaskNow(id),
      log: (line) => console.log(line),
    })
    const cookiesFeed = wireCookiesFeed(esRelay, {
      cookiesFor: (domain) => kernel.credentials.cookieProvider.cookiesFor(domain),
    })
    const wss = attachEventSourceRelay(server as unknown as Server, esRelay, { token: extToken })
    return () => closeRelayServer(wss)
  })
  // 后端自己养 Stream Desktop 的本机进程（登记 native messaging + 拉起 + 看护）：扩展配对要经它
  // 拿 relay token，没人养 = 扩展永远 never-seen 且不报错。理由见 host-agent/mount.ts 头注。
  // 挂在 relay 之后：它起来就会连 /api/host，门得先开。
  {
    const skip = hostAgentSkipReason()
    // 前缀与这个能力挂上之后它自己那条日志一致（`[stream-<能力名>]`，host 按能力名派生）。
    // 两个前缀会让"这台机器上 Stream Desktop 到底怎么了"分成两串日志，而它是同一件事。
    if (skip) console.log(`[stream-${DESKTOP_CAPABILITY_NAME}] ${skip}`)
    else {
      kernel.effect(() => {
        const disposing = mountHostAgent({
          // 与可选包同一个宿主：服务总线和工具表都只有这一份。
          host: capabilityHost,
          baseUrl: `http://127.0.0.1:${PORT}`,
          dataDir: resolveDataDir(config),
          extensionId: EXT_ID,
          log: (msg) => console.log(msg),
        })
        return async () => { await (await disposing)() }
      })
    }
}
}
