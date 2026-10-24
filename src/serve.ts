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
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { routes, attachRelayServers } from './engine/routes.ts'
import { createStream, createRuntime, type Stream } from './engine/index.ts'
import { loadConfig } from './config-env.ts'
import { type HttpDeps } from './http/app.ts'
import { classifyLauncher } from './restart/policy.ts'
import { makeRestartTrigger, type Shutdown } from './restart/trigger.ts'
import { WsHub } from './http/ws.ts'
import { toClientItem } from './http/client-item.ts'
import { DebugLog } from './http/debug-log.ts'
import { createFailureSink } from './http/debug-sink.ts'
import { startLoopLagMonitor } from './loop-lag.ts'
import { OpTracker, type TrackFn, type TrackSyncFn } from './op-track.ts'
import { type StandbyManager } from './plugins/standby/manager.ts'
import { reportUnboundHooks } from './kernel/plugins/module-hooks.ts'
import { makeFetchFor } from './devices/fetch.ts'

/** 后端自己就是那扇门，默认口 = 唯一的对外口 8900（`DEFAULT_BACKEND_URL`、`GATEWAY_PORT`
 *  都是这个数）。曾经默认 4555 是容器时代的遗留：门在 Caddy 上，
 *  后端躲在网内，于是"起在 4555、探 8900"的默认组合让 spawn 必然超时（见 `mcp/spawn-backend.ts`
 *  的 C1 注释）。默认值对齐之后，那个坑连同它的补丁一起消失。
 *  compose 自托管旁支里后端仍躲在 Caddy 后面，那条路显式传 `STREAM_PORT=4555`（见
 *  `plugins/compose.ts`）——**显式的那一侧是特例，默认的这一侧是主路**。 */

const PORT = Number(process.env.STREAM_PORT ?? 8900)
// /tmp isn't guaranteed to exist or be writable on every platform the released
// package targets. STREAM_DATA_DIR (the app-data dir `stream` is launched with) is
// the natural home for this; os.tmpdir() covers dev and any other caller that
// doesn't set it.
const LOCK_FILE = join(process.env.STREAM_DATA_DIR ?? tmpdir(), 'stream-serve.pid')

// pid 活性/出生时刻的判据收进 proc-identity.ts。
// pidStartTime 保持从这里 re-export——serve.lock.test.ts 按旧路径引它。
import { pidAlive, pidStartTime } from './proc-identity.ts'
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
  enabled: boolean,
  log: (msg: string) => void = console.log,
): boolean {
  if (!enabled) {
    log('[stream] scheduler disabled — query-only backend, no standing harvest')
    return false
  }
  scheduler.start()
  return true
}


async function main() {
  acquireLock()        // refuse to start if another serve is live
  // 进程级共享资源（`src/engine/runtime.ts`）。serve 是进程入口，所以由它接管进程级钩子（`process: true`）：
  // 兜底网（孤儿 rejection 不带走后端、未捕获异常留堆栈 + 通知再退）、信号上的收尾、全局 fetch 陷阱。
  // 位置有讲究：**早于实例装配**——真事故（2026-09-04 发行机上 RsshubClient 的孤儿 `ready`）就发生在启动装配
  // 期间，挂晚了正好错过它。实例在建内核那一刻把自己的通知口挂上去（`runtime.attachNotify`）。
  const runtime = createRuntime({ env: process.env, process: true })
  const config = loadConfig()
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
  // `boot` span: the monitor above deliberately predates bootstrap to catch boot-time stalls —
  // without this span those stalls all reported "卡顿来自未埋点的门", reading like an unknown
  // hole when it was the (known, expected) registry build / provider seeding.
  // 实例本体经库入口装配（`src/engine/index.ts`）：数据目录锁、内核、`bootstrap()`、关停。serve 只是它的一个调用方。
  // 内核仍由这里建好递进去（搬迁期过渡口）：上面的进程兜底网已经握着它的 lazy 引用。
  const stream: Stream = await track('boot', () => createStream({
    dataDir: process.env.STREAM_DATA_DIR ?? process.cwd(),
    config,
    log: console.log,
    runtime,
    hooks: {
      // agent 修复会话给 agent 的那条 MCP 线：**口和 token 只有这儿知道**（口就是本进程绑的那个，
      // 两个数一分家，agent 就会去敲一个没人应答的地址）。
      mcpEndpoint: () => ({ url: `http://127.0.0.1:${PORT}/api/mcp`, token: stream.secrets.apiToken }),
      onItem: (item, type) => hub.broadcast({ type: 'item', item_type: type, item: toClientItem({ ...item, type }, stream.kernel.sources.itemProjection()) }),
      onDebug: recordDebug,
      broadcast: (msg) => hub.broadcast(msg),
      track,
      trackSync,
    },
  }))
  const kernel = stream.kernel
  // 出站唯一入口接上设备目录（装进本实例的 ctx.deviceFetch）。装配早期 send 对非 local 一律
  // 报离线，这一步之后才能派到设备。必须早于调度中心 / 任务中心开始派活（更靠后才启动）。
  kernel.deviceFetch.install(makeFetchFor({ directory: kernel.harvest.hostRelays, debug: recordDebug }))
  // 设备 / 节点 / 身份表随实例建（`src/engine/devices.ts`）；下面的设备路由、中继、任务的执行位置都读这几格。
  // 能力包宿主随实例建、可选包也在 createStream 里装好了（`src/engine/capabilities.ts`）；内置的 Stream Desktop
  // 仍在 `attachRelayServers` 里挂（它要养本机进程、要知道本进程的口）。
  // 两把令牌随实例落数据目录（`src/engine/index.ts`）：访问守卫与三条中继认它们。

  // ── HTTP 面（D1）：路由/挂载/中继接线全在 src/engine/routes.ts，serve 只递 io ──
  // `POST /api/restart` 的两只手：闸门读账本；触发先交出 mode、下一拍才开始关（trigger.ts）。
  // 优雅关（`shutdownThen`）在 main() 末尾才装好，而 HTTP 早在那之前就在听——中间这个窗口里
  // 的 restart 请求必须被**拒绝**而不是排进 setImmediate 去撞 undefined（那会是未捕获异常、
  // 进程以 1 退出）。所以这里是一个显式的 `undefined` 槽 + 现取，不是前向引用。
  let shutdown: Shutdown | undefined
  const restart: NonNullable<HttpDeps['restart']> = {
    running: () => stream.tasks.runningTasks(),
    trigger: makeRestartTrigger({ mode: classifyLauncher(process.env), shutdown: () => shutdown }),
  }
  // standby 管理器的共享槽：接线在 routes() 里（buildStandbyOrDegrade），关停在下面 shutdownThen 读。
  const standbyRef: { current: StandbyManager | null } = { current: null }
  const app = await routes({
    stream,
    hub,
    debugLog,
    track,
    trackSync,
    port: PORT,
    restart,
    standbyRef,
  })

  const server = serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) =>
    console.log(`[stream] HTTP+WS on http://0.0.0.0:${info.port} (ws: /ws)`)
  )
  kernel.effect(() => () => { server.close() })
  attachRelayServers(server as unknown as Server, { stream, hub, debugLog, track, trackSync, port: PORT, restart, standbyRef })
  const streams = kernel.scheduling.scheduler.list()
  console.log(`[stream] ${streams.length} streams → vault ${config.vault_root}`)
  // scheduler.start() runs each stream's initial harvest itself (staggered) — no
  // manual tick loop here, which previously double-ran every stream at boot.
  // 查询档(STREAM_NO_SCHEDULER=1,stdio MCP spawn 的即用即回收后端)跳过采集,只服务查询。
  maybeStartScheduler(kernel.scheduling.scheduler, config.deployment?.scheduler !== false)
  // The scheduler is the only standing harvest engine (ARCHITECTURE.md Data Scheduling,
  // invariant 4). Standing resolution goals are expressed as exclusive Streams, harvested
  // here — not by any parallel subscription loop.

  // 三个模块级钩子的接线体检：只报**不该是 null 却是 null 的那些**。两条常态降级显式申报，
  // 不进这行——没有 Docker / 没插件声明 standby 时 standby 本就该 inert；查询档
  // （STREAM_NO_SCHEDULER=1）根本不起调度中心，taskDeps 没人要。掺进常态 = 第一天就变噪音。
  reportUnboundHooks({
    log: (m) => console.log(m),
    probes: [
      // 钩子都在实例上（ctx.packages），名册也跟着实例走——没有模块级全局可指了。
      { name: 'pluginTarget', bound: () => kernel.packages.targets.bound },
      { name: 'standby', bound: () => kernel.packages.standby.bound },
      { name: 'taskDeps', bound: () => stream.tasks.depsBound() },
    ],
    degraded: [
      ...(standbyRef.current ? [] : ['standby']),
      ...(config.deployment?.scheduler === false ? ['taskDeps'] : []),
    ],
  })

  let shuttingDown = false
  /** 优雅关：关停步骤对信号退出和 `POST /api/restart` 是同一份，只有**最后一步**不同——
   *  信号退出 `process.exit(0)`；重启按「谁拉起我」收尾（`src/restart/policy.ts`）。 */
  const shutdownThen = async (finale: () => void, label: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[stream] ${label} → shutting down...`)
    await stream.tasks.stop()
    if (standbyRef.current) await standbyRef.current.shutdown().catch(() => {})
    // 采集的两步关停（先 `scheduler.stop()` 不再派新班，再 `shutdownAdapters()` 杀掉 adapter
    // 名下的 chrome 子进程）已经是采集调度域的两个 effect，由下面 quiesceKernel 按注册反序
    // 执行——**这里一行手写的都没有了**。漏掉 shutdownAdapters 的后果没变：遗留 chrome 跨重启
    // 堆积，最终把 WSL 打到 OOM。
    // 落盘库的 close 也全在下面这一步里（存储域每个 store 一个 effect）。
    // 统一销毁：撤销所有登记在内核上的 effect（句柄、定时器、订阅）。放在上面那些手写步骤
    // **之后**——存量的关停顺序有它自己的约定，内核这一步只负责「已经搬进来的那部分」。
    // dispose() resolve 之后可能还有后继 transition，所以要轮 `fiber.inertia` 到静默。
    // 整段有超时兜底：销毁卡死不能挡住 process.exit —— 这条路径的第一职责是让进程真的退。
    // 库入口的 `close()` = `quiesceKernel` + 放掉数据目录锁（必须早于下面的 finale：reexec 档的新进程要拿同一把锁）。
    await stream.close().catch((e) => {
      console.error('[stream] kernel dispose error:', (e as Error).message)
    })
    // runtime 是 serve 建的、serve 关：收掉 RSSHub worker、跑退出收尾（facility 锁文件）。
    await runtime.close().catch(() => {})
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
