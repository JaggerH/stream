/** 调度中心的任务契约。任务代码只认这三个类型，不 import sidequest（弃坑保险，见 spec §3.1）。 */

export interface TaskOutcome {
  /** 一句话结果，面板/通知展示用 */
  summary: string
  /** 结构化明细（如归档器的分流计数），面板 JSON 展示 */
  detail?: unknown
}

/** bootstrap 完成接线后注入的依赖切面。字段全部 optional——各任务运行时自查所需依赖，
 *  缺了就抛（记 failed），不做启动期硬校验（cookieProvider 等本来就是条件装配的）。 */
export interface TaskDeps {
  log: (msg: string) => void
  events?: { append: (e: import('../events/store.ts').EventInput) => unknown }
  cookieProvider?: { refresh: () => Promise<unknown> }
  capabilityJobs?: { sweep: () => void }
  standbyManager?: { tick: () => Promise<void> }
  netdisk?: import('../netdisk/sync.ts').NetdiskService
  netdiskStore?: { list: () => import('../netdisk/types.ts').MappingSet[] }
  reconcile?: { runScheduled: () => Promise<TaskOutcome> }
  /** 浏览器 lane 的回收面。持久 lane 的正常收尾靠使用者显式关（离开频道），这里兜的是
   *  异常路径：用户直接关标签 / 浏览器崩了 / 人走了——那些情况下收尾回调根本不会跑。 */
  browserLanes?: { reapIdle: (maxIdleMs: number) => Promise<string[]> }
  /** 登录横幅对账：不跑采集，只用便宜的活证据核对一次（见 auth-reconciler）。 */
  authReconcile?: () => Promise<void>
  /** 意图消化巡检：scanDue 跑到期意图，回执行过的 id 列表。 */
  intents?: { scanDue: () => Promise<string[]> }
  /** 影视追更巡检：scanDue 跑到期的追更绑定，回跑过的 setId 列表。 */
  follow?: { scanDue: () => Promise<string[]> }
  /** Sidequest 账本的保留期清理。分钟级任务一天攒 1440 条，不清理历次执行页第一天就慢。 */
  ledger?: { prune: (o: { keepPerTask: number; keepMs: number }) => number }
  /** agent run 账本（`agent-runs.db`）+ 动作产物文件的保留期清理（保留期钉在 store / artifacts 模块里）。 */
  agentRuns?: { prune: () => { removed: number; stripped: number; files: number; vacuumed: boolean } }
  /**
   * 登录态导出（`src/credentials/session-export.ts`）。**只在 config.yaml 声明了
   * `session_exports` 时才装配**——一条都没声明就没有这个任务，任务表上也不该出现它。
   * 回执只带名字/条数/字段名，绝不带值：它会进任务历史，那是能在界面上翻的。
   */
  sessionExports?: () => Promise<import('../credentials/session-export.ts').SessionExportResult[]>
  /**
   * 内置 + 已装 recipe 包的更新检查（`RecipePackageOps.updates`，比内置版 / 已装版与 npm latest）。
   * **只在 `STREAM_RECIPE_UPDATE_CHECK` 不是 `0` 时装配**——关掉 = 任务表上根本没有这条，
   * 不是一条每天跑一次然后什么都不做的空任务。任务本身只报不装（装要用户点头，见 spec §2）。
   */
  recipePackageOps?: { updates: () => Promise<import('../replay/recipe-install.ts').RecipeUpdateCandidate[]> }
}

export interface ScheduledTask {
  id: string
  /** 人话名字，面板/通知显示 */
  label: string
  /** node-cron 6 段（支持秒），如每天 03:30 = '0 30 3 * * *' */
  schedule: string
  timezone?: string
  /**
   * 归属分组，**纯展示**：任务页把同一组的行收在一个小标题下，仅此而已。
   *
   * 调度、依赖、并发、路由一律不看它——**别给它执行语义**。要拿它当"这一组串行跑"之类的
   * 开关，那是另一个字段该干的事（`serial` 已经在那儿了），混进来的表现是改一个显示分组
   * 顺手改掉了执行行为，而界面上什么都看不出来。
   */
  group?: string
  /**
   * true → **这一条任务自己不叠着跑**（uniqueness 存活即拒：上轮没完则跳过本次，不排队）。
   *
   * **它只管这一条任务和它自己**，不决定队列、不让这条任务跟别的任务互斥——那是
   * `exclusiveOn` 的事。给一条任务标 serial 不会让它和另一条标了 serial 的任务错开跑。
   */
  serial: boolean
  /**
   * 这条任务**独占的资源的名字**（一座数据桥、一份登录态标签、一个库文件的写锁、一把 key）。
   * 同名的任务共用一个 concurrency=1 的队列 `x:<exclusiveOn>`，同时只跑一条。
   *
   * **缺席 = 不跟任何人互斥**（进 `default`，concurrency 4）。判定与命名规则见
   * `.claude/skills/stream-cron/SKILL.md` 第 1 步：名字是**资源**的名字，不是业务类别；
   * 一个人独享的东西不需要排队（那种情况用 `serial` 就够了）。
   */
  exclusiveOn?: string
  /**
   * 轮不上的时候怎么办。判据只有一句：**这次执行晚一小时跑，还是它本来要做的那件事吗？**
   *
   * - `'queue'`（默认）→ 排着，前面跑完就跑。补数、导出、发布都属于这类，晚了照样有价值。
   * - `'skip'` → **这一班不跑**，并在日志与通知里留一条。凡是有外部时间窗的动作（申购/打新、
   *   竞价前的报盘、有截止时间的提交）迟到执行不是"晚了一点"，是做了一件错事。
   */
  whenBusy?: 'queue' | 'skip'
  maxAttempts: number
  run: (deps: TaskDeps) => Promise<TaskOutcome>
  // 这里曾有一格 `effect`（read-only / writes-files / writes-db / external）。**别再加回来**：
  // 它从头到尾没有一个后端消费方——调度、重试、通知都不看它，唯一的用处是让页面上那枚标签
  // 有字可显。一个只有自己申报、没人校验也没人消费的枚举，写错不报错，读的人却会以为它管着什么。
  // 「这次执行撤不撤得回」的那道闸现在钉在动作本身上：「立即跑一次」一律两步确认（见 TasksPage）。
  /** 这个任务从何时起存在（epoch ms）。**丢班自愈只补这之后的槽**——早于它的槽不是"丢了"，
   *  是"那时候还没有这个任务"。没有它的话，任何新建任务都会被 watchdog 当场倒补最近一班：
   *  周六 10:00 建一条 `0 45 9 * * 1-5`，下一分钟就跑掉周五那一班。对下单类任务这是真会出事的。
   *  builtin 不设（它们随进程存在，倒补正是要的自愈行为）。 */
  notBefore?: number
}
