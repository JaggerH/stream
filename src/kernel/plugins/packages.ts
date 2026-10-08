import type { Context } from 'cordis'
import Schema from 'schemastery'
import { scanPackages, type StreamPackage } from '../../packages/scan.ts'
import { toPluginDescriptor, fillsPluginSlot } from '../../plugins/loader.ts'
import { pluginEnabled } from '../../plugins/enabled.ts'
import type { PluginDescriptor } from '../../plugins/types.ts'
import { pluginIdForDescriptor } from '../../registry/seal.ts'
import { BackendDirectory, backendDirectoryPlugin } from './backend-directory.ts'
import { bindModuleHook } from './module-hooks.ts'
import {
  isPluginTargetBound,
  pluginNetMode,
  pluginTarget,
  resolvePluginTarget,
  setPluginTargetMissReporter,
  setPluginTargetResolver,
  type PluginNetMode,
} from '../../plugins/plugin-target.ts'
import { makePluginTargetMissReporter } from '../../plugins/target-miss.ts'
import { standbyDiagnose, standbyInertReason, standbyOrigin, withAwake } from '../../plugins/standby/hook.ts'
import { provisionDeclaredBackends, type ProvisionNotice } from '../../plugins/provision-wire.ts'
import { aggregatePluginStatus, type PluginStatus } from '../../plugins/status.ts'
import { activatePackages, makeCookieFor, type ActivateFn, type PackageActivationFailure } from '../../packages/activate.ts'
import { pickCodeLayer, type LayerPick } from '../../packages/pick-layer.ts'
import { makePackageReadSource, type ReadSourceImpl } from '../../packages/read-source.ts'
import type { PackageActionEntry } from '../../tasks/package-actions.ts'
import { buildPackageInventory, listRecipeNames, type PackageSummary } from '../../packages/inventory.ts'
import { diffLoadedVsDisk, loadedFromPackage, type LoadedPackage, type PendingChange } from '../../packages/pending.ts'
import { makeContainerOps, type ContainerOps } from '../../packages/container-ops.ts'
import { BUILTIN_ACTIVATIONS } from '../../../packages/index.ts'
import { provisionAlist, dockerAdminSet, fetchPermanentToken } from '../../../packages/alist/provision.ts'
import { ALIST_SERVICE } from '../../../packages/alist/adapter.ts'
import { isJwtLike } from '../../../shared/netdisk/token-shape.ts'
import { hostAlistClient, resolveAlistUrl } from '../../netdisk/alist-client.ts'
import { USER_LAYER_SCAN } from '../../replay/recipe-package.ts'
import { loginToFacility } from '../../credentials/facility-login.ts'
import type { Adapter } from '../../adapters/types.ts'
import type { PluginSummary } from '../../mcp/tools.ts'
import type { TrackFn } from '../../op-track.ts'
import { basename, join } from 'node:path'
import { extractArticle } from '../../content/extract.ts'
import { NETDISK_BASE_PACKAGE_ID } from '../../netdisk/base-package.ts'

declare module 'cordis' {
  interface Context {
    /** 「这台机器装了哪些 Stream 包」这一域（`src/kernel/plugins/packages.ts`）。 */
    packages: PackagesService
  }
}

/**
 * AList 那一格（宿主托管的网盘门面）。内置托管是唯一形态：地址由宿主现取，token 由接管序列
 * 维护——这里没有任何「配置」可写，只有活值和取它的通道。
 */
export interface AlistFacet {
  /** 当前的 token（活值）—— netdisk 域构造 `AlistClient` 用的就是它。可能还空着，见 `managed`。 */
  token: string | undefined
  /** 网盘底座在不在用（= 那个包开没开 = `refresh` 走不走得通）。开着而 `token` 还空着 = 启动时
   *  容器在睡、第一次接管还没跑成；消费方照常装配，带着 `refresh` 用到时再取。 */
  managed: () => boolean
  /** 面板读的状态（token 永不回显）。 */
  status: () => { hasToken: boolean }
  /** 面板的活探测：打一次已认证的 fs/list（没 token 时先接管）。 */
  test: () => Promise<{ ok: boolean; error?: string }>
  /**
   * 取 token 的通道（底座包没开时抛错）：48h JWT 过期时重登，以及启动时没接管成时的第一次接管。
   * 两个消费者：netdisk 域的 `AlistClient`，和 alist 包的 adapter（经 `configForPackage`）。
   */
  refresh: () => Promise<string>
  /**
   * 给**别的进程**用的永久 token（今天唯一的消费者：工作台里的 DSH 网盘插件，netdisk spec §5.3）。
   * 手里是永久 token 就原样交出；是接管序列换来的 48h JWT 就拿它去 OpenList 读设置项换成永久的
   * （401 时重登一次再试）。没有 token → undefined。**每次调用现取**——接管可能在 boot 之后才成。
   */
  permanentToken: () => Promise<string | undefined>
}

/** `activatePackages` 的结果：包自己贡献的 adapter / 动作 + 这次没装起来的那些。 */
export interface ActivatedPackages {
  adapters: Map<string, Adapter>
  failures: PackageActivationFailure[]
  /** 包提供的动作（`<包 id>:<动作名>`）。用户任务行的 `action` 字段在这份名录里查。 */
  actions: PackageActionEntry[]
  /** 包交出来的富化处理器（`/api/enrich?source=<键>`）。 */
  enrichers: Map<string, import('../../packages/activate.ts').Enricher>
  /** 包交出来的一键订阅（键 = 域名）。 */
  connect: Map<string, import('../../packages/activate.ts').ConnectFn>
}

export interface PackagesService {
  /** 内置层（`packages/`）的扫描快照——包的原形，装载器与「装了什么」目录都吃它。 */
  packages: StreamPackage[]
  /** 内置层里填了插件槽位的那些，投影成对外的描述（没有 code）。 */
  plugins: PluginDescriptor[]
  /**
   * 同 npm 名两层都在时各自该跳哪一层（`pickLayers`，启动那次扫描的结论）。sources 域的 curated
   * 投影吃它：被用户层新版顶掉的内置包，`manifests.yaml` 不再从 `plugins[].sources` 进 registry
   * ——否则与用户层那份（走 recipes 组）撞成 `Duplicate manifest id`。`plugins` 本身**不**按它过滤：
   * 目录、容器名册、sealManifests 的 pluginName 查表都还要认识这个包。
   */
  layerPick: LayerPick
  /** 「所有带 backend 的包」的唯一合并名单（内置 + 用户装的第三方）。 */
  backendDirectory: BackendDirectory
  /** 容器取址走哪个档（host loopback / compose 容器 DNS / 没有容器）。 */
  netMode: PluginNetMode
  /** 启用开关的**活**判据（settings 支撑）——目录、状态探测、standby 名册共用这一个。 */
  isPluginEnabled: (p: PluginDescriptor) => boolean
  /** 翻一个插件的开关（落盘 + 刷新判据读的那张活 map）；required 的拒绝。 */
  setPluginEnabled: (id: string, enabled: boolean) => PluginSummary
  /** 「装了什么」的统一目录（内置快照 + 用户层现扫）。 */
  packageInventory: () => PackageSummary[]
  /** 待生效清单：启动那一刻装载的用户层（冻住的快照）vs 盘上现扫，差异见 `packages/pending.ts`。
   *  每次调用现扫现算，结果不存。 */
  pending: () => PendingChange[]
  /** 「包」页对容器的两个动作（看日志 / 重启）。 */
  containerOps: ContainerOps
  /** 只读插件状态聚合（stale-while-revalidate 缓存在内部）。 */
  pluginStatus: () => Promise<PluginStatus[]>
  alist: AlistFacet
  /** 宿主解析好的、按包分发的部署配置。包不自己读 config/env/settings。 */
  configForPackage: (id: string) => Record<string, unknown>
  /** 包自己 `activate(ctx)` 贡献出来的东西 —— bootstrap 后段汇进全局 adapters Map。 */
  activated: ActivatedPackages
  /** 启动时接管容器的结果通知（events 在装配序上更靠后，先攒着由 bootstrap emit）。 */
  provisionNotices: ProvisionNotice[]
  /**
   * 接上「把某个 facility 登回来」的实现（`ctx.login` 背后那一个）。
   *
   * **为什么要绕这一道，而不是在这里直接 `ctx.sources` / `ctx.harvest`：** 它俩在装载序上都
   * 排在本域**后面**——`sources` 自己 `inject: ['packages', …]`，本域再 inject 回去就是环，
   * Cordis 会当场拒。所以由下游那个真正 owns 登录态的域（`auth`，它已经握着 sources /
   * harvest / credentials）在自己起来之后回填进来。
   *
   * 回填必须配**调用时现取**（`activate` 交给包的那个 `login` 闭包读的是这个字段，不是它的
   * 快照）。这正是 AGENTS.md 记的那种「前向 let + 回填」的坑：拿快照的依赖方会永远握着回填
   * 之前那一份 undefined。没接上就抛，不静默 no-op——静默的话包会以为"登好了"然后去重做那件
   * 事，而那件事可能是下一笔单。
   */
  setFacilityLogin: (fn: (facility: string) => Promise<void>) => void
  /** 把某个 facility 登回来——`ctx.login` 背后就是这一个。没接上实现时**抛**（见上一格）。 */
  facilityLogin: (facility: string) => Promise<void>
  /**
   * 接上「读一条源」的实现（`ctx.readSource` 背后那一个，= `Scheduler.readSource`）。
   *
   * 形状与 `setFacilityLogin` 完全相同、理由也相同：Scheduler 住在 scheduling 域，装配序上排在
   * 本域**后面**（它 inject 本域），本域拿不到它；由 scheduling 域建完 Scheduler 后回填进来。
   * 包拿到的 `readSource` 闭包每次调用现读这个回填变量（`makePackageReadSource` 的 thunk），
   * 不抓快照；回填之前调用就抛，不静默回空——空数组会被包读成"这条源没内容"。
   * 包名限定（只许跑自己的源）在闭包里判，实现这一侧收到的已经是全名。
   */
  setPackageReadSource: (fn: ReadSourceImpl) => void
}

export interface PackagesConfig {
  /** 内置包目录（`config.packages_dir`）。 */
  packagesDir: string
  /** 可写状态根目录——第三方包装在 `<dataDir>/recipes`。 */
  dataDir: string
  /** `config.manage_containers`：要不要替用户建容器。默认 false。 */
  manageContainers: boolean
  log: (...args: unknown[]) => void
  /**
   * 目录里这个插件此刻的摘要行 —— `setPluginEnabled` 翻完开关要回一份。
   * 前向引用是有意的：目录住在 `StreamService`，装配序上远在本域之后，
   * 而这个 thunk 只在 HTTP 请求时才调。
   */
  catalogSummary: (pluginId: string) => PluginSummary | undefined
  /** 容器健康探测那一轮的 op-track 跨度。 */
  track?: TrackFn
  /** 探测轮次发去 DebugBox 的 `plugins` 频道。 */
  onDebug?: (entry: import('../../debug.ts').DebugEntry) => void
  /**
   * 通知中心的入口，只喂**取址答空里真指向缺陷**的那两档（其余仍只进 debug bus）。
   *
   * **必须是调用时才解引用的那种**（bootstrap 传 `lazyNotify(() => kernel.streamEvents)`）：
   * 事件层在装配序上排在本域之后，装配期取到的一律是 undefined，存成字段 = 这条通知永远
   * 发不出去且一个字都不报。缺席 = 只记 debug bus。
   */
  notify?: (input: import('../../events/store.ts').EventInput) => void
  /**
   * 内置包代码入口表。缺席 = `packages/index.ts` 的 `BUILTIN_ACTIVATIONS`（生产唯一的一份）。
   * **只有测试传它**：要钉「同名两层按版本挑一层激活」得放一个假的内置带 code 包，而真表里没有
   * 它的入口（`activatePackages` 对此是抛错，不是跳过——那条不变量不该为了测试放松）。
   */
  builtinActivations?: Map<string, ActivateFn>
}

/** 状态缓存的新鲜度上限：过了就后台刷一轮，但先把旧的答出去。 */
const PLUGIN_STATUS_TTL_MS = 15_000
/** 预热延迟：错开启动潮，否则探测耗时被启动本身的忙碌污染、健康的后端会被误报成 down。 */
const PLUGIN_STATUS_PREWARM_MS = 3_000

/**
 * 包这一域：**这台机器上装了哪些 Stream 包、它们各自填了哪些槽位、哪些开着**。
 *
 * 两层扫描（内置 `packages/` + 用户 `<dataDir>/recipes`）在这里各跑一次、然后被反复使用：
 * 描述符投影、容器接管、代码装载、「装了什么」目录、安装期撞名闸门，全部读同一份快照。
 * **别在别处再扫一遍**——那是把 51 份 manifest 的 zod 解析再跑一轮。
 *
 * **apply 内的顺序是有语义的**，改动前先读这三条：
 * 1. `setPluginTargetResolver`（模块级钩子）必须早于任何 adapter/client 构造——`bindModuleHook`
 *    的回调是同步立刻跑的，所以包进 effect 不改变时机，只多出 dispose 时复位为 null。
 * 2. 容器接管（`provisionDeclaredBackends`）必须早于 AList 接管：AList 要 `/ping` 得通。
 * 3. AList 接管必须早于 `activatePackages`——`configForPackage` 是**立即求值**的，
 *    `AlistAdapter` 构造时就把 token 收进字段，提前一步拿到的就是 undefined。
 *    （启动时这一次接管**抢不到是常态**：容器多半在睡。所以同一格里还递了 `refresh`，
 *    消费方带着它装配、用到时再取——token 字段为空不等于坏了。）
 *
 * 句柄：只有状态预热那一个 `setTimeout`（已 unref）需要 effect —— 关停后它还会去打一轮
 * 容器健康探测，没有实害但会在测试里留一条悬空的异步。扫描/目录/容器动作都是现建现扫，不持句柄。
 */
export const packagesPlugin = {
  name: 'packages',
  inject: ['settings', 'credentials'],
  async apply(ctx: Context, config: PackagesConfig): Promise<void> {
    const { log } = config
    const settings = ctx.settings
    const track: TrackFn = config.track ?? (<T,>(_name: string, fn: () => Promise<T>) => fn())

    // 扫一次，用两次：`packages` 是包的原形（装载器要它的 `code` 槽位），`plugins` 是投影出来的
    // 描述（**发给前端的目录形状**，没有 code）。
    // 这一层住着两种包（并轨后同一个目录），所以投影前要按槽位挑：纯 recipe 包没有任何插件槽位
    // （见 fillsPluginSlot），它对外的东西走 sources 域的 mountRecipePackages 那条。
    const packages = scanPackages(config.packagesDir)
    const plugins = packages.filter(fillsPluginSlot).map(toPluginDescriptor)
    log(`[stream] loaded ${plugins.length} plugin descriptors from ${config.packagesDir} (${packages.length} packages total)`)

    // 用户数据目录（`<dataDir>/recipes`，也就是 install 的落地处）里的第三方包。**扫一次用两次**：
    // 这里给容器接管挑出带 backend 的，下面 activatePackages 用同一份挑出带 code 的。
    const recipesUserDir = join(config.dataDir, 'recipes')
    // **读不动的第三方包只掉自己那一格**：`package.json` 坏了（或 manifests.yaml 不过 schema）
    // 以前从这里抛出去 = 后端起不来，而用户唯一的恢复手段是自己去文件系统删包。这是
    // recipe 那条（坏 `.recipe.json` 由 sources 域跳过）同一个缺陷，只是早了一层。
    // **只对用户装的这层接**：上面 `config.packagesDir` 那次是随应用发布的内置包，坏了就该掀桌。
    // 落进 `activated.failures` 那本台账，跟"执行期炸了"的包同一条出口（日志 + 事件层通知）——
    // 另起一套就又变成"只有日志说了"。
    const unreadableUserPackages: PackageActivationFailure[] = []
    const userPackages = scanPackages(recipesUserDir, {
      ...USER_LAYER_SCAN,
      onPackageError: (dir, error) => void unreadableUserPackages.push({ id: basename(dir), dir, error }),
    })
    // 只投影 provisioner 要的那几格，**不走 toPluginDescriptor**：那条路会跑 validatePluginGrouping，
    // 第三方写一个宿主不认的 grouping resolver 就会在启动时抛——容器接管不该有掀翻启动的权力。
    // backend 用**盘上的原样字节**：它在安装期已经被 container-policy 钳制过（service 名指派、
    // 卷加包前缀、mem 必填），这里再钳一次就是两份判据分家。手改盘上文件那条路由运行时闸门堵
    // （provisioner 的 requireMemLimit + createContainer 拒宿主 bind）。
    // `credentials` 必须跟着一起投影：provisioner 用它判「这个容器要不要拿凭证 token」，
    // 判据与 compose 生成器同一条。漏了它 = 第三方申报了凭证域也拿不到 cookie（broker 一路 401），
    // 而这件事没有任何日志会提到。
    const thirdPartyBackends: PluginDescriptor[] = userPackages
      .filter((p) => p.backend)
      .map((p) => ({ id: p.id, name: p.name, backend: p.backend, credentials: p.credentials }))

    // 启动快照——**故意冻住**：它记的就是「启动那一刻装载了什么」，`pending()` 拿盘上现扫和它对账。
    // 这是 AGENTS.md「装配期取的值 = 冻住的答案」那条的例外，因为"冻住"正是这个值的定义。
    // 只算用户层：内置层随二进制走，不会在运行期变。
    // 精确地说它记的是「启动时盘上有的」，不是「真装载了的」：同名两层里输掉的那份、activate 抛了的
    // 那份也在里面。它们后来被删掉时会报成 `removed` + needsRestart——多要一次重启，宁可保守。
    // 要"真装载了的"就得回头问每个装载器的结果，三个消费端各有一套时序，这里不接。
    const hasRecipes = (dir: string) => listRecipeNames(dir).length > 0
    const loadedSnapshot: LoadedPackage[] = userPackages.map((p) => loadedFromPackage(p, hasRecipes(p.dir)))
    // 盘上那一侧每次现扫，**结果不存**。读不动的包跳过不抛：这是请求路径（三处露面），
    // 抛 = 整份清单和 /api/health 一起 500。
    const pending = (): PendingChange[] => {
      const disk = scanPackages(recipesUserDir, { ...USER_LAYER_SCAN, onPackageError: () => {} })
      return diffLoadedVsDisk(loadedSnapshot, disk.map((p) => loadedFromPackage(p, hasRecipes(p.dir))))
    }

    const netMode = pluginNetMode()
    // descriptors 是**两层合并**（内置 + 第三方带 backend 的那些）：只给内置那层的话，第三方
    // 容器在 compose 档永远解不出 origin（`ctx.backendUrl()` 恒 undefined），容器建起来了却没人
    // 打得到它，而且没有任何日志会提。合并只发生在 BackendDirectory 里一次，`/_p` 网关、
    // standby 名册、「包」页容器动作都从 `ctx.backendDirectory` 拿同一份引用。
    const backendDirectory = new BackendDirectory(plugins, thirdPartyBackends)
    ctx.plugin(backendDirectoryPlugin, { directory: backendDirectory })
    // Wire the server-side plugin-target resolver ONCE now that descriptors are loaded — every
    // resolveXUrl() in transcribe/docparse/netdisk/pansou, and the `ctx.backendUrl()` thunk handed
    // to packages, reads through this indirection (src/plugins/plugin-target.ts) so real container
    // targets (compose mode) or null (none mode — no gateway) reach every caller without threading
    // descriptors through each call site. Must run before any adapter/client below is constructed.
    // host 档取址走 standby Cell（动态，先 withAwake 后取）；compose 档静态容器 DNS。
    // 本域先于 wireStandby 跑，hook 是调用时读——接线前一律 null，等价还没醒。
    // 答空时的现场记录（spec 2026-08-19-plugin-target-empty-observability）。**事实收集必须在
    // 这里**：只有本域同时握着 netMode、合并名册和 standby hook 三样。分类与渲染是纯函数
    // （src/plugins/target-miss.ts），喊声出口在 plugin-target.ts。与 resolver 同生共死，
    // 所以两个都绑在同一个 bindModuleHook 里、由同一个 disposer 复位。
    const reportMiss = makePluginTargetMissReporter({
      mode: netMode,
      resolverBound: isPluginTargetBound,
      // 「名册里有它且声明了 backend」——直接问静态解析器，别在这里复刻一遍 find 逻辑。
      backendDeclared: (service) =>
        resolvePluginTarget(service, { descriptors: backendDirectory.all(), mode: 'compose' }) !== null,
      standbyDiagnose,
      // 上面那个答 null 时**为什么**——「够不着 Docker」(所有容器插件一起失效,该喊)和
      // 「按设计如此」(桌面档 / 没插件声明 standby)在 `standby === null` 这一格里长得一样,
      // 不带上原因就只能一律沉默,而那正是影响面最大的一种失败(2026-09-02 活体)。
      standbyInertReason,
      emit: (entry) => config.onDebug?.(entry),
      // 真缺陷那两档另外进通知中心（判据 pluginTargetNotifiableDefect，spec §2.1）。
      notify: (input) => config.notify?.(input),
    })
    bindModuleHook(
      ctx,
      () => {
        setPluginTargetResolver((service) =>
          netMode === 'host' ? standbyOrigin(service) : resolvePluginTarget(service, { descriptors: backendDirectory.all(), mode: netMode }),
        )
        setPluginTargetMissReporter(reportMiss)
      },
      () => {
        setPluginTargetResolver(null)
        setPluginTargetMissReporter(null)
      },
    )

    // Per-plugin enable overlay (settings.json → toggled from the UI). Opt-out: an absent entry = on.
    // A toggle persists immediately and the catalog/status reflect it live (the StreamService
    // predicate + pluginStatus read this mutable map). But source (un)registration runs at
    // BOOT, so a *disable* only fully lands — sources gone from the registry, hence from Provider
    // 候选/推荐 — after a restart. Container backends are compose-managed: a disabled container plugin
    // is skipped by health probing here, but stopping the container itself is the user's manual step.
    let pluginEnabledMap: Record<string, boolean> = settings.get().plugins ?? {}
    const isPluginEnabled = (p: PluginDescriptor) => pluginEnabled(p, pluginEnabledMap)

    // 插件容器由后端自己备齐（`manage_containers`，**默认关闭**）。关着时这一行不发任何 docker
    // 调用，容器照旧归 `docker compose up -d` 管——现状一字不差。
    // **位置有讲究**：必须排在下面 AList 接管之前。接管要 `/ping` 得通，容器还没起就静默跳过、
    // 要等下次重启；先备齐容器，那条路第一次启动就能走通。
    // 通知先攒着（events 在装配序上更靠后，与 activated.failures 同款）。
    const provisioning = await provisionDeclaredBackends({
      descriptors: plugins,
      thirdParty: thirdPartyBackends,
      enabled: config.manageContainers,
      mode: netMode,
      isEnabled: isPluginEnabled,
      log,
    })

    // alist 是一个配置 row：只有 token（密文）一格。网盘底座只有内置托管一种形态——地址由宿主
    // 现取（`resolveAlistUrl`），token 由接管序列经 `settings.setAlistCredentials` 维护。
    // **这一行没有任何人工写入口**：`validate` 一律拒，所以通用的 `PUT /api/config/alist` 也写不进来；
    // 没有 config.yaml / 环境变量那一层。`adminPassword`（接管用的内部凭证）与 `mounts`（挂载期望态）
    // 不是 row 字段，留在 legacy alist 块。
    ctx.effect(() =>
      settings.rows.register({
        id: 'alist',
        schema: Schema.object({
          token: Schema.string().role('secret').description('网盘底座 token（由接管序列自动维护）'),
        }),
        legacy: (s) => (s.alist?.token ? { token: s.alist.token } : undefined),
        validate: () => { throw new Error('网盘底座由 Stream 托管，凭证自动维护，不接受手工写入') },
      })
    )
    const alistCfg = () => settings.rows.resolve('alist') as { token?: string }
    let alistToken = alistCfg().token

    // T7 接管序列（内置托管是唯一形态，AList 是实现细节）：手里没 token 且 alist 插件启用 →
    // 生成/复用 admin 密码，login 换 48h JWT。就绪门控 /ping 2s；容器没起 → 跳过，不阻塞 boot。
    // 启动时这一次只是顺手：standby 管着的容器这时多半在睡（或刚被拉起、2s 内答不上），跳过是常态。
    // 兜底在 `alistRefresh`——消费方带着它装配，第一次真用到网盘时再接管。
    const alistProvisionDeps = () => ({
      baseUrl: resolveAlistUrl(),
      getStored: () => ({
        password: settings.get().alist?.adminPassword, // 非 row 字段（bootstrap 内部凭证）
        token: alistCfg().token,
      }),
      save: (c: { password: string; token: string }) => settings.setAlistCredentials(c),
      execAdminSet: dockerAdminSet(),
    })
    const netdiskBaseEnabled = () => plugins.some((p) => p.id === NETDISK_BASE_PACKAGE_ID && isPluginEnabled(p))
    /**
     * 网盘底座在不在用 = 那个包开没开。内置托管是唯一形态，所以「开着」就等于「token 归我们取」
     * ——手里暂时没有 token（启动时容器在睡、第一次接管还没跑成）不改变这个答案。
     */
    const alistManaged = (): boolean => netdiskBaseEnabled()
    /**
     * 取 token 的通道：48h JWT 过期时重登，以及启动时没接管成的那种情况下的**第一次接管**。
     * 包在 `withAwake` 里——登录打的是容器自己，host 档下它的地址也只在醒着时才有；启动那一刻
     * 抢不到的东西，等到真有人要用（容器必然被唤醒）时再取。
     */
    const alistRefresh = async (): Promise<string> => {
      if (!alistManaged()) throw new Error('[alist] 网盘底座包未启用，无法取 token')
      return withAwake(ALIST_SERVICE, async () => {
        alistToken = await provisionAlist(alistProvisionDeps())
        return alistToken
      })
    }
    if (!alistToken && netdiskBaseEnabled()) {
      const base = resolveAlistUrl()
      const up = await fetch(`${base}/ping`, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.ok)
        .catch(() => false)
      if (up) {
        try {
          alistToken = await provisionAlist(alistProvisionDeps())
          log('[stream] alist 接管完成（admin 凭证已托管）')
        } catch (e) {
          log(`[stream] alist 接管失败，跳过: ${(e as Error).message}`)
        }
      } else {
        log('[stream] alist 未就绪（/ping 不通），启动时不接管 — 第一次用到网盘时再取 token')
      }
    }

    /** 宿主解析好的、按包分发的部署配置（config.yaml 里的**显式**值，不传解析后的快照——host 档下
     *  快照必得空串，容器醒着时才有 loopback origin）。托管容器的地址不从这儿走：包经
     *  `ctx.backendUrl()` 请求时现取。 */
    const configForPackage = (id: string): Record<string, unknown> => {
      switch (id) {
        // `token` 可能还空着（启动时没接管成）；`refresh` 让包用到时经它取、过期时经它换发。
        case 'alist': return { token: alistToken, refresh: alistRefresh }
        default: return {}
      }
    }

    // 包自己声明它贡献什么（activate(ctx)），宿主只负责给 ctx 并收下结果。
    // 宿主四件（builtin/rsshub/replay/browser）不走这条路——它们依赖 transport/ledger/sessionFetch
    // 这些宿主基础设施，继续在 bootstrap 里手工织。
    // **位置有讲究**：必须排在上面 alist 接管之后（见文件头注第 3 条）。
    //
    // 两条来路：内置包走 BUILTIN_ACTIVATIONS 那张静态 import 表；用户数据目录里带 `stream.code`
    // 的第三方包走运行时动态 import。同一个包**可以同时带 recipe 数据和代码**，两者互不影响
    // ——recipe 那条路照旧由 sources 域的 mountRecipePackages 走。
    // 这里只挑带 code 的：没有 code 的用户包（纯 recipe 包）对装载器来说不存在。
    // 「把某个 facility 登回来」的实现，由下游 auth 域回填（见 `setFacilityLogin` 头注）。
    // 下面那个 `facilityLogin` 读的是**这个变量**，不是它此刻的值——回填之后立刻生效。
    let facilityLoginImpl: ((facility: string) => Promise<void>) | undefined

    /** 包的 `ctx.login` 和服务面共用这一个入口，所以"没接线"只在一处判、一处抛。 */
    const facilityLogin = async (facility: string): Promise<void> => {
      if (!facilityLoginImpl) {
        throw new Error(
          `ctx.login("${facility}")：登录能力还没接线（auth 域没起来）——这一步不能静默跳过，` +
          `调用方会把它当成"登好了"去重做那件事，而那件事可能是下一笔单`,
        )
      }
      await facilityLoginImpl(facility)
    }
    // 「读一条源」的实现，由下游 scheduling 域建完 Scheduler 后回填（见 `setPackageReadSource`
    // 头注）。包的 `readSource` 闭包读的是**这个变量**，不是它此刻的值。
    let readSourceImpl: ReadSourceImpl | undefined

    // 同 npm 名的包两层都在（内置 + `stream update` 装来的新版）→ 按版本高者只装载一层的一切，
    // 另一层整包跳过并留日志（`pick-layer.ts` 头注）。这里是代码那条路；同一个结论（`picked.pick`）
    // 经 `layerPick` 交给 sources 域，它的 curated 投影 / recipe 装载 / 声明归并用同一把尺——
    // 四条路分家就是「Provider 行是新的、adapter 是旧的」。日志只从这里出一次（sources 域那两遍
    // 算的是同一份结论，不再报）。
    const picked = pickCodeLayer(packages, userPackages, log)
    const userCodePackages = picked.user
    const activatedResult = await activatePackages(
      [...picked.builtin.filter(isPluginEnabled), ...userCodePackages],
      // 装的是**包对象本身**，不是 id：第三方把 stream.id 写成 `alist` 也绝不会让内置那个
      // alist 被路由去动态 import（理由见 PackageEntries 的头注）。
      { builtin: config.builtinActivations ?? BUILTIN_ACTIVATIONS, dynamic: new Set(userCodePackages) },
      (pkg) => ({
        // 走 pluginTarget()（上面刚接线的那个 resolver），不是 resolvePluginTarget()——后者只解
        // compose 档的容器 DNS，host 档一律 null。两个档的取址差异归 resolver 管，包不该知道。
        backendUrl: (service) => pluginTarget(service ?? pkg.backend?.service ?? pkg.id) ?? undefined,
        withAwake: (service, fn) => withAwake(service, fn),
        cookieFor: makeCookieFor(pkg, (domain) => ctx.credentials.cookieProvider.cookieString(domain)),
        // 转发到上面那个共用入口——它每次现读回填变量。**别在这儿抓快照**：实现由下游的
        // auth 域在自己起来之后才回填（`setFacilityLogin`，理由见那一格头注：sources/harvest
        // 在装载序上排在本域后面，本域 inject 它俩就是环），抓快照就是 AGENTS.md 记的
        // "前向 let + 回填"那个坑——永远拿到回填之前那一份 undefined。
        login: (facility) => facilityLogin(facility),
        // 同一形状：thunk 现读回填变量，包名限定在闭包里判（只许跑自己的源）。
        readSource: makePackageReadSource(pkg, () => readSourceImpl),
        // 宿主那一份正文抽取（`/api/enrich?source=link` 同一个实现、同一份缓存）。无状态、无登录态，
        // 直接借函数本身，没有回填这回事。
        readArticle: (url) => extractArticle(url),
        log: (msg) => log(`[${pkg.id}] ${msg}`),
        config: configForPackage(pkg.id),
      }),
    )
    // 「这次没装起来的包」只有一本台账：读不动的（上面扫描时跳过的）和执行期炸了的合成一份，
    // 消费者（日志、事件层）就不用知道它是在哪一步倒下的。
    const activated: ActivatedPackages = {
      adapters: activatedResult.adapters,
      failures: [...unreadableUserPackages, ...activatedResult.failures],
      actions: activatedResult.actions,
      enrichers: activatedResult.enrichers,
      connect: activatedResult.connect,
    }
    log(`[stream] activated ${activated.adapters.size} package adapter(s): ${[...activated.adapters.keys()].join(', ') || '(none)'}`)
    // 第三方包**执行期**炸了（少打包一个依赖 / 顶层抛错 / 没导出 activate）不掀翻 bootstrap——
    // 那是这个包自己的问题，掀翻了用户在 UI 里恢复不了。它这次不生效，但必须响亮：这里一条日志，
    // 加一条事件（events 在装配序上更靠后，先攒着，见 `activated.failures` 的消费点）。
    for (const f of activated.failures) {
      log(`[stream] package "${f.id}" 装载失败，本次不生效（${f.dir}）：${f.error.message}`)
    }

    // Read-only plugin status: per-plugin backend url from config override → gateway default.
    // Probe only ENABLED plugins — a disabled plugin yields no status row, so mergePluginStatus
    // leaves its catalog entry untouched (keeps status='disabled', doesn't downgrade to needs_config)
    // and its (possibly stopped) container is never health-checked.
    const probePluginStatus = () =>
      aggregatePluginStatus(
        plugins.filter(isPluginEnabled),
        // 宿主不替任何内置容器包读显式地址（config.yaml 里没有这类键）：aggregatePluginStatus
        // 自己兜底到 pluginTarget（compose 容器 DNS）/ standby snapshot（host 档睡着 → 不发探针）。
        // 包自己读的环境变量覆盖（如某包 README 写的 `<X>_URL`）只影响包的取数，不影响这里的探针——
        // 探的是宿主托管的那个容器，不是外部实例。
        () => undefined,
      )

    // Stale-while-revalidate cache around the probes. GET /api/plugins sits on the Plugins page's
    // critical path; with down containers each visit used to pay a fresh probe round (3s timeout
    // each — the "sidebar → Plugins takes 10s" bug). Now: warm cache answers instantly (a stale one
    // still answers instantly and refreshes in the background); only the very first call after boot
    // waits, capped by PROBE_TIMEOUT_MS since probes run in parallel. Each completed round is
    // emitted on the DebugBox `plugins` channel with per-plugin timings.
    let pluginStatusCache: { rows: PluginStatus[]; at: number } | null = null
    let pluginStatusInflight: Promise<PluginStatus[]> | null = null
    const refreshPluginStatus = () => {
      // track 'plugin-status' span: TTL 到期/预热触发的一轮容器健康探测(docker inspect + health fetch)。
      pluginStatusInflight ??= track('plugin-status', async () => {
        const started = Date.now()
        try {
          const rows = await probePluginStatus()
          pluginStatusCache = { rows, at: Date.now() }
          // "probed" = a health fetch actually ran. probeMs is set only on that path, so it says
          // exactly that; the old proxy (mode !== 'n/a') also counted rows whose base never
          // resolved but whose owner had once picked a deployment mode — those showed `unknown ?ms`.
          const probed = rows.filter((r) => r.probeMs !== undefined)
          const down = probed.filter((r) => r.health === 'down')
          config.onDebug?.({
            id: `plugins:probe@${started}`,
            at: started,
            channel: 'plugins',
            key: 'probe',
            title: '插件健康探测',
            summary: `探测 ${probed.length} 个插件 ${Date.now() - started}ms${down.length ? ` · ${down.map((r) => r.id).join(', ')} down` : ' · 全部 ok'}`,
            ok: down.length === 0,
            fields: probed.map((r) => ({
              label: r.id,
              value: `${r.health} ${r.probeMs ?? '?'}ms ${r.base ?? ''}`.trim(),
              tone: r.health === 'ok' ? ('ok' as const) : ('bad' as const),
            })),
          })
          return rows
        } finally {
          pluginStatusInflight = null
        }
      })
      return pluginStatusInflight
    }
    const pluginStatus = (): Promise<PluginStatus[]> => {
      if (pluginStatusCache) {
        if (Date.now() - pluginStatusCache.at >= PLUGIN_STATUS_TTL_MS) void refreshPluginStatus().catch(() => {})
        return Promise.resolve(pluginStatusCache.rows)
      }
      return refreshPluginStatus()
    }
    // Prewarm the probe cache shortly after boot (delayed past the boot rush so the event loop is
    // idle — probing during startup skews timings and misreports healthy backends as down), so the
    // first sidebar visit to Plugins hits the cache instead of paying a cold probe round.
    // 登记成 effect：关停后这一轮预热不该再醒过来碰容器（已 unref，所以只是悬空不是卡住）。
    ctx.effect(() => {
      const timer = setTimeout(() => void refreshPluginStatus().catch(() => {}), PLUGIN_STATUS_PREWARM_MS)
      timer.unref?.()
      return () => clearTimeout(timer)
    })

    /** Persist + live-apply a plugin enable toggle. Required plugins reject (locked on). Source
     *  (un)registration happens at boot, so the registry effect lands after a restart; the returned
     *  summary + catalog/status flip immediately (this refreshes the live map the predicate reads). */
    const setPluginEnabled = (id: string, enabled: boolean): PluginSummary => {
      const d = plugins.find((p) => p.id === id || pluginIdForDescriptor(p) === id)
      if (!d) throw new Error(`unknown plugin: ${id}`)
      if (d.required) throw new Error(`plugin ${id} is required and cannot be disabled`)
      settings.setPluginEnabled(d.id, enabled)
      pluginEnabledMap = settings.get().plugins ?? {} // refresh the closure the predicate reads
      const summary = config.catalogSummary(pluginIdForDescriptor(d))
      if (!summary) throw new Error(`plugin ${id} missing from catalog`)
      return summary
    }

    /**
     * 「装了什么」的统一目录（`GET /api/packages`）。**同一把尺**：走 `scanPackages`，不另造一套
     * 目录扫描（见 `src/packages/scan.ts` / `listInstalledRecipePackages` 的头注）。
     *
     * 两层取法不同，是有意的：内置层（仓库自带 `packages/`）运行时不会变，用启动时已经扫好的
     * `packages` 即可；**用户层每次现扫**——刚 install 完的包不在任何启动快照里，用快照会让用户
     * 装完看不到自己刚装的东西。
     *
     * `enabled` 只发给填了插件槽位的包（buildPackageInventory 默认按 `fillsPluginSlot` 判）：
     * `PUT /api/plugins/:id/enabled` 认的正是那批，纯 recipe 包翻了也没有东西会响应。
     */
    const packageInventory = (): PackageSummary[] => {
      // 读不动的包在这里**不能抛**（这是每次请求现扫的读路径，抛 = 整页 500、一个包都看不见），
      // 也不能悄悄少一行（用户会以为没装上，去装第二遍）。所以收集起来，照样出一行，
      // 由 `PackageSummary.unreadable` 说清它为什么读不动。
      const unreadableUser: { dir: string; error: Error }[] = []
      const user = scanPackages(recipesUserDir, {
        ...USER_LAYER_SCAN,
        onPackageError: (dir, error) => void unreadableUser.push({ dir, error }),
      })
      return buildPackageInventory({
        builtin: packages,
        user,
        enabled: (id) => isPluginEnabled({ id, required: plugins.find((p) => p.id === id)?.required }),
        unreadableUser,
      })
    }

    /**
     * 「包」页对容器的两个动作（看日志 / 重启）。参数与上面那次 `provisionDeclaredBackends`
     * 必须对齐——同一个网络名、同一个 host 档 loopback 判据、同一把 credential token。
     *
     * `manageEnabled` 在这里的含义比 provision 那边**窄**：它只挡「容器不存在时替你新建」，
     * 不挡重启一个已经存在的容器。那个开关管的是"要不要替你建"，而重启是用户对着一个
     * 崩溃回环的容器唯一的自助动作，拿它挡住等于把容器锁死。
     */
    const containerOps = makeContainerOps({
      descriptors: () => backendDirectory.all(),
      mode: netMode,
      manageEnabled: config.manageContainers,
    })

    /** 面板读的状态（token 永不回显）。读活值：接管在启动之后才跑成时这里跟着变。 */
    const alistStatus = () => ({ hasToken: !!alistCfg().token })
    /** 面板的活探测：一次已认证的 fs/list。手里没 token 时经接管通道现取——探测本身就会把
     *  「启动时没接管成」这件事补上。 */
    const testAlist = async (): Promise<{ ok: boolean; error?: string }> => {
      if (!alistManaged()) return { ok: false, error: '网盘底座包未启用' }
      try {
        await hostAlistClient({ token: alistCfg().token ?? '', refresh: alistRefresh }).listDir('/')
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }

    /** 见 `AlistFacet.permanentToken`。读的是活值：row 里的（接管刷新过的）优先，其次 boot 期解析的。 */
    const alistPermanentToken = async (): Promise<string | undefined> => {
      const token = alistCfg().token ?? alistToken
      if (!token) return undefined
      if (!isJwtLike(token)) return token
      // 地址在 withAwake 里面取：容器睡着时它是空的（同 `hostAlistClient` 的 `around`）。
      const read = (t: string) => withAwake(ALIST_SERVICE, () => fetchPermanentToken(resolveAlistUrl(), t))
      try {
        return await read(token)
      } catch (e) {
        if (!/401/.test((e as Error).message)) throw e
        // JWT 过期：重登一次再读一次。
        return read(await alistRefresh())
      }
    }

    ctx.provide('packages', {
      packages,
      plugins,
      layerPick: picked.pick,
      backendDirectory,
      netMode,
      isPluginEnabled,
      setPluginEnabled,
      packageInventory,
      pending,
      containerOps,
      pluginStatus,
      alist: {
        // 活值：接管把 token 存进 row 之后（包括启动之后才跑成的那一次）这里跟着变。
        get token() { return alistCfg().token ?? alistToken },
        managed: alistManaged,
        status: alistStatus,
        test: testAlist,
        refresh: alistRefresh,
        permanentToken: alistPermanentToken,
      },
      configForPackage,
      activated,
      provisionNotices: provisioning.notices,
      setFacilityLogin: (fn) => { facilityLoginImpl = fn },
      facilityLogin,
      setPackageReadSource: (fn) => { readSourceImpl = fn },
    } satisfies PackagesService)
  },
}
