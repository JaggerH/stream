import type { Context } from 'cordis'
import { join } from 'node:path'
import type { DebugEntry } from '../../debug.ts'
import type { Adapter } from '../../adapters/types.ts'
import { BuiltinAdapter } from '../../adapters/builtin/adapter.ts'
import { RssHubAdapter } from '../../rsshub-adapter.ts'
import { BrowserAdapter } from '../../../packages/browser/adapter.ts'
import { ReplayAdapter, sessionOutcomeToItems, facilityOf } from '../../adapters/replay/adapter.ts'
import { makeFileRecipeStore, makeRecipePackageStore } from '../../replay/recipe-store.ts'
import { ledgerIdsFrom } from '../../replay/feed-ledger.ts'
import { isCanonicalBrowserRecipe } from '../../replay/recipe.ts'
import { RepairLedger } from '../../replay/repair-ledger.ts'
import { forwardingRepairRunner, LoggingRepairRunner } from '../../replay/repair-runner.ts'
// 只为让 `ctx.intervention` 的模块声明可见——`adapters` 的 inject **不加** `intervention`
// （它是可选的后到者，这里只在调用时现取，缺席就落 fallback）。
import type { InterventionService } from './intervention.ts'
import type { RuntimeConfigResolver } from './runtime-config.ts'

declare module 'cordis' {
  interface Context {
    /**
     * 「一个 source 的 `adapter` 字段指的是谁」的唯一查表（`src/kernel/plugins/adapters.ts`）。
     *
     * **直接就是那张 Map**，不是聚合对象：它在 `Boot` 上本来就是一个 `Map<string, Adapter>`，
     * 消费方（Scheduler / ResolveEngine / HttpDeps 的写动作路由）拿的是同一个签名——搬家不改形状。
     */
    adapters: Map<string, Adapter>
    /** 修复账本（隔离 / 连累名单）。**只读消费**：写它的只有 ReplayAdapter 那条采集路。 */
    repairLedger: RepairLedger
  }
}

export interface AdaptersConfig {
  /** 可写状态根目录（修复账本落在它下面）。 */
  dataDir: string
  log: (...args: unknown[]) => void
  /**
   * 「这个 source 跑起来时该拿到哪份配置」——`BuiltinAdapter` 唯一的构造参数。
   *
   * 由 bootstrap 传进来而不是从 `ctx.runtimeConfig` 取：四个消费点（这里 / Scheduler /
   * ResolveEngine / 分集索引）今天共用 bootstrap 里那**同一个**闭包实例，从内核另取一份
   * 等于把"同一份判据"悄悄变成两份。等四处都能从内核取时再收口。
   */
  runtimeConfigFor: RuntimeConfigResolver
  /** debug bus 的入口——`replay` adapter 的 kind:'desktop' 分支用它记桌面会话租约排队超时
   *  （channel `host-agent`，见 `adapter.ts` runDesktop 的头注 I2）。 */
  onDebug?: (entry: DebugEntry) => void
  /**
   * 介入域的现取口（bootstrap 递 `() => kernel.intervention`）。**经 config 传、不走 inject、
   * 也不能在这里读 `ctx.intervention`**：Cordis 不允许绕过 inject 惰性取服务（活体 2026-09-11
   * 一次采集当场 `cannot get property "intervention" without inject`），而 inject 一个比本域晚挂
   * 的域会让本域等它。缺席 / 还没挂 → undefined，转发 runner 落回日志那一档。
   */
  intervention?: () => InterventionService | undefined
}

/**
 * adapter 装配这一域：**四个宿主 adapter 手织，再把带 code 槽位的包自己交出来的那些汇进来。**
 *
 * 一张 Map 就是全部产物。四格宿主件各自代表一条取数通道：
 *  - `builtin` —— 进程内实现（`register()` 逐个挂，注册发生在 provider 域，那里才有那些依赖）；
 *  - `rsshub` —— 内嵌 RSSHub 路由；
 *  - `browser` —— 通用兜底：把一个公开 URL 在**用户自己的 Chrome** 里渲染出来读回正文；
 *  - `replay` —— recipe 那条线（canonical browser recipe + legacy fetch/browser recipe）。
 *
 * 依赖全部经 inject 从内核取，没有一格是 bootstrap 现造的对象：
 *  - `ctx.harvest` —— 运输面（`ensureHarvestBrowser` / `transport` / `extLauncher` /
 *    `desktopDriver` / `sessionRecipes` / `feedLedger` / `extRelay.cookieNames`）。
 *    **本域整个建在它上面**，所以装载序天然是 harvest → adapters。
 *  - `ctx.sources` —— recipe 的分层查找（包内 builtin+user 覆盖，miss 落回平铺目录）。
 *    `liveRecipes.current` **调用时才解**：装配期解开就等于冻结在启动那一刻，热装的 recipe 包
 *    永远查不到，而且不报错。
 *  - `ctx.packages` —— 包自己 `activate()` 交出来的 adapter（撞名已在 activatePackages 的
 *    只读检查里拒过，上面手织的四个宿主件不与它们同名）。
 *  - `ctx.credentials` —— legacy fetch recipe 的 `cookieDomain` 要的那个 Cookie 头。
 *
 * 没有 `ctx.effect()`：这一域里没有一格持句柄或定时器（`RepairLedger` 是逐次读写的 JSON 文件，
 * adapter 自身的关停由 `Scheduler.shutdownAdapters()` 负责——scheduler 进内核是批次 8 的事）。
 */
export const adaptersPlugin = {
  name: 'adapters',
  inject: ['sources', 'packages', 'harvest', 'credentials'],
  apply(ctx: Context, config: AdaptersConfig): void {
    const { dataDir, log } = config
    const { liveRecipes, recipesBuiltinDir } = ctx.sources
    const {
      extRelay, extLauncher, transport, desktopDriver, makeSee, recipeOverrides, sessionRecipes, feedLedger,
      ensureHarvestBrowser,
    } = ctx.harvest
    const cookieProvider = ctx.credentials.cookieProvider

    const repairLedger = new RepairLedger(join(dataDir, 'repair-ledger.json'))

    const adapters = new Map<string, Adapter>([
      ['builtin', new BuiltinAdapter(config.runtimeConfigFor)],
      // dataDir 是 RSSHub 的落点：发行安装不带 RSSHub，第一次跑到这类源时由 adapter 现装
      // 到 `<dataDir>/rsshub/`（`src/rsshub-install.ts` 写着为什么不能当 npm 依赖装）。
      ['rsshub', new RssHubAdapter({
        resolveDeps: { dataDir },
        log,
        // 长尾目录只在一次真的取数之后顺手刷（那时 worker 已经热着）——单独为它拉起 worker
        // 是 +168MB RSS 且不会自己退。理由全在 src/rsshub-catalog-cache.ts 的头注。
        catalog: {
          needsRefresh: () => ctx.sources.rsshubCatalogNeedsRefresh(),
          apply: (raw) => ctx.sources.applyRsshubCatalog(raw),
        },
      })],
      // 通用兜底档：把一个公开 URL 渲染出来。渲染发生在用户自己的 Chrome 里（和采集同一个浏览器、
      // 同一条中继）——不另起浏览器，所以也得先确认它在。开的是后台标签，读完即关。
      ['browser', new BrowserAdapter({
        render: async (url) => {
          await ensureHarvestBrowser()
          const tab = await transport.launcher.launch(url, 'domcontentloaded')
          try {
            const read = async (expr: string) => String((await transport.evaluate(tab.rawPage, expr)) ?? '')
            return {
              url,
              title: await read('document.title'),
              text: await read('document.body ? document.body.innerText : ""'),
              html: await read('document.documentElement.outerHTML'),
            }
          } finally {
            await tab.close()
          }
        },
      })],
      ['replay', new ReplayAdapter({
        // 分层查找:包内 recipe(builtin+user, user 覆盖)优先,miss 落回 legacy 平铺 <sourceId>.json。
        recipes: makeRecipePackageStore(() => liveRecipes.current, makeFileRecipeStore(recipesBuiltinDir)),
        // legacy(fetch/browser) recipe 的采集前置：canonical recipe 在 sessionFetch 里已经调过
        // ensureHarvestBrowser，这条路是它的对偶——两条路都得确认浏览器在，否则 Chrome 关着时
        // xueqiu 这类 fetch recipe 只会白白跳过整轮，而不会去唤起它。
        ensureTransport: () => ensureHarvestBrowser(),
        // 只有一个浏览器了：用户自己的 Chrome，经扩展中继。
        makeLauncher: () => extLauncher,
        // host-desktop Engine: a DesktopDriver over the /api/host relay when Stream Desktop is
        // connected; undefined otherwise → a kind:'desktop' source declines as a miss.
        desktopDriver,
        // 识别层（`see` 的四段梯子）。**唯一构造点在 harvest 域**——这里只是把工厂递过去，
        // adapter 自己在开跑那一刻按 recipe 的 sourceId 建一个。
        makeSee,
        // 本机学到的落地方式。**唯一构造点同样在 harvest 域**——这条路（采集）和
        // run_action_recipe 那条路读写的必须是同一份存储。
        recipeOverrides,
        // 登录态快照 → 这个域的 `name=value; …` Cookie 头，给 recipe 里显式要 cookie 的地方用
        // （legacy fetch recipe 的 cookieDomain）。按引用持有，设置热更能传导。
        cookieFor: (domain) => cookieProvider.cookieString(domain).then((s) => s ?? undefined),
        // login detect 的便宜那一半：直接问用户 Chrome 这个域现在有哪些 cookie **名字**（不取值，
        // 值走 broker）。会话 cookie 一个都不在 ⇒ 一定没登录，不开 tab 就 decline。
        // 中继没连时这里会抛，sessionPrecheck 把它当"不知道"处理——不会把停电误判成登出。
        cookieNames: (domain) => extRelay.cookieNames(domain),
        ledger: repairLedger,
        // 漂移那一刻问一次「这个源坏了会连累谁」，答案随记录一起落账。**调用时才解**：
        // `uses` 随 recipe 包热装卸变，装配期取一次就是冻在启动那一刻的答案，而且少算了不报错。
        affectedSources: (sourceId) => ctx.sources.registry.affectedSources(sourceId).affected,
        // **调用时才解**：介入域（`intervention.ts`）比这个域晚装配，装配期取一次就是冻住的
        // undefined，症状是「介入从来没发生过」且没有一处会喊。缺席 → 落到只记日志的那份。
        repairRunner: forwardingRepairRunner(() => config.intervention?.()?.repairRunner, new LoggingRepairRunner(log)),
        onDebug: config.onDebug,
        // outcome → items | typed error (NeedsLoginError / ReplayDriftError / RecipeBlockedError),
        // so session recipes surface the same health/ledger classification as the legacy runner.
        sessionFetch: async (recipe, params, manifest, signal) => {
          if (!isCanonicalBrowserRecipe(recipe)) return undefined
          await ensureHarvestBrowser()
          const outcome = await sessionRecipes.execute(recipe, params, signal)
          const items = sessionOutcomeToItems(outcome, manifest.id, ...facilityOf(manifest))
          // 记账：**声明了 `ledger` 的 recipe** 跑完，它铺在这条 lane 上的这一批就是新账本（整本
          // 替换）。挂在这里而不是在某个调用点，是因为这里是每一次 canonical browser recipe 运行
          // 的唯一必经处——不管这次是 HTTP 搜索、MCP、还是定时采集触发的，账本都跟着页面走。
          const ids = ledgerIdsFrom(recipe, items as Array<Record<string, unknown>>)
          if (ids) feedLedger.record(recipe.session.facility, ids, recipe.session.laneKey)
          return items
        },
      })],
    ])
    // 带 code 槽位的包自己交出来的 adapter（撞名已在 activatePackages 的只读检查里拒过，
    // 上面手工织的这几个宿主件不与它们同名）。
    for (const [name, adapter] of ctx.packages.activated.adapters) adapters.set(name, adapter)

    ctx.provide('adapters', adapters)
    ctx.provide('repairLedger', repairLedger)
  },
}
