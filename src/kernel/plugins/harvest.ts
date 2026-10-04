import type { Context } from 'cordis'
import { join } from 'node:path'
import Schema from 'schemastery'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { AppConfig } from '../../types.ts'
// 只为把 `ctx.intervention` 的声明合并进来——那个域自己装配得更晚，这里不 inject 它。
import type { InterventionService } from './intervention.ts'
import type { DebugEntry } from '../../debug.ts'
import type { EventInput } from '../../events/store.ts'
import { ExtRelay, ExtRelayDisconnected } from '../../http/ext-relay.ts'
import { WsHostRelay, INTERACTIVE_SESSION_WAIT_MS } from '../../http/host-relay.ts'
import { BrowserCapabilityStore } from '../../browser/capability-store.ts'
import { discoverChromeCandidates, nodeDiscoverFs } from '../../browser/discover-chrome.ts'
import { harvestBrowserStatus, type HarvestBrowserStatus } from '../../browser/harvest-browser.ts'
import { makeExtensionLauncher } from '../../replay/browser-ext.ts'
import { callPluginService } from '../../replay/call-service.ts'
import { makeDesktopDriver, type DesktopDriver } from '../../replay/desktop-driver.ts'
import { makeSeeResolver, type SeeResolver } from '../../replay/desktop-see.ts'
import { RecipeOverrideStore } from '../../replay/desktop-override-store.ts'
import type { LlmForTask } from '../../llm/task.ts'
import { ensureAppDebugEntry } from '../../replay/ensure-app-debug.ts'
import { resolveTransport, type Transport } from '../../replay/transport.ts'
import { RecipeSessionManager } from '../../replay/session-manager.ts'
import { SessionRecipeExecutor } from '../../replay/session-recipe-executor.ts'
import { RecipeRunner } from '../../replay/recipe-runner.ts'
import { RunProbe, recipeProbeEnabled } from '../../replay/recipe-probe.ts'
import { FeedLedger } from '../../replay/feed-ledger.ts'
import { FacilityRateLimiter } from '../../replay/facility-rate-limit.ts'
import { FacilityCooldown } from '../../replay/facility-cooldown.ts'
import { BlockEpisodeLog } from '../../replay/block-episodes.ts'
import type { RecipeSessionSpec } from '../../replay/recipe.ts'
import type { ActResult, ActionSpec } from '../../replay/interactive-gate.ts'
import { normalize, type RawItem } from '../../content/normalize.ts'

declare module 'cordis' {
  interface Context {
    /** 采集运输面这一域（`src/kernel/plugins/harvest.ts`）——一个聚合对象，不是十几个 ctx key。 */
    harvest: HarvestService
  }
}

/**
 * 「像人一样在用户自己的 Chrome 里浏览」这条链路的全部零件。**字段名与它们在 `Boot` 上的
 * 旧名字一字不差**——搬家不改名。
 */
export interface HarvestService {
  /** extension CDP transport 中继单例；serve.ts 用 attachExtRelay 把它挂到 `/api/ext`。 */
  extRelay: ExtRelay
  /** host-desktop Engine 中继单例；serve.ts 用 attachHostRelay 把它挂到 `/api/host`。 */
  hostRelay: WsHostRelay
  /** 「这台机器装过 Chrome + 扩展吗」的落盘缓存。 */
  browserCapability: BrowserCapabilityStore
  /** 「采集用哪个 Chrome」：列候选 / 选一个。 */
  harvestBrowser: {
    status(): Promise<HarvestBrowserStatus>
    select(exe: string): Promise<HarvestBrowserStatus>
  }
  /** ext-cdp ReplayLauncher over that relay — `launch(url).rawPage.evalExpr` 供临时求值。 */
  extLauncher: ReturnType<typeof makeExtensionLauncher>
  /** 原生窗口驱动。**没连 Stream Desktop 时返回 undefined**——调用方据此报「桌面这一档不可用」，
   *  而不是静默降级。**每次调用现判 `hostRelay.connected`**，不是启动那一刻的快照。 */
  desktopDriver: () => DesktopDriver | undefined
  /**
   * 桌面 recipe 的识别层工厂——**一趟 recipe 一个实例**（`modelCalls` 的预算归一趟，见
   * `SeeResolver`）。模板缓存落在 `<dataDir>/desktop-see/<sourceId>/`，model 段走 LLM 网关。
   *
   * 是工厂不是实例：两个调用方（采集的 `ReplayAdapter` 与 `run_action_recipe`）各自在开跑
   * 那一刻用**这条 recipe 自己的 sourceId** 建一个。绑错 sourceId = 两条 recipe 共用一份模板
   * 缓存，表现是每一步都"命中"、只是点在别的应用的坐标上——这条路上最贵的错。
   */
  makeSee: (driver: DesktopDriver, sourceId: string) => SeeResolver
  /**
   * 本机学到的落地方式（`<dataDir>/recipe-overrides/<sourceId>.json`）——**唯一构造点**，
   * 和上面那个识别层工厂同一条理由：两个 runner 调用点（采集的 `ReplayAdapter` 与
   * `run_action_recipe`）必须读写同一份存储。各建一份的表现是「这条路学到的，另一条路看不见」，
   * 而两条路每一步照样"成功"——没有任何一处会喊。
   */
  recipeOverrides: RecipeOverrideStore
  /** 唯一的运输面：用户自己那个可见的 Chrome，经扩展中继。 */
  transport: Transport
  /** lane（= 一个 facility 名下的标签）的生命周期管理器。 */
  recipeSessions: RecipeSessionManager
  /** 每条 lane 的有序账本（detail 的 locate 拿它当坐标系）。 */
  feedLedger: FeedLedger
  /** canonical browser recipe 的执行器（限速 + 退让 + 探针 + 抽取落盘都在它身上）。 */
  sessionRecipes: SessionRecipeExecutor
  /** 采集前的环境前置：用户的 Chrome 得连着中继。**每一轮都要确认**。 */
  ensureHarvestBrowser: () => Promise<void>
  /** 看/动 recipe 正骑着的那个活 tab：求值 / 截图 / 动手。 */
  pageLook: (facility: string, expression: string) => Promise<{ value: unknown } | null>
  pageShot: (facility: string) => Promise<string | null>
  pageAct: (action: ActionSpec & { facility: string }, confirmed?: boolean) => Promise<ActResult | null>
  /** 显式收尾一个 facility 名下的所有标签（前端离开该频道时调）。正常终点。 */
  closeFacilityTabs: (facility: string) => Promise<void>
  /** 关掉闲置超时的 lane，返回关掉了谁。兜的是收尾回调跑不到的异常路径。 */
  reapIdleLanes: (maxIdleMs: number) => Promise<string[]>
  /** 后端此刻真正骑着的浏览器标签 id（给扩展对账）。 */
  claimedTabs: () => number[]
  /** 把某 facility 的标签放到用户面前，让他自己在浏览器里完成登录。 */
  focusLoginTab: (facility: string) => Promise<boolean>
}

export interface HarvestConfig {
  /** 可写状态根目录（能力缓存 / 撞墙台账 / 失败现场截图都落在它下面）。 */
  dataDir: string
  log: (...args: unknown[]) => void
  /** lane 预算（`config.yaml` 的 `browser_lanes`）。缺席就是管理器自己的默认。 */
  browserLanes?: AppConfig['browser_lanes']
  /** 采集浏览器的 `config.yaml` 默认档；用户在设置里选的那个压在它上面。 */
  harvestBrowser?: AppConfig['harvest_browser']
  /** Stream Desktop 的会话租约排队上界（`config.yaml` 的 `desktop.session_wait_ms`）。
   *  缺席就是 `WsHostRelay` 自己的默认（180s）——见该字段在 `types.ts` 的头注。 */
  hostSessionWaitMs?: number
  onDebug?: (entry: DebugEntry) => void
  /**
   * 介入域的现取口（bootstrap 递 `() => kernel.intervention`）。**经 config 传、不走 inject、
   * 也不能在这里读 `ctx.intervention`**：Cordis 不允许绕过 inject 惰性取服务（活体 2026-09-11
   * 一次采集当场 `cannot get property "intervention" without inject`），而 inject 一个比本域晚挂
   * 的域会让本域等它。缺席 / 还没挂 → 三个接线都如实回 undefined。
   */
  intervention?: () => InterventionService | undefined
  /**
   * 通知中心的入口，只喂**挂满 relay 闸门**那一档（慢命令仍只进 debug bus）。
   *
   * **必须是调用时才解引用的那种**（bootstrap 传 `lazyNotify(() => kernel.streamEvents)`）：
   * 事件层在装配序上排在本域之后，装配期取到的一律是 undefined，存成字段 = 这条通知永远
   * 发不出去且一个字都不报。缺席 = 只记 debug bus。
   */
  notify?: (input: EventInput) => void
  broadcast?: (msg: unknown) => void
  /**
   * `see` 梯子最后一段（model）打给谁——就是 LLM 网关的 `ctx.llm.forTask`。
   *
   * **别改成 `inject: ['llm']`，那是一个环**（直接依赖看着没环，环在传递闭包里）：
   *
   * ```
   * harvest → llm → provider → adapters → harvest
   *           ↑ llm.ts:48   ↑ provider.ts:140  ↑ adapters.ts:70（inject 里有 'harvest'）
   * ```
   *
   * Cordis 对环是**当场拒**（同形状的说明见 `auth.ts` 里 `ctx.packages.setFacilityLogin`
   * 那条），而拒的表现是**本域整个不激活**——采集运输面静默消失，不是一条报错。
   *
   * 传函数 = 调用时才解引用，装配序天然对（bootstrap 里 llm 域比本域晚建），和 `intervention`
   * 那格同一个理由。**消费侧也必须每次现取**，见 `makeSee` 的实现。
   *
   * 缺席 = 梯子只走得到前三段（a11y / screen / template），**不是静默降级**：`SeeResolver`
   * 走到 model 段会明说宿主没配。
   */
  llmForTask?: LlmForTask
}

/**
 * 采集运输面这一域：**用户自己那个 Chrome 里的一切**。
 *
 * 两条中继（扩展 `/api/ext`、Stream Desktop `/api/host`）→ 一个 Transport → lane 管理器 →
 * recipe 执行器，外加挂在它们上面的读写面（look/shot/act、收标签、认领对账、xhs 两个动作）。
 * Stream 自己不带浏览器，所以这一域没有进程要管——它管的是**用户浏览器里的标签**。
 *
 * 域内保序（改动前先读，顺序不是随手排的）：
 *  1. `browserCapability` → `extRelay`：relay 构造时就要拿到能力缓存（扩展连上那一刻同时回答
 *     「有没有 Chrome」和「有没有扩展」，靠的是 relay 把握手字段喂进这个 store）。
 *  2. `extRelay` + `extLauncher` → `transport` → `recipeSessions` / `sessionRecipes`：
 *     单一运输面接缝，三处都从同一个 Transport 读页面，而不是各持一个 page 句柄。
 *  3. `feedLedger` 先于 `sessionRecipes`：执行器构造时就要拿到 `orderedFor`（locate 步的坐标系），
 *     而每跑完一条声明了 `ledger` 的 recipe 就整本替换（记账在 adapters 域的 `sessionFetch`）。
 *
 * **限速表每次现取**（`sources.recipePackages()`）：装配期把 `.current` 解开就等于冻结在启动
 * 那一刻，新装的 recipe 包限速永远读不到，而且不报错——只是限速悄悄按旧表走。
 *
 * 句柄一个，登记成 effect：`recipeSessions.closeAll()`。它撤销的是**用户看得见的东西**
 * （还给他的那些采集标签），过去挂在 bootstrap 的 `shutdown()` 手写行上。
 */
export const harvestPlugin = {
  name: 'harvest',
  inject: ['settings', 'sources'],
  apply(ctx: Context, config: HarvestConfig): void {
    const { dataDir, log } = config
    const settings = ctx.settings

    // extension CDP transport 中继：单连接（单用户单机一浏览器）。serve.ts 用 attachExtRelay 把
    // /api/ext 挂到 http server。采集全部骑在它上面——用户自己的 Chrome 就是那个浏览器。
    // 采集能力检测锚在 relay 上：扩展跑在用户的 Chrome 里，它连上来那一刻「有没有 Chrome」和
    // 「有没有扩展」同时被回答，不需要探测文件系统、不需要问 host-agent（spec §5）。
    const browserCapability = new BrowserCapabilityStore(join(dataDir, 'browser-capability.json'))
    // onDebug：慢命令 / 超时的分段账本进 debug bus 的 `ext-cdp` channel——和扩展侧那两条
    // （slow-command / slow-command-done）落在同一个频道里，好对着读出"慢在哪一跳"。
    const extRelay = new ExtRelay({
      capability: browserCapability,
      ...(config.onDebug && { onDebug: config.onDebug }),
      // 超时那一档另外进通知中心（debug ring 会被冲掉，而症状是用户先感知到的）。
      ...(config.notify && { onNotify: config.notify }),
    })
    const extLauncher = makeExtensionLauncher(extRelay, { onDebug: config.onDebug })
    // host-desktop Engine 中继：单连接（宿主上一个 automation agent）。serve.ts 用 attachHostRelay 把
    // /api/host 挂到 http server。无 agent 连接时 desktopDriver 返 undefined → kind:'desktop' source
    // 以 miss 落档（不抛）：前置条件不在就是 miss，不是故障。
    const hostRelay = new WsHostRelay({ sessionWaitMs: config.hostSessionWaitMs })
    // 原生窗口驱动的**唯一构造点**：adapter（kind:'desktop' source）与 cdp_* 的 desktop/app 两档
    // 共用它。两处各建一份会让"agent 连没连"出现两个答案。
    const desktopDriver = () => (hostRelay.connected ? makeDesktopDriver(hostRelay) : undefined)
    // 识别层的**唯一构造点**，和上面那个 driver 同一个理由：两个调用方（采集 adapter 与
    // run_action_recipe）各建一份，缓存目录和 model 预算就会出现两个答案。
    const makeSee = (driver: DesktopDriver, sourceId: string): SeeResolver =>
      makeSeeResolver(driver, sourceId, {
        cacheDir: join(dataDir, 'desktop-see'),
        // **每次调用现从 config 上取，不在这儿把那个函数捞出来存着**：捞出来就等于把
        // 「打给谁」冻在建实例那一刻，而 model 段可能几分钟后才第一次跑到（"装配期取的值
        // = 冻住的答案"，见 AGENTS.md）。在场判定同样是每次现判——没配 LLM 网关时这一格
        // 缺席，梯子走到 model 段会明说，不静默降级成"找不到"。
        ...(config.llmForTask && {
          llm: ((callsiteId, input, opts) => config.llmForTask!(callsiteId, input, opts)) as LlmForTask,
        }),
      })
    // 本机学到的落地方式，**唯一构造点**（理由见 `HarvestService.recipeOverrides` 的头注）。
    // 不落在包目录里：包升级是整目录覆盖，放进去就丢。
    const recipeOverrides = new RecipeOverrideStore(join(dataDir, 'recipe-overrides'))
    // 对账（spec §5.3）不在这儿：它发生在**每趟运行的开头**（runner 自己调 `overrides.reconcile`）。
    // 包的装/卸是 sources 域进程内热重载的，不重启后端——在装配期对账会整个漏掉"包升级"这条
    // 主路径，而漏掉不报错，只是本机那份一直压着包里的新版本。
    // The ONE transport: the user's own visible Chrome over the extension relay. Nothing injects
    // cookies here any more — that was CloakBrowser's tax for being a browser the user had never
    // logged into. Their Chrome carries their real logins, so a facility's session is simply
    // there, and an expired one is re-established the way a person does it: by logging in.
    //
    // Single transport seam (CP1): the session manager, the executor and look/act/shot all read
    // the page through this one object rather than each holding a Playwright page.
    const transport = resolveTransport({ extLauncher, extRelay, onDebug: config.onDebug })
    const transportFor = (_spec: RecipeSessionSpec) => transport
    // The registry bounds the TABS we open: idle lanes get reaped when a facility/global lane cap
    // is hit (a live-leased lane is never touched). There is no memory ceiling — the tabs live in
    // the user's Chrome, so they are not this container's RAM to police.
    // lane 预算走配置（`browser_lanes`），缺席就是管理器自己的默认（每 facility 4 / 全局 8）。
    // **`per_facility` 是风险闸门不是性能旋钮**：同一个站上同时开着几个标签是最容易被看出来的
    // 特征；`global` 才是资源那一侧。理由与什么时候该调，写在 `AppConfig.browser_lanes` 的头注。
    // 常驻 lane（recipe 的 session.keepAlive，Photopea 这类工作台标签）的 lane→tabId 落盘：
    // 后端重启时不关它、启动就认领它、下一轮原地骑回去（见 SessionBudget.keepAliveStore）。
    const keepAlivePath = join(dataDir, 'keepalive-lanes.json')
    const recipeSessions = new RecipeSessionManager(transportFor, {
      ...(config.browserLanes?.per_facility != null && { maxLanesPerFacility: config.browserLanes.per_facility }),
      ...(config.browserLanes?.global != null && { maxLanesGlobal: config.browserLanes.global }),
      keepAliveStore: {
        load: () => {
          try { return JSON.parse(readFileSync(keepAlivePath, 'utf8')) as Record<string, number> } catch { return {} }
        },
        save: (pins) => writeFileSync(keepAlivePath, JSON.stringify(pins)),
      },
    })
    // 关停时把标签还给用户。**这是对用户可见的行为**（他的浏览器里少几个采集开出来的标签），
    // 所以它是一条 effect 而不是 bootstrap 关停清单上的一行手写代码——手写清单少一条就少一处账。
    ctx.effect(() => () => recipeSessions.closeAll())
    /**
     * 每条 lane 的有序账本（detail 的 locate 拿它当坐标系）。来源是**声明了 `ledger` 的 feed
     * recipe**——xhs 现在是 search（homefeed 那本随 homefeed 一起没了，spec §8-B）。记账在
     * `sessionFetch`（adapters 域的 ReplayAdapter 接线里），消费在 `sessionRecipes` 的 `orderedFor`
     * （locate 步缺省 `ordered` 时运行时按 facility 来取），标签一关就作废。
     */
    const feedLedger = new FeedLedger()
    // Live harvest preview: normalize each freshly-scraped batch and broadcast it so the UI can
    // watch a scrape come in, mid-run. Preview only — the authoritative persist/dedup/health
    // still happen batch-at-end (see live-harvest-preview-stream spec). `sourceId` is the
    // manifest id (recipe.sourceId), matching the harvest-done frame below.
    const liveHarvestSink = (sourceId: string, items: Array<Record<string, unknown>>) => {
      if (!config.broadcast) return
      const manifest = ctx.sources.registry.get(sourceId)
      if (!manifest) return
      const now = new Date().toISOString()
      for (const raw of items) {
        // Full Item shape so the preview's LEFT pane can render it with PostItemRow live —
        // no waiting on the blocking previewStream (which only returns after the whole scrape).
        const id = String(raw.guid ?? raw.noteId ?? raw.link ?? raw.title ?? '')
        config.broadcast({
          type: 'harvest-item',
          sourceId,
          label: manifest.facility?.label ?? manifest.title ?? manifest.id,
          item: {
            id,
            stream_id: '',
            source_id: manifest.id,
            type: manifest.type,
            title: raw.title != null ? String(raw.title) : '',
            url: raw.link != null ? String(raw.link) : undefined,
            author: raw.author != null ? String(raw.author) : undefined,
            author_avatar: raw.author_avatar != null ? String(raw.author_avatar) : undefined,
            timestamp: raw.pubDate != null ? String(raw.pubDate) : now,
            fetched_at: now,
            content: normalize(raw as RawItem, manifest),
          },
        })
      }
    }
    // 撞墙台账：跨重启活着的那份「这个站点撞墙之后多久才凉」的实测记录，喂给冷却的底数和封顶。
    // 采样靠自然流量（冷却到期本来就会放行一发），不刻意去探。
    const blockEpisodes = new BlockEpisodeLog(join(dataDir, 'block-episodes.json'))
    const facilityCooldown = new FacilityCooldown({}, blockEpisodes)
    // 频率闸门：每个 facility 在自己的 package.json 的 stream.rateLimit 里声明，没声明就不限速。
    // 这是封号治理的正解——站点数的是频率，不是像不像人（xhs 那次登录墙是高频打 detail
    // 打出来的，拟人轨迹全程开着）。撞墙时 executor 还会叫它排空小时预算，见 drainBudget。
    const facilityRateLimit = new FacilityRateLimiter(
      // 每次现取：install 热挂载后归并快照会整体换掉，冻结在启动那一刻 = 新装包的限速读不到。
      (facility) => ctx.sources.recipePackages().byFacility.get(facility)?.rateLimit,
    )
    // 单条腿自己那道闸不在这里接：它写在 recipe 的 `meta.rateLimit` 上，由执行器直接从
    // canonical recipe 读了递给 take()——绕开"拿局部名查全名表"那个静默失效。
    const sessionRecipes = new SessionRecipeExecutor(
      recipeSessions,
      // Same transport seam the session manager reads from — the executor picks driver + relay
      // off the resolved Transport instead of its own ext-cdp/cloak if/else.
      transportFor,
      new RecipeRunner(
        (id) => new RunProbe(id, recipeProbeEnabled()),
        liveHarvestSink,
        (sourceId) => config.broadcast?.({ type: 'harvest-done', sourceId }),
        // Every recipe run (detail included) posts its per-phase breakdown to the DebugBox — so
        // opening a note shows the same step timing (open vs state-wait, or fallback-nav) that the
        // [recipe-probe] console line does, filterable by source key.
        (sourceId, timing, itemCount) => {
          if (!timing.length) return
          const at = Date.now()
          const total = timing.reduce((s, t) => s + t.ms, 0)
          const slow = timing.reduce((a, b) => (b.ms > a.ms ? b : a), timing[0])
          config.onDebug?.({
            id: `recipe:${sourceId}@${at}`,
            at,
            channel: 'recipe',
            key: sourceId,
            title: `${sourceId} 运行`,
            summary: `${(total / 1000).toFixed(1)}s · ${itemCount} 项 · 最慢 ${slow.phase} ${slow.ms}ms`,
            ok: itemCount > 0,
            fields: timing.map((t) => ({
              label: t.phase,
              value: `${t.ms}ms`,
              tone: t.ms >= 3000 ? 'warn' : 'muted',
            })),
          })
        },
        // 失败现场 → DebugBox。one-shot 的 tab 失败即关，现场只有这一次机会；没有它，排查就只
        // 剩一句"什么没发生"，只能靠重跑加猜。
        (sourceId, scene) => {
          const at = Date.now()
          const step = scene.trace.length ? `step#${scene.trace[scene.trace.length - 1].step}` : '起步前'
          // 截图落盘、只把路径推给 DebugBox：base64 整页 JPEG 走 WS 太重，而 DebugEntry 也没有
          // 放图片的字段——塞进去会被对象展开静默丢掉（多余属性检查绕过了），比不放更坏。
          let shotPath: string | undefined
          if (scene.shot) {
            try {
              const dir = join(dataDir, 'failures')
              mkdirSync(dir, { recursive: true })
              shotPath = join(dir, `${sourceId}-${at}.jpg`)
              writeFileSync(shotPath, Buffer.from(scene.shot, 'base64'))
            } catch {
              shotPath = undefined // 取证失败绝不能盖掉真正的失败原因
            }
          }
          config.onDebug?.({
            id: `recipe-fail:${sourceId}@${at}`,
            at,
            channel: 'recipe',
            key: sourceId,
            title: `${sourceId} 失败现场`,
            summary: `${step} · ${scene.reason.slice(0, 120)}`,
            ok: false,
            fields: [
              ...(scene.url ? [{ label: '停在', value: scene.url, tone: 'muted' as const }] : []),
              ...(scene.title ? [{ label: '标题', value: scene.title, tone: 'muted' as const }] : []),
              ...scene.trace.map((t) => ({
                label: `step#${t.step} ${t.kind}`,
                value: t.note ?? '—',
                tone: 'muted' as const,
              })),
              // 站点自己的报错（"验证失败""名称已存在"）几乎总在可见文本里
              ...(scene.text ? [{ label: '页面文本', value: scene.text.slice(0, 600), tone: 'warn' as const }] : []),
              ...(shotPath ? [{ label: '现场截图', value: shotPath, tone: 'muted' as const }] : []),
            ],
          })
        },
        // `call` 步骤的出口。**地址在这一侧解析，recipe 只给得出一个服务名**——那一格的
        // 第 1 条边界（见 `src/replay/recipe.ts`）：recipe 是能从 npm 装的第三方数据，给它
        // 拼 URL 的能力就是给它一个外泄原语。
        callPluginService,
      ),
      // recipe 一次性抽取的落点。目标 ref 与"哪些键是 secret"都由 executor 从**这份 recipe 自己的**
      // manifest 声明里取，这里只负责落盘——所以这个函数拿不到、也不需要知道是谁在写。
      // 值不进日志：只记 ref/字段，长度由 runner 那侧写进 outcome.extract。
      (ref, field, value) => {
        settings.setRuntimeConfig(ref, { [field]: value }, [field])
        log(`[stream] recipe 抽取写入 runtime_config ${ref}.${field}`)
      },
      facilityRateLimit,
      // 退让闸门：撞墙之后先别去打（底数与封顶按台账学到的来，学不到就 60s 起、翻倍、封顶 30min，
      // 跑成一次清零）。和上面那道互补——那道管频率，这道管「已经被拦下了」。不需要任何声明：
      // 判据是运行结果，不是配置。
      facilityCooldown,
      // 读凭据：`secret_params` 注入的那一端（写那端是上面的 setRuntimeConfig）。**值不落日志**。
      // 非字符串一律当没有——凭据存储里躺着的应该是字符串，读到别的形状说明那一格被写坏了，
      // 这时候硬失败（recipe 一步都跑不了）远好过把一个 `[object Object]` 打进登录框。
      (ref, field) => {
        const v = settings.runtimeConfig(ref)[field]
        return typeof v === 'string' && v !== '' ? v : undefined
      },
      // 闸 3：只有内置层的 recipe 拿得到凭据。判据由 sources 域现查（热重载会换掉整批对象）。
      // **这一格以前根本没接**，于是 `secret_params` 从落地那天起就没有一条能跑通的路：
      // 不注入 = 谁都不是内置 = 谁都拿不到，而错误信息说的是「这不是内置包」——一句把人
      // 指向完全错误方向的话（真因是"宿主没接线"）。
      (recipe) => ctx.sources.isBuiltinRecipe(recipe),
      // 介入接线。**两个都写成 thunk**：介入域装配得比 harvest 晚，装配期取一次就是永久
      // 冻住一个 undefined，而症状是「介入从来没发生过」，没有任何一处会喊。
      // 这个插件的 `inject` 故意**不加** `intervention`——它装配得更早，加了会死锁；也**不能在这里
      // 读 `ctx.intervention`**：Cordis 对没 inject 的服务是抛错不是 undefined（活体撞过）。所以经
      // `config.intervention`（bootstrap 递的根 kernel thunk）现取，缺席时三个都如实回 undefined。
      {
        repairRunner: () => config.intervention?.()?.repairRunner,
        graphFor: (facility) => config.intervention?.()?.graphFor(facility),
        onObserved: (facility, o) => config.intervention?.()?.observations.record(facility, o),
      },
      // locate 步的坐标系：这个 facility 的 feed 账本（记账在 adapters 域的 `sessionFetch`，同一条
      // 必经路的另一端）。调用方不必再自己塞 `ordered`。
      (facility) => feedLedger.ordered(facility),
    )

    // harvest-browser 是一个配置 row（spec 2026-08-17-config-rows-slice1）：row 只存 `exe`
    // （配置值）；候选清单是现扫文件系统的**活体探测**，留在下面 status() 那张脸上，不进 row。
    // 原 select 的「先确认它真的在」判据搬进 validate 钩子——把一个不存在的路径存进去，
    // 症状是采集永远唤不起浏览器，而错误发生在几小时后的某一轮调度里，没人会把它联系回这次点击。
    ctx.effect(() =>
      settings.rows.register({
        id: 'harvest-browser',
        schema: Schema.object({
          exe: Schema.string().description('采集用的 Chrome 可执行文件（绝对路径）'),
        }),
        legacy: (s) => s.harvest_browser as Record<string, unknown> | undefined,
        deployDefaults: () => (config.harvestBrowser?.exe ? { exe: config.harvestBrowser.exe } : {}),
        validate: async (v) => {
          const exe = typeof v.exe === 'string' ? v.exe.trim() : ''
          if (!exe) throw new Error('exe required')
          if (!(await nodeDiscoverFs().exists(exe))) throw new Error(`no such executable: ${exe}`)
        },
      })
    )

    /** 用户自己的选择（settings 用户层，**不含** config.yaml 部署层）——status() 要区分
     *  origin: settings / config，所以这里读的是 userValues 不是四层合并的 resolve。 */
    const chosenExe = () => settings.rows.userValues('harvest-browser')?.exe as string | undefined

    /** 采集浏览器的生效配置：config.yaml 是默认，用户在入口里选的那个（settings 覆盖层）压在上面。
     *  每次读——用户改完选择下一轮采集就该按新的来，不能被启动时的快照钉死。 */
    const harvestBrowserSpec = () => {
      const base = config.harvestBrowser ?? {}
      const chosen = chosenExe()
      return chosen ? { ...base, exe: chosen } : base
    }

    /** 「采集用哪个 Chrome」的选择面（spec 2026-07-29 §4）：列候选 + 当前选择 + 要不要问用户。
     *  发现走注入的 fs（默认真实文件系统），选择永远来自用户——这里绝不自动挑一个。 */
    const harvestBrowser = {
      async status(): Promise<HarvestBrowserStatus> {
        return harvestBrowserStatus({
          settingsExe: chosenExe(),
          configExe: config.harvestBrowser?.exe,
          candidates: await discoverChromeCandidates(nodeDiscoverFs()),
        })
      },
      /** 选定一个。存在性校验在 row 的 validate 钩子里（`/api/config/harvest-browser` 直写
       *  同样吃到它——判据只有一份）。 */
      async select(exe: string): Promise<HarvestBrowserStatus> {
        await settings.rows.put('harvest-browser', { exe: exe.trim() })
        return harvestBrowser.status()
      },
    }

    /**
     * 采集前的环境前置：用户的 Chrome 得连着中继。**每一轮都要确认**，不是一次性的安装动作。
     *
     * 三档：已连 → 直接过；没连但桌面端在 → 唤起 Chrome（`ensureApp`，**只让进程活着，不抢屏**）
     * 然后等中继连上（扩展的 onStartup 会主动连，等就行）；唤不醒或没有桌面端 → 抛
     * `ExtRelayDisconnected`，调度侧据此**跳过本轮而不是判源故障**。
     *
     * 那个 500ms 轮询有 deadline 自止，所以不进 effect。
     */
    const ensureHarvestBrowser = async (): Promise<void> => {
      if (extRelay.connected) return
      if (hostRelay.connected) {
        const driver = makeDesktopDriver(hostRelay)
        const spec = harvestBrowserSpec()
        // 等扩展自己连上来（onStartup → startExtCdp）。给足一次冷启动，但不无限等：等不到就按
        // "这一轮没跑"处理，比挂在这里好——挂住会拖垮整个调度轮次。
        const waitForRelay = async (ms: number) => {
          const deadline = Date.now() + ms
          while (!extRelay.connected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500))
          return extRelay.connected
        }
        // 唤起是 best-effort：它失败不该盖掉"中继没连"这个更准确的原因
        // 限制排队等待时间——采集轮次不该被前一趟 recipe 的会话租约卡住。这里只是唤起浏览器进程，
        // 是整个 ensureHarvestBrowser 的一部分，不是单独的工作单元——不需要等默认的 180s。
        // 等不到就按"这轮没跑"处理，下一轮再试。
        const first = await hostRelay.withSession(
          () => driver.ensureApp(spec),
          { waitMs: INTERACTIVE_SESSION_WAIT_MS }
        ).catch(() => undefined)
        // 回执整个进 debug bus（`GET /api/debug/log?channel=desktop`）。这是它唯一的观测面：
        // 下面只读 running/started 就丢掉了 pid/window，而"唤起了但没窗口"正是托盘 Chrome 的形状。
        config.onDebug?.(ensureAppDebugEntry('first', first, Date.now()))
        // `running:false` = 启动过了但进程始终没出现。此时等 30 秒毫无意义——没有浏览器会来连。
        if (first && !first.running) throw new ExtRelayDisconnected()
        if (!(await waitForRelay(30_000)) && first?.running && !first.started) {
          // 进程本来就在跑（我们什么都没做），却等不到中继——**这正是托盘 Chrome 的形状**：
          // 进程在、一个窗口都没有、扩展的 SW 也睡着，没有任何东西会去叫醒它。默认的 ensure
          // 语义（在跑就别动）此时正确却没用，所以补一发 force：Chrome 会把这次调用交给已有
          // 实例并开一个窗口，SW 随之醒来。
          //
          // 只在这条分支上 force，不是每轮都 force——后者等于每次采集都在用户桌面上弹窗口。
          // 同样限制排队等待时间——这是 best-effort 操作，不该被无关的租约卡住。
          const forced = await hostRelay.withSession(
            () => driver.ensureApp({ ...spec, force: true }),
            { waitMs: INTERACTIVE_SESSION_WAIT_MS }
          ).catch(() => undefined)
          config.onDebug?.(ensureAppDebugEntry('force', forced, Date.now()))
          await waitForRelay(15_000)
        }
      }
      if (!extRelay.connected) throw new ExtRelayDisconnected()
    }

    // 看/动活页面：在 recipe 正骑着的那个 tab 上求值/动手/截图（见 /api/facilities/:id/page*）。
    /** 显式收尾：使用者说"我不用这个 facility 了"（前端离开频道）→ 关掉它名下所有标签。
     *  这是 lane 的**正常**终点；异常路径（关标签/崩溃/人走了）由 browser-lane-reaper 兜。 */
    const closeFacilityTabs = async (facility: string) => {
      await recipeSessions.closeFacility(facility)
      // 账本描述的是那个标签。标签没了，账本就是废纸——留着只会让下一次 locate 拿着一批不存在的
      // id 白找一轮，再落 fallback-nav。
      feedLedger.clearFacility(facility)
    }
    const reapIdleLanes = async (maxIdleMs: number) => {
      const reaped = await recipeSessions.reapIdle(maxIdleMs)
      for (const label of reaped) {
        const [facility, laneKey] = label.split('/')
        feedLedger.clearLane(facility, laneKey)
      }
      return reaped
    }
    // 后端认领的标签 = 每条活 lane 骑着的那个 tab。lanes() 是"什么标签存在"的唯一真相源。
    // 再加上常驻 lane 落盘的标签：重启后、骑回去之前，它们也得算认领，否则扩展重连对账就当孤儿收走了。
    const claimedTabs = (): number[] => [...new Set([
      ...recipeSessions.lanes().map((l) => l.tabId).filter((id): id is number => typeof id === 'number'),
      ...recipeSessions.pinnedTabIds(),
    ])]
    const pageLook = (facility: string, expression: string) => recipeSessions.look(facility, expression)
    const pageShot = (facility: string) => recipeSessions.shot(facility)
    const pageAct = (action: ActionSpec & { facility: string }, confirmed?: boolean) => {
      const { facility, ...spec } = action
      return recipeSessions.act(facility, spec, { confirmed })
    }
    ctx.provide('harvest', {
      extRelay,
      hostRelay,
      browserCapability,
      harvestBrowser,
      extLauncher,
      desktopDriver,
      makeSee,
      recipeOverrides,
      transport,
      recipeSessions,
      feedLedger,
      sessionRecipes,
      ensureHarvestBrowser,
      pageLook,
      pageShot,
      pageAct,
      closeFacilityTabs,
      reapIdleLanes,
      claimedTabs,
      focusLoginTab: (facility: string) => recipeSessions.focusFacilityTab(facility),
    } satisfies HarvestService)
  },
}
