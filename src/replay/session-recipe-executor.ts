import { RecipeRunner, type RecipeRunOutcome } from './recipe-runner.ts'
import type { CanonicalBrowserRecipe, RecipeSessionSpec } from './recipe.ts'
import type { RecipeSessionManager } from './session-manager.ts'
import type { Transport } from './transport.ts'
import { substitute } from './interpret.ts'
import { provisionedConfigSlot } from './recipe-provisioner.ts'
import { isEnvironmentUnavailable } from '../failure.ts'
import type { RepairRunner } from './repair-runner.ts'
import type { Observation, StateGraph } from './state-graph.ts'

function staleTab(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
  return /no tab with given id/i.test(message)
}

/** Same page, ignoring the hash and query (a chat URL copied from the address bar may carry either). */
function sameLocation(a: string, b: string): boolean {
  try {
    const x = new URL(a), y = new URL(b)
    return x.origin === y.origin && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '')
  } catch {
    return a === b
  }
}

export class RecipeBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecipeBlockedError'
  }
}

/** Generic bridge from a canonical recipe to a facility session lease. */
export class SessionRecipeExecutor {
  constructor(
    private readonly sessions: RecipeSessionManager,
    private readonly transportFor: (spec: RecipeSessionSpec) => Transport,
    private readonly runner = new RecipeRunner(),
    /**
     * 把一次抽取写进**这份 recipe 自己声明的** runtime_config。这是 recipe 写凭据存储的唯一入口，
     * 所以守卫在这一层，不在 recipe 体里：
     *
     * - 目标 ref 来自 `recipe.meta.runtime_config.ref`，recipe 运行期给不出别的 ref；
     * - 字段必须在同一份声明里、且 `type:'secret'`，否则拒写 —— 不能凭空往凭据存储里塞键；
     * - 没装配这个 sink 时，抽取被明确拒绝（runner 会记进 outcome.extract），不是静默丢弃。
     *
     * 返回值是给 trace 的说明，永远不含被抽到的值。
     */
    private readonly writeSecret?: (ref: string, field: string, value: string) => void,
    /**
     * 落到站点上的**频率闸门**，每个 facility 一个桶（见 FacilityRateLimiter）。
     *
     * 装在这一层而不是 recipe 里：一次运行 = 一次访问，而 recipe 只知道自己，不知道同一个
     * facility 上还有搜索、detail、互动三条线在同时打。封号数的是这个 facility 的总频率，
     * 所以闸门必须在**所有 recipe 的共同入口**上，而这里就是那个入口。
     *
     * 放在 acquire 之前：被限速时连标签都不该开。
     */
    private readonly rateLimit?: {
      take(
        facility: string,
        source?: { id: string; limit?: { burst: number; perMinute: number; perHour?: number; maxWaitMs?: number } },
      ): Promise<void>
      /** 撞墙时排空小时预算并回报"这一小时发了几发"（见 `FacilityRateLimiter.drainBudget`）。 */
      drainBudget?(facility: string): number | undefined
    },
    /**
     * **被拦之后的退让闸门**（见 `FacilityCooldown`）。和上面那道是两件事：那道管频率，
     * 这道管「站点已经把我们拦下了，先别去打」。同样装在这一层、同样在 acquire 之前——
     * 理由一样：一次运行 = 一次访问，而 facility 上有好几条线在同时打。
     */
    private readonly cooldown?: {
      assertReady(facility: string): void
      blocked(facility: string, because: string, ctx?: { spentLastHour?: number }): void
      cleared(facility: string): void
    },
    /**
     * 读**这份 recipe 自己那一格**的凭据（`meta.secret_params`，见 `recipe.ts` 那一格的头注）。
     * 和 `writeSecret` 是同一条缝的两个方向，守卫同样在这一层而不在 recipe 体里。
     * 不注入 = 声明了 secret_params 的 recipe 一步都跑不了（硬失败），不是静默跑一个没填的。
     */
    private readonly readSecret?: (ref: string, field: string) => string | undefined,
    /**
     * **闸 3：这份 recipe 是不是来自内置层。** 凭据只注入给内置包——npm 装来的第三方 recipe
     * 一律拿不到。判据来自装载方（`mountRecipePackages` 的 `builtinRecipeIds`，那是唯一
     * 分得清层的地方），**不是**从 sourceId 的形状猜出来的：猜法会在某天有人用一个像内置的
     * 名字发包时安静地失效。
     *
     * **收 recipe 本身，不收 sourceId** —— 这一格曾经收的是 sourceId，而那是个对不上的判据：
     * 装载期给 recipe 加了命名空间前缀（`@streamapp/dfcf/dfcf-login`）作为 map 的键，recipe
     * 体里的 `sourceId` 仍是局部名（`dfcf-login`）。拿局部名去查一份装着全名的集合，恒为 false，
     * 表现是「凭据永远注入不了」而错误信息却在说「这不是内置包」——指向完全错误的方向。
     * 按对象身份判从根上没有这个问题，装载方那边也早就是按身份判覆盖的。
     *
     * 不注入这个判据 = 谁都不是内置 = 谁都拿不到凭据。**默认方向是关**，这是有意的。
     */
    private readonly isBuiltinRecipe?: (recipe: CanonicalBrowserRecipe) => boolean,
    /**
     * 介入接线（spec §3）。两个都是**调用时才解**的 thunk：executor 在 harvest 域建，介入服务在
     * llm 域之后才有——装配期取一次就是冻住的 undefined（AGENTS.md「装配期取的值 = 冻住的答案」），
     * 而症状是「介入从来没发生过」，没有任何一处会喊。
     *
     * `graphFor(facility)` 是这个 facility 的本地状态图 = 包自带 `states.json` ∪ 学到的那一层
     * （spec §9.1）；runner 自己再并上内置全局那张。**键是 facility 不是 sourceId**——状态是
     * 站点级的事，按 sourceId 分会把同一张图学成几份互不相识的碎片。
     */
    private readonly interventions?: {
      repairRunner: () => RepairRunner | undefined
      graphFor: (facility: string) => StateGraph | undefined
      /**
       * 认出状态时记一笔观测。**facility 由这里补上**：runner 那一侧只知道"认出了哪个状态"，
       * 它不该也不需要知道这是谁家的账本——键与状态图一致（facility，不是 sourceId）。
       */
      onObserved?: (facility: string, o: Observation) => void
    },
    /**
     * `locate` 步的坐标系（`FeedLedger.ordered(facility)`），调用方没传 `ordered` 时 runner 按
     * recipe 的 facility 来问。**接在这一层**是因为这里是每一次 canonical browser recipe 运行的
     * 唯一必经处（记账的那一端 `sessionFetch` 也是同样的理由挂在这条路上）——账本住在 harvest 域，
     * runner 不该认识它，而各个调用方（包代码 / HTTP / MCP）更不该各自去取。
     * 不注入 = 缺省 `ordered` 就是空账本（locate 直接 MISS 落 fallback），不是报错。
     */
    private readonly orderedFor?: (facility: string) => string[],
  ) {}

  /**
   * 把这份 recipe 声明的凭据注入参数袋。**返回一份新的**，绝不改调用方那个对象——
   * 那个对象在别处被引用（trace/日志的上游），往里塞凭据就是把它撒进所有拿着它的人手里。
   *
   * 闸 1/2（只读自己那一格、字段必须已声明为 secret）在装载期判过了（`recipe-store.ts`），
   * 这里只判运行期才知道的那两件：**来源**（闸 3）和**值在不在**。
   */
  private withSecrets(recipe: CanonicalBrowserRecipe, params: Record<string, string>): Record<string, string> {
    const names = recipe.meta?.secret_params
    if (!names || names.length === 0) return params
    const spec = recipe.meta?.runtime_config
    // 装载期保证了有 spec；这里再判一次是因为这条路也接受没过装载校验的 recipe（测试/直调）。
    if (!spec) throw new RecipeBlockedError(`recipe "${recipe.sourceId}": 声明了 secret_params 却没有 runtime_config`)
    if (!this.isBuiltinRecipe?.(recipe)) {
      throw new RecipeBlockedError(
        `recipe "${recipe.sourceId}": 只有内置包的 recipe 能拿到凭据（secret_params）。` +
        `从 npm 装来的 recipe 一律注入不到——把用户的凭据交给一份从网上装来的数据，没有任何守卫能补救。`,
      )
    }
    if (!this.readSecret) {
      throw new RecipeBlockedError(`recipe "${recipe.sourceId}": 宿主没有接凭据读口，secret_params 注入不了`)
    }
    const next = { ...params }
    for (const field of names) {
      const value = this.readSecret(spec.ref, field)
      if (!value) {
        // 缺就停。放行的话 `{jymm}` 会以**字面量**打进密码框，站点只回一句"密码错误"——
        // 排查时看起来像密码不对，实际是根本没配。
        throw new RecipeBlockedError(
          `recipe "${recipe.sourceId}": 凭据 "${field}" 在 ${spec.ref} 里没有值——先在配置里填上再跑`,
        )
      }
      next[field] = value
    }
    return next
  }

  /** 绑定到某份 recipe 的抽取 sink；声明缺失/字段没声明成 secret 都返回 undefined = 拒写。
   *  判据本身住在 `provisionedConfigSlot`——**界面上那颗「一键帮我完成」按钮问的是同一个
   *  函数**，两边不许各写一份（漂移的两种形状都不报错：按钮亮着却没人写、或者会写却没入口）。 */
  private sinkFor(recipe: CanonicalBrowserRecipe): ((field: string, value: string) => void) | undefined {
    if (!this.writeSecret) return undefined
    const slot = provisionedConfigSlot(recipe)
    if (!slot) return undefined
    return (field, value) => this.writeSecret!(slot.ref, field, value)
  }

  async execute(recipe: CanonicalBrowserRecipe, params: Record<string, string>, signal?: AbortSignal): Promise<RecipeRunOutcome> {
    const facility = recipe.session.facility
    // 已经没人要这次结果了：连闸门都不必碰。**这一档必须在 `take` 之前**——被放弃的运行不该
    // 从这个 facility 的访问预算里扣一发，那是封号预算，花在一个没人看的答案上是纯亏。
    //
    // 反过来，**跑到一半才被取消的那次不退还令牌**：标签已经开了、站点已经被访问过，那一发是
    // 真花掉的。账要如实记，不然预算就成了一个会自己变多的数。
    if (signal?.aborted) {
      return { outcome: 'cancelled', items: [], trace: [], reason: 'superseded before start' }
    }
    // 退让闸门在最前面（比限流还前）：站点已经拦下我们时，连令牌都不必花——花了也是去挨一次拦。
    this.cooldown?.assertReady(facility)
    // 频率闸门其次：被限速时连标签都不该开。**不在重试循环里**——一次用户动作是一次
    // 访问，内部的陈旧标签重试不该再收一次费。
    // 第二道闸随 recipe 递进去：facility 那道之外，这条腿自己可能还声明了一道更严的
    // （写腿用，见 `RecipeMeta.rateLimit`）。**配置从 recipe 上读、不按 id 查表**——体里的
    // `sourceId` 是局部名，查一份装着全名的集合恒为空，那是静默失效（下面 builtinPackage
    // 那一格栽过同一个坑）。两道都过才放行，且同一次结算，不会半拉子扣。
    await this.rateLimit?.take(facility, { id: recipe.sourceId, limit: recipe.meta?.rateLimit })
    // 凭据注入在闸门之后、开标签之前：注入会抛（来源不对 / 没配值），那种失败不该先花掉一发
    // 访问预算，也不该开出一个标签来。
    const outcome = await this.attempts(recipe, this.withSecrets(recipe, params), signal)
    // 「被站点挡住」有两种具名形状，**冷却对两种一视同仁**：`needsLogin`（`loginCheck.wall` 命中）
    // 和 `challenged`（`loginCheck.challenge` 命中，风控挑战）。动作之后才被拦的那些，runner
    // 会在失败路径上补探一次，同样落到这两档之一。跑成了就清账——站点已经不生气了。
    //
    // **`challenged` 必须也进这里**：它正是"站方让我们等"的那一档，不退让就是接着去撞；
    // 而它对用户的说法与 needsLogin 相反（无需重登），两件事分开在别处、退让在这里合并。
    if (outcome.outcome === 'needsLogin') this.blockedBy(facility, outcome.reason ?? '撞上登录墙/拦截页')
    else if (outcome.outcome === 'challenged') this.blockedBy(facility, outcome.reason ?? '站方风控挑战')
    else if (outcome.outcome === 'ok') this.cooldown?.cleared(facility)
    return outcome
  }

  /**
   * 被拦下之后的两个动作，**必须一起做**：排空这个 facility 的小时预算（否则冷却一过就按原速
   * 接着撞），把"撞墙前这一小时发了几发"顺手交给冷却那侧记进台账。
   */
  private blockedBy(facility: string, because: string): void {
    const spentLastHour = this.rateLimit?.drainBudget?.(facility)
    this.cooldown?.blocked(facility, because, { spentLastHour })
  }

  /**
   * Which group tab to ride, per `recipe.adoptTab` (see its doc on the recipe type).
   * null = ride nothing, take the facility's own lane as usual — that is the answer when the
   * user gave a URL no group tab holds. Without a URL there is no lane to fall back to (the
   * lane would need one), so zero or several candidates are errors that name what was seen.
   */
  private async resolveRide(
    adopt: NonNullable<CanonicalBrowserRecipe['adoptTab']>,
    session: RecipeSessionSpec,
    params: Record<string, string>,
  ): Promise<{ tabId: number; url: string } | null> {
    // Only tabs the USER dragged into the group. Our own lane tabs are in the group too (origin
    // created/probe) and may well hold the same URL — but they are parked renders from a previous
    // run, exactly what riding must avoid; those fall through to the lane path, which reloads.
    // No origin = an extension that predates the field: unknown → not ridden.
    const tabs = (await this.sessions.listTabs(session)).filter(
      (t) => t.origin === 'adopted' && t.url.startsWith(adopt.urlPrefix),
    )
    const wanted = params[adopt.param]
    if (wanted) {
      const hit = tabs.find((t) => sameLocation(t.url, wanted))
      return hit ? { tabId: hit.tabId, url: wanted } : null
    }
    if (tabs.length === 1) return { tabId: tabs[0].tabId, url: tabs[0].url }
    if (tabs.length === 0) {
      throw new Error(`没给 ${adopt.param}，会话标签组里也没有开着的 ${adopt.urlPrefix} 页面——先把那个 tab 拖进组，或把地址传进来`)
    }
    throw new Error(
      `没给 ${adopt.param}，而会话标签组里有 ${tabs.length} 个 ${adopt.urlPrefix} 页面，不猜：${tabs.map((t) => t.url).join(' , ')}`,
    )
  }

  private async attempts(
    recipe: CanonicalBrowserRecipe,
    params: Record<string, string>,
    signal: AbortSignal | undefined,
  ): Promise<RecipeRunOutcome> {
    for (let attempt = 0; attempt < 2; attempt++) {
      // Driver + network observer come from the Transport (the ONE seam that folds every
      // browser-specific detail), so this canonical runner never names a browser.
      const transport = this.transportFor(recipe.session)
      /**
       * 新建 lane 落在**空白页**，不落 entryUrl —— 否则同一个页面要加载两遍。
       *
       * 两遍是这么来的：建标签时就导航到 entryUrl（第一遍），可那会儿 observer 还没挂上，
       * 这一遍发出去的 XHR 一条都收不到；于是 runner 只好再 `goto(entryUrl)` 一遍（第二遍），
       * 这次才有人听。**第一遍纯属浪费**，而且它正是 `capturesLoad` 必须强制重新导航的原因。
       * 用户看到的就是「搜一次，页面跳两次」。
       *
       * 落空白页之后，真正的导航只剩 runner 那一次，observer 全程在听。
       *
       * `rideCurrentPage` 的 recipe 例外：它不自己导航，标签停在哪就是它的工作上下文，落点
       * 有意义（冷启的 detail 骑不到搜索页时，entryUrl 就是它的兜底落点）。
       */
      const landing = recipe.rideCurrentPage ? substitute(recipe.entryUrl, params) : 'about:blank'
      let ride: { tabId: number; url: string } | null = null
      if (recipe.adoptTab) {
        try {
          ride = await this.resolveRide(recipe.adoptTab, recipe.session, params)
        } catch (error) {
          // 没有 tab 可骑也没有 url 可去：一步没跑，报清原因就退（不是站点拦我们，不进冷却）。
          return { outcome: 'blocked', items: [], trace: [], reason: error instanceof Error ? error.message : String(error) }
        }
        if (ride) params = { ...params, [recipe.adoptTab.param]: ride.url }
      }
      const lease = ride
        ? await this.sessions.adopt(recipe.session, ride.tabId)
        : await this.sessions.acquire(recipe.session, landing, recipe.entryWait)
      const raw = lease.rawPage
      try {
        // tabId is the ext tab id when present, else 1.
        //
        // 这里曾经有一句「前台档：动作之前先把标签放到前面」（外加跑完还焦点）。**已退役**：
        // 采集不抢屏幕，一次都不抢。把窗口提到最前只发生在用户显式要求时——那条路是
        // `RecipeSessionManager.focusFacilityTab`（点「带我去看登录页」），不在这条链路上。
        const driver = transport.driverFactory(raw)
        const relay = transport.relayFactory(raw)
        const tabId = (raw as { tabId?: number } | undefined)?.tabId ?? 1
        // 现取，不在装配期取：见构造参数 `interventions` 的头注。
        const repairRunner = this.interventions?.repairRunner()
        // graphFor 会抛：本地两层（包自带 ∪ 学到的）id 撞车、或转移指向不存在的状态。
        // 包升级之后与机器学到的层撞车是人要处理的事，不该让这个源从此每趟都被判 blocked——
        // 单独兜住，本趟退化成只用 runner 内置的全局图，采集继续跑。
        let stateGraph: StateGraph | undefined
        try {
          stateGraph = this.interventions?.graphFor(recipe.session.facility)
        } catch (error) {
          console.error(`[state] 本地状态图装配失败，本趟只用内置全局图：${error instanceof Error ? error.message : String(error)}`)
        }
        const result = await this.runner.run(recipe, params, driver, {
          relay, tabId, signal, onExtract: this.sinkFor(recipe),
          ...(lease.adopted ? { adoptedTab: true } : {}),
          ...(repairRunner ? { repairRunner } : {}),
          ...(stateGraph ? { stateGraph } : {}),
          ...(this.orderedFor ? { orderedFor: this.orderedFor } : {}),
          // 现取（同上）：账本住在介入域里，装配期取一次就是冻住的 undefined。
          ...(this.interventions?.onObserved ? { onObserved: (o: Observation) => this.interventions!.onObserved!(recipe.session.facility, o) } : {}),
        })
        if (result.outcome === 'blocked') lease.markBlocked(result.reason ?? 'recipe blocked')
        if (attempt === 0 && result.outcome === 'blocked' && staleTab(result.reason)) continue
        return result
      } catch (error) {
        // 环境没就绪（中继没连 = 命令根本没发出去）：**不 markBlocked**。markBlocked 会把 lane 关掉，
        // 而 lane 不是问题所在；更要紧的是别把它当成对源的判断（见 EnvironmentUnavailableError）。
        if (isEnvironmentUnavailable(error)) {
          return { outcome: 'unavailable', items: [], trace: [], reason: (error as Error).message }
        }
        lease.markBlocked(error instanceof Error ? error.message : String(error))
        if (attempt === 0 && staleTab(error)) continue
        return { outcome: 'blocked', items: [], trace: [], reason: error instanceof Error ? error.message : String(error) }
      } finally {
        await lease.release()
      }
    }
    return { outcome: 'blocked', items: [], trace: [], reason: 'stale tab retry exhausted' }
  }
}
