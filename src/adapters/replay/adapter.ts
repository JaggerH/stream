import type { Adapter, AdapterFetchResult, SourceExecutionContext } from '../types.ts'
import type { DebugEntry } from '../../debug.ts'
import type { SourceManifest } from '../../manifest/types.ts'
import type { RecipeStore } from '../../replay/recipe-store.ts'
import type { ReplayLauncher } from '../../replay/browser-fetch.ts'
import { runFetchRecipe } from '../../replay/browser-fetch.ts'
import { runBrowserRecipe } from '../../replay/browser-drive.ts'
import { interpret, interpretObject, ReplayDriftError, ReplayThrottledError, type MappedItem } from '../../replay/interpret.ts'
import { makeHttpFetch } from '../../replay/http-fetch.ts'
import { interpretHtml } from '../../replay/interpret-html.ts'
import { makeHtmlFetch } from '../../replay/html-fetch.ts'
import type { HttpRecipe, HtmlRecipe, Recipe } from '../../replay/recipe.ts'
import { runDesktopRecipe, type OverrideSource } from '../../replay/desktop-runner.ts'
import type { DesktopRecipe } from '../../replay/desktop-recipe.ts'
import type { DesktopDriver } from '../../replay/desktop-driver.ts'
import type { SeeResolver } from '../../replay/desktop-see.ts'
import type { SeeFailureContext } from '../../replay/desktop-failure.ts'
import { HostRelayDisconnected, HostRelayTimeout, HostSessionQueueTimeout, HostAbortedByUser } from '../../http/host-relay.ts'
import type { RecipeRunOutcome } from '../../replay/recipe-runner.ts'
import { RecipeBlockedError } from '../../replay/session-recipe-executor.ts'
import type { RepairLedger } from '../../replay/repair-ledger.ts'
import type { RepairRunner } from '../../replay/repair-runner.ts'
import { isCanonicalBrowserRecipe } from '../../replay/recipe.ts'
import { EnvironmentUnavailableError } from '../../failure.ts'
import { sessionPrecheck } from '../../auth/session-precheck.ts'

/**
 * The source's login session is gone (login wall) — a USER action, not a broken
 * recipe: no drift is recorded, no quarantine. Surfaces as source failure with a
 * "re-login" message through the existing health visibility.
 */
export class NeedsLoginError extends Error {
  /** `facility`/`label` make the failure ACTIONABLE: the re-login flow is keyed by facility, and
   *  the label is what the user is shown (the site's display name, not its facility key). Optional because a source may
   *  declare no facility at all — see `blockedOf`, which then refuses to offer a login button
   *  rather than offering one that leads nowhere. */
  constructor(readonly sourceId: string, readonly facility?: string, readonly label?: string) {
    super(`source "${sourceId}" needs re-login`)
    this.name = 'NeedsLoginError'
  }
}

/**
 * 一条 `meta.action:true` 的动作 recipe，被经普通采集路径（定时调度 / `stream_read` / HTTP
 * preview——凡是走 `ReplayAdapter.fetch` 的入口）碰到了，而这次调用又没有声明 `userInitiated`。
 *
 * 这道闸防的是**模型经工具静默触发**，不是"是不是动作"本身——`meta.action` 只是"这条 recipe
 * 有真实副作用"的标记，真正决定放不放行的是调用方能不能证明"这次执行来自用户在界面上的一次
 * 显式点击"（`SourceExecutionContext.userInitiated`）。模型侧唯一合法的路线仍是
 * `run_action_recipe`（`src/mcp/action-recipe.ts`）：那条路上有二次确认闸。第一方 UI
 * 路径（前端按钮 → 后端 handler）不走那条闸，但必须在 `readSource` 的 opts 里显式带上
 * `userInitiated: true` 才能放行——漏带就当场报这个错，不会静默通过。
 *
 * 堵在这里（`fetch` 里 recipe 已经在手的地方）是因为它是三个入口共同经过的唯一一点，
 * 不在每个入口分别打补丁。
 */
export class ActionRecipeBlockedError extends Error {
  constructor(readonly sourceId: string) {
    super(
      `"${sourceId}" 是一条动作 recipe（会产生真实副作用）——` +
      '模型侧要走 run_action_recipe（用户确认后带 confirmed:true；desktop 与 browser 两档都接了，' +
      'browser 档经 SessionRecipeExecutor 执行、凭据/限速/冷却各闸照常成立）；' +
      '第一方 UI 路径（前端按钮触发）要在 readSource 的 opts 里显式声明 userInitiated:true 才能放行。',
    )
    this.name = 'ActionRecipeBlockedError'
  }
}

/**
 * 站方在**限流/挑战**我们（验证码遮罩之类）—— 和 `NeedsLoginError` 严格分开的一档。
 *
 * **登录态是好的，用户什么都不用做。** 分不开的代价今天两头都踩过：
 *  · 判成 needsLogin → 界面喊「需要重新登录」，把人支去重登一个完全正常的账号；
 *  · 判成 drift → `RepairLedger` 三次之后**静默隔离**这个源，此后返回 `items:0 + errors:[]`，
 *    和「跑成功了、但确实没搜到」一模一样（failure-atlas 附录 B.3）。
 *
 * 正确的去处是 facility 冷却（底数与封顶由该站点的撞墙台账喂，见 `FacilityCooldown`）：到点自己回来。
 * 消息里那句话是**用户真正会看到的文案**（前端目前直接渲染 `reason`），所以它必须说清
 * 「不用你动手」和「大概多久」——`retryAfterMs` 有值就写进去。
 */
export class SiteChallengeError extends Error {
  constructor(readonly sourceId: string, readonly facility?: string, readonly label?: string, readonly retryAfterMs?: number) {
    super(`${label ?? facility ?? sourceId} 站方在限流/挑战（不是登录失效，无需重新登录）${retryAfterMs ? `，约 ${humanWait(retryAfterMs)}后自动重试` : '，稍后自动重试'}`)
    this.name = 'SiteChallengeError'
  }
}

/**
 * 把毫秒说成人话。**下限故意是「1 分钟内」而不是"约 0 分钟"**：冷却最短一档是 60s，
 * 直接四舍五入成分钟会在第一档就说出"约 0 分钟后重试"——一句自我否定的话。
 */
export function humanWait(ms: number): string {
  const s = Math.ceil(ms / 1000)
  if (s <= 60) return '1 分钟内'
  return `${Math.round(s / 60)} 分钟`
}

/** The facility identity to attach to a NeedsLoginError, read off the manifest. */
export function facilityOf(manifest: SourceManifest): [facility?: string, label?: string] {
  return [manifest.facility?.key, manifest.facility?.label]
}

/** Map a session-recipe outcome to items or the same typed errors the legacy
 *  runner path throws, so health/ledger classification is transport-independent. */
export function sessionOutcomeToItems(
  result: RecipeRunOutcome, sourceId: string, facility?: string, label?: string,
): MappedItem[] {
  switch (result.outcome) {
    case 'ok': return result.items
    case 'needsLogin': throw new NeedsLoginError(sourceId, facility, label)
    case 'challenged': throw new SiteChallengeError(sourceId, facility, label)
    case 'drift': throw new ReplayDriftError(result.reason ?? 'session recipe drift', 0)
    case 'blocked': throw new RecipeBlockedError(result.reason ?? 'recipe blocked')
    case 'cancelled': throw new Error(result.reason ?? 'recipe cancelled')
    // 抛的是带标记的错误而不是返回空数组：空数组会被当成"采到了 0 条"（进而 blocked / 记 health），
    // 而这里的真相是"没采"。调度侧靠这个类型把本轮跳过。
    case 'unavailable': throw new EnvironmentUnavailableError(result.reason ?? 'harvest environment unavailable')
    // **别加 `default:`**。这个 switch 是"新增一档 outcome 时编译器替你数漏了谁"的唯一一处
    // 保险：漏掉一档，`never` 这一行当场类型错。写成 default 兜底就把这层保险扔了，等于退回
    // 「每个消费端都得记得去看」的处境——这个仓库栽过太多次的那个形状。
    default: return assertNever(result.outcome)
  }
}

function assertNever(x: never): never {
  throw new Error(`unhandled recipe outcome: ${String(x)}`)
}

/**
 * "本轮没采" 的返回值 —— 空 items **加上一个说假的成功指针**。
 *
 * 裸 `[]` 到了调度侧和"上游采到 0 条"完全一样，collection 流会拿它去替换分片、把存量清掉
 * （2026-07-24 怡乐事故的形状）。decline 不是错误（不该记 health、不该进隔离），也不是成功，
 * 所以它需要自己的说法。见 2026-07-30 collection-empty-snapshot-guard spec。
 */
const DECLINED: AdapterFetchResult = { items: [], authoritative: false }

/** Ensure the RSSHub DataItem contract so makeStreamItem/dedup work unchanged. */
export function toDataItem(m: MappedItem): Record<string, unknown> {
  const link = (m.link ?? m.url) as unknown
  const guid = (m.guid ?? link ?? m.title) as unknown
  return { ...m, link, guid }
}

/**
 * `output.timestampFrom:'harvest-order'`（见 `RecipeOutput` 的头注）：把 pubDate 盖成
 * 「本轮采集时刻 − 序号秒」，让条目按采到的先后排。`items` 的顺序就是采集顺序——
 * `ObserverPipeline.items()` 合并时保的正是这一点（首批在前、翻页在后）。没申报的 recipe原样返回。
 * 用秒不用分：一轮 100 条只占 100s，两轮之间（cadence 以小时计）不会交叠。
 */
export function stampHarvestOrder(items: MappedItem[], recipe: Recipe, now = Date.now()): MappedItem[] {
  if (!isCanonicalBrowserRecipe(recipe) || recipe.output.timestampFrom !== 'harvest-order') return items
  return items.map((m, i) => ({ ...m, pubDate: new Date(now - i * 1000).toISOString() }))
}

export interface ReplayAdapterDeps {
  recipes: RecipeStore
  /**
   * 每一轮采集前确认浏览器还在（用户的 Chrome 连着中继吗？没连就唤起）。**每轮都要确认**——
   * canonical browser recipe 走 `sessionFetch`，它在这个类里自己调；legacy 的 fetch/browser
   * recipe 走下面这条路，需要在这里补上同一个前置，否则 Chrome 关着时 xueqiu 这类 fetch recipe
   * 只能白白跳过整轮而不会去唤起它。
   */
  ensureTransport?: () => Promise<void>
  makeLauncher: (opts: { cookieHeader?: string; cookieDomain?: string }) => ReplayLauncher
  /** injectable browser-recipe runner (tests); defaults to the real runBrowserRecipe */
  runBrowser?: typeof runBrowserRecipe
  /** resolve a DesktopDriver over the /api/host relay; undefined (Stream Desktop not connected) →
   *  a kind:'desktop' source declines as a miss instead of throwing. */
  desktopDriver?: () => DesktopDriver | undefined
  /** 桌面 recipe 的识别层工厂（`ctx.harvest.makeSee`）——一趟一个实例，绑这条 recipe 的
   *  sourceId。缺席 = 宿主没接识别层，用了 `see` 的 recipe 会明说，不静默降级。 */
  makeSee?: (driver: DesktopDriver, sourceId: string) => SeeResolver
  /** 本机学到的落地方式（`ctx.harvest.recipeOverrides`）——runner 每一步开头读它、整趟 done 后
   *  写它。缺席 = 这台后端没接这份存储，只跑包里自带的 grounding，不静默伪造一份空的。 */
  recipeOverrides?: OverrideSource
  /** injectable desktop-recipe runner (tests); defaults to the real runDesktopRecipe */
  runDesktop?: typeof runDesktopRecipe
  /** optional: resolve a Cookie header for the recipe's domain (broker wiring is a later plan) */
  cookieFor?: (domain: string) => Promise<string | undefined>
  /** optional: which cookie NAMES a domain currently has in the user's Chrome (never values).
   *  Drives the login-detect fast path — see `sessionPrecheck`. Absent → the fast path is
   *  skipped and detection happens on the page, as before. */
  cookieNames?: (domain: string) => Promise<string[]>
  /** optional: drift/quarantine ledger — quarantined sources decline without launching */
  ledger?: RepairLedger
  /** 「这个源坏了会连累谁」——`Registry.affectedSources` 的注入口，漂移那一刻问一次，答案写进
   *  账里（见 `RepairState.affectedSources`）。**调用时才问**，装配期解不得：`uses` 随 recipe 包
   *  热装卸变，冻在启动那一刻的答案不会报错，只会少算几条边。缺席 = 这一格没算过。 */
  affectedSources?: (sourceId: string) => string[]
  /** optional: called once when a source becomes quarantined (reserved for a Code Agent) */
  repairRunner?: RepairRunner
  /** debug bus 的入口——kind:'desktop' 分支的 `HostSessionQueueTimeout` 落这里（channel
   *  `host-agent`），见 `runDesktop` 头注 I2。缺席就不记（诊断通道没资格掀翻一条能用的采集）。 */
  onDebug?: (entry: DebugEntry) => void
  /** Optional facility session executor. `undefined` means this recipe uses the normal runner. */
  sessionFetch?: (
    recipe: import('../../replay/recipe.ts').Recipe,
    params: Record<string, string>,
    manifest: SourceManifest,
    signal?: AbortSignal,
  ) => Promise<unknown[] | undefined>
}

/**
 * The `replay` adapter — runs a source's recipe and returns DataItem-shaped raw. It spans the
 * whole cost ladder, cheapest first: `http`/`html` are bare host fetches, `desktop` drives the
 * OS a11y tree, and the browser kinds ride the user's own Chrome over the extension relay
 * (the page's own signed fetch). **No master switch**: what a recipe costs is declared by its
 * `kind`, and each kind declines on its own missing precondition (no Stream Desktop, no relay).
 */
export class ReplayAdapter implements Adapter {
  readonly id = 'replay'
  constructor(private readonly deps: ReplayAdapterDeps) {}

  async init(_env: Record<string, string>): Promise<void> {}

  /** I2：往 debug bus 记一条会话租约排队超时——见 `runDesktop` 头注。**绝不抛**：这是一条
   *  诊断通道，它出问题不该让一条本来只是"排队超时"的 decline 变成真正的失败。 */
  private recordSessionQueueTimeout(sourceId: string): void {
    if (!this.deps.onDebug) return
    const at = Date.now()
    try {
      this.deps.onDebug({
        id: `host-agent:sessionQueueTimeout:${sourceId}@${at}`,
        at,
        channel: 'desktop',
        key: 'sessionQueueTimeout',
        title: `桌面会话租约排队超时：${sourceId}`,
        summary: `"${sourceId}" 这一轮没跑——排队等桌面会话租约超时（被另一条 recipe/操作占着，不是 agent 没响应），已 decline 为本轮无新内容`,
        ok: false,
        fields: [{ label: 'sourceId', value: sourceId, tone: 'warn' }],
      })
    } catch {
      /* 听众的问题不是采集本身的问题 */
    }
  }

  /**
   * 桌面 recipe 漂移时，把这一趟 `see` 的现场留在 debug bus 上（channel `host-agent`）。
   *
   * **桌面这一侧没有 DevTools、没有 DOM 快照**：一步做完屏幕上就什么都不剩了，而
   * `driftReason` 只说"哪一步没成"。"模板命中却点空"和"模型指错了"的下一步完全不同
   * （前者作废模板重走梯子，后者要改 recipe 的 `see`），光看 reason 分不出来。
   *
   * **整趟没用过 `see` 就不记**：一条空现场只会把这个频道填满噪音，真正的现场反而看不见。
   * 和上面那条一样**绝不抛**——诊断通道没资格掀翻一条本来只是漂移的采集。
   *
   * `ok` 由调用方给，**不在这里写死 false**：今天唯一的调用点是漂移那一档，但这几样
   * （`seeVia` / `dismissed`）在成功的运行里同样有意思（"每轮都要先关一次广告"正是那种
   * 成功了但不对劲）。写死就等于给将来的复用埋一句假话——一条成功的运行被标成红的，
   * 而这个频道上没有任何东西会喊。
   */
  private recordSeeContext(sourceId: string, ctx: SeeFailureContext, ok: boolean): void {
    if (!this.deps.onDebug) return
    const via = Object.entries(ctx.seeVia ?? {})
    const dismissed = ctx.dismissed ?? []
    if (!via.length && !dismissed.length) return
    const at = Date.now()
    try {
      this.deps.onDebug({
        id: `host-agent:seeContext:${sourceId}@${at}`,
        at,
        channel: 'desktop',
        key: 'seeContext',
        title: `桌面识别层现场：${sourceId}`,
        summary: `这一趟每步的靶子是怎么找到的${dismissed.length ? `，另消化了 ${dismissed.length} 个打断` : ''}`,
        ok,
        fields: [
          ...via.map(([step, v]) => ({ label: step, value: v, tone: 'muted' as const })),
          // 弹窗是"成功了但不对劲"的典型：框被关掉、recipe 照常跑完，没人知道每轮都要先关一次广告。
          ...dismissed.map((d, i) => ({ label: `打断#${i + 1}`, value: d, tone: 'warn' as const })),
        ],
      })
    } catch {
      /* 听众的问题不是采集本身的问题 */
    }
  }

  /**
   * 记一次漂移，并在它**刚跨进隔离**时请一次修复。六条取数路径（http/html/desktop/session/
   * browser/fetch）共用这一处，好让「连累了谁」只有一份实现——分散成六份，下一条新增的取数路径
   * 一定会漏掉它，而漏掉之后没有任何一处会喊。
   *
   * `ledgerReason` 与 `repairReason` 分开：legacy browser 那条把 seed/trace 拼进账本原因（离线
   * 可复现），但递给修复方的仍是那句人话。
   */
  private noteDrift(
    sourceId: string,
    recipeVersion: number,
    ledgerReason: string,
    repairReason: string = ledgerReason,
  ): void {
    // 诊断问不出来不该掀翻采集本身：这一格没算过，比因为它抛而丢掉整条漂移记录好得多。
    let affected: string[] | undefined
    try {
      affected = this.deps.affectedSources?.(sourceId)
    } catch {
      affected = undefined
    }
    const st = this.deps.ledger?.recordDrift(sourceId, ledgerReason, recipeVersion, affected)
    // Fires once at the quarantine transition — a quarantined source declines on
    // subsequent fetches (shouldRun=false), so it never re-reaches this path.
    if (st?.status === 'quarantined') {
      void this.deps.repairRunner?.requestRepair({
        sourceId,
        reason: repairReason,
        affectedSources: st.affectedSources,
      })
    }
  }

  /** Run a plain-HTTP recipe: the shared declarative engine over a host fetch. Drift is
   *  recorded exactly as on the browser paths, so health/quarantine/repair stay
   *  transport-independent — a source that rots is a source that rots. */
  private async runHttp(
    recipe: HttpRecipe,
    params: Record<string, string>,
    manifest: SourceManifest,
  ): Promise<unknown[]> {
    try {
      const fetchInPage = makeHttpFetch(recipe, this.deps.cookieFor)
      if (recipe.output === 'object') {
        // 探针/解析器：decode 的返回值就是判决对象。Adapter 契约是数组，单个判决以 [obj]
        // 承载（null decline → []）；执行器缝上按 manifest.output 解包回对象。
        const result = await interpretObject(recipe, { fetchInPage }, params)
        this.deps.ledger?.recordSuccess(manifest.id)
        return result == null ? [] : [result]
      }
      const { items } = await interpret(recipe, { fetchInPage }, params)
      this.deps.ledger?.recordSuccess(manifest.id)
      return items.map((item) => toDataItem(item))
    } catch (e) {
      if (e instanceof ReplayDriftError) {
        this.noteDrift(manifest.id, recipe.version, e.assertDesc)
      }
      throw e
    }
  }

  /** Run a plain-HTML recipe: the same shape as runHttp, over a guarded host fetch that
   *  returns text, parsed with linkedom. Drift is recorded identically, so health/quarantine/
   *  repair stay transport-independent. */
  private async runHtml(
    recipe: HtmlRecipe,
    params: Record<string, string>,
    manifest: SourceManifest,
  ): Promise<unknown[] | AdapterFetchResult> {
    try {
      const { items } = await interpretHtml(recipe, { fetchHtml: makeHtmlFetch(recipe, this.deps.cookieFor) }, params)
      this.deps.ledger?.recordSuccess(manifest.id)
      return items.map((item) => toDataItem(item))
    } catch (e) {
      // 被限流 = 瞬时，和中继断线 / 队列超时同一类：**不记漂移**（`ReplayThrottledError` 的
      // 头注写着代价：记了三次就把一份完好的 recipe 关进隔离，之后这个源静默返回空）。
      // 也**不 recordSuccess**——这一趟确实没拿到东西，不能把连败计数洗掉。
      if (e instanceof ReplayThrottledError) return DECLINED
      if (e instanceof ReplayDriftError) {
        this.noteDrift(manifest.id, recipe.version, e.assertDesc)
      }
      throw e
    }
  }

  /** Run a kind:'desktop' recipe: the host-desktop Engine drives the OS a11y tree over the
   *  /api/host relay. Drift/needsLogin are recorded exactly as on the browser path, so
   *  health/quarantine/repair stay transport-independent. Declines (miss) with no Stream Desktop.
   *
   *  I2：`HostSessionQueueTimeout`（桌面会话租约排队等太久）declines 的样子和"这个源本来就
   *  没有新内容"一模一样——不记 health、不进 debug 通道、没有 reason，桌面 source 数量 ×
   *  单趟耗时一旦逼近 `sessionWaitMs`，排在后面的源每轮都拿不到租约，查不到也不会告警。
   *  这个天花板正是"整趟 recipe 串行化"这个机制本身带来的，是最需要观测的一格——所以单独
   *  给它记一条 debug bus 条目（channel `host-agent`——频道名跟着那个二进制走，产品名是
   *  Stream Desktop；和 `ensureAppDebugEntry` 同一个频道），
   *  跟另外两种（agent 断线 / op 超时）分开：那两种是 agent 本身不健康，这种是 agent 健康、
   *  只是被别的 recipe/操作占着——诊断方向完全不同，混在一起报告会把"该等"看成"该修 agent"。 */
  private async runDesktop(
    recipe: DesktopRecipe,
    params: Record<string, string>,
    manifest: SourceManifest,
  ): Promise<unknown[] | AdapterFetchResult> {
    const driver = this.deps.desktopDriver?.()
    if (!driver) return DECLINED // Stream Desktop not connected → decline (miss), like a disabled transport
    let result
    try {
      // 工厂而不是实例：runner 自己在开跑那一刻建一个，`modelCalls` 的预算才归这一趟。
      const makeSee = this.deps.makeSee
      const [desktopFacility] = facilityOf(manifest)
      result = await (this.deps.runDesktop ?? runDesktopRecipe)(recipe, params, driver, {
        ...(makeSee && { see: (d: DesktopDriver) => makeSee(d, recipe.sourceId) }),
        // 本机学到的落地方式，原样递（不复制、不包一层）：runner 读写的必须是那一份。
        // **不递 `packageInfo`**：这一跳手里只有 `Recipe`，没有包身份；override 文件的
        // `package` 字段由贡献时的 CLI 补，运行时不填。
        ...(this.deps.recipeOverrides && { overrides: this.deps.recipeOverrides }),
        // 介入闸的提议交给**接线方注入的那个** runner，和源级的 `requestRepair` 同一个收件人。
        // 不传的话它们会落到 runner 自己 new 的那份日志里——宿主装了别的实现也收不到，
        // 而"收不到"和"没有提议"长得一模一样。
        ...(this.deps.repairRunner && { repairRunner: this.deps.repairRunner }),
        // 设施键只有清单上才有（`DesktopRecipe` 不带它）。不透传的话提议落到 Broker 时会退回
        // 用 sourceId，同一站的状态与观测被学散到几份文件里——而两边都不报错。
        ...(desktopFacility ? { facility: desktopFacility } : {}),
      })
    } catch (e) {
      // 用户按热键叫停 → decline（miss），和"这个源这轮没有新内容"同样收场：不记 drift、
      // 不隔离。用户叫停不是 recipe 坏了，隔离会让一次手动干预连累这个源之后的每一轮。
      if (e instanceof HostAbortedByUser) return DECLINED
      if (e instanceof HostSessionQueueTimeout) {
        this.recordSessionQueueTimeout(manifest.id)
        return DECLINED
      }
      // Agent dropped mid-recipe (disconnect / op timeout) → decline as a MISS, same as
      // no-agent-connected. It's a transient host condition, not a broken recipe — no drift,
      // no quarantine (otherwise a flaky agent would quarantine every source it touches).
      if (e instanceof HostRelayDisconnected || e instanceof HostRelayTimeout) return DECLINED
      throw e
    }
    if (result.outcome === 'needsLogin') throw new NeedsLoginError(manifest.id, ...facilityOf(manifest))
    if (result.outcome === 'drift') {
      const reason = result.driftReason ?? 'desktop-recipe drift'
      this.recordSeeContext(manifest.id, result, false)
      this.noteDrift(manifest.id, recipe.version, reason)
      throw new ReplayDriftError(reason, 0)
    }
    this.deps.ledger?.recordSuccess(manifest.id)
    // 成功的那一趟同样要留现场：「每轮都要先关一次广告」正是那种成功了但不对劲的事，
    // 只在漂移路径上记等于永远看不见它（`recordSeeContext` 自己在 seeVia/dismissed 都空时
    // 不记，所以没有 `see` 的普通桌面 recipe 不会因此多出一条噪音）。
    this.recordSeeContext(manifest.id, result, true)
    return result.items.map((item) => toDataItem(item as MappedItem))
  }

  async fetch(
    params: Record<string, unknown>,
    manifest: SourceManifest,
    context?: SourceExecutionContext,
  ): Promise<unknown[] | AdapterFetchResult> {
    const recipe = this.deps.recipes.load(manifest.id)

    // 动作 recipe 不得经这条路静默执行——见 ActionRecipeBlockedError 头注。判据是"这次调用
    // 是不是用户第一方发起的"（userInitiated），不是"是不是动作"：后者恒真，前者才是真正要防的
    // 那件事。放在最前面，quarantine/sessionPrecheck 之类的分支都不该有机会先于这道闸跑到底。
    if (recipe.meta?.action === true && !context?.userInitiated) throw new ActionRecipeBlockedError(manifest.id)

    // Quarantined (persistently drifting) source → decline WITHOUT launching/installing
    // a browser. A newer recipe version releases the quarantine (see RepairLedger).
    if (this.deps.ledger && !this.deps.ledger.shouldRun(manifest.id, recipe.version)) return DECLINED

    const stringParams: Record<string, string> = {}
    for (const [k, v] of Object.entries(params)) stringParams[k] = String(v)

    // kind:'http' — the cheapest rung. No browser, no session, so it short-circuits
    // everything below.
    if (recipe.kind === 'http') {
      return await this.runHttp(recipe, stringParams, manifest)
    }

    // kind:'html' — the same cheap rung as http (bare host fetch, no browser), for upstreams
    // that serve HTML instead of JSON.
    if (recipe.kind === 'html') {
      return await this.runHtml(recipe, stringParams, manifest)
    }

    // kind:'desktop' — the host-desktop Engine (OS a11y tree over the /api/host relay). It
    // needs no browser at all, same as http/html. It declines (miss) when Stream Desktop is
    // not connected.
    if (recipe.kind === 'desktop') {
      return await this.runDesktop(recipe, stringParams, manifest)
    }

    // Login detect, cheap half first: if the facility declared which cookies carry its session
    // and NONE of them are in the user's Chrome, the session is definitively gone — say so now
    // rather than paying for a tab + navigation + render to be told the same thing by a login
    // wall. Matters most exactly where it is most visible: a multi-source search, where the user
    // is waiting on the OTHER sources. Only a proven absence short-circuits; anything unknown
    // (not declared, lookup failed, extension offline) falls through to the page.
    if (this.deps.cookieNames && manifest.auth
        && (await sessionPrecheck(manifest.auth, this.deps.cookieNames)) === 'GONE') {
      throw new NeedsLoginError(manifest.id, ...facilityOf(manifest))
    }

    let sessionItems: unknown[] | undefined
    try {
      sessionItems = await this.deps.sessionFetch?.(recipe, stringParams, manifest, context?.signal)
    } catch (e) {
      if (e instanceof ReplayDriftError) {
        this.noteDrift(manifest.id, recipe.version, e.assertDesc)
      }
      throw e
    }
    if (sessionItems !== undefined) {
      this.deps.ledger?.recordSuccess(manifest.id)
      return stampHarvestOrder(sessionItems as MappedItem[], recipe).map(toDataItem)
    }

    // 采集环境前置（Chrome 连着中继吗？没连就唤起）。放在 makeLauncher 之前，因为 launcher 一旦
    // 拿到就会立刻去开 tab；连不上时这里抛 EnvironmentUnavailableError，调度侧据此跳过本轮而不是
    // 判源故障。
    await this.deps.ensureTransport?.()

    const cookieHeader = this.deps.cookieFor ? await this.deps.cookieFor(recipe.cookieDomain) : undefined
    const launcher = this.deps.makeLauncher({
      cookieHeader,
      cookieDomain: recipe.cookieDomain || undefined,
    })

    if (recipe.kind === 'browser') {
      if (isCanonicalBrowserRecipe(recipe)) {
        throw new Error(`canonical browser recipe "${recipe.sourceId}" requires a session executor`)
      }
      const result = await (this.deps.runBrowser ?? runBrowserRecipe)(recipe, stringParams, launcher)
      if (result.outcome === 'needsLogin') throw new NeedsLoginError(manifest.id, ...facilityOf(manifest))
      if (result.outcome === 'drift') {
        const reason = result.driftReason ?? 'browser-recipe drift'
        // The ledger reason string carries the run context (seed + realized action
        // trace) so a failed run's random decisions are replayable offline. A
        // structured ledger field is Phase 5.
        this.noteDrift(
          manifest.id,
          recipe.version,
          `${reason} [seed=${result.seed} trace=${JSON.stringify(result.trace)}]`,
          reason,
        )
        throw new ReplayDriftError(reason, 0)
      }
      this.deps.ledger?.recordSuccess(manifest.id)
      return result.items.map(toDataItem)
    }

    try {
      const items = await runFetchRecipe(recipe, stringParams, launcher)
      this.deps.ledger?.recordSuccess(manifest.id)
      return items.map(toDataItem)
    } catch (e) {
      if (e instanceof ReplayDriftError) {
        this.noteDrift(manifest.id, recipe.version, e.assertDesc)
      }
      throw e // propagate so the scheduler records the (classified) health error too
    }
  }
}
