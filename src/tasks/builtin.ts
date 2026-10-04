// 收编的 4 处业务定时器（spec §3.5）。原裸定时驱动位置：serve.ts:392/404、
// standby/wire.ts:91、bootstrap.ts:1348。周期原样保留（cron 6 段）。
import type { ScheduledTask, TaskDeps } from './types.ts'
import { formatRecipeUpdateNotice } from '../replay/recipe-install.ts'

function need<K extends keyof TaskDeps>(deps: TaskDeps, k: K): NonNullable<TaskDeps[K]> {
  const v = deps[k]
  if (!v) throw new Error(`task dep missing: ${String(k)}`)
  return v
}

/** 一条持久浏览器 lane 闲置多久算没人要了。给得比"在一个频道里正常停留"长得多（用户去接杯水
 *  回来不该发现会话没了），又不至于让孤儿标签过夜。正常收尾不靠它——靠前端离开频道时显式关。 */
const LANE_IDLE_MS = 10 * 60_000

/**
 * 内置任务的归属分组（纯展示，见 `types.ts` 的 `group`）。**按职能归，不按依赖归**：
 * 读的人在任务页上问的是"这条是干什么的"，不是"它接的是哪个 service"。
 *
 * 四组，名字用人话、两三个字——它要当小标题，长了就把标题行变成一句话：
 * - 登录态：让各站的登录还活着、以及把它交出去（刷新 / 对账 / 导出）。
 * - 网盘：网盘那摊活（同步 / 对账 / 追更）。
 * - 意图：意图的到期消化。**一组一条也照样单列**——它和上面两组不是一回事，
 *   为了凑数塞进「运维」会让那一组变成"剩下的"，那就等于没分组。
 * - 运维：Stream 自己的内脏回收（账本 / 容器 / 标签 / 历史）。
 */
const GROUPS = {
  auth: '登录态',
  netdisk: '网盘',
  intent: '意图',
  ops: '运维',
} as const

/**
 * 内置任务 id 的权威名单——静态、不看任何依赖是否接上。
 *
 * **为什么要单独一份**：`builtinTasks()` 的结果按 `wired.*` 条件装配，是"这台机器此刻实际
 * 跑着哪些"；路由层的建/改守卫要拦的是"这个 id 会不会跟内置任务撞名"，答案不该因为本机
 * 缺 Docker、或跑在查询档（`taskDeps` 未装配）就变。两处都读 `deps.builtins()`（条件装配的
 * 结果）曾经的后果：查询档下 `builtins()` 恒为 `[]`，任何内置 id 都被当成"没人用"放行；
 * 本机没 Docker 时 `standby-reaper` 不在结果里，同一个 id 在后来装了 Docker 的机器上就被
 * 用户行占了，装配一炸就是一次 `duplicate task id` 全盘降级。
 *
 * 与 `builtinTasks()` 的装配分支必须一一对应——`builtin.test.ts` 的钉数测试守着两边不许漂。
 */
export const BUILTIN_TASK_IDS: readonly string[] = [
  'cookie-refresh',
  'jobs-sweep',
  'standby-reaper',
  'browser-lane-reaper',
  'auth-reconcile',
  'netdisk-autosync',
  'intent-digest-scan',
  'netdisk-reconcile',
  'netdisk-follow',
  'ledger-prune',
  'agent-runs-prune',
  'session-export',
  'recipe-update-check',
]

/**
 * 按依赖可用性条件装配内置任务。
 *
 * **入参就是那份 `TaskDeps` 本身**，不是一张平行的布尔表：两者曾经分家（serve.ts 一处
 * `setTaskDeps({...})`、紧接着一处 `builtinTasks({ cookie: !!boot.cookieProvider, ... })`，
 * 8 对必须一一对应），而漏配一对的两种表现都是静默的——注册了任务但 deps 缺 ⇒ 每次跑都 throw
 * 一条 `task dep missing`；deps 在但布尔忘了开 ⇒ 任务干脆不存在，没有任何一处会提。
 * 现在「有没有这个依赖」只有一个真相源。
 */
export function builtinTasks(wired: TaskDeps): ScheduledTask[] {
  const tasks: ScheduledTask[] = []
  if (wired.cookieProvider) tasks.push({
    id: 'cookie-refresh', label: '登录态刷新', schedule: '0 */5 * * * *',
    group: GROUPS.auth, serial: false, maxAttempts: 1,
    run: async (deps) => {
      await need(deps, 'cookieProvider').refresh()
      return { summary: 'cookies refreshed' }
    },
  })
  if (wired.capabilityJobs) tasks.push({
    // 名字里不夹英文标识符：这一行是给人在任务表里扫的，`Job` 是我们内部的词。
    id: 'jobs-sweep', label: '能力任务账本回收', schedule: '0 */10 * * * *',
    group: GROUPS.ops, serial: false, maxAttempts: 1,
    run: async (deps) => {
      need(deps, 'capabilityJobs').sweep()
      return { summary: 'swept' }
    },
  })
  if (wired.standbyManager) tasks.push({
    id: 'standby-reaper', label: '闲置插件容器回收', schedule: '0 * * * * *',
    group: GROUPS.ops, serial: false, maxAttempts: 1,
    run: async (deps) => {
      await need(deps, 'standbyManager').tick() // tick 自身承诺永不 reject（双保险不拆）
      return { summary: 'ticked' }
    },
  })
  if (wired.browserLanes) tasks.push({
    id: 'browser-lane-reaper', label: '闲置浏览器标签回收', schedule: '0 * * * * *',
    group: GROUPS.ops, serial: false, maxAttempts: 1,
    run: async (deps) => {
      const closed = await need(deps, 'browserLanes').reapIdle(LANE_IDLE_MS)
      return { summary: closed.length ? `closed ${closed.join(', ')}` : 'none idle' }
    },
  })
  if (wired.authReconcile) tasks.push({
    // 每分钟一次，而且**只在确实有「需要登录」横幅挂着时**才发远程调用（对账器自己会先看
    // needs()，空就直接返回）。这条是"无感"的那一半：用户开着 Stream、在别的标签里登录回来，
    // 没有任何采集会跑，只有它会去把陈掉的横幅撤下来。
    // 成本是一次 cookie 名字读取（约 10ms，不开标签、不加载页面、不落到站点上）。
    id: 'auth-reconcile', label: '登录横幅对账', schedule: '0 * * * * *',
    group: GROUPS.auth, serial: false, maxAttempts: 1,
    run: async (deps) => {
      await need(deps, 'authReconcile')()
      return { summary: 'reconciled' }
    },
  })
  if (wired.netdisk) tasks.push({
    id: 'netdisk-autosync', label: '网盘绑定自动同步', schedule: '0 0 */6 * * *',
    // 三条网盘任务（同步 / 对账 / 追更）抢的是同一样东西：网盘那边的登录态和它的速率配额。
    // 所以它们共用一个互斥组，同时只跑一条。
    group: GROUPS.netdisk, serial: true, exclusiveOn: 'netdisk', maxAttempts: 2,
    run: async (deps) => {
      const netdisk = need(deps, 'netdisk')
      const store = need(deps, 'netdiskStore')
      let synced = 0, failed = 0
      const errors: string[] = []
      for (const s of store.list()) {
        if (!s.autoSync) continue
        try { await netdisk.sync(s); synced++ } catch (e) { failed++; errors.push(`${s.id}: ${(e as Error).message}`) }
      }
      if (failed > 0) throw new Error(`autosync: ${synced} ok, ${failed} failed — ${errors.join('; ')}`)
      return { summary: `autosync: ${synced} synced`, detail: { synced } }
    },
  })
  if (wired.intents) tasks.push({
    // 每 10 分钟扫,不是每小时:扫描频率≠消化频率(该不该消化由 lastDigestAt+cadence 把门,空扫近零成本),
    // 而本机小时级 cron 槽会被静默丢掉(节拍器迟到超容差只告警不执行;活体实测 08:15/09:15 连丢两槽,
    // 同机 netdisk-autosync 的 6h 槽历史同样大面积丢),10 分钟级实测全程可靠——丢一槽只亏 10 分钟。
    id: 'intent-digest-scan', label: '意图消化巡检', schedule: '0 */10 * * * *',
    group: GROUPS.intent,
    // 消化打 LLM，且 service 内部本就单槽——`serial` 是双保险，保它自己不叠着跑。
    // **不设互斥组**：那个单槽只有它一条任务在用，独享的东西不需要排队（见 stream-cron skill 1.2）。
    serial: true,
    maxAttempts: 1,
    run: async (deps) => {
      const ran = await need(deps, 'intents').scanDue()
      return { summary: ran.length > 0 ? `消化 ${ran.length} 个到期意图` : '无到期意图', detail: { ran } }
    },
  })
  if (wired.reconcile) tasks.push({
    // 叫「对账」不叫「归档」：它跑的是 `reconcile.runScheduled()`，报的是「观察到 N 条
    // （付费 0/下架 0），N 条待定」——那是核对，不搬任何文件。叫归档会让人以为它在动数据。
    id: 'netdisk-reconcile', label: '网盘内容对账', schedule: '0 30 3 * * *',
    group: GROUPS.netdisk, serial: true, exclusiveOn: 'netdisk', maxAttempts: 1,
    run: async (deps) => {
      return await need(deps, 'reconcile').runScheduled()
    },
  })
  if (wired.follow) tasks.push({
    // 每小时扫一次，到期才真跑（`nextCheckAt` 把门）——空扫近零成本。
    // 为什么不用天级槽：理由同 intent-digest-scan，本机小时级以上的 cron 槽会被静默丢掉，
    // 丢一槽只亏一小时是可以接受的，丢一整天不是。
    id: 'netdisk-follow', label: '影视追更', schedule: '0 5 * * * *',
    group: GROUPS.netdisk, serial: true, exclusiveOn: 'netdisk', maxAttempts: 1,
    run: async (deps) => {
      const ran = await need(deps, 'follow').scanDue()
      return { summary: ran.length ? `追更：跑了 ${ran.length} 部` : '追更：没有到期的', detail: { ran } }
    },
  })
  if (wired.ledger) tasks.push({
    // 「定时任务历史」而不是「任务账本」：它清的正是任务页上展开看到的那份执行记录。
    // 和上面 `jobs-sweep`（能力任务账本）是两本不同的账，名字必须一眼分得开——两条都叫
    // 「XX 账本 YY」时，谁也说不出该去看哪一条。
    id: 'ledger-prune', label: '定时任务历史清理', schedule: '0 15 4 * * *',
    // 不设互斥组：它写的是账本自己的那张表，没有第二条任务在抢（WAL 下的并发写由 sqlite 管）。
    group: GROUPS.ops, serial: true, maxAttempts: 1,
    run: async (deps) => {
      // 每任务保留最近 200 次**或** 30 天内的，取宽的那个——低频任务（每天一次）30 天也就
      // 30 条，靠条数保不住它的历史；高频任务（每分钟）30 天有 4 万条，靠时间又太多。
      const removed = need(deps, 'ledger').prune({ keepPerTask: 200, keepMs: 30 * 24 * 60 * 60_000 })
      return { summary: `清理 ${removed} 条`, detail: { removed } }
    },
  })
  if (wired.agentRuns) tasks.push({
    // 第三本账：搜索 / 购买 / 动作 recipe 的 run 记录（`agent-runs.db`）+ 动作导出的文件。
    // 上面两条各清各的账，这条也一样——名字里点明「agent run」，别和「定时任务历史」混。
    // 它存在的理由：这本账曾经攒到 2GB（导出文件被编成文本塞进 result），开机扫一遍直接 OOM。
    id: 'agent-runs-prune', label: 'Agent 运行记录清理', schedule: '0 25 4 * * *',
    group: GROUPS.ops, serial: true, maxAttempts: 1,
    run: async (deps) => {
      const r = need(deps, 'agentRuns').prune()
      return { summary: `删 ${r.removed} 条记录、${r.files} 个产物文件${r.stripped ? `，抹掉 ${r.stripped} 条超限结果` : ''}${r.vacuumed ? '，已回收磁盘' : ''}`, detail: r }
    },
  })
  if (wired.sessionExports) tasks.push({
    // **10 分钟不是"够新就行"，是这条能力成立的前提。** 券商的服务端会话有 idle 超时（东财
    // 实测 30–60 分钟就把 session 踢掉，返回 302 /LogIn/ExitLogin），而消费者是**定点**跑的
    // （09:45 / 14:55）——用户早上在自己 Chrome 里登一次，到点时那份会话早凉了。每 10 分钟
    // 取一次 extras 会打一发带 cookie 的 GET，那一发同时把 idle 计时器按回零。
    // 也就是说：**这个周期在"保鲜"之外还在"续命"**，这是有意为之，不是副作用。要改它先想清楚
    // 是不是愿意让那份交易会话一直活着。
    id: 'session-export', label: '登录态导出', schedule: '0 */10 * * * *',
    group: GROUPS.auth,
    // serial：一轮要打外部站点，慢过一个周期是可能的；排队重跑没有意义（下一轮拿的是同样的
    // 登录态），跳过这次才对。**不设互斥组**：它抢的是各券商自己的会话，没有第二条内置任务
    // 在抢——真要跟某条用户任务互斥，那条用户任务自己填组名（组是资源的名字，不是谁先来）。
    serial: true, maxAttempts: 1,
    run: async (deps) => {
      const results = await need(deps, 'sessionExports')()
      const ok = results.filter((r) => r.ok)
      const bad = results.filter((r) => !r.ok)
      // 失败必须响。这条链路所有的失败都长得一样（消费者读到一份陈旧文件 → 到点那一刻才炸），
      // 而它的消费者是定点跑的真钱任务：静默吞掉就等于把失败推到最不该失败的那一刻。
      if (bad.length) {
        throw new Error(
          `登录态导出 ${ok.length} 成 ${bad.length} 败 — ` +
          bad.map((r) => `${r.name}: ${r.reason}`).join('; '),
        )
      }
      return {
        summary: results.length ? `导出 ${ok.length} 份登录态` : '没有声明任何导出',
        // 只有名字/条数/字段名，绝不带值（见 SessionExportResult）——任务历史是能在界面上翻的。
        detail: { exports: ok.map((r) => ({ name: r.name, cookies: r.cookieCount, extras: r.extras })) },
      }
    },
  })
  if (wired.recipePackageOps) tasks.push({
    // 内置 + 已装 recipe 包有没有新版（比内置版 / 已装版与 npm latest）。**只报不装**：装会热挂载、
    // 改变正在跑的 recipe，那个动作要用户点头（`stream update`）。一天一次够了——包更新是天级
    // 节奏；要立刻知道，任务页「立即跑一次」就是那条路（所以不再需要"启动后 30s 查一次"）。
    // 04:40 挑在 ledger-prune（04:15）之后、离早上用机还远；丢班由 watchdog 倒补（builtin 不设
    // notBefore，见 types.ts），所以天级槽被静默丢掉也只是晚一点，不是不查。
    id: 'recipe-update-check', label: '包更新检查', schedule: '0 40 4 * * *',
    // 不设互斥组：它只读 npm registry，不抢任何本机资源；serial 只保它自己不叠着跑。
    group: GROUPS.ops, serial: true, maxAttempts: 1,
    run: async (deps) => {
      // 查 registry 失败（断网 / registry 慢）**不 throw**：它不是后端的功能，是一句提醒——
      // 记成 failed 会在任务页上挂一个红点、还可能触发失败通知，为一次没查成的更新提示不值得。
      // 但要把"没查成"如实写进 summary，别让它长得和"查了、没有更新"一样。
      const ops = need(deps, 'recipePackageOps') // 缺依赖照旧抛：那是接线错，不是网络抖动
      let candidates
      try {
        candidates = await ops.updates()
      } catch (e) {
        return { summary: `没查成：${(e as Error).message}` }
      }
      const notice = formatRecipeUpdateNotice(candidates)
      if (notice) deps.log(notice)
      return {
        summary: notice ? `${candidates.length} 个包有更新` : '都是最新的',
        detail: { candidates },
      }
    },
  })
  return tasks
}
