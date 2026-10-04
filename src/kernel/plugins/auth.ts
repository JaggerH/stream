import type { Context } from 'cordis'
import { join } from 'node:path'
import type { DebugEntry } from '../../debug.ts'
import { CookiePuller } from '../../credentials/cookie-puller.ts'
import { makeFileRecipeStore, makeRecipePackageStore } from '../../replay/recipe-store.ts'
import { acquireFacilityLock } from '../../replay/author/facility-lock.ts'
import { isSessionAuth } from '../../manifest/types.ts'
import {
  facilityAuthView,
  buildAuthFacilities,
  authInputs,
  type FacilityAuthInput,
  type FacilityAuthNeed,
} from '../../auth/facility-auth-view.ts'
import { reconcileAuth } from '../../auth/auth-reconciler.ts'
import { sessionPrecheck } from '../../auth/session-precheck.ts'
import { AuthNeededNotifier } from '../../auth/auth-needed-notifier.ts'
import { LoginProviderRegistry, type LoginEvent } from '../../auth/login-provider.ts'
import { BrowserQrLoginProvider } from '../../auth/browser-qr-login-provider.ts'
import { BrowserOAuthLoginProvider } from '../../auth/browser-oauth-login-provider.ts'
import { makeTransportLoginPage } from '../../auth/transport-login-page.ts'
import type { LoginCheck } from '../../replay/recipe.ts'
import { loginToFacility } from '../../credentials/facility-login.ts'
import type { SessionAuthSpec, SourceManifest } from '../../manifest/types.ts'
import type { RuntimeConfigResolver } from './runtime-config.ts'

declare module 'cordis' {
  interface Context {
    /** 授权健康这一域（`src/kernel/plugins/auth.ts`）：横幅 / 对账 / 重登 / cookie 取数。 */
    auth: AuthService
  }
}

/**
 * 登录态快照多旧就该去浏览器再取一份。
 *
 * 5 分钟：比"一轮采集"短得多（所以每轮之前基本都会去取一次新的），又长到足以让一次批量采集里
 * 的几十条流共用同一份，不会每条都往浏览器打一趟。**采集前那一发**（时机 ②）在调度侧接线，
 * 所以这个数字导出给它用——两处各写一个 5 分钟就是两份会漂移的判据。
 */
export const COOKIE_SNAPSHOT_MAX_AGE_MS = 5 * 60_000

/**
 * login:oauth 的 `account` 现取——抽成具名函数是为了能脱离整棵 kernel 单测：装配期误求值这类
 * 缺陷（把某个答案写进一个装配时创建的对象字段）只有"调两次、中间改一次配置、看第二次有没有
 * 跟上"才能测出来，钉在 `startLogin` 内联闭包里就只能靠拉起一整棵 kernel、真跑一次登录才能测。
 *
 * `account` 不来自 manifest（那是随包分发的，写死某个用户的邮箱是荒谬的），而来自用户在设置页
 * 填的 runtime_config——且必须在**每次真正发起登录时**现取，不能在装配 provider 那一刻求值：
 * 用户是在装配之后才去填这个字段的，装配期读一次存进去，拿到的永远是那一刻的空值，而且不报
 * 错、不降级，表现只是"自动选账号不存在"。`runtimeConfig(manifest)` 本身就是「调用时现查」的
 * 解析器（见 runtime-config.ts），调用方（`startLogin`）必须在每次调它时才调用本函数，绝不能
 * 缓存它的返回值。
 */
export function resolveLoginAuthSpec(
  manifest: SourceManifest,
  auth: SessionAuthSpec,
  runtimeConfig: RuntimeConfigResolver,
): SessionAuthSpec {
  if (auth.login !== 'oauth') return auth
  return { ...auth, account: runtimeConfig(manifest).googleAccount as string | undefined }
}

export interface AuthService {
  /** 此刻哪些 facility 挂着登录墙（`GET /api/auth/facilities`）。 */
  authFacilities: () => FacilityAuthNeed[]
  /** 登录横幅对账：不跑采集，只用便宜的活证据核对一次。 */
  reconcileAuthNow: () => Promise<void>
  /** 跑某个 facility 申报的登录 provider；事件由调用方桥到 WS。 */
  startLogin: (facility: string, emit: (e: LoginEvent) => void) => Promise<void>
  /** 登录态的取数方（后端去用户的 Chrome 里取）。调度侧在 beforeTick 上调它的 ensureFresh。 */
  cookiePuller: CookiePuller
  /**
   * 把「现在谁挂着登录墙」重新算一遍并推出去。
   *
   * **对外只给这一个动作，不给 `AuthNeededNotifier` 本体**：两个消费点（对账 onChanged、
   * 一轮采集跑完 onOutcome）要的都是同一句 `notifier.sync(facilityAuthView(snapshot()))`，
   * 把三件事拼对是本域的职责，不该复制到每个调用点去。
   */
  syncAuthBanner: () => void
}

export interface AuthConfig {
  /** 可写状态根目录；重登的 per-facility 锁文件住 `<dataDir>/locks`。 */
  dataDir: string
  log: (...args: unknown[]) => void
  onDebug?: (entry: DebugEntry) => void
  /** 往所有连着的前端推一帧（`auth-needed` 原样保留，AuthPanel 依赖它）。 */
  broadcast?: (msg: unknown) => void
  /** 这台 Stream 需要同步哪些 cookie 域。thunk：它从 registry + 已订阅流推出来。 */
  requiredCookieDomains: () => string[]
}

/**
 * 授权健康这一域：**「这个站现在还认得我吗」以及认不出来时怎么办**。
 *
 * 不存任何登录态（spec I2）——横幅是一层**活投影**：逐源健康账本按 facility 归堆算出来的。
 * 判据分三档，由 `auth-reconciler` 排序：lane 活着就问页面本身（登录墙在不在，它说了算）、
 * 没有 lane 就退到 cookie 名字的便宜证据、都问不出来就是 UNKNOWN——**UNKNOWN 绝不当成
 * 「没登录」**，那会把一次停电写成一次登出。
 *
 * 整域建在 harvest 域的产物上（`extRelay` / `recipeSessions` / `transport`），所以 inject 它。
 *
 * 三个触发点都骑同一个 `reconcileAuthNow`：扩展连上时（用户可能在 Stream 关着的时候登录了）、
 * 每分钟一次（调度中心的定时任务——用户开着 Stream 在别的标签里登录了，这条才是"无感"）、
 * 打开重登面板时（已经登录就别再弹二维码）。三处都只在**确实有横幅挂着**时才发远程调用。
 *
 * 没有 `ctx.effect()`：本域不持句柄也不起定时器。`extRelay.onConnected` / `onCookiesChanged`
 * 上挂的三个监听器是随中继一生一世的注册，中继本身归 harvest 域管。
 */
export const authPlugin = {
  name: 'auth',
  inject: ['settings', 'sources', 'stores', 'credentials', 'harvest', 'streamEvents', 'packages', 'runtimeConfig'],
  apply(ctx: Context, config: AuthConfig): void {
    const { log } = config
    const { registry, liveRecipes, recipesBuiltinDir } = ctx.sources
    const { sourceHealth } = ctx.stores
    const { extRelay, recipeSessions, transport } = ctx.harvest
    const events = ctx.streamEvents
    const runtimeConfig = ctx.runtimeConfig

    // No stored login state (spec I2): a live projection over source health, grouped by facility.
    const authRecipes = makeRecipePackageStore(() => liveRecipes.current, makeFileRecipeStore(recipesBuiltinDir))
    const authSnapshot = (): FacilityAuthInput[] =>
      authInputs(registry.all(), (key) => sourceHealth.get(key))
    /**
     * 一个 facility 的登录判据（recipe 声明的两个选择器）。给不出就返回 undefined —— 调用方据此
     * 退到别的证据，而不是拿一个"永远不命中"的假判据去问，那会把"问不出来"伪装成"没登录"。
     *
     * 桌面 recipe 的 loginCheck 装的是 a11y 查询不是 CSS 选择器，对浏览器这条路没有意义，所以
     * 两个字段都必须是字符串才算数。
     *
     * **惰性**：每次调用现查 registry + 现读 recipe，所以热重载后的 recipe 立刻生效。
     */
    const loginCheckFor = (facility: string): LoginCheck | undefined => {
      const manifest = registry.all().find((m) => m.facility?.key === facility && isSessionAuth(m.auth))
      if (!manifest) return undefined
      const recipe = authRecipes.load(manifest.id)
      const declared = 'loginCheck' in recipe ? recipe.loginCheck : undefined
      return declared && typeof declared.loggedIn === 'string' && typeof declared.wall === 'string'
        ? (declared as LoginCheck)
        : undefined
    }

    const authNotifier = new AuthNeededNotifier((msg) => {
      config.broadcast?.(msg) // 原 auth-needed frame 原样保留（AuthPanel 依赖它）
      const m = msg as { type?: string; facility?: string; need?: { label?: string; lastReason?: string } }
      if (m.type === 'auth-needed' && m.facility) {
        events.emit({
          type: 'auth.needed', severity: 'warn',
          title: `${m.need?.label ?? m.facility} 登录失效`,
          body: m.need?.lastReason,
          ref: { kind: 'facility', id: m.facility },
          dedupeKey: `auth:${m.facility}`,
        })
      }
    })
    const syncAuthBanner = () => authNotifier.sync(facilityAuthView(authSnapshot()))

    /**
     * 「需要登录」横幅的**对账**：不跑采集，只用便宜的活证据核对一次（见 reconcileAuth）。
     *
     * 补的是一个真实缺口：横幅原来只在 `onOutcome`（一次采集跑完）时更新。定时采集的源靠下一轮
     * tick 自己翻；**只有搜索才跑的源没有任何东西会自己跑**——用户在浏览器里登录回来了，Stream
     * 一直挂着旧结论，非得先搜一次才发现横幅是陈的。
     */
    const reconcileAuthNow = async (): Promise<void> => {
      const needs = facilityAuthView(authSnapshot())
      await reconcileAuth({
        needs: () =>
          needs.map((n) => ({
            facility: n.facility,
            // 一个 facility 名下所有 session 源共用一份登录态，撤标记就得一起撤 —— 只撤一个，
            // 另一个源的陈旧 auth 失败会把横幅立刻又点亮。
            sourceIds: registry.all()
              .filter((m) => (m.facility?.key ?? '') === n.facility && isSessionAuth(m.auth))
              .map((m) => m.id),
          })),
        // lane 活着就用真判据（那个页面上有没有登录墙，它说了算）；没有 lane 就返回 undefined。
        liveVerdict: async (facility: string) => {
          const check = loginCheckFor(facility)
          if (!check) return undefined
          return recipeSessions.loginStateOf(facility, check)
        },
        cookieEvidence: async (facility: string) => {
          const m = registry.all().find((s) => (s.facility?.key ?? '') === facility && isSessionAuth(s.auth))
          return m?.auth ? sessionPrecheck(m.auth, (d: string) => extRelay.cookieNames(d)) : ('UNKNOWN' as const)
        },
        clear: (sourceId: string) => sourceHealth.clearAuthFailure(sourceId),
        onChanged: syncAuthBanner,
      })
    }

    // 触发 ①：扩展一连上就对一次账 —— 覆盖「用户在 Stream 关着 / 后端重启期间登录了」。
    // 挂在这一域而不是 relay 内部：relay 只管管道，不该知道 auth 是什么。
    extRelay.onConnected?.(() => { void reconcileAuthNow().catch(() => {}) })

    // 登录态的取数方：后端在中继上向用户的 Chrome 要，整份写回快照。
    const cookiePuller = new CookiePuller({
      relay: extRelay,
      store: ctx.credentials.pushedCookies,
      requiredDomains: config.requiredCookieDomains,
      log,
      // 这条链路的失败全长一个样（取不到 cookie → 采集变游客态），而 log 只在 stdout 上。
      // 发进 debug bus，"上一次取成功没有"就成了一个 curl 能回答的问题。
      report: config.onDebug,
    })
    /**
     * 把「登录态掉了自己登回来」这条能力回填给包那一层（`ctx.login`）。
     *
     * **为什么接在 auth 而不是 packages 自己：** packages 域在装载序上排在 `sources` /
     * `harvest` **前面**（`sources` 自己 `inject: ['packages']`），它 inject 回去就是环，
     * Cordis 当场拒。而本域本来就 owns facility 的登录态（重登面板、授权健康、loginCheck、
     * 以及下面那个 cookiePuller 都在这儿），是这条线天然的归属。
     *
     * 回填而不是快照：包拿到的 `ctx.login` 读的是 packages 域里那个变量，这一句执行完就立刻
     * 生效，不存在"某些包拿到的是回填之前那份 undefined"。
     *
     * **位置有讲究**：必须排在 `cookiePuller` 之后——登完要靠它去浏览器把新 cookie 取回来。
     */
    ctx.packages.setFacilityLogin((facility) =>
      loginToFacility(
        {
          // 都现取：recipe 表会因为热重载/装卸包变化，执行器与 cookieProvider 也可能被
          // reconfigure 换掉（见 AGENTS.md「装配期取的值 = 冻住的答案」）。
          recipes: () => ctx.sources.liveRecipes.current,
          run: (recipe, params) => ctx.harvest.sessionRecipes.execute(recipe, params),
          // 两层缺一不可，各自都真栽过（见 loginToFacility 头注第 2 条）：
          // `pull` 去**浏览器**要一份新的（登录 recipe 刚跑完时，新 cookie 还只在浏览器里，
          // 本地快照要等扩展推过来），`refresh` 再把 provider 那 60 秒 TTL 缓存顶掉。
          adoptCookies: async () => {
            await cookiePuller.pull('facility-login')
            await ctx.credentials.cookieProvider.refresh()
          },
        },
        facility,
      ),
    )

    // 时机 ①：中继一连上。Chrome 刚起来，快照是全场最旧的那一刻。
    extRelay.onConnected?.(() => {
      void cookiePuller.pull('relay-connected').catch(() => {})
    })
    // 时机 ③：扩展报「同步域里的 cookie 变了」。这条是 quark __puus 那类轮换后秒级自愈的信号，
    // 也是周期闹钟撤掉之后仍然不会落后的原因。
    extRelay.onCookiesChanged?.(() => {
      void cookiePuller.pull('cookies-changed').catch(() => {})
    })
    // 时机 ②（动手采集前，快照太旧就补一轮）挂在 scheduler 的 beforeTick 上（调度侧接线）。
    //
    // **绝不挂在 `cookieString()` 上**，哪怕那样接线更少：那是热路径（媒体代理每个字节请求都过
    // 它），一次 relay 往返最坏能等到 30 秒超时，等的是用户的播放请求。而且"本地查得到"不等于
    // "这份还有效"——过期 cookie 一样查得到，按 miss 触发的话最该刷新的那一刻恰恰永不刷新。

    // Serializes the re-login flow per facility (two concurrent logins on one site fight over the
    // same tab). Just lockfiles — Stream owns no browser profile any more.
    const locksRoot = join(config.dataDir, 'locks')
    const loginProviders = new LoginProviderRegistry()
    loginProviders.register(new BrowserQrLoginProvider({
      // Log in ON the facility's registry lane — the SAME tab the harvest rides, so the session
      // the user just established is the session the next harvest uses. Releasing (not closing)
      // after login keeps that tab in place. No onBefore closeFacility: login serializes behind
      // any running harvest via the lane's tail instead of tearing it down.
      //
      // Everything here goes through the lane's Transport rather than Playwright: the tab is one
      // of the user's own Chrome tabs driven over the extension relay, and `rawPage` is that
      // relay's handle, not a Playwright Page.
      browser: {
        // purpose:'login' —— 它会占着这条 lane 直到用户扫完（分钟级）。声明出来，采集撞上时
        // 才能当场返回"需要登录"，而不是排队排到成员超时（用户的要求：没登录不该阻塞搜索）。
        openProfile: async (facility) => makeTransportLoginPage(transport, await recipeSessions.acquire(
          { facility, lifecycle: 'persistent', visibility: 'unattended' }, 'about:blank', 'commit', 'login',
        )),
      },
      lock: { acquire: (facility) => acquireFacilityLock(locksRoot, facility) },
    }))
    // login:oauth —— 骑用户 Chrome 里已有的第三方登录态（今天只有 Google）。装配形状与上面
    // qr 那支完全一样：同一条 lane、同一个 Transport-backed LoginPage（`makeTransportLoginPage`
    // 现在返回的是 OAuthLoginPage，qr/oauth 共用同一个实现，click/bringToFront 只有 oauth 用）。
    loginProviders.register(new BrowserOAuthLoginProvider({
      browser: {
        openProfile: async (facility) => makeTransportLoginPage(transport, await recipeSessions.acquire(
          { facility, lifecycle: 'persistent', visibility: 'unattended' }, 'about:blank', 'commit', 'login',
        )),
      },
      lock: { acquire: (facility) => acquireFacilityLock(locksRoot, facility) },
    }))

    // Resolve a facility's declared session source + provider, then run the login challenge.
    // The panel clears via the frontend's optimistic drop on `login-success` + the next real
    // harvest overwriting the health signal (a forced re-harvest awaits the sibling transport spec).
    const startLogin = async (facility: string, emit: (e: LoginEvent) => void): Promise<void> => {
      const manifest = registry.all().find((m) => m.facility?.key === facility && isSessionAuth(m.auth))
      if (!manifest || !isSessionAuth(manifest.auth)) { emit({ kind: 'failed', facility, reason: `no session source for facility ${facility}` }); return }
      const provider = loginProviders.get(manifest.auth.login)
      if (!provider) { emit({ kind: 'failed', facility, reason: `no login provider for method ${manifest.auth.login}` }); return }
      // 判据由 loginCheckFor 统一给（对账那条路也用它，两边必须同源）。给不出就退到一个
      // 永远不命中的检查，而不是 ''（那作为选择器会抛）。
      const loginCheck: LoginCheck =
        loginCheckFor(facility) ?? { loggedIn: 'html.__never__', wall: 'html.__never__' }
      // 这条流程**难复现**（xhs 的二次验证不是每次都来），没有痕迹下次就只能靠猜。把关键节点
      // 打进 debug bus，事后能翻账本，而不是让用户再撞一遍。
      const onTrace = (line: string) => {
        const at = Date.now()
        config.onDebug?.({
          id: `auth:${facility}@${at}`,
          at,
          channel: 'auth',
          key: facility,
          title: `${facility} 登录`,
          summary: line,
          ok: true,
          fields: [],
        })
        log(`[auth] ${facility}: ${line}`)
      }
      // 见 resolveLoginAuthSpec 头注：account 必须在这里、每次真正发起登录时现取。
      const authSpec = resolveLoginAuthSpec(manifest, manifest.auth, runtimeConfig)
      await provider.begin(authSpec, { loginCheck, onTrace }, emit, new AbortController().signal)
    }

    ctx.provide('auth', {
      authFacilities: buildAuthFacilities(authSnapshot),
      reconcileAuthNow,
      startLogin,
      cookiePuller,
      syncAuthBanner,
    } satisfies AuthService)
  },
}
