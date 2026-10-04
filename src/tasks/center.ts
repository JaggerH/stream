// 调度中心封装层：ScheduledTask → Sidequest 翻译，唯一允许 import sidequest 的接线文件。
import { ensureLedgerIndexes, LEDGER_QUERIES, interruptOrphanRuns, releaseStaleDigests, INTERRUPTED_BY_RESTART } from './orphan-sweep.ts'
// 降级守卫（对齐 serve.ts buildStandbyOrDegrade）：任何 throw ⇒ 一行日志 + inert，绝不带走后端。
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
// 只有 `whenBusy: 'skip'` 那一档要自己持节拍器：sidequest 的 `b.schedule()` 到点直接落账，
// 中间没有任何钩子，而"这一班到底跑不跑"必须在**入队之前**决定（见 buildCron）。
import nodeCron from 'node-cron'
import type { ScheduledTask } from './types.ts'
import { taskRegistry, registerTasks } from './registry.ts'
import { getTaskDeps } from './deps.ts'
import { makeWatchdogTask, type TaskLook } from './watchdog.ts'

/**
 * `sidequest.jobs.js` 在盘上的位置。**两种布局，不能只按源码树算。**
 *
 * 源码树跑（dev / tsx）：本模块是 `src/tasks/center.ts`，往上两级才是仓库根。
 * 发行形态跑：整个后端被打成**一个** `server.mjs`，`import.meta.url` 指向它自己，
 * 往上两级会跑到装载目录的祖父目录去——实测 2026-08-30 在一台全新 Windows 上解析成了
 * `C:\Users\sidequest.jobs.js`，于是 Sidequest 起不来、**整个任务中心静默降级**
 * （定时采集全没了，而后端本身 200 一切正常，只有日志里一行）。
 *
 * 所以按"文件在哪儿就用哪儿"来定：先看发行布局（和 `server.mjs` 同目录），再看源码树布局。
 * 两个都没有就返回发行布局那个路径——让 Sidequest 自己报"文件不存在"，错误信息里带的是
 * 我们最可能期望的那个位置，而不是一个凭空往上两级算出来的地方。
 */
export function resolveJobsFile(moduleDir: string, exists: (p: string) => boolean = existsSync): string {
  const shipped = resolve(moduleDir, 'sidequest.jobs.js')
  if (exists(shipped)) return shipped
  const inRepo = resolve(moduleDir, '../../sidequest.jobs.js')
  return exists(inRepo) ? inRepo : shipped
}

/** node-cron 的 ScheduledTask 句柄——我们只用 destroy() 停掉一条已注册的 cron。 */
interface CronHandle { destroy: () => unknown }

interface SidequestFacade {
  start: (config: unknown) => Promise<unknown>
  /** 运行期建一个队列（幂等：已存在就当成功）。缺席 = 这个门面建不了队列，见 `ensureQueue`。 */
  createQueue?: (name: string, concurrency: number) => Promise<void>
  build: (jobClass: unknown) => {
    queue: (q: string) => unknown
    maxAttempts: (n: number) => unknown
    retryDelay: (ms: number) => unknown
    unique: (v: unknown) => unknown
    scheduleOptions: (o: unknown) => unknown
    schedule: (cron: string, ...args: unknown[]) => Promise<CronHandle>
    /** 一次性立即入队（watchdog 补跑丢班用）——与节拍器到点做的事等价 */
    enqueue: (...args: unknown[]) => Promise<unknown>
  }
  stop: () => Promise<void>
}

let active: SidequestFacade | undefined
let activeJobClass: unknown
/** 中心这一代已经建过（或确认存在）的队列名。只为省掉重复的建队列往返，不是真相源。 */
const knownQueues = new Set<string>()
/**
 * "这个队列此刻有没有活着的 job"。**读的是 sidequest 账本，不是本进程的内存**——本进程内存
 * 只知道自己刚才做过什么，而队列里排着的东西可能是上一个进程留下的（账本跨重启存活）。
 * 装不起来（账本还没建、better-sqlite3 起不来）时留 undefined，见 `groupBusy`。
 */
let queueAlive: ((queue: string) => boolean) | undefined
/** 中心这一代的日志出口（`startTaskCenter` 的 opts.log）。跳过一班要留痕，得有地方写。 */
let centerLog: (msg: string) => void = () => {}
/** 这一代账本的路径（`startTaskCenter` 的 opts.dbPath）。`runningTasks` 只读它；中心没起 / 已停 = undefined。 */
let ledgerPath: string | undefined
/** taskId → 它当前那条 cron 的句柄。改排期 = destroy 旧的 + 注册新的。 */
const cronHandles = new Map<string, CronHandle>()

/**
 * 中心的**代际**：每关停一次就 +1（start 失败的回滚那条路同理——它也把中心打回"没起来"）。
 *
 * 这是 `addTask` 唯一可信的"中心还活着吗"判据。`if (!active)` 只在**问的那一刻**成立：
 * addTask 从发问到真正写 `taskRegistry` / `cronHandles` 之间隔着若干个 await（排队、摘旧
 * cron、`b.schedule()`），stopTaskCenter 完全可以落在中间——`taskRegistry.clear()` 先跑完，
 * 这次 addTask 再把行写回去，留下一条**有注册表行、没有 cron** 的任务（watchdog 读
 * taskRegistry，会一直对着它补跑）；反过来那条也一样：`destroyAllCrons()` 先跑完，这次
 * addTask 再把新句柄塞进 `cronHandles`，留下一条**活着但再没人摘得掉**的 cron。
 *
 * 修法不是把 `!active` 挪进队列里再问一次——那只把窗口缩小到"最后一个 await"，不消除它。
 * 真正的原子性来自：**所有 await 先做完，把结果攒在手里；最后用一个同步块一次性提交**，
 * 提交前比一次代际。同步块中间没有 await ⇒ 没有任何东西能插进"确认中心还活着"和"写下这一行"
 * 之间。代际变了就整体作废（顺手把已经建出来的 cron 摘掉，别留孤儿）。
 */
let generation = 0

/**
 * 摘掉所有 cron 句柄。**必须 destroy，不能只 clear map**——node-cron 的计划活在它自己的定时器
 * 里，把 map 清空只是丢掉引用，那条 cron 照样按点触发，而且再没有任何东西能摘掉它（只能重启
 * 进程收）。这正是 `serialize` 头注警告过的那个形状；`removeTaskLocked` 那条路一直是对的，
 * stop 和 start 的失败回滚这两条路曾经不是。
 *
 * **后果不是"多跑一次日志"**：进程内 stop→start（测试套件每条用例之间就在这么干）或者 start
 * 失败后重试，会让孤儿 cron 和新 cron 并存，同一个槽点触发两次。调度中心今天挂着真下单的
 * 任务（东财那两条真下单的），`serial: true` 的 uniqueness 大概率挡得住第二次——但那是
 * "大概率"，不是安全垫。
 *
 * 一条 destroy 失败不该拖住其余的：逐条吞掉异常，保证 map 最后一定清空。
 */
async function destroyAllCrons(): Promise<void> {
  for (const h of cronHandles.values()) {
    try { await h.destroy() } catch { /* 摘一条失败不该让其余的留成孤儿 */ }
  }
  cronHandles.clear()
}

async function realFacade(): Promise<{ facade: SidequestFacade; jobClass: unknown }> {
  const { Sidequest } = await import('sidequest')
  const { StreamTaskJob } = await import('./stream-task-job.ts')
  return {
    facade: {
      start: (c) => Sidequest.start(c as never),
      // 已存在不是错：两条任务同组时第二条走到这里必然撞上第一条建出来的那个队列，
      // 而"确认它在"正是我们要的结果。真失败（后端没配好）仍旧抛给 ensureQueue 去报。
      createQueue: async (name, concurrency) => {
        if (await Sidequest.queue.get(name)) return
        try { await Sidequest.queue.create({ name, concurrency }) }
        catch { if (!await Sidequest.queue.get(name)) throw new Error(`建不出队列 ${name}`) }
      },
      build: (j) => Sidequest.build(j as never) as never,
      stop: () => Sidequest.stop(),
    },
    jobClass: StreamTaskJob,
  }
}

/** 缺省队列（concurrency 4）。不互斥的任务全在这里。 */
export const DEFAULT_QUEUE = 'default'

/**
 * 这条任务该进哪个队列。**队列名就是互斥组名**，加个 `x:` 前缀跟内置的 `default` 分开——
 * 一个用户把互斥组起名叫 `default` 不该把自己的任务塞进公共队列。
 *
 * `serial` 不在这里出现：它只管"这一条不叠着自己跑"（uniqueness），跟队列无关（见 types.ts）。
 */
export function queueOf(t: Pick<ScheduledTask, 'exclusiveOn'>): string {
  return t.exclusiveOn === undefined || t.exclusiveOn === '' ? DEFAULT_QUEUE : `x:${t.exclusiveOn}`
}

/**
 * 确保这条任务的队列在。**`facade.start()` 里那份 `queues` 是静态的**，而互斥组是用户在界面上
 * 现敲出来的——新组的队列只能在装配这条任务时现建。
 *
 * 建不出来时**不装这条任务的排期**（调用方按 false 处理）：Sidequest 对未知队列的 job 是
 * "落账但永远没人捡"，那是一条看着排上了、其实永不执行的任务——比不排期更坏。
 */
async function ensureQueue(name: string, log: (m: string) => void = centerLog): Promise<boolean> {
  if (name === DEFAULT_QUEUE || knownQueues.has(name)) return true
  if (!active?.createQueue) {
    // 门面建不了队列（单测的假门面）——静态声明过的队列仍然可用，其余的只能拒。
    log(`[tasks] 建不出队列 ${name}：这个门面不支持运行期建队列`)
    return false
  }
  try {
    await active.createQueue(name, 1)
    knownQueues.add(name)
    return true
  } catch (e) {
    log(`[tasks] 建不出队列 ${name}——这一组的任务这次不排期：${(e as Error).message}`)
    return false
  }
}

/**
 * 这个互斥组此刻忙不忙（队列里有 waiting/claimed/running 的 job）。
 *
 * **读不到账本时一律答"不忙"**：那一档下每一班都跳等于这条任务再也不跑，而且没人会发现；
 * 答"不忙"最坏只是退回默认行为（照常入队、由队列的 concurrency 1 保住互斥）。这一句要留痕。
 */
function groupBusy(queue: string, log: (m: string) => void = centerLog): boolean {
  if (queue === DEFAULT_QUEUE) return false // 不互斥的任务没有"组忙"这回事
  if (!queueAlive) {
    log(`[tasks] 读不到账本，${queue} 这一班按"组不忙"处理（照常入队）`)
    return false
  }
  try { return queueAlive(queue) } catch (e) {
    log(`[tasks] 查 ${queue} 忙不忙失败，按"不忙"处理：${(e as Error).message}`)
    return false
  }
}

/**
 * 跳过一班要**留得下痕**：一条有硬时间窗的任务这一班没跑，如果只是"什么都没发生"，
 * 那和"它跑了、没事可做"在界面上长得一模一样。所以一行后端日志 + 一条 warn 事件
 * （事件面板看得见）。事件层没接上时只剩日志，不该因此把这一次跳过变成一次崩溃。
 */
function traceSkipped(t: ScheduledTask, queue: string, log: (m: string) => void): void {
  const line = `[tasks] ${t.id} 这一班不跑——互斥组 ${t.exclusiveOn!} 正忙（whenBusy=skip）`
  log(line)
  try {
    getTaskDeps().events?.append({
      type: 'task.skipped', severity: 'warn',
      title: `跳过一班：${t.label}`,
      body: `互斥组「${t.exclusiveOn!}」里还有活着的任务，这一班按 whenBusy=skip 不入队（队列 ${queue}）`,
      dedupeKey: `task-skipped:${t.id}`,
    })
  } catch { /* 事件层没接上（查询档/启动早期）时只剩日志——不该把跳过变成崩溃 */ }
}

export function configure(b: ReturnType<SidequestFacade['build']>, t: ScheduledTask): void {
  b.maxAttempts(t.maxAttempts)
  b.retryDelay(30_000)
  b.queue(queueOf(t))
  if (t.serial) {
    // 存活即拒入队 → 上轮没完就跳过本次，不积压补跑（spec §2.4）。
    //
    // **`withArgs` 不是可选项，是这条语义成立的前提。** Sidequest 的 alive-job 去重 digest
    // 默认只吃 **job 类名**（`AliveJobUniqueness`，`withArgs: false`）；而我们所有 ScheduledTask
    // 共用同一个类 `StreamTaskJob`，taskId 只活在 args 里。写 `unique(true)` 的后果不是
    // "每条任务各有一把锁"，是**全部 serial 任务共用一把锁**：任意一条还活着（waiting/
    // claimed/running），其余每一条的入队都被拒，抛 `Job #undefined - StreamTaskJob is
    // duplicated`。
    //
    // 全新库首启 100% 复现（2026-09-04 活体）：watchdog 一轮里补跑多条丢班任务，第一条 serial
    // 的落账后，第二条 serial 的当场被自己顶掉，整轮 watchdog 报错。节拍器那条路同样中招，
    // 只是更安静——两条 serial 任务的槽点撞在一起时，后到的那次触发直接消失。
    b.unique({ withArgs: true })
  }
}

/**
 * 这个错是不是 Sidequest 的「已有同 digest 的存活 job」信号（`DuplicatedJobError`，
 * @sidequest/core）。
 *
 * 按名字认而不是 `instanceof`：facade 可注入（单测用假的），真 sidequest 只在 `realFacade`
 * 里动态 import——静态 import 一个错误类会把整个 sidequest 拖进模块加载期。认不出来就**当成
 * 真失败上报**（安全的那一边：宁可吵，不可静）。
 */
export function isDuplicatedJobError(e: unknown): boolean {
  return e instanceof Error && (e.constructor?.name === 'DuplicatedJobError' || / is duplicated$/.test(e.message))
}

/**
 * 建一条 cron 并把句柄**交回调用方**——登记（或作废）由调用方决定。句柄不在这里落表：
 * `b.schedule()` 是个 await 点，谁在它醒来之后写 `cronHandles`，谁就得先回答"中心还是我
 * 走进来时那个中心吗"（见 `generation` 头注）。中心没起来时返回 undefined。
 */
async function buildCron(t: ScheduledTask): Promise<CronHandle | undefined> {
  if (!active) return undefined
  const queue = queueOf(t)
  // 队列不在就别排期：未知队列的 job 会落账然后永远没人捡（见 ensureQueue）。
  if (!await ensureQueue(queue)) return undefined
  if (!active) return undefined // ensureQueue 是 await 点，中间可能被关停
  if (t.whenBusy === 'skip') return buildSkipCron(t, queue)
  const b = active.build(activeJobClass)
  configure(b, t)
  // node-cron v4 对迟到超容差(默认 1s)的触发只告警不执行；本进程事件循环常态性延迟数秒，
  // 分钟级任务会被整点判 missed、永不运行(2026-07-24 活体实测，恒定迟到 ~6s)。
  b.scheduleOptions({ missedExecutionTolerance: 30_000, ...(t.timezone ? { timezone: t.timezone } : {}) })
  return b.schedule(t.schedule, t.id)
}

/**
 * `whenBusy: 'skip'` 那一档的节拍器——**我们自己持**，不走 `b.schedule()`。
 *
 * 理由是那条路够不着这个决定：sidequest 的 `schedule()` 到点直接 `backend.createNewJob()`，
 * 中间没有任何钩子；而"组正忙时这一班不跑"必须在**入队之前**答完（入队之后再判就晚了——
 * 队列 concurrency 是 1，那条 job 会安静地排着，等前面跑完再跑，正好是 skip 要避免的"迟到执行"）。
 *
 * 排期选项与上面那条路逐字相同（同样的迟到容差、同样的时区），另加 `noOverlap`——
 * sidequest 的 builder 默认就开着它，这里自己调 node-cron 得自己写上。
 */
function buildSkipCron(t: ScheduledTask, queue: string): CronHandle {
  return nodeCron.schedule(t.schedule, () => runSkipSlot(t, queue), {
    noOverlap: true,
    missedExecutionTolerance: 30_000,
    ...(t.timezone ? { timezone: t.timezone } : {}),
  })
}

/**
 * `whenBusy: 'skip'` 的一班：**先看组忙不忙，再决定要不要入队**。这就是上面那条自己持的
 * 节拍器到点做的全部事情——单独一个函数是为了它能被直接调（cron 回调没法在测试里到点触发）。
 */
export async function runSkipSlot(t: ScheduledTask, queue: string): Promise<void> {
  try {
    if (!active) return
    if (groupBusy(queue)) { traceSkipped(t, queue, centerLog); return }
    const b = active.build(activeJobClass)
    configure(b, t)
    await b.enqueue(t.id)
  } catch (e) {
    // 这条回调是 node-cron 直接调的：不接住就是一次 unhandled rejection。
    // 去重不是失败（serial 的存活即拒），其余原样记一行——它是这一班没跑的唯一证据。
    if (isDuplicatedJobError(e)) return
    centerLog(`[tasks] ${t.id} 这一班入队失败：${(e as Error).message}`)
  }
}

/** 摘掉一条刚建出来、但已经不该存在的 cron。摘失败只能吞——它已经没有别的持有者了。 */
async function discardCron(h: CronHandle): Promise<void> {
  try { await h.destroy() } catch { /* 已经作废的一条，摘不掉也没别的招 */ }
}

/** 注册一条 cron 并留住句柄。中心没起来（或建到一半被关停）时静默返回。 */
async function scheduleOne(t: ScheduledTask): Promise<void> {
  const gen = generation
  const h = await buildCron(t)
  if (!h) return
  if (gen !== generation) { await discardCron(h); return } // 建 cron 期间中心被关停
  cronHandles.set(t.id, h)
}

export async function startTaskCenter(
  tasks: ScheduledTask[],
  opts: {
    dbPath: string
    dashboardPort?: number
    log: (msg: string) => void
    /** 注入假门面供单测；生产缺省动态 import 真 sidequest */
    sidequest?: SidequestFacade
    jobClass?: unknown
    /** false = 不装丢班自愈(单测的假门面没有真 sqlite 账本可读) */
    watchdog?: boolean
    /** 注入"这个队列此刻有没有活着的 job"供单测；生产缺省读 sidequest 账本。 */
    queueAlive?: (queue: string) => boolean
  },
): Promise<{ ok: boolean }> {
  try {
    taskRegistry.clear()
    knownQueues.clear()
    queueAlive = undefined
    centerLog = opts.log
    // 一行重名的用户任务只该赔它自己，不该把整个调度中心拖下水：registerTasks 对重复 id
    // throw，未去重时那个 throw 会被下面的 catch 接住变成"start failed"——builtin 运维任务
    // （cookie-refresh/standby-reaper 等）全部消失，只留一行日志。路由层的 403 挡的是"新建/改
    // 时撞了内置 id"，挡不住已经落库的旧行（比如内置任务是后来才加的 id）。这里按传入顺序
    // （builtin 在前，见调用方）保留先出现的一条，后来者丢弃并留痕。
    const deduped: ScheduledTask[] = []
    const seenIds = new Set<string>()
    for (const t of tasks) {
      if (seenIds.has(t.id)) {
        opts.log(`[tasks] 丢弃重名任务 "${t.id}"——与已注册的另一条撞 id，这一条不排期`)
        continue
      }
      seenIds.add(t.id)
      deduped.push(t)
    }
    registerTasks(deduped)
    let facade = opts.sidequest
    let jobClass = opts.jobClass
    if (!facade) {
      const real = await realFacade()
      facade = real.facade
      jobClass = real.jobClass
    }
    // 上一个进程留下的 claimed / running 行在这一刻必然是死的（inline runner，子进程随后端一起
    // 死）：起引擎之前先记成 failed 并写明理由。不收的后果见 orphan-sweep.ts 头注（serial 去重
    // 把整条任务锁一小时、账本里留一句谁也看不懂的英文）。收不了只记日志，不拦启动。
    try {
      const n = await interruptOrphanRuns(opts.dbPath)
      if (n > 0) opts.log(`[tasks] 上次进程留下 ${n} 条没跑完的执行，已记为「${INTERRUPTED_BY_RESTART}」`)
      // 不变量巡检：终态 job 不许带 unique_digest，否则那条任务每班都被判 duplicated、永远排不上。
      const stale = await releaseStaleDigests(opts.dbPath)
      if (stale > 0) opts.log(`[tasks] ${stale} 条已结束的执行还带着 unique_digest（会让同一任务永远"排着队"），已清掉`)
    } catch (e) {
      opts.log(`[tasks] 收尸失败（不影响启动）：${e instanceof Error ? e.message : String(e)}`)
    }
    await facade.start({
      fork: false,
      runner: 'inline',
      backend: { driver: '@sidequest/sqlite-backend', config: opts.dbPath },
      logger: { level: 'warn' },
      manualJobResolution: true,
      jobsFilePath: resolveJobsFile(dirname(fileURLToPath(import.meta.url))),
      // 静态只声明这两个。互斥组的队列（`x:<组名>`）是用户在界面上现敲出来的，只能在装配
      // 每条任务时现建（见 ensureQueue）。`serial` 是**只进不出**的一格：今天没有任何任务
      // 会被排进去（互斥走 `x:` 前缀），声明它只为让上一个进程留在那儿的 waiting job 还有人捡。
      queues: [
        { name: DEFAULT_QUEUE, concurrency: 4 },
        { name: 'serial', concurrency: 1 },
      ],
      ...(opts.dashboardPort
        ? { dashboard: { enabled: true, port: opts.dashboardPort, basePath: '/_p/sidequest' } }
        : {}),
    })
    active = facade
    activeJobClass = jobClass
    // 放在 start 之后：首启时表是 sidequest 的迁移在 start 里建的，之前调就是空操作。
    // 建不起来只是慢（每次轮询全表扫，见 LEDGER_INDEXES 头注），不拦启动。
    try {
      await ensureLedgerIndexes(opts.dbPath)
    } catch (e) {
      opts.log(`[tasks] 账本索引建不起来（调度照常，只是轮询会全表扫）：${e instanceof Error ? e.message : String(e)}`)
    }
    // 互斥组忙不忙，读的是**账本**（跨进程、跨重启），不是本进程的内存——排在队列里的东西
    // 完全可能是上一个进程留下的。开不起来不拦启动：`groupBusy` 那一档会退回"按不忙处理"。
    if (opts.queueAlive) queueAlive = opts.queueAlive
    else {
      try {
        const { default: Database } = await import('better-sqlite3')
        const qdb = new Database(opts.dbPath, { readonly: true })
        const busyStmt = qdb.prepare(LEDGER_QUERIES.aliveByQueue)
        queueAlive = (queue) => ((busyStmt.get(queue) as { n: number } | undefined)?.n ?? 0) > 0
      } catch (e) {
        opts.log(`[tasks] 互斥组忙闲查询装不起来 — ${(e as Error).message}`)
      }
    }
    // 丢班自愈:节拍器对每个槽只有一次机会(迟到超容差只告警不执行),本机时钟毛病会让长周期任务
    // 静默丢班——watchdog 每分钟对着 sidequest 账本(跨重启存活)对账,丢了就经同一条 build 管道补跑。
    // 装配失败只损失自愈,不带走调度中心(与外层降级守卫同念)。
    const all = [...deduped]
    if (opts.watchdog !== false) {
      try {
        const { default: Database } = await import('better-sqlite3')
        const ledger = new Database(opts.dbPath, { readonly: true })
        const lastStmt = ledger.prepare(LEDGER_QUERIES.lastInsertedByTask)
        const aliveStmt = ledger.prepare(LEDGER_QUERIES.aliveByTask)
        const look = (taskId: string): TaskLook => {
          const arg = JSON.stringify([taskId])
          const last = (lastStmt.get(arg) as { last: number | null } | undefined)?.last ?? null
          const n = (aliveStmt.get(arg) as { n: number } | undefined)?.n ?? 0
          return { lastInsertedAt: last, alive: n > 0 }
        }
        all.push(makeWatchdogTask({
          // 读 taskRegistry（活的），不是 startTaskCenter 收到的 `tasks` 数组（启动快照）——
          // addTask/removeTask 之后只改 taskRegistry，快照不会跟着变。读快照会让运行期新建的
          // 任务永远等不到自愈、改排期后仍按旧排期被判丢班、删掉的任务在旧槽上被反复补跑成
          // "unknown task" 报警（三个后果都是这条快照/活表分家造成的，见 review）。
          listTasks: () => [...taskRegistry.values()].map((t) => ({
            id: t.id, schedule: t.schedule,
            ...(t.notBefore === undefined ? {} : { notBefore: t.notBefore }),
          })),
          look,
          // 把 sidequest 的错翻译成 watchdog 认得的三个词——去重不是失败，是"已经排着了"，
          // 正好就是 watchdog 想要的结果（它补跑的目的就是让这一班有 job）。翻译放在这一层：
          // watchdog.ts 不认识 sidequest，也不该认识。
          enqueue: async (taskId) => {
            const t = taskRegistry.get(taskId)
            if (!t) return 'unknown-task'
            // 补跑也要过互斥这一关：一条 skip 任务的丢班在组正忙时**照样不该补**——
            // 那正是"迟到执行等于做错事"的那一档，补跑只会把它做得更迟。
            const queue = queueOf(t)
            if (t.whenBusy === 'skip' && groupBusy(queue, opts.log)) {
              traceSkipped(t, queue, opts.log)
              return 'skipped-busy'
            }
            if (!await ensureQueue(queue, opts.log)) throw new Error(`建不出队列 ${queue}`)
            const b = facade!.build(jobClass)
            configure(b, t)
            try {
              await b.enqueue(taskId)
            } catch (e) {
              if (isDuplicatedJobError(e)) return 'already-queued'
              throw e
            }
            return 'enqueued'
          },
        }))
      } catch (e) {
        opts.log(`[tasks] watchdog disabled — ${(e as Error).message}`)
      }
    }
    // 普通任务已在 facade.start 前入册(上一进程遗留的 waiting job 会在 start 后立刻被 runner
    // 捡起来跑,晚注册就解析不到);这里只增量补注册 watchdog 自己。
    registerTasks(all.filter((t) => !deduped.includes(t)))
    for (const t of all) await scheduleOne(t)
    ledgerPath = opts.dbPath
    opts.log(`[tasks] center up: ${all.map((t) => t.id).join(', ')}`)
    return { ok: true }
  } catch (e) {
    // 这条路把中心打回"没起来"，和 stopTaskCenter 是同一件事——代际同样要 +1，否则一次
    // 在途的 addTask 会醒来后往一个已经拆掉的中心里登记（见 `generation` 头注）。
    generation += 1
    if (active) {
      try { await active.stop() } catch {}
      active = undefined
    }
    // start 走到一半才失败时，前面 scheduleOne 成功的那几条句柄已经在 map 里了。不 destroy
    // 就地变孤儿，而下面那行日志读起来像是干净地放弃了——**这条路生产会走**。
    await destroyAllCrons()
    taskRegistry.clear()
    knownQueues.clear()
    queueAlive = undefined
    activeJobClass = undefined
    ledgerPath = undefined
    opts.log(`[tasks] task center disabled — start failed: ${(e as Error).message}`)
    return { ok: false }
  }
}

/**
 * 关停调度中心。**支持进程内停了再起**——`center.dynamic.test.ts` 的 `afterEach` 每条用例之间
 * 都在这么干，所以别把 stop 写成"本进程只调用一次"。生产今天只在 shutdown 时调一次
 * （`serve.ts` 唯二两处），但那只说明这个不变量没有生产压力，不是它不成立。
 *
 * `idQueues`（每 taskId 的串行链）**故意不清**：stop 撞上一个在途的 addTask 时清掉链头，等于
 * 把串行保证撕开——而它泄漏的只是一批已 settle 的 promise，键还被任务 id 天然收敛。这一处的
 * 收益远小于风险，不是漏了。
 */
export async function stopTaskCenter(): Promise<void> {
  // 第一件事、且**同步**做：从这一刻起，任何在途的 addTask/scheduleOne 醒来都会发现代际变了，
  // 从而整体作废。放到后面（哪怕只隔一个 await）就会漏掉正好落在那个窗口里的那一次。
  generation += 1
  try { await active?.stop() } catch { /* 关停失败不阻塞 shutdown */ }
  active = undefined
  knownQueues.clear()
  queueAlive = undefined
  await destroyAllCrons()
  // 停了的中心还能从 listTasks() 报出一串任务，那是假的——watchdog 正好读它。今天被
  // startTaskCenter 开头那句 `taskRegistry.clear()` 掩盖着，所以不清也不出错。
  taskRegistry.clear()
  activeJobClass = undefined
  ledgerPath = undefined
}

/**
 * 此刻真在跑的任务（sidequest 账本里 state='running'）。给 `POST /api/restart` 的闸门用——
 * 重启不该打断正在跑的采集 / 交易；而「在跑」只有账本知道，别让前端 / CLI 猜。
 * 任务中心没起（ledgerPath 缺席）→ 空数组：没有任务中心就没有可打断的东西。
 * 与 watchdog 同款：只读打开、用完即关。
 */
export async function runningTasks(): Promise<{ id: string; label: string }[]> {
  if (!ledgerPath) return []
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(ledgerPath, { readonly: true })
  try {
    const rows = db.prepare(LEDGER_QUERIES.runningArgs).all() as { args: string }[]
    return rows.map((r) => {
      const id = (JSON.parse(r.args) as string[])[0]
      return { id, label: taskRegistry.get(id)?.label ?? id }
    })
  } finally {
    db.close()
  }
}

/**
 * addTask/removeTask 按 taskId 串行——不能让两次并发写同一 id 交错：A await `b.schedule(...)`
 * 期间 B 也进来（此刻 cronHandles 还没有 A 的句柄），A/B 各自 schedule 出一条 cron，谁的
 * `cronHandles.set` 后落地谁就把另一条的句柄从 map 里挤掉——挤掉的那条没人再持有引用，
 * 变成一条活着但摘不掉的 cron（只能靠重启进程收）。
 *
 * 选择「每 taskId 一条 promise 链」而不是「先占位再检查代际」：占位方案要在 scheduleOne 里
 * 插一段"我是不是最新一代"的判断，散在两个函数里都要改、都要记得改对；串行链把整个决策收在
 * 一处——同一个 id 的两次调用，前一次不管成不成功，后一次必须等它彻底做完（含 destroy 旧句柄）
 * 才开始，跟同步代码里两次调用同一个非并发函数的直觉一致，读的人不用推并发交错。
 * 不同 id 之间不互相等待——各自的链互不相关。
 *
 * **这条链只排 addTask/removeTask 之间的序，管不着 stopTaskCenter**：stop 不进任何链，它随时
 * 可以落在链上某次调用的两个 await 之间。那一维由 `generation` 守（见其头注），两者正交——
 * 串行链回答"同一个 id 的两次写谁先谁后"，代际回答"醒来时中心还是不是原来那个"。
 */
const idQueues = new Map<string, Promise<unknown>>()

function serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = idQueues.get(id) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  // 链上存的是"占位用"的影子 promise：不管这次成不成功都要通知下一个排队者可以开始，
  // 但真实的成功/失败仍经 `next`（下面 return 的那个）原样传回调用者。
  idQueues.set(id, next.then(() => undefined, () => undefined))
  return next
}

/**
 * 摘一条任务（已在串行链里）。**先出表再 destroy**：`destroy()` 是个 await 点，句柄留在表里
 * 等于让并发的 `destroyAllCrons()` 对同一条 cron 再摘一次；出表之后它只剩这一个持有者。
 * 删注册表行、摘 cron 都是幂等的减法，落在 stop 之后也只是无事发生——所以这条路不需要代际闸。
 */
async function removeTaskLocked(id: string): Promise<boolean> {
  const h = cronHandles.get(id)
  cronHandles.delete(id)
  if (h) { try { await h.destroy() } catch { /* 停一条 cron 失败不该拖垮改配置 */ } }
  return taskRegistry.delete(id) || h !== undefined
}

/** 加一条任务；已存在同 id 视为改（先摘旧的 cron，再注册新的）。中心没起来时静默。 */
export async function addTask(task: ScheduledTask): Promise<void> {
  if (!active) return
  await serialize(task.id, async () => {
    const gen = generation
    if (!active) return
    await removeTaskLocked(task.id)
    const h = await buildCron(task)
    // —— 以下同步块即"登记"这一步，中间没有 await：确认中心还是走进来时那个，和写下这两行，
    // 是一次不可分割的判断。代际变了 ⇒ 中间被关停过，这次登记整体作废（cron 也摘掉）。
    if (gen !== generation) { if (h) await discardCron(h); return }
    taskRegistry.set(task.id, task)
    if (h) cronHandles.set(task.id, h)
  })
}

/** 摘掉一条任务：停 cron + 出注册表。返回它原本在不在。 */
export async function removeTask(id: string): Promise<boolean> {
  return serialize(id, () => removeTaskLocked(id))
}

/**
 * 立即跑一次（与节拍器到点做的事等价）。任务不存在返回 false。
 *
 * **不看 `whenBusy`**：这是人点的按钮，人已经知道自己在做什么。组正忙时它照常入队，
 * 由队列的 concurrency 1 保住互斥——排着，不并发。
 */
export async function runTaskNow(id: string): Promise<boolean> {
  const t = taskRegistry.get(id)
  if (!t || !active) return false
  if (!await ensureQueue(queueOf(t))) return false
  if (!active) return false
  const b = active.build(activeJobClass)
  configure(b, t)
  await b.enqueue(id)
  return true
}
