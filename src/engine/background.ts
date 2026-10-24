/**
 * 实例的后台工作（openspec `embeddable-engine`，design D1 附注）。
 *
 * design D1 的装配块表把这些定为**实例**：调度中心（内置 + 用户任务、`taskDeps`、`TaskStore`、
 * `RunLedger`）、`markInterruptedAtBoot`、research watchers、standby 接线，以及 `scheduler.start()`
 * 与接线体检（`reportUnboundHooks`）。判据是「不挂路由的嵌入方是否也需要它」——订阅要按时采集、
 * 任务要按点跑，这些不该等 HTTP 面挂起来才转。
 *
 * **启动时机（D1 附注）**：`createStream()` 直接启动，**不设**显式的 `start()`。
 * D1 草图把 `createStream` 定义为 bootstrap + 非 HTTP 装配：嵌入方只调它，就该拿到一份会自己动的
 * 实例——「拿到实例还要记得 start」是个无声的坑（忘了就什么都不跑，而且没有任何一处报错）。
 * 不加方法 = 不新增公共接口面。代价是失去「先装配、后开闸」的顺序控制；真要延迟的调用方用
 * `config.deployment.scheduler = false` 整体关掉（与查询档同一开关）。
 *
 * `routes()` 只挂 HTTP 与「推 ws」那半（hub 广播、ws 命令、面板）。本文件可达的模块不许出现
 * `process.env`（`no-process-env.guard.test.ts` 钉着）。
 */
import { join, dirname } from 'node:path'
import type { Stream, StreamHostHooks } from './index.ts'
import type { TaskDeps } from '../tasks/types.ts'
import { builtinTasks } from '../tasks/builtin.ts'
import { TaskStore, type UserTaskRow } from '../tasks/task-store.ts'
import { RunLedger } from '../tasks/run-history.ts'
import { compileEnabled, compileUserTask } from '../tasks/user-tasks.ts'
import { actionDirectory } from '../tasks/package-actions.ts'
import { buildStandbyOrDegrade, wireStandby } from '../plugins/standby/wire.ts'
import { resolveDockerEndpoint } from '../plugins/standby/docker-api.ts'
import { standbyInertNotification } from '../plugins/standby/inert-notice.ts'
import type { StandbyManager } from '../plugins/standby/manager.ts'
import { bindModuleHook, reportUnboundHooks } from '../kernel/plugins/module-hooks.ts'
import { createResearchWatchers } from '../live/research-watchers.ts'
import { watchArtifactsDir } from '../live/watch.ts'
import { artifactsDirOf } from '../board/run-source.ts'
import { lazyNotify, type EventsService } from '../events/service.ts'
import { makeFetchFor } from '../devices/fetch.ts'
import { assertDeviceReady, facilityTarget, placeRun } from '../devices/placement.ts'
import { LOCAL_TARGET, taskTarget } from '../devices/target.ts'
import type { RunPlacement } from '../devices/run-context.ts'
import { errText } from '../err-text.ts'
import { runSessionExports } from '../credentials/session-export.ts'

/** standby 管理器的共享槽：startBackground 写（接线成功 / 降级），实例关停读。 */
export interface StandbySlot { current: StandbyManager | null }

/** 查询档无采集：stdio MCP spawn 出的即用即回收后端（scheduler=false）不该把所有订阅流的
 *  定时采集跑起来——查询型用户连上问一句不应顺带触发全量采集（两档拍板）。标记为假则跳过
 *  scheduler.start() 并打一行原因日志；否则照常启动。返回是否已启动，便于调用方/测试断言。
 *  （原 `serve.ts` 的同名函数，随后台工作一起搬进实例。） */
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

/**
 * streamId → research present 的 artifacts 目录。routes 的详情面与实例的 watcher 共用同一条
 * 解析——两条路各写一遍，改一处漏一处就是「详情页有、推送没有」的那种分叉。
 */
export function researchArtifactsDirFor(stream: Stream): (streamId: string) => string {
  const kernel = stream.kernel
  const sources = kernel.sources
  return (streamId: string): string => {
    const rec = kernel.stores.channels.getStream(streamId)
    if (!rec) throw new Error(`no stream "${streamId}"`)
    const member = rec.members[0]
    if (!member) throw new Error(`stream "${streamId}" 没有绑定任何源`)
    const manifest = sources.registry.get(member.source)
    const runtimeConfig = manifest ? kernel.runtimeConfig(manifest as never) : {}
    return artifactsDirOf(member.params, { runtimeConfig })
  }
}

/**
 * 启动这份实例的后台工作。`createStream()` 在装配成功后调一次；抛错由 createStream 的
 * 装配失败路径统一回收（已登记的 effect 归 quiesceKernel 撤）。
 */
export async function startBackground(
  stream: Stream,
  hooks: StreamHostHooks | undefined,
  log: (msg: string) => void,
  standby: StandbySlot,
): Promise<void> {
  const kernel = stream.kernel
  const config = stream.config
  const pkgs = kernel.packages
  const stores = kernel.stores
  const settingsStore = kernel.settings
  const schedulerOn = config.deployment?.scheduler !== false
  // 出站唯一入口接上设备目录（装进本实例的 ctx.deviceFetch）。装配早期 send 对非 local 一律
  // 报离线，这一步之后才能派到设备。必须早于调度中心 / 任务中心开始派活（就在下面）。
  // 调试记录走宿主回调：serve 把它接到「环 + ws 广播 + 落盘」那一份上，嵌入方自定。
  kernel.deviceFetch.install(makeFetchFor({ directory: kernel.harvest.hostRelays, debug: (e) => hooks?.onDebug?.(e) }))

  // ── standby：声明了 backend.standby 的插件闲置回收 + 按需唤醒（原 routes() 整块搬入）──
  // 接线经内核 effect 登记（bindModuleHook）：挂上时 set、quiesceKernel 时复位为 null。
  // 传 null 的那一路（adopt 半路抛的复位）保持直接 set——那是「撤销一个半成品」，不是一次新的
  // 绑定，包成 effect 只会往树上挂一个什么都不做的 disposer。
  // 整块交给 buildStandbyOrDegrade：任何 throw 都降级成一行日志 + standby inert，绝不掀翻开机。
  // reaper 轮次由调度中心的 standby-reaper 任务驱动（src/tasks/builtin.ts），只管 tick()。
  await buildStandbyOrDegrade(async () => {
    const wiring = await wireStandby({
      // 合并名单（内置 + 第三方），不是 `pkgs.plugins`：container-policy 给第三方兜的
      // `standby: { idleMinutes: 30 }` 写在安装确认页上，名册漏了第三方那层，那句承诺就是空话。
      descriptors: pkgs.backendDirectory.all(),
      mode: config.deployment?.plugin_network ?? 'none',
      isEnabled: (p) => pkgs.isPluginEnabled(p),
      // Docker 端点从 config 走（`deployment.docker_host`，进程入口在 deploymentFromEnv 里翻译）：
      // 库入口可达模块禁 process.env，默认实现拿不到环境就当没配。
      resolveEndpoint: () =>
        resolveDockerEndpoint(config.deployment?.docker_host ? { DOCKER_HOST: config.deployment.docker_host } : {}, process.platform),
      setHook: (m) =>
        m
          ? bindModuleHook(kernel, () => pkgs.standby.bind(m), () => pkgs.standby.bind(null))
          : pkgs.standby.bind(null),
    })
    standby.current = wiring.manager
    // inert 的原因要活过这次接线：取址答空时才有人能分出「够不着 Docker」（事故，该喊）
    // 和「按设计如此」（桌面档 / 没插件声明 standby）。随内核 dispose 复位——不复位的话，
    // 同进程第二次 bootstrap 会读到上一次的残留，而残留和真事故长得一模一样。
    bindModuleHook(
      kernel,
      () => pkgs.standby.setInertReason(wiring.inertReason ?? null),
      () => pkgs.standby.setInertReason(null),
    )
    // 降级不等于闭嘴：够不着 Docker 时所有带容器的插件一起失效，而它们的失败形状是
    // 「取址答空 → base 空串 → 一句 Failed to parse URL」，没有一处会说出真正的原因。
    const notice = standbyInertNotification(wiring)
    if (notice) kernel.streamEvents.emit(notice)
  }, () => {
    // 降级清理：hook 若已指向一个半成品管理器，后续 withAwake 会打到它上面。
    standby.current = null
    pkgs.standby.bind(null)
  }, log, (detail: string) => {
    kernel.streamEvents.emit({
      type: 'plugin.container', severity: 'error',
      title: '插件容器的休眠/唤醒失效了',
      body: '接线没起来，所有带后端容器的插件不再按需唤醒、也不再闲置回收。'
        + '已经停着的那些容器**不会有人叫醒它们**，用到它们的功能会一直失败（Stream 其余部分照常）。'
        + `原因：${detail}`,
      dedupeKey: 'standby:degraded',
    })
  })

  // ── 介入域：上一个进程留下的在飞 run（原 routes() 搬入）──
  // agent 子进程随它一起没了，库里那些行却还写着「running」。续得上的收成 paused（**不自动续**——
  // 自动拉起来等于用户没点过任何东西就开始烧 token），续不上的收成终态 error。
  // **两个数分开说**：只报暂停那个，另一批就没人知道发生过。
  if (kernel.intervention) {
    const { paused, failed } = kernel.intervention.repairs.markInterruptedAtBoot()
    if (paused) log(`[intervention] ${paused} 条修复会话因重启暂停，可在运维页「源健康」该源的修复页里「继续」`)
    if (failed) log(`[intervention] ${failed} 条在飞的 run 没有可续的会话，因重启收成 error`)
  }

  // ── 调度中心（原 routes() 的装配 + serve.ts 的启动，合并搬入）──
  // store/ledger/日志目录不是调度中心的专属资源：store/ledger 无条件构造（打不开则任务面整体
  // 降级，路由仍挂但清单为空），真正按 scheduler 开关门控的是 start 本身与 taskDeps 的装配。
  // TaskStore 构造函数同步 `new Database(dbPath)` + `db.exec(...)`，文件被锁 / 损坏 / 权限不对 /
  // 磁盘满都会同步 throw；降级方式与 standby 同款：接住、打一行日志、任务面整体缺席。
  const packageActions = actionDirectory(pkgs.activated.actions)
  if (packageActions.size) {
    log(`[stream] package actions: ${[...packageActions.keys()].join(', ')}`)
  }
  const ledgerPath = join(dirname(config.item_db), 'sidequest.sqlite')
  const taskLogDirCandidate = join(dirname(config.item_db), 'task-logs')
  let taskStore: TaskStore | undefined
  let runLedger: RunLedger | undefined
  let taskLogDir: string | undefined
  try {
    taskStore = new TaskStore(join(dirname(config.item_db), 'stream.db'))
    runLedger = new RunLedger(ledgerPath)
    taskLogDir = taskLogDirCandidate
  } catch (e) {
    taskStore = undefined
    runLedger = undefined
    taskLogDir = undefined
    log(`[stream] task center store disabled — open failed: ${errText(e)}`)
  }
  /** 编译一条任务行要的两样东西：动作名录 + 它绑的那格配置 row 的**生效值**。
   *  两个都是**调用时才取**——用户在界面上改完那格，下一轮就该按新的来。 */
  const compileOpts = () => ({
    ...(taskLogDir ? { logDir: taskLogDir } : {}),
    actions: (name: string) => packageActions.get(name),
    paramsFor: (ref: string) => settingsStore.runtimeConfig(ref),
    // 执行位置：行的身份 → 环境 → 设备 → 包 facility 的默认目标 → local，开跑时解一次（browser-identity D7）。
    // 身份 / 环境目标在这里选节点、唤起、核对（动作的新鲜度窗口 60 秒）；失败都在动作被调用之前。
    placement: (row: UserTaskRow) => {
      const pkgId = row.action?.split(':')[0]
      const net = pkgId ? pkgs.networkFor(pkgId) : undefined
      const target = taskTarget(row) ?? (net?.facility ? facilityTarget(stream.devices.facilityBindings, net.facility) : undefined) ?? LOCAL_TARGET
      return placeRun({
        target,
        ...(net?.facility ? { facility: net.facility } : {}),
        hosts: net?.hosts ?? [],
        router: kernel.identityRouter,
        purpose: 'action',
      })
    },
    ready: (p: RunPlacement) => assertDeviceReady(p, kernel.harvest.hostRelays, 'http.fetch'),
    // 运行记录带节点（browser-identity D12）：执行那一刻节点表里的 profile 名与环境。
    nodeOf: (bindingId: string) => {
      const nodeId = kernel.harvest.extRelays.nodeOf(bindingId)
      if (!nodeId) return undefined
      const n = stream.devices.nodes?.get(nodeId)
      return { nodeId, ...(n?.profileName ? { profileName: n.profileName } : {}), ...(n?.environment ? { environment: n.environment } : {}) }
    },
  })
  const compileRow = (row: UserTaskRow) => compileUserTask(row, compileOpts())
  // 用户定义的定时任务（spec 2026-08-28 §3.1）：定义住 stream.db，跑起来和 builtin 无差别。
  // **一份装配，两个消费者**：start 在这里（实例），改排期 / 立即跑在 HTTP 任务面（routes 经
  // `tasks.assembly` 读同一份）——两边读的都是这一个对象。
  const userTasks = taskStore ? compileEnabled(taskStore.list(), compileOpts()) : []
  let taskDeps: TaskDeps | undefined
  const streamEvents = kernel.streamEvents
  if (schedulerOn) {
    // 查询档（scheduler=false）不起调度中心也不装配 taskDeps：查询型即用即回收后端不该常驻
    // 定时任务（cookie-refresh/jobs-sweep/standby-reaper/netdisk-autosync）。任务面的内置清单
    // 随 assembly.builtins 缺席而诚实报空。
    taskDeps = {
      log,
      events: { append: (e) => streamEvents.emit(e) }, // EventsService 的门面方法叫 emit，TaskDeps 只认 append
      cookieProvider: kernel.credentials.cookieProvider,
      // 接缝：这一格**直连内核的 conversions 域**，不经 HttpDeps。
      capabilityJobs: kernel.conversions.capabilityJobs ?? undefined,
      standbyManager: standby.current ?? undefined,
      // 接缝：这四格**直连内核的 netdisk 域**，不经 HttpDeps。漏改不报错——netdisk-autosync
      // 每轮「成功」实为 deps undefined 早退，网盘几天不同步零报警。
      netdisk: kernel.netdisk.netdisk ?? undefined,
      netdiskStore: kernel.netdisk.netdiskRoutes?.store ?? undefined,
      reconcile: kernel.netdisk.netdiskRoutes?.reconcile ?? undefined,
      // 第四格（追更）同样直连内核那一份——每小时的 netdisk-follow 靠它扫到期的剧。
      follow: kernel.netdisk.netdiskRoutes?.follow ?? undefined,
      browserLanes: { reapIdle: kernel.harvest.reapIdleLanes },
      authReconcile: kernel.auth.reconcileAuthNow,
      // 接缝：这两格**直连内核的 agent 域**，不经 HttpDeps（intent 的定时消化同上，静默早退型）。
      intents: kernel.agent.intents,
      agentRuns: kernel.agent.agentRuns,
      // runLedger 开不起来时这一格不装配：一个恒 throw 的 ledger-prune 比没有这个任务更坏
      // （builtinTasks 按 wired.ledger 是否存在条件装配，见其头注）。
      ...(runLedger ? { ledger: { prune: (o: { keepPerTask: number; keepMs: number }) => runLedger!.prune(o) } } : {}),
      // 登录态导出：**一条都没声明就整格不装配**，于是任务表上根本不出现这个任务。
      // 声明在 config.yaml，见 AppConfig.session_exports。
      ...(config.session_exports?.length
        ? { sessionExports: () => runSessionExports(config.session_exports!, kernel.credentials.cookieProvider) }
        : {}),
      // 包更新检查（`recipe-update-check`）：deployment.recipe_update_check=false 关掉 = 整格不装配，
      // 任务表上就没有这条（与 sessionExports 同一种「没有就不出现」的写法）。
      ...(config.deployment?.recipe_update_check !== false
        ? { recipePackageOps: { updates: () => kernel.sources.recipePackageOps.updates() } }
        : {}),
    }
    // deps 经内核 effect 登记：quiesceKernel 时复位——job 对着一个已撤的内核取 deps 是错的。
    bindModuleHook(kernel, () => stream.tasks.setDeps(taskDeps!), () => stream.tasks.resetDeps())
  }
  const builtins = taskDeps ? builtinTasks(taskDeps) : undefined
  stream.tasks.assembly = {
    ...(taskStore ? { store: taskStore } : {}),
    ...(runLedger ? { ledger: runLedger } : {}),
    ...(builtins ? { builtins } : {}),
    actions: packageActions,
    compileRow,
  }
  if (taskDeps) {
    // await：createStream 解析 = 调度中心已在跑（上一进程遗留的 waiting job 此刻已有人捡）。
    // start 内部自降级（失败只留一行日志、回 {ok:false}），不会把开机掀翻。
    await stream.tasks.start([...builtins!, ...userTasks], { dbPath: ledgerPath, log })
  }
  // 采集调度器（原 serve.ts）：scheduler.start() 自己按错峰派每条流的首采，这里没有手工 tick。
  maybeStartScheduler(kernel.scheduling.scheduler, schedulerOn, log)

  // ── research watchers（原 routes() 搬入；「推 ws」的那半走宿主回调）──
  // 每个 research present 频道绑的流各起一个 watcher。目录取不到就跳过这条流（源没配全，
  // 不是错误路径）——watcher 缺席只意味着退化成「打开页面时查一次」。`notify` 用 lazyNotify：
  // 事件层比装配晚，直接取字段会冻住 undefined。
  const notifyNewResearchRun = lazyNotify(() => kernel.streamEvents as EventsService | undefined)
  const researchWatchers = createResearchWatchers({
    listChannels: () => stores.channels.listChannels(),
    dirForStream: researchArtifactsDirFor(stream),
    start: ({ dir, streamId }) => watchArtifactsDir({
      dir,
      streamId,
      onChanged: (id) => hooks?.broadcast?.({ type: 'live-changed', streamId: id }),
      onNewRun: (runId) => notifyNewResearchRun({ type: 'research-run', severity: 'info', title: `新 run：${runId}`, dedupeKey: `research-run:${runId}` }),
    }),
  })
  researchWatchers.sync()
  // 集合是**运行期可变**的（频道随时新建/改绑/删），登记进内核 effect 的只有 stopAll()——常驻
  // 句柄不登记就没人关。所有权边界见 research-watchers.ts 头注。
  kernel.effect(() => () => researchWatchers.stopAll())
  // 同步触发从 HTTP 写路径搬进数据层：改动「流—频道」关系 / 频道 present / 流成员表的每条
  // 写入路径（HTTP、MCP 工具、导入）都落在这张表上，watcher 跟着重建一次（幂等）。过去挂在
  // HttpDeps.onChannelsChanged 上，MCP / 导入那几条写入路径要各记得调一次——漏一处就是
  // 静默的不刷新。
  kernel.effect(() => {
    const off = stores.channels.onChange(() => researchWatchers.sync())
    return () => { off() }
  })

  // ── 接线体检（原 serve.ts）：只报**不该是 null 却是 null 的那些** ──
  // 两条常态降级显式申报，不进这行——没有 Docker / 没插件声明 standby 时 standby 本就该 inert；
  // 查询档根本不起调度中心，taskDeps 没人要。掺进常态 = 第一天就变噪音。
  reportUnboundHooks({
    log,
    probes: [
      // 钩子都在实例上（ctx.packages），名册也跟着实例走——没有模块级全局可指了。
      { name: 'pluginTarget', bound: () => pkgs.targets.bound },
      { name: 'standby', bound: () => pkgs.standby.bound },
      { name: 'taskDeps', bound: () => stream.tasks.depsBound() },
    ],
    degraded: [
      ...(standby.current ? [] : ['standby']),
      ...(schedulerOn ? [] : ['taskDeps']),
    ],
  })
}
