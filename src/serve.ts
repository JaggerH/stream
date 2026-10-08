/**
 * HTTP + WS backend entry. Serves the REST API + live WS channel and runs the
 * scheduler in the background. The panel bundles (or any client) talk to this.
 * Logs to stdout.
 */
import './load-env.ts' // make .env the backend secret source (RSSHub telegram session, etc.)
// owned-outbound 必须在任何 facility（尤其内嵌 RSSHub，其 request-rewriter 会 patch 全局 fetch /
// node:http）加载之前 import，才能在顶层同步快照到原始出站绑定。放在 load-env 之后、首位，收敛为
// 显式启动契约。时序保证来自 RSSHub 的运行时懒加载 + 本 import 首位（结构性早于任何补丁）；命门测试
// owned-outbound.sentinel.test.ts 锁死的是「捕获机制本身」（import 后再 patch，已存引用不受影响）。
// 别把它挪到其他 facility import 之后。
import './http/owned-outbound.ts'
import { serve } from '@hono/node-server'
import type { Server } from 'node:http'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { bootstrap, loadConfig, resolveDataDir } from './bootstrap.ts'
import { createHttpApp, type HttpDeps } from './http/app.ts'
import { classifyLauncher } from './restart/policy.ts'
import { makeRestartTrigger, type Shutdown } from './restart/trigger.ts'
import { writeFixtureFromItem } from './content/ad-fixtures.ts'
import { WsHub, attachWs } from './http/ws.ts'
import { toClientItem } from './http/client-item.ts'
import { attachExtRelay, closeRelayServer } from './http/ext-relay.ts'
import { summarizeCapability } from './browser/capability-store.ts'
import { materializeExtension } from './browser/extension-dir.ts'
import { installExtension } from './browser/extension-install.ts'
import { uninstallExtension } from './browser/extension-uninstall.ts'
import { reloadExtension } from './browser/extension-reload.ts'
import { readExtensionConsole } from './browser/extension-console.ts'
import { attachHostRelay } from './http/host-relay.ts'
import { EventSourceRelay, attachEventSourceRelay } from './event-source/relay.ts'
import { makeDrain } from './event-source/drain.ts'
import { wireCookiesFeed } from './event-source/cookies-feed.ts'
import { loadOrCreateExtToken, loadOrCreateApiToken } from './http/secrets.ts'
import { authorizeAccess, parseTrustedOrigins } from './http/access-guard.ts'
import { attachEnrichCommands } from './http/enrich-ws.ts'
import { attachAuthLoginCommands } from './http/auth-login.ts'

// 真相源在 src/ext-id.ts（扩展 id 的唯一定义处；access-guard 与 ext relay 都从那里读）。
import { STREAM_EXTENSION_ID as EXT_ID } from './ext-id.ts'
import { DESKTOP_CAPABILITY_NAME, hostAgentSkipReason, mountHostAgent } from './host-agent/mount.ts'
import { createCapabilityHost } from './capabilities/host.ts'
import { loadOptionalCapabilities, type LoadedCapability } from './capabilities/load.ts'
import { BROWSER_COOKIE_SERVICE } from '../capabilities/desktop/src/cookies.ts'
import { DebugLog } from './http/debug-log.ts'
import { createFailureSink } from './http/debug-sink.ts'
import { startLoopLagMonitor } from './loop-lag.ts'
import { OpTracker, type TrackFn, type TrackSyncFn } from './op-track.ts'
import { mountMcp } from './http/mcp-mount.ts'
import { backendToolNames } from './mcp/server.ts'
import { ACTION_RUN_DOMAIN, projectActionRun } from './mcp/action-run.ts'
import type { RunStatus } from './agent/search/types.ts'
import { withCapabilityTools } from './mcp/capability-tools.ts'
import { mountConfigRows } from './http/config-rows-routes.ts'
import { mountLiveRoutes } from './http/live-routes.ts'
import { LiveStreamService } from './live/service.ts'
import { mountResearchRoutes } from './http/research-routes.ts'
import { localRecipesDir, mountLocalRecipeRoutes } from './http/local-recipes-routes.ts'
import { mountImageGenerationRoutes, PRODUCES_IMAGES } from './http/image-generation-routes.ts'
import { isCanonicalBrowserRecipe } from './replay/recipe.ts'
import { mountSkillRoutes } from './http/skills-routes.ts'
import { SKILLS_ROOT_REL } from './skills/shipped.ts'
import { artifactsDirOf } from './board/run-source.ts'
import { watchArtifactsDir } from './live/watch.ts'
import { createResearchWatchers, type ResearchWatchers } from './live/research-watchers.ts'
import { lazyNotify, type EventsService } from './events/service.ts'
import { installProcessGuards } from './process-guard.ts'
import { mountPanelAssets } from './http/panel-mount.ts'
import { mountStandalonePage } from './http/standalone-page.ts'
import { repoRoot, shippedRoot } from './http/build-identity.ts'
import { mountTaskDashboard } from './http/task-dashboard.ts'
import { mountPluginGateway } from './http/plugin-gateway.ts'
import { pluginNetMode } from './plugins/plugin-target.ts'
import { type StandbyManager } from './plugins/standby/manager.ts'
import { wireStandby } from './plugins/standby/wire.ts'
import { standbyInertNotification } from './plugins/standby/inert-notice.ts'
import { setStandbyManager, setStandbyInertReason } from './plugins/standby/hook.ts'
import { setTaskDeps, resetTaskDeps } from './tasks/deps.ts'
import type { TaskDeps } from './tasks/types.ts'
import { startTaskCenter, stopTaskCenter, addTask, removeTask, runTaskNow, runningTasks } from './tasks/center.ts'
import { builtinTasks } from './tasks/builtin.ts'
import { TaskStore } from './tasks/task-store.ts'
import { RunLedger } from './tasks/run-history.ts'
import { compileEnabled, compileUserTask } from './tasks/user-tasks.ts'
import { actionDirectory } from './tasks/package-actions.ts'
import { mountTaskRoutes } from './http/task-routes.ts'
import { mountInterventionRoutes } from './http/intervention-routes.ts'
import { mountSourceHealthRoutes } from './http/source-health-routes.ts'
import { SourceHealthIndex } from './intervention/source-health-view.ts'
import { draftPath, readDraft } from './intervention/explore-graph.ts'
import { AGENT_ROW_ID, readAgentConfig } from './intervention/agent-config.ts'
import { localNameOf } from './registry/source-id.ts'
import type { InterventionService } from './kernel/plugins/intervention.ts'
import { errText } from './err-text.ts'
import { ImportRunStore } from './sharing/import-run-store.ts'
import { createKernel, quiesceKernel } from './kernel/context.ts'
import { bindModuleHook, reportUnboundHooks } from './kernel/plugins/module-hooks.ts'

/** 后端自己就是那扇门，默认口 = 唯一的对外口 8900（`DEFAULT_BACKEND_URL`、`GATEWAY_PORT`
 *  都是这个数）。曾经默认 4555 是容器时代的遗留：门在 Caddy 上，
 *  后端躲在网内，于是"起在 4555、探 8900"的默认组合让 spawn 必然超时（见 `mcp/spawn-backend.ts`
 *  的 C1 注释）。默认值对齐之后，那个坑连同它的补丁一起消失。
 *  compose 自托管旁支里后端仍躲在 Caddy 后面，那条路显式传 `STREAM_PORT=4555`（见
 *  `plugins/compose.ts`）——**显式的那一侧是特例，默认的这一侧是主路**。 */
const PORT = Number(process.env.STREAM_PORT ?? 8900)
/** 能力包取登录态前，快照旧过这个数就先去浏览器取一次。**不是缓存 TTL**：`ensureFresh`
 *  自己带并发去重，这个数只决定"多旧算旧"。取小了每次都发一轮 `cookiePull`（几个
 *  `chrome.cookies.getAll`，便宜但没必要）；取大了就退化成读快照，白设这道闸。 */
const COOKIE_FRESH_MS = 60_000
// /tmp isn't guaranteed to exist or be writable on every platform the released
// package targets. STREAM_DATA_DIR (the app-data dir `stream` is launched with) is
// the natural home for this; os.tmpdir() covers dev and any other caller that
// doesn't set it.
const LOCK_FILE = join(process.env.STREAM_DATA_DIR ?? tmpdir(), 'stream-serve.pid')

// pid 活性/出生时刻的判据收进 proc-identity.ts。
// pidStartTime 保持从这里 re-export——serve.lock.test.ts 按旧路径引它。
import { pidAlive, pidStartTime } from './proc-identity.ts'
import { openReconcile } from './netdisk/reconcile/open.ts'
import { runSessionExports } from './credentials/session-export.ts'
import { streamRecordToStream } from './store/compat.ts'
import { envCoveredFields } from './kernel/plugins/runtime-config.ts'
export { pidStartTime }

/**
 * Sidequest 的 job 类要**从这里再导出一次**。
 *
 * Sidequest 按路径读一个 jobs 清单文件（`jobsFilePath`）来解析 job 类。源码树跑的时候那份
 * 清单指向 `src/tasks/stream-task-job.ts`，和后端是同一个模块图，没问题。**发行形态下整个
 * 后端被打成一个 `server.mjs`，那个源码路径不存在**——而把 job 类单独再打一份出货是**错的**：
 * 那会在同一个进程里造出第二份任务注册表，job 跑起来看到的是空的（jobs 是 `runner:'inline'`，
 * 就在本进程里跑）。
 *
 * 所以出货的清单文件写成 `export { StreamTaskJob } from './server.mjs'`：同一个文件 URL 会命中
 * ESM 的模块缓存，拿到的就是**正在跑的这一份**，不会重新求值、也不会有第二份状态。
 * 生成那份清单的是 `scripts/build-server.mjs`。
 */
export { StreamTaskJob } from './tasks/stream-task-job.ts'

/** Best-effort identity check: on Linux a reused pid whose cmdline isn't our serve
 *  entrypoint means the lock is stale (container restarts reset the pid namespace).
 *  /proc unreadable (mac/win) → fall back to pid-alive-only, current behavior. */
export function lockPidIsServe(pid: number, readCmdline = (p: number) => readFileSync(`/proc/${p}/cmdline`, 'utf8')): boolean {
  try {
    const cmd = readCmdline(pid)
    return cmd.includes('serve.ts')
  } catch {
    return true
  }
}

/** I3：standby 整块构造的降级包装。
 *
 *  为什么必须有它：standby 的接线整块跑在 main() 里，而 main() 结尾是 `.catch(… process.exit(1))`。
 *  makeStandbyManager 对重名 service 是主动 throw 的（模块内部这么做是对的：静默相互覆盖更坏），
 *  可这个 throw 一旦落到 main() 里，就变成**两个插件的 service 名撞车 ⇒ 整个后端拒绝启动**，把每一个
 *  跟 standby 毫无关系的功能一起带走。这个特性的核心安全属性正是"绝不弄挂主链路"——让一次调用失败
 *  远好过让开机失败。所以：任何 throw ⇒ 一行日志 + standby 彻底 inert + 服务器照常起来。
 *  build 里的 Docker 探测 / adopt / 定时器接线故意留在 main() 里不外移（它们有副作用、跟 boot 强耦合），
 *  这里只包住"炸了怎么办"这一层——它就是这条降级承诺的可测接缝。 */
export async function buildStandbyOrDegrade(
  build: () => Promise<void>,
  cleanup: () => void,
  log: (msg: string) => void = console.log,
  notify?: (detail: string) => void,
): Promise<void> {
  try {
    await build()
  } catch (e) {
    try { cleanup() } catch { /* 清理本身再炸也不能把 main() 带走 */ }
    const detail = errText(e)
    log(`[standby] disabled — standby setup failed: ${detail}`)
    // 只有日志不够。standby inert 的后果是**沉默的**：睡着的容器再没人唤醒——备齐也不会替
    // 它起（那是 standby 的活，见 provisioner.ts 头注「谁管『转不转』」），于是表现只是
    // 「这个插件就是不好使」，唯一的线索在一行没人看的启动日志里。
    // 通知本身再炸也不许掀翻开机——这整个函数的存在理由就是这个。
    try { notify?.(detail) } catch { /* 同上 */ }
  }
}

// pidStartTime 的实现与「为什么必须比 starttime」的论证见 proc-identity.ts——pid 会被复用,
// 而我们自己的 launcher（`tsx src/serve.ts`）的 cmdline 也含 "serve.ts",光比 cmdline 会误认。

/** Is the lock's recorded pid still the SAME process that wrote it? A lock with no recorded
 *  start time (legacy) or an unreadable /proc falls back to the old pid-alive-only behavior. */
export function lockIsSameProcess(
  pid: number,
  recordedStart: string | undefined,
  startOf: (p: number) => string | null = (p) => pidStartTime(p),
): boolean {
  if (!recordedStart) return true
  const live = startOf(pid)
  if (live == null) return true
  return live === recordedStart
}

/**
 * Single-instance guard. A second `serve` must NOT start while one is live: two
 * servers = two sets of headless chrome, the exact pile-up that OOMs WSL. Refuse
 * to start if the lock points at a live pid; otherwise claim the lock.
 */
function acquireLock(): void {
  if (existsSync(LOCK_FILE)) {
    const [pidStr, recordedStart] = readFileSync(LOCK_FILE, 'utf8').trim().split(/\s+/)
    const old = Number(pidStr)
    if (
      old && old !== process.pid && pidAlive(old) && lockPidIsServe(old) &&
      lockIsSameProcess(old, recordedStart)
    ) {
      console.error(`[stream] another serve is already running (pid ${old}). Kill it first; refusing to start.`)
      process.exit(1)
    }
  }
  // pid + start time: the pid alone is ambiguous once the container restarts and pids are reused.
  writeFileSync(LOCK_FILE, `${process.pid} ${pidStartTime(process.pid) ?? ''}`.trim())
}

function releaseLock(): void {
  try {
    // the lock now records "<pid> <startTime>" — only the pid identifies the owner here
    if (existsSync(LOCK_FILE) && Number(readFileSync(LOCK_FILE, 'utf8').trim().split(/\s+/)[0]) === process.pid) {
      unlinkSync(LOCK_FILE)
    }
  } catch { /* best-effort */ }
}

/*
 * 启动时**不要**去 reap 任何浏览器进程。Stream 不 launch 浏览器（全仓 playwright 只有
 * `connectOverCDP`：`replay/browser.ts` 是 authoring CLI），采集骑
 * 用户自己那个 Chrome——所以能被 `pkill` 匹配到的浏览器进程，只可能是**别人的**（用户的窗口、
 * 开发者别的工具起的 headless shell）。后端启动去杀它们，就是关一扇不属于自己的窗。
 */
/** 查询档无采集:stdio MCP spawn 出的即用即回收后端(STREAM_NO_SCHEDULER=1)不该把所有订阅流的
 *  定时采集跑起来——查询型用户连上问一句不应顺带触发全量采集(两档拍板)。标记为真则跳过
 *  scheduler.start() 并打一行原因日志;否则照常启动。API 查询路径与本分支无关(app 在 main() 里
 *  无条件构造),不受本标记影响。返回是否已启动,便于调用方/测试断言。 */
export function maybeStartScheduler(
  scheduler: { start(): void },
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = console.log,
): boolean {
  if (env.STREAM_NO_SCHEDULER === '1') {
    log('[stream] scheduler disabled (STREAM_NO_SCHEDULER=1) — query-only backend, no standing harvest')
    return false
  }
  scheduler.start()
  return true
}

async function main() {
  acquireLock()        // refuse to start if another serve is live
  // 进程内内核：能力的共同挂载点 + 退出时的统一销毁口。**必须早于 bootstrap**——
  // bootstrap 里的服务（Phase 1/2 起）会把自己的句柄/定时器登记成它的 effect。
  const kernel = createKernel()
  // 进程级兜底网（process-guard.ts 头注是权威说明）：孤儿 promise 的 rejection 不再把整个
  // 后端带走，未捕获异常仍然退出但**先留下堆栈 + 一条通知**。
  //
  // 位置有讲究：紧跟 createKernel、**早于 bootstrap** —— 真事故（2026-09-04 发行机上
  // RsshubClient 的孤儿 `ready`）就发生在启动装配期间，挂晚了正好错过它。
  // 事件层比这里晚装配，所以走 `lazyNotify` 调用时现取（装配期取字段 = 冻住 undefined，
  // 那条通知会永远发不出去且一个字都不报）。
  // 不登记成内核 effect：这道网要一直活到进程真的退出为止，关停期的异常同样该被看见。
  installProcessGuards({ notify: lazyNotify(() => kernel.streamEvents as EventsService | undefined) })
  const config = loadConfig()
// ext-relay 共享 secret：首启生成、持久化在 item_db 同目录（0600），重启不变。
// **后端从不把它发出去**：扩展经 native messaging 让 stream-desktop 读同一个文件自取，
// 后端只在 /api/ext/verify 上用它签一条 proof 自证身份。握手仍走 WS subprotocol，用户全程无感。
const extToken = loadOrCreateExtToken(dirname(config.item_db))
// `/api/*` 与 `/ws` 的访问令牌。**默认就有**（用户没配 api_token 时自动生成一份持久的）——
// 后端绑 0.0.0.0 是有意的（用户要从手机访问），那就必须有一把默认的锁，而不是默认没有。
// 本机 loopback 请求免密，所以自己机器上用完全无感（判据与实测见 http/access-guard.ts）。
const apiToken = config.api_token || loadOrCreateApiToken(dirname(config.item_db))
  const hub = new WsHub()
  // one shared debug bus: record() rings + broadcasts, so audio-resolve (http route) and download
  // (queue) entries all land in the same log that GET /api/debug/log reads.
  // 环之外还挂一份落盘：环是 200 条、进程一重启就清空（开发期一天几十次热重载），而偶发故障
  // 的排查全指望「等撞一次现场」——只埋在环里等于没埋。落盘只收失败条目，读法见 http/debug-sink.ts。
  const debugLog = new DebugLog(undefined, createFailureSink(dirname(config.item_db)))
  const recordDebug = (entry: import('./debug.ts').DebugEntry) => {
    debugLog.put(entry)
    hub.broadcast({ type: 'debug', entry })
  }
  // Task-boundary attribution: one process-wide tracker beside the debug bus. Gates (scheduler /
  // http / download queue / cookie refresh) wrap work through `track`; loop-lag queries it on a
  // stall. Spec: docs/superpowers/specs/2026-07-22-loop-lag-op-attribution-design.md
  // 环容量旋钮:HTTP 门追踪每一个请求,release 模式下一次 SPA 首屏的静态资源就能冲掉半个环、
  // 把真正的证据挤出去。若发现归因经常"漏掉"某类 op,先转这个旋钮(默认 200)再考虑别的。
  const opRing = Number(process.env.STREAM_OP_RING)
  const opTracker = new OpTracker(Number.isFinite(opRing) && opRing > 0 ? Math.floor(opRing) : undefined)
  const track: TrackFn = (name, fn) => opTracker.track(name, fn)
  const trackSync: TrackSyncFn = (name, fn) => opTracker.trackSync(name, fn)
  // Event-loop-lag flight recorder — started BEFORE bootstrap so it also covers boot-time
  // synchronous work (registry build, provider seeding). Logs a stdout line + a `loop`-channel
  // DebugBox entry whenever a synchronous op stalls the loop past the threshold.
  //
  // STREAM_LOOP_PROFILE=1 additionally arms the V8 CPU profiler, which NAMES the function that did
  // it. Off by default because arming is not free: V8 rebuilds its code map on Profiler.start,
  // measured at 250–500ms of loop stall on this (warm, RSSHub-sized) backend. Detection AND
  // task-level attribution (below, via opTracker) stay free and always-on; only this frame-level
  // profiler is a hunting mode you switch on while chasing a specific stall.
  startLoopLagMonitor({
    log: console.warn,
    onDebug: recordDebug,
    profile: process.env.STREAM_LOOP_PROFILE === '1',
    activeOps: (windowStartMs) => opTracker.overlapping(windowStartMs),
  })
  // 能力包的宿主（spec 2026-09-06）：**后端是唯一的聚合者**。内置的 Stream Desktop（下面
  // `mountHostAgent` 那一格）与用户 `stream add` 装进来的可选包走同一个 `host.mount()`，
  // 工具从同一个 `/api/mcp` 出去。
  //
  // **建在 bootstrap 之前**，因为 bootstrap 要拿它当「该同步哪些 cookie 域」的第三个来源
  // （能力包是一等的登录态消费者）。建它本身没有副作用——真正的装载在下面，两个入参都是
  // 调用时才求值的 thunk（`scheduling` / `agentDomain` 在下面才声明，闭包里引用没问题）。
  const capabilityHost = createCapabilityHost({
    dataDir: resolveDataDir(config),
    log: (line) => console.log(line),
    // 后端自己的动词。**thunk**：工具面按域的可用性现算，装配那一刻取一次会把「此刻还没醒的
    // 那些工具」永久算成不存在，于是一个第三方包可以拿走它们的名字。
    reservedToolNames: () => backendToolNames(scheduling.service, agentDomain.mcpExtras),
  })
  kernel.effect(() => async () => { await capabilityHost.dispose() })
  /** 已装载的可选能力包。**可变数组不是随手写的**：装载发生在下面（内置能力之后），而读它的
   *  两处都是 thunk，指着同一个数组就永远读到最新的一份。 */
  const loadedCapabilities: LoadedCapability[] = []
  // `boot` span: the monitor above deliberately predates bootstrap to catch boot-time stalls —
  // without this span those stalls all reported "卡顿来自未埋点的门", reading like an unknown
  // hole when it was the (known, expected) registry build / provider seeding.
  const boot = await track('boot', () => bootstrap(config, console.log, {
    // 「该同步哪些 cookie 域」的第三个来源：已挂能力包自己申报的那些。**现取**——可选包在
    // bootstrap 之后才装载，取快照等于永远只认内置那半，而漏一个域的表现是那个包每次都拿到
    // 空 cookie，和"用户没登录"一字不差。
    extraCookieDomains: () => capabilityHost.credentialDomains(),
    // agent 修复会话给 agent 的那条 MCP 线：**口和 token 只有这儿知道**（口就是本进程绑的那个，
    // 两个数一分家，agent 就会去敲一个没人应答的地址）。
    mcpEndpoint: () => ({ url: `http://127.0.0.1:${PORT}/api/mcp`, token: apiToken }),
    onItem: (item, type) => hub.broadcast({ type: 'item', item_type: type, item: toClientItem({ ...item, type }) }),
    onDebug: recordDebug,
    broadcast: (msg) => hub.broadcast(msg),
    track,
    trackSync,
    kernel,
  }))
  // 落盘状态住内核的存储域（`ctx.stores`）——下面的 HttpDeps 组装从这里取，键一个没变。
  // 设置覆盖层（`settings.json`）：TMDb/OMDb 凭证与 Source 运行时配置两组读写口直接吃它，
  // 不再经 Boot 转一手（那几格本来就只是转调）。
  const settingsStore = kernel.settings
  /** 旧 /api/settings/video-sources 契约的状态投影（has* 布尔，key 永不回显），
   *  数据源是 video-sources 配置 row 的四层合并读口。 */
  const videoSourcesStatus = () => {
    const v = settingsStore.rows.resolve('video-sources')
    return {
      hasTmdbApiKey: !!v.tmdbApiKey,
      hasOmdbApiKey: !!v.omdbApiKey,
      language: (v.language as string | undefined) ?? 'zh-CN',
    }
  }
  const stores = kernel.stores
  // 包这一域（描述符 / 启用判据 / 容器动作 / AList 配置面）住 `ctx.packages`。**网关与 standby
  // 那两处不走 HttpDeps**，直接吃 `pkgs.backendDirectory` / `pkgs.isPluginEnabled`（见下）。
  const pkgs = kernel.packages
  // Source 目录 + recipe 包安装面住 `ctx.sources`。
  const sources = kernel.sources
  // 通知中心住 `ctx.streamEvents`（**不是 `ctx.events`**——那是 cordis 本体的服务，见
  // kernel/plugins/events.ts）。三个消费点：HttpDeps、standby 降级告警、TaskDeps。
  const streamEvents = kernel.streamEvents
  // 采集运输面住 `ctx.harvest`。**这一域有 5 处不走 HttpDeps 的直连接线**（两条中继 attach、
  // WS hub 的两条命令、TaskDeps 的 reapIdle），漏改任一处都是静默的：extRelay 那次的形状是
  // 「扩展 popup 显示已连、后端 status() 恒 disconnected、采集每轮只报『环境没就绪』」。
  const harvest = kernel.harvest
  // 授权健康住 `ctx.auth`（横幅 / 对账 / 重登）。`focusLoginTab` 不在这儿——它是 lane 的薄壳，
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

  // research watcher 注册表的**前向引用**：真身在下面（要 `researchArtifactsDirForStream` 和
  // `hub`），而 HttpDeps 在这里就得成型。所以下面传给 `onChannelsChanged` 的是一个**调用时
  // 现取**的 thunk，不是把对象冻进去（把求值结果写死在装配期是本文件反复吃过亏的形状）。
  // 路由只在请求到来时调它，那时装配早已结束。
  let researchWatchers: ResearchWatchers | undefined

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

  // 唯一一格由宿主主动提供的服务：网盘那个包 `require('streamBrowserCookies')` 取用户浏览器里
  // 的登录态。后端自己就有那条接缝（`cookieString` / `cookiesFor`，同一把作用域尺子），所以
  // 这里只是把它翻译成包认识的形状——**不是**再开一条取 cookie 的路。
  //
  // **每次都先催一次新鲜度再读**：`cookieProvider` 读的是落盘快照，而"本地查得到"不等于
  // "这份还有效"——包在这一刻要 cookie，通常正是因为它刚吃了一个 401。`ensureFresh` 自己
  // 带并发去重和"够新就不动"的短路，所以这不是给热路径加一次网络往返（`cookieString` 那条
  // 热路径仍然一个字都没改，见 cookie-puller.ts 头注的禁令）。中继没连不报错，照旧读快照。
  const freshCookies = async (verb: string) => {
    try {
      await kernel.auth.cookiePuller.ensureFresh(COOKIE_FRESH_MS, `capability:${verb}`)
    } catch (err) {
      // 取数失败不该让"读一份可能还好用的旧快照"也跟着失败——但必须留一行，否则
      // 「一直在用旧 cookie」和「刚取过一份新的」在日志上分不出来。
      console.log(`[stream-capabilities] WARN 取登录态前的刷新失败（${verb}）：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  capabilityHost.provide(BROWSER_COOKIE_SERVICE, {
    cookieFor: async (domain: string) => {
      await freshCookies('cookieFor')
      return (await kernel.credentials.cookieProvider.cookieString(domain)) ?? undefined
    },
    cookiesFor: async (domain: string) => {
      await freshCookies('cookiesFor')
      return kernel.credentials.cookieProvider.cookiesFor(domain)
    },
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

  // `POST /api/restart` 的两只手：闸门读账本；触发先交出 mode、下一拍才开始关（trigger.ts）。
  // 优雅关（`shutdownThen`）在 main() 末尾才装好，而 HTTP 早在那之前就在听——中间这个窗口里
  // 的 restart 请求必须被**拒绝**而不是排进 setImmediate 去撞 undefined（那会是未捕获异常、
  // 进程以 1 退出）。所以这里是一个显式的 `undefined` 槽 + 现取，不是前向引用。
  let shutdown: Shutdown | undefined
  const restart: NonNullable<HttpDeps['restart']> = {
    running: () => runningTasks(),
    trigger: makeRestartTrigger({ mode: classifyLauncher(process.env), shutdown: () => shutdown }),
  }

  const app = createHttpApp({
    service: scheduling.service,
    restart,
    // 每条改动「流—频道」关系 / 频道 present / 流成员表的写入路径都调它一次——
    // 与 `applyCollectionPolicy` 是同一个接缝的两边，见 live/research-watchers.ts 头注。
    onChannelsChanged: () => researchWatchers?.sync(),
    resolve: { registry: sources.registry, resolveEngine: provider.resolveEngine, intentResolver: provider.intentResolver, radarMatcher: provider.radarMatcher, sourceHealth: stores.sourceHealth, streams: () => scheduling.scheduler.list(), lyricsCache: stores.audioArchive },
    channelStore: stores.channels,
    sharing: {
      store: stores.channels,
      registry: sources.registry,
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
    extRelayAuth: { token: extToken, extId: EXT_ID },
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
  // 同款直连挂载，不进 HttpDeps。streamId → artifacts 目录的解析抽成具名函数
  // `researchArtifactsDirForStream`——Task 6 的文件系统 watcher 复用同一条解析，不重抄一遍。
  // 取法与 live 面同款（见上面 liveStreams 的头注）：manifestOf 用 `sources.registry.get`，
  // runtimeConfig 用 `kernel.runtimeConfig`；只取该 stream 的第一个成员——research present
  // 一个 stream 只绑一个 research-runs 源。
  function researchArtifactsDirForStream(streamId: string): string {
    const stream = stores.channels.getStream(streamId)
    if (!stream) throw new Error(`no stream "${streamId}"`)
    const member = stream.members[0]
    if (!member) throw new Error(`stream "${streamId}" 没有绑定任何源`)
    const manifest = sources.registry.get(member.source)
    const runtimeConfig = manifest ? kernel.runtimeConfig(manifest as never) : {}
    return artifactsDirOf(member.params, { runtimeConfig })
  }
  mountResearchRoutes(app, { dirForStream: researchArtifactsDirForStream })
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
  // store/ledger/日志目录不是调度中心的专属资源：它们在这里（路由挂载之前）无条件构造，两种模式
  // 都能读——"看一眼有哪些任务、上次跑得怎么样"是读 store + 账本，不需要节拍器在跑。真正按
  // STREAM_NO_SCHEDULER 门控的只有下面调度中心那个 if 块（节拍器本身、taskDeps 的装配）。
  // 构造本身要挡：TaskStore 构造函数同步 `new Database(dbPath)` + `db.exec(...)`，文件被锁 /
  // 损坏 / 权限不对 / 磁盘满都会同步 throw；这个 throw 不接住会一路逃到 main() 外层的
  // `.catch(() => process.exit(1))`。降级方式与 buildStandbyOrDegrade 同款：接住、打一行日志、
  // 任务面整体缺席（taskStore/runLedger/taskLogDir 留 undefined），路由仍挂但内置/用户任务清单为空。
  const ledgerPath = join(dirname(config.item_db), 'sidequest.sqlite')
  const taskLogDirCandidate = join(dirname(config.item_db), 'task-logs')
  let taskStore: TaskStore | undefined
  let runLedger: RunLedger | undefined
  let taskLogDir: string | undefined
  let taskDeps: TaskDeps | undefined
  try {
    taskStore = new TaskStore(join(dirname(config.item_db), 'stream.db'))
    runLedger = new RunLedger(ledgerPath)
    taskLogDir = taskLogDirCandidate
  } catch (e) {
    taskStore = undefined
    runLedger = undefined
    taskLogDir = undefined
    console.log(`[stream] task center store disabled — open failed: ${errText(e)}`)
  }
  // 任务面路由：两种模式都挂（store/ledger 已在上面无条件构造）。builtins 读 taskDeps——
  // 查询档（STREAM_NO_SCHEDULER=1）下调度中心不起，taskDeps 保持 undefined，内置任务清单就
  // 诚实地报空；用户自定义任务不受影响。store/ledger 开不起来（罕见：文件锁/权限/磁盘满）时
  // 整个任务面缺席——TaskRoutesDeps 要求 store/ledger 非空，这里没有第三种"半条腿"的挂法。
  // 包提供的动作：`activate()` 交出来的第三样东西。一条**用户任务**行可以把 `action` 指到
  // 这里的某个名字上（排期、启停、参数全在那一行和它绑的配置 row 里，见 `package-actions.ts`）。
  const packageActions = actionDirectory(pkgs.activated.actions)
  if (packageActions.size) {
    console.log(`[stream] package actions: ${[...packageActions.keys()].join(', ')}`)
  }
  /** 编译一条任务行要的两样东西：动作名录 + 它绑的那格配置 row 的**生效值**。
   *  两个都是**调用时才取**——用户在界面上改完那格，下一轮就该按新的来。 */
  const compileOpts = () => ({
    ...(taskLogDir ? { logDir: taskLogDir } : {}),
    actions: (name: string) => packageActions.get(name),
    paramsFor: (ref: string) => settingsStore.runtimeConfig(ref),
  })
  if (taskStore && runLedger) {
    mountTaskRoutes(app, {
      store: taskStore,
      ledger: runLedger,
      builtins: () => (taskDeps ? builtinTasks(taskDeps) : []).map((t) => ({
        id: t.id, label: t.label, schedule: t.schedule,
        ...(t.timezone === undefined ? {} : { timezone: t.timezone }),
        ...(t.group === undefined ? {} : { group: t.group }),
        ...(t.exclusiveOn === undefined ? {} : { exclusiveOn: t.exclusiveOn }),
        ...(t.whenBusy === undefined ? {} : { whenBusy: t.whenBusy }),
      })),
      actions: () => [...packageActions.keys()],
      apply: (row) => addTask(compileUserTask(row, compileOpts())),
      unapply: async (id) => { await removeTask(id) },
      runNow: (id) => runTaskNow(id),
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
    // 上一个进程留下的在飞 run：agent 子进程随它一起没了，库里那些行却还写着「running」。
    // 续得上的收成 paused（**不自动续**——自动拉起来等于用户没点过任何东西就开始烧 token），
    // 续不上的收成终态 error。**两个数分开说**：只报暂停那个，另一批就没人知道发生过。
    const { paused, failed } = kernel.intervention.repairs.markInterruptedAtBoot()
    if (paused) console.log(`[intervention] ${paused} 条修复会话因重启暂停，可在运维页「源健康」该源的修复页里「继续」`)
    if (failed) console.log(`[intervention] ${failed} 条在飞的 run 没有可续的会话，因重启收成 error`)
  }
  // 每个 research present 频道绑的流各起一个 watcher。目录取不到就跳过这条流（源没配全，
  // 不是错误路径）——watcher 缺席只意味着退化成"打开页面时查一次"。`notify` 用
  // `lazyNotify`：事件层比这里晚装配，装配期直接取 `kernel.streamEvents` 字段会冻住 undefined。
  const notifyNewResearchRun = lazyNotify(() => kernel.streamEvents as EventsService | undefined)
  // 集合本身是**运行期可变**的（频道随时新建/改绑/删），所以它归 ResearchWatchers 自己管；
  // 登记进内核 effect 的只有 `stopAll()` 这一件进程级收尾——常驻句柄不登记就没人关，是本文件
  // 已经吃过一次亏的形状（那次是 wss + ping 定时器）。所有权边界见那个模块的头注。
  researchWatchers = createResearchWatchers({
    listChannels: () => stores.channels.listChannels(),
    dirForStream: researchArtifactsDirForStream,
    start: ({ dir, streamId }) => watchArtifactsDir({
      dir,
      streamId,
      onChanged: (id) => hub.broadcast({ type: 'live-changed', streamId: id }),
      onNewRun: (runId) => notifyNewResearchRun({ type: 'research-run', severity: 'info', title: `新 run：${runId}`, dedupeKey: `research-run:${runId}` }),
    }),
  })
  researchWatchers.sync()
  kernel.effect(() => () => researchWatchers?.stopAll())
  // 面板产物（app/ 打出来的 IIFE bundle）的出口。必须在 dev 反代 / SPA 兜底之前挂，
  // 否则 /panel/* 被整段吞成 index.html。同上直连挂 app，不进 HttpDeps。
  // **根要挑，不能写死 `repoRoot`**：打包形态下整个后端是一个 `server.mjs`，`repoRoot` 算出来
  // 是资源目录的上两级（不存在），于是 `/panel/*` 恒 404 —— 工作台里报「bundle 加载失败」，
  // 而那句话给的两个猜测（后端没起 / 没 build:panel）都不是真因。同扩展目录那一处，见 `shippedRoot`。
  mountPanelAssets(app, { root: join(shippedRoot('app/dist-panel'), 'app', 'dist-panel') })
  // Sidequest 面板：经 /_p/sidequest 整路透传到容器内 loopback:8678。必须先于
  // mountPluginGateway 注册，因为两者都处理 /_p/* 路由，更具体的规则需要优先匹配。
  mountTaskDashboard(app, { port: 8678 })
  // /_p 插件网关：与 mountMcp 同样直接挂在 app 上（不进 HttpDeps，避开三处接线陷阱——见
  // src/http/plugin-gateway.ts 头注）。descriptors 用包域加载后的那份描述符
  // （PluginDescriptor[]，sharing.plugins 已用同一字段）；mode 读
  // STREAM_PLUGIN_NETWORK。mode=none 或无插件能解析出 target 时自行 no-op，不注册路由。
  // descriptors 必须是**两层合并**（`pkgs.backendDirectory`）：只喂 `pkgs.plugins` 的话，
  // 第三方包的容器被建起来、被 standby 管着，`/_p/<包 id>` 却恒 404——建了没人打得到，
  // 而且一行日志都不会提（终审 Important 3）。同一份合并名单也喂给包域里的 target resolver。
  mountPluginGateway(app, {
    descriptors: pkgs.backendDirectory.all(),
    mode: pluginNetMode(),
  })

  // standby-manager：声明了 backend.standby 的插件闲置回收 + 按需唤醒。
  // 接线陷阱同 mountMcp/mountPluginGateway：不进 HttpDeps（见 src/http/plugin-gateway.ts 头注），
  // 走模块级 hook，在 serve.ts 里一次性接好。要管哪些服务是纯计算，抽到 planStandbyServices
  // （service-list.ts）里单测——两道构造闸、healthUrl 拼装、跳过不可解析目标都在那边有测试；
  // 留在这里的只有「把接线结果绑到 main() 的局部变量上」这一件事：整段有副作用的接线
  // （Docker 探测 / 造管理器 / adopt）都在 wireStandby（standby/wire.ts）里，
  // 那里有 wire.test.ts 逐条守着失败路径。别把 adopt() 拎回这个回调外面——
  // 它必须留在 buildStandbyOrDegrade 的受保护区内，否则「配置错掀翻开机」会悄悄回来。
  // reaper 轮次不再由 wireStandby 自建裸定时器驱动，见下方 standby-reaper 任务注释。
  let standbyMgr: StandbyManager | null = null
  // I3：整块交给 buildStandbyOrDegrade（见其注释）——任何 throw 都降级成一行日志 + standby inert，
  // 绝不掀翻 main()。reaper 轮次不再是这里自建的裸定时器——已收编进调度中心的
  // standby-reaper 任务（src/tasks/builtin.ts），只驱动 standbyMgr.tick()。
  await buildStandbyOrDegrade(async () => {
    const wiring = await wireStandby({
      // 合并名单（内置 + 第三方），不是 `pkgs.plugins`：container-policy 给第三方兜的
      // `standby: { idleMinutes: 30 }` 写在安装确认页上，名册漏了第三方那层，那句承诺就是
      // 空话——容器建起来一直跑，没人收也没人说。
      descriptors: pkgs.backendDirectory.all(),
      mode: pluginNetMode(),
      isEnabled: (p) => pkgs.isPluginEnabled(p),
      // 接线经内核 effect 登记（bindModuleHook）：挂上时 set、quiesceKernel 时复位为 null。
      // 传 null 的那一路（adopt 半路抛的复位）保持直接 set——那是"撤销一个半成品"，
      // 不是一次新的绑定，包成 effect 只会往树上挂一个什么都不做的 disposer。
      setHook: (m) =>
        m
          ? bindModuleHook(kernel, () => setStandbyManager(m), () => setStandbyManager(null))
          : setStandbyManager(null),
    })
    standbyMgr = wiring.manager
    // inert 的原因要活过这次接线:取址答空时才有人能分出「够不着 Docker」(事故,该喊)
    // 和「按设计如此」(桌面档 / 没插件声明 standby)。随内核 dispose 复位——不复位的话,
    // 同进程第二次 bootstrap 会读到上一次的残留,而残留和真事故长得一模一样。
    bindModuleHook(
      kernel,
      () => setStandbyInertReason(wiring.inertReason ?? null),
      () => setStandbyInertReason(null),
    )
    // 降级不等于闭嘴:够不着 Docker 时所有带容器的插件一起失效,而它们的失败形状是
    // 「取址答空 → base 空串 → 一句 Failed to parse URL」,没有一处会说出真正的原因。
    // 判据(只有这一档喊)与文案在 standbyInertNotification。
    const notice = standbyInertNotification(wiring)
    if (notice) streamEvents.emit(notice)
  }, () => {
    // 降级清理：hook 若已指向一个半成品管理器，后续 withAwake 会打到它上面。
    // 只可能在异常前被设上，这里无条件复位。
    standbyMgr = null
    setStandbyManager(null)
  }, undefined, (detail) => {
    streamEvents.emit({
      type: 'plugin.container', severity: 'error',
      title: '插件容器的休眠/唤醒失效了',
      body: '接线没起来，所有带后端容器的插件不再按需唤醒、也不再闲置回收。'
        + '已经停着的那些容器**不会有人叫醒它们**，用到它们的功能会一直失败（Stream 其余部分照常）。'
        + `原因：${detail}`,
      dedupeKey: 'standby:degraded',
    })
  })

  // 前端那一层：必须最后挂载——兜底 `*` 若挂在 mountMcp/mountPluginGateway/mountPanelAssets
  // 之前会抢先吞掉 /api/mcp、/_p/*、/panel/*。
  //
  // 这一层只有一种形态：8900 的独立正门（standalone-page.ts）——一张自包含页挂同一批面板
  // bundle。对话不在这里，对话在用户自己的宿主（Claude Code / Codex / DSH）里，经 MCP 使唤
  // 这个后端（spec 2026-09-05）。
  mountStandalonePage(app)

  // 可选能力包：扫 `<dataDir>/recipes/` 里填了 capability 槽位的包，逐个装、逐个兜错。
  //
  // **必须在 listen 之前**：`stream mcp` 探到 health 一通就整面转发，宿主随即把那一刻的
  // `tools/list` 缓起来。装在 listen 之后就有一个窗口期，窗口里装好的包一件工具都不在表上，
  // 而没有任何一处会喊——用户看到的是"装了没用"。
  //
  // 计划里「内置先、可选后」的动机是 provide/require 的先到先得（内置的服务名不该被第三方包
  // 抢走）。今天两者不冲突：内置 Stream Desktop **一格 provide 都没有**（它只 registerTools），
  // cookie 服务由后端自己 provide 且早在这之前就装好了。所以可选包提前到 listen 之前无碍，
  // 而 `mountHostAgent` 仍留在 relay attach 之后（agent 起来就会连 /api/host，门得先开）。
  // 真有一天内置能力开始 provide，就得把那一格也提前，而不是把这一块推回去。
  {
    const loaded = await loadOptionalCapabilities({
      recipesDir: join(resolveDataDir(config), 'recipes'),
      host: capabilityHost,
      log: (line) => console.log(line),
      config: config.capabilities,
    })
    loadedCapabilities.push(...loaded)
    if (loaded.length) {
      console.log(`[stream] ${loaded.length} 个可选能力包已装载：${loaded.map((c) => c.name).join(', ')}`)
    }
  }

  const server = serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) =>
    console.log(`[stream] HTTP+WS on http://0.0.0.0:${info.port} (ws: /ws)`)
  )
  // 监听口本身也是个要关的句柄：不关就一直占着 8900 到 process.exit——信号退出无所谓，
  // 但 restart 的 reexec 档是**先起新的一份再退**，新的一份会撞 EADDRINUSE。登记在下面几个
  // wss effect **之前**（effect 按注册反序销毁 → 它最后跑）。`close()` 只停止接新连接、
  // 不掐正在飞的响应，所以那个 202 照样从原 socket 出去。
  kernel.effect(() => () => { server.close() })
  attachWs(server as unknown as Server, hub, (req, url) =>
    authorizeAccess({
      remoteAddress: req.socket.remoteAddress,
      bearer: req.headers.authorization,
      queryToken: url.searchParams.get('token'),
      token: apiToken,
    }) !== 'denied'
  )
  // 两条中继的 wss **接住返回值并登记成内核 effect**：过去这里把它们丢了，于是关停时
  // 两个 WebSocketServer 加上每条连接身上那个 20s ping 定时器从没人关——全项目关停期
  // 最后一处常驻连接泄漏。`closeRelayServer` 先断连再关服务器（interval 挂在连接上，
  // 光 close 服务器清不掉它）。
  kernel.effect(() => {
    const wss = attachExtRelay(server as unknown as Server, harvest.extRelay, { token: extToken })
    return () => closeRelayServer(wss)
  })
  // host-desktop Engine relay at /api/host — Stream Desktop's native process (enigo + OS a11y)
  // connects here. Reuses the local shared secret — it reads it straight off disk (it is a local
  // process, so the filesystem is its channel; see app/host-agent datadir.rs — the directory name
  // is internal, the shipped binary is `stream-desktop`).
  // Nothing connected → kind:'desktop' sources decline as a miss.
  kernel.effect(() => {
    const wss = attachHostRelay(server as unknown as Server, harvest.hostRelay, { token: extToken })
    return () => closeRelayServer(wss)
  })
  // 外部事件源子进程的收信端 at /api/event-source（Spec 1 只装端点，spawn/看护留 Spec 2）。
  // 与上面两条中继同一把 `extToken`、同一个 teardown 形状。事件帧经 `drain` 触发已注册任务
  // （`EVENT_SOURCE_TASK_MAP` 现为空 → 每个事件都 mapToTask=null，drain 直接 ack；Spec 2 加
  // `{ xianyu: '<发货任务>' }`）；`hello` 帧按子进程声明的域名，把后端已有的 cookie 快照喂回去。
  // 喂 cookie 走**只读**接缝：直接读 `cookieProvider.cookiesFor`，不催新鲜度、不拉浏览器
  //（那条带 ensureFresh 的路是能力包热路径专用，见上面 BROWSER_COOKIE_SERVICE 那格头注）。
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
      runTaskNow,
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

  const streams = scheduling.scheduler.list()
  console.log(`[stream] ${streams.length} streams → vault ${config.vault_root}`)
  // scheduler.start() runs each stream's initial harvest itself (staggered) — no
  // manual tick loop here, which previously double-ran every stream at boot.
  // 查询档(STREAM_NO_SCHEDULER=1,stdio MCP spawn 的即用即回收后端)跳过采集,只服务查询。
  maybeStartScheduler(scheduling.scheduler)
  // The scheduler is the only standing harvest engine (ARCHITECTURE.md Data Scheduling,
  // invariant 4). Standing resolution goals are expressed as exclusive Streams, harvested
  // here — not by any parallel subscription loop.

  // 调度中心（spec 2026-07-24 §3）：4 处业务定时器收编——cookie-refresh（原 5min 裸定时）、
  // jobs-sweep（原 10min）、standby-reaper（原 wire.ts 自建 60s）、netdisk-autosync（原 bootstrap
  // 6h，失败不再 .catch(() => {}) 静默吞）。降级守卫在 startTaskCenter 内部：start 失败只留一行
  // 日志，不掀翻服务器。
  // 查询档(STREAM_NO_SCHEDULER=1)跳过采集调度中心，与上面 maybeStartScheduler 同一开关——
  // 查询型即用即回收后端不该常驻定时任务（cookie-refresh/jobs-sweep/standby-reaper/netdisk-autosync）。
  if (process.env.STREAM_NO_SCHEDULER !== '1') {
    // 用户定义的定时任务（spec 2026-08-28 §3.1）：定义住 stream.db，跑起来和 builtin 无差别。
    // store/ledger/taskLogDir 已经在路由挂载之前无条件构造好了（见上面那段头注），这里直接读
    // 同一份绑定——不重新声明、不重新 new。
    // **一份装配，两个消费者**：模块级 deps（Job 类经动态 import，闭包不到这里）与
    // builtinTasks 的条件装配，都读这同一个对象——布尔表参数已删，见 builtinTasks 头注。
    taskDeps = {
      log: (m) => console.log(m),
      events: { append: (e) => streamEvents.emit(e) }, // EventsService 的门面方法叫 emit，TaskDeps 只认 append
      cookieProvider: boot.kernel.credentials.cookieProvider,
      // 接缝：这一格**直连内核的 conversions 域**，不经 HttpDeps（见上面 conversionsDomain 的头注）。
      capabilityJobs: conversionsDomain.capabilityJobs ?? undefined,
      standbyManager: standbyMgr ?? undefined,
      // 接缝：这四格**直连内核的 netdisk 域**，不经 HttpDeps（见上面 netdiskDomain 的头注）。
      netdisk: netdiskDomain.netdisk ?? undefined,
      netdiskStore: netdiskDomain.netdiskRoutes?.store ?? undefined,
      reconcile: netdiskDomain.netdiskRoutes?.reconcile ?? undefined,
      // 第四格（追更）同样直连内核那一份——每小时的 netdisk-follow 靠它扫到期的剧。
      follow: netdiskDomain.netdiskRoutes?.follow ?? undefined,
      browserLanes: { reapIdle: harvest.reapIdleLanes },
      authReconcile: auth.reconcileAuthNow,
      // 接缝：这一格**直连内核的 agent 域**，不经 HttpDeps（见上面 agentDomain 的头注）。
      intents: agentDomain.intents,
      // 同上：run 账本 + 动作产物的保留期清理直连 agent 域。
      agentRuns: agentDomain.agentRuns,
      // runLedger 开不起来时这一格不装配：一个恒 throw 的 ledger-prune 比没有这个任务更坏
      // （builtinTasks 按 `wired.ledger` 是否存在条件装配，见其头注）。
      ...(runLedger ? { ledger: { prune: (o: { keepPerTask: number; keepMs: number }) => runLedger!.prune(o) } } : {}),
      // 登录态导出：**一条都没声明就整格不装配**，于是任务表上根本不出现这个任务（`builtinTasks`
      // 按 `wired.sessionExports` 在不在条件装配）。声明在 config.yaml，见 AppConfig.session_exports。
      ...(boot.config.session_exports?.length
        ? {
            sessionExports: () =>
              runSessionExports(boot.config.session_exports!, boot.kernel.credentials.cookieProvider),
          }
        : {}),
      // 包更新检查（`recipe-update-check`）：`STREAM_RECIPE_UPDATE_CHECK=0` 关掉 = 整格不装配，
      // 任务表上就没有这条（与 sessionExports 同一种"没有就不出现"的写法，不是一条空跑的任务）。
      ...(process.env.STREAM_RECIPE_UPDATE_CHECK !== '0'
        ? { recipePackageOps: { updates: () => sources.recipePackageOps.updates() } }
        : {}),
    }
    bindModuleHook(kernel, () => setTaskDeps(taskDeps!), () => resetTaskDeps())
    void startTaskCenter(
      [
        ...builtinTasks(taskDeps),
        // taskStore 开不起来时用户定义任务面整体缺席，只用内置任务照常起——见上面 try/catch 头注。
        ...(taskStore ? compileEnabled(taskStore.list(), compileOpts()) : []),
      ],
      // sidequest.sqlite 落在 config 数据目录下（同 ext-token 的落盘规则），不依赖启动 cwd。
      { dbPath: ledgerPath, dashboardPort: 8678, log: (m) => console.log(m) },
    )
  }

  // 三个模块级钩子的接线体检：只报**不该是 null 却是 null 的那些**。两条常态降级显式申报，
  // 不进这行——没有 Docker / 没插件声明 standby 时 standby 本就该 inert；查询档
  // （STREAM_NO_SCHEDULER=1）根本不起调度中心，taskDeps 没人要。掺进常态 = 第一天就变噪音。
  reportUnboundHooks({
    log: (m) => console.log(m),
    degraded: [
      ...(standbyMgr ? [] : ['standby']),
      ...(process.env.STREAM_NO_SCHEDULER === '1' ? ['taskDeps'] : []),
    ],
  })

  let shuttingDown = false
  /** 优雅关：关停步骤对信号退出和 `POST /api/restart` 是同一份，只有**最后一步**不同——
   *  信号退出 `process.exit(0)`；重启按「谁拉起我」收尾（`src/restart/policy.ts`）。 */
  const shutdownThen = async (finale: () => void, label: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[stream] ${label} → shutting down...`)
    await stopTaskCenter()
    if (standbyMgr) await standbyMgr.shutdown().catch(() => {})
    // 采集的两步关停（先 `scheduler.stop()` 不再派新班，再 `shutdownAdapters()` 杀掉 adapter
    // 名下的 chrome 子进程）已经是采集调度域的两个 effect，由下面 quiesceKernel 按注册反序
    // 执行——**这里一行手写的都没有了**。漏掉 shutdownAdapters 的后果没变：遗留 chrome 跨重启
    // 堆积，最终把 WSL 打到 OOM。
    // 落盘库的 close 也全在下面这一步里（存储域每个 store 一个 effect）。
    // 统一销毁：撤销所有登记在内核上的 effect（句柄、定时器、订阅）。放在上面那些手写步骤
    // **之后**——存量的关停顺序有它自己的约定，内核这一步只负责「已经搬进来的那部分」。
    // dispose() resolve 之后可能还有后继 transition，所以要轮 `fiber.inertia` 到静默。
    // 整段有超时兜底：销毁卡死不能挡住 process.exit —— 这条路径的第一职责是让进程真的退。
    await quiesceKernel(kernel).catch((e) => {
      console.error('[stream] kernel dispose error:', (e as Error).message)
    })
    releaseLock()
    finale()
  }
  // 到这一行 restart 才算接通——在此之前 `POST /api/restart` 回 500「still booting」，不排关停。
  shutdown = shutdownThen
  process.on('SIGINT', () => void shutdownThen(() => process.exit(0), 'SIGINT'))
  process.on('SIGTERM', () => void shutdownThen(() => process.exit(0), 'SIGTERM'))
  process.on('exit', releaseLock)
}

if (!process.env.VITEST) {
  main().catch((e) => {
    console.error('[stream] fatal:', e)
    process.exit(1)
  })
}
