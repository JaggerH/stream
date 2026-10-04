import type { Context } from 'cordis'
import { join } from 'node:path'
import { Registry } from '../../registry/registry.ts'
import { sealManifests } from '../../registry/seal.ts'
import { loadRsshubCatalog, parseRsshubCatalog } from '../../rsshub-catalog.ts'
import { catalogNeedsRefresh, readCatalogCache, writeCatalogCache } from '../../rsshub-catalog-cache.ts'
import type { SourceManifest } from '../../manifest/types.ts'
import {
  mountRecipePackages,
  loadRecipePackages,
  mergeRecipePackagesByFacility,
  servingPoliciesOf,
  retiredRoutesOf,
  rsshubNamespaceNormalizersOf,
  rsshubNoBrowserNamespacesOf,
  rsshubCookieEnvOf,
  providerDeclarationsOf,
  searchSourcesOf,
  linkTableOf,
  USER_LAYER_SCAN,
  BUILTIN_LAYER_SCAN,
  type LinkTableEntry,
  type RecipePackage,
} from '../../replay/recipe-package.ts'
import { setLinkDebugSink, setLinkDeclarationSource } from '../../links/recognize.ts'
import { setServingPolicySource } from '../../media/serving.ts'
import { setPackageIdentities } from '../../providers/identities.ts'
import { setPackageSearchSources } from '../../search/seeds.ts'
import { setPackageCookieEnvSource } from '../../credentials/cookie-provider.ts'
import { setItemProjectionSource } from '../../http/client-item.ts'
import { setSourceSiteSource } from '../../registry/public.ts'
import { sourceSitesOf } from '../../packages/item-projection.ts'
import type { Recipe } from '../../replay/recipe.ts'
import { provisionedConfigSlot } from '../../replay/recipe-provisioner.ts'
import { watchTree } from '../../replay/watch-tree.ts'
import { npmRegistryClient, officialRegistryIfMirror } from '../../replay/recipe-registry.ts'
import {
  previewRecipePackage,
  installRecipePackage,
  uninstallRecipePackage,
  checkRecipeUpdates,
  listInstalledRecipePackages,
  readHostVersion,
  type RecipeInstallDeps,
  type RecipeUpdateCandidate,
  type UninstallNotice,
} from '../../replay/recipe-install.ts'
import { keyStateOf } from '../../credentials/key-state.ts'
import { runtimeSpecToSchema } from '../../manifest/runtime-config.ts'
import { deprovisionService } from '../../plugins/deprovision.ts'
import { scanPackages } from '../../packages/scan.ts'
import { occupiedByBuiltins, withInstalled } from '../../packages/activate.ts'
import type { TrackSyncFn } from '../../op-track.ts'

declare module 'cordis' {
  interface Context {
    /** 「这台 Stream 认识哪些 Source」这一域（`src/kernel/plugins/sources.ts`）。 */
    sources: SourcesService
  }
}

/** 一份活的 recipe 表的 holder。**消费者读 `.current`**，重载时整体换掉里面那张 Map。 */
export interface LiveRecipes {
  current: Map<string, Recipe>
}

export interface RecipePackageOps {
  preview: (name: string, version?: string) => Promise<unknown>
  install: (name: string, version: string | undefined, confirm: string) => Promise<unknown>
  uninstall: (name: string) => Promise<boolean>
  updates: () => Promise<RecipeUpdateCandidate[]>
  search: (q: string) => Promise<unknown>
  listInstalled: () => Promise<unknown>
}

/** 启动那次装载里被跳过的一个包（坏 JSON / schema 过高 / manifest 不合法 / id 撞了别人）。 */
export interface RecipeMountFailure {
  /** 包目录绝对路径——用户要恢复就得找到它，所以点名的是目录不是 facility。 */
  dir: string
  error: Error
}

/**
 * 「这一格配置能自助申请，跑的是这条」——`configProvisionerFor` 的回执，也是 HTTP 面
 * `POST /api/source-runtime-config/status` 里那格 `provisioner` 的原样投影。
 *
 * 每一格都是**用户下决心之前要知道的事**，不是调试信息：跑起来会在他自己的 Chrome 里打开
 * 哪一页（`entryUrl`）、以谁的名义（`label`）、会把哪一格填满（`field`）、还要他填什么
 * （`paramsSchema`）。少一格，那颗按钮就变成"点下去不知道会发生什么"。
 */
export interface ConfigProvisioner {
  /** 跑它时用的 Source 全名（带命名空间），如 `@streamapp/groq/groq-create-key`。 */
  sourceId: string
  /** 会被写满的那个 secret 字段名。 */
  field: string
  /** 会在用户自己的 Chrome 里打开的那一页——文案要如实点名它。 */
  entryUrl: string
  /** 人看的站点名（recipe 的 facility label），如 `Groq`。 */
  label: string
  /** 这条 recipe 自己的参数（如 key 名）。前端照它渲染表单。 */
  paramsSchema: Record<string, unknown>
}

export interface SourcesService {
  /** 三组 manifest 合成的唯一目录：curated（含插件自带）+ recipes + RSSHub 全量长尾。 */
  registry: Registry
  /** recipe 包按 facility 归并后的快照。**每次调用现取**——install 后重载会整体换掉它。 */
  recipePackages: () => { byFacility: Map<string, RecipePackage>; list: RecipePackage[] }
  /** 活的 recipe 表（holder）：replay 侧的 store 每次 load 走 getter，改正文下一次 fetch 即生效。 */
  liveRecipes: LiveRecipes
  /**
   * 这份 recipe 是不是来自内置层——`secret_params` 闸 3 的判据（凭据只注入给内置包）。
   *
   * **按对象身份判，不按 id**：map 的键带命名空间前缀，recipe 体里的 `sourceId` 是局部名，
   * 拿后者去查前者恒为 false。**每次调用现查**：热重载会整体换掉这份集合，冻在装配那一刻
   * 等于新装的包永远算不上内置（而这个方向的错是静音的）。
   */
  isBuiltinRecipe: (recipe: Recipe) => boolean
  /**
   * 反查：**这一格配置有谁能替用户去申请**（`runtime_config.ref` → 那条 recipe）。
   *
   * 存在的理由：recipe 那一侧早就声明了「我产出 ref X 这把钥匙」（`provisionedConfigSlot`），
   * 而配置界面手里只有「我这一格要 ref X」——两头都在，中间没有一条能从后者查到前者的路，
   * 于是一条跑得通的自助申请在界面上等于不存在（groq 就这么躺了）。
   *
   * **只认内置层**，与 `secret_params` 闸 3 同一条理由的镜像：那条闸挡「把用户已有的凭据交给
   * 从网上装来的数据」，这条挡反方向的同一件事——第三方包只要声明 `runtime_config.ref: 'groq'`
   * 就能让内置 groq 那张配置卡长出一颗「一键帮我完成」，点下去跑的是它的 recipe、写的是用户
   * 真正在用的那格 key。判据按对象身份问 `builtinRecipesRef`（键带命名空间、recipe 体里是局部名，
   * 拿 id 比恒为 false），**每次调用现查**——热重载整体换表，冻一份等于新装的包永远不算内置。
   *
   * 同一个 ref 有多条候选时取**排序后的第一条**：一格配置只该有一个自助申请入口，让它稳定，
   * 别随 Map 的插入顺序在两次刷新之间跳来跳去。
   */
  configProvisionerFor: (ref: string) => ConfigProvisioner | null
  /** 内置那层 recipe 的目录（= 内置包目录，只读）。 */
  recipesBuiltinDir: string
  /** 用户可写的那层（install 的落地处）。 */
  recipesUserDir: string
  /** npm recipe 包的安装面（preview → install 两步 + 卸载 / 更新 / 搜索 / 列表）。 */
  recipePackageOps: RecipePackageOps
  /** 立即重挂两层 recipe（换 registry 的 recipes 组 + liveRecipes + 归并快照）。绝不抛。 */
  reloadRecipePackages: () => void
  /**
   * 启动那次装载跳过了哪些包。**bootstrap 在事件层建好之后逐条发通知**——本域比事件层早挂，
   * 这里发不出去（同 `packageActivationFailures` 那条路）。只写日志等于没说：用户看到的现象
   * 是「我装的那个源不见了」，而日志他不会去看。
   */
  mountFailures: RecipeMountFailure[]
  /** 「这个 Source 的 key 配没配」——只报层（stored/env/missing），**从不回值**；无 secret 声明的
   *  源返回 null。perInstance 源按成员 `params.tokenName` 取层。判定规则全在
   *  `credentials/key-state.ts`，本域只负责把 manifest（registry）和 TokenProvider 接上——
   *  它问的是一个 Source 的事，所以归本域，而不是采集调度域。
   *  见 app.ts `HttpDeps.keyState` 头注。 */
  keyState: (sourceId: string, memberParams?: Record<string, unknown>) => 'stored' | 'env' | 'missing' | null
  /** 「RSSHub 长尾目录该重取了吗」——没缓存或缓存过期。取它的时机由 adapter 定（见下）。 */
  rsshubCatalogNeedsRefresh: () => boolean
  /** 已加载的包声明的退役目录路由（id → 理由）。**调用时现取**：热装一个包之后表就变了。
   *  与 catalog 解析吃的是同一份表（`retiredRoutesOf`）；provider 域拿它判「系统行上指向
   *  被包顶掉的目录路由的成员」是死成员（`pruneDeadMembers`）。 */
  retiredRoutes: () => ReadonlyMap<string, string>
  /**
   * 收下一份新取回来的 RSSHub 目录：落盘缓存 + 换掉 registry 里的长尾。
   *
   * **谁来喂它**：`RssHubAdapter` 在一次真的取数之后（那时 worker 已经热着，`/api/namespace`
   * 只要 67ms）。不在开机时取，是因为拉起 worker 要 +168MB RSS，而它起来就不会自己退——
   * 从不碰 RSSHub 源的用户不该背这份内存。全部推理在 `src/rsshub-catalog-cache.ts` 的头注。
   */
  applyRsshubCatalog: (raw: Record<string, unknown>) => number
}

export interface SourcesConfig {
  /** 内置包目录——同时是内置那层 recipe 的所在。 */
  builtinDir: string
  /** 可写状态根目录；用户层 recipe 住 `<dataDir>/recipes`。 */
  dataDir: string
  /** RSSHub 全量路由目录的文件路径。读不到只降级成「只有 curated」，不掀翻启动。 */
  rsshubCatalog: string
  log: (...args: unknown[]) => void
  /** 整轮重挂是同步解析每一份 recipe —— 大目录上的已知 loop 卡顿嫌疑人。 */
  trackSync?: TrackSyncFn
  onDebug?: (entry: import('../../debug.ts').DebugEntry) => void
  /**
   * 卸载时收容器没收成要说的那句话。**前向引用是有意的**：事件层在装配序上更靠后，
   * 而这个只在用户点卸载时才调。不给 = 沉默，而沉默正是这条缺陷的形状。
   */
  notifyUninstall?: (n: UninstallNotice, pkgName: string) => void
}

/** watcher 收到文件事件后的合并窗口：一次编辑常常触发好几个事件。 */
const RECIPE_RELOAD_DEBOUNCE_MS = 300

/**
 * Source 这一域：**这台 Stream 认识哪些 Source，以及它们从哪来**。
 *
 * 三层来路合成一个 `Registry`：包自带的 curated 清单（只收**启用**的包——这就是启用开关的
 * 全部机制）、recipe 包（内置 + 用户装的，同 npm 名两层只装版本高的一层）、RSSHub 的全量路由长尾。
 * `sealManifests` 在进 Registry 之前把派生展示字段写死，出了 registry 的 manifest 一律已填满。
 *
 * **热重载是本域唯一的活动部件**：watch 两个 recipe 目录 → debounce → 整体重挂。
 * 重挂只换三样东西（registry 的 recipes 组 / `liveRecipes.current` / 归并快照），
 * **holder 不换**——消费者持的是 holder 引用，把 `.current` 在装配期解开就等于冻结在启动那一刻。
 *
 * 句柄两个，都登记成 effect：watcher 本身，以及那个 pending 的 debounce 定时器
 * （不 clear 的话，关停之后它还会跑一次重载去碰一个已经撤掉的 registry）。
 */
export const sourcesPlugin = {
  name: 'sources',
  // credentials 只为 keyState 那一格（TokenProvider.layer）；它比本域早挂，inject 把这条依赖
  // 写明白，免得靠装载顺序心照不宣。
  inject: ['packages', 'credentials', 'settings'],
  apply(ctx: Context, config: SourcesConfig): void {
    const { log } = config
    const trackSync: TrackSyncFn = config.trackSync ?? (<T,>(_name: string, fn: () => T) => fn())
    const { packages, plugins, isPluginEnabled, layerPick } = ctx.packages

    // registry: curated manifests + RSSHub's full route catalog (long tail).
    // sealManifests 在进 Registry 前把派生展示字段(pluginId/pluginName/title)写死 —
    // 出了 registry 的 manifest 一律已填满,读取端零推导(见 src/registry/seal.ts)。
    // Only ENABLED plugins contribute sources to the registry — the core mechanism behind the
    // enable toggle (disabled plugin's sources simply never get registered). The full descriptor
    // list still flows to StreamService/sealManifests so the catalog lists disabled plugins too.
    // **被用户层同名新版顶掉的内置包也不出 curated**（`layerPick`，与代码激活同一个结论）：它的
    // `manifests.yaml` 由用户层那份经 recipes 组进 registry，这里再出一份就是 `Duplicate manifest id`
    // → 用户装的那个包整包被跳过。描述符本身留在 `plugins` 里（目录 / pluginName 查表照旧）。
    const pkgNameOf = new Map(packages.map((p) => [p.id, p.pkgName]))
    const supersededByUserLayer = (p: { id: string }) => {
      const name = pkgNameOf.get(p.id)
      return name != null && layerPick.skipBuiltinNames.has(name)
    }
    const curated = plugins.filter(isPluginEnabled).filter((p) => !supersededByUserLayer(p)).flatMap((p) => p.sources || [])
    // 两层装载的开关（`LayerOptions`），启动与热重载共用一份：
    //  - `pick`：**冻住**启动那次的结论。curated 不热换，recipes 组对同一对包必须永远给同一个答案，
    //    否则运行中装一个同名新版会让之后每一轮热重载都撞 Duplicate（改 recipe 也不生效）。
    //  - `supersededBuiltinDisabled`：开关是活的，按 npm 名现查——被顶掉的内置禁用了，用户层那份也不装。
    //  - `builtinHasCurated`：运行中新装的同名新版要不要等重启——只看它顶掉的内置**此刻**有没有清单
    //    在 curated 里（禁用的内置不出 curated，不算）。
    const builtinPluginsNamed = (name: string) => plugins.filter((p) => pkgNameOf.get(p.id) === name)
    const layerOptions = {
      pick: layerPick,
      supersededBuiltinDisabled: (name: string) => {
        const ds = builtinPluginsNamed(name)
        return ds.length > 0 && ds.every((p) => !isPluginEnabled(p))
      },
      builtinHasCurated: (name: string) => builtinPluginsNamed(name).some((p) => isPluginEnabled(p) && (p.sources?.length ?? 0) > 0),
    }
    // recipe packages: builtin(app resources, read-only) + user(<dataDir>/recipes)；同 npm 名两层只装版本高的一层（pick-layer.ts）。
    // mount 在进 Registry 前完成 — schemaVersion/pluginId 门禁在此,坏包 fail loud(见 recipe-package.ts)。
    const recipesBuiltinDir = config.builtinDir
    const recipesUserDir = join(config.dataDir, 'recipes')
    // 热重载**静默失效**过：改了 recipe 没反应，第一反应是「我 recipe 写错了」而不是
    // 「重载没跑」，于是去查一个不存在的 bug。整条链路上三件事在外面长得一模一样——
    // 监听器没收到事件 / 收到了但重载抛了（只 log，页面上看不见）/ 重载跑完了但装载数没变。
    // 所以三处都往 debug bus 发一条：`GET /api/debug/log?channel=recipe-reload` 就能分清是哪一种。
    // 启动期跳过的坏包也发在这个频道——排查路径不该因为"这次是启动还是热重载"分叉。
    let recipeWatchEvents = 0
    const emitReload = (
      key: string,
      title: string,
      summary: string,
      ok: boolean,
      fields: import('../../debug.ts').DebugField[] = []
    ) => {
      const at = Date.now()
      config.onDebug?.({ id: `recipe-reload:${key}@${at}`, at, channel: 'recipe-reload', key, title, summary, ok, fields })
    }

    // 启动期装载：**一个坏包只掉自己那一格，不掀翻整个后端**。热重载那条路早就是 try/catch
    // 保留上一份（见 reloadRecipePackages），启动这条以前是裸的——而启动失败的代价高一个
    // 量级：8900 上没人听，用户唯一的恢复手段是自己去文件系统把包删掉。三处一起说（日志 /
    // debug bus / 事件层通知），少一处用户就只会看到「我装的那个源不见了」。
    const mountFailures: RecipeMountFailure[] = []
    const skipPackage = (dir: string, err: Error) => {
      if (mountFailures.some((f) => f.dir === dir)) return   // 两层装载各扫一遍，同一个包别报两次
      mountFailures.push({ dir, error: err })
      log(`[stream] recipe package skipped (${dir}): ${err.message}`)
      emitReload('skipped', 'recipe 包被跳过', `${dir}：${err.message}`, false, [
        { label: '包目录', value: dir },
        { label: '错误', value: err.message, tone: 'bad' },
      ])
    }
    const recipePkgs = mountRecipePackages(recipesBuiltinDir, recipesUserDir, skipPackage, layerOptions)
    // 措辞是「盘上读出来多少」，不是「装进去多少」——后者是下面那行 registry 汇总的事。
    // 两行都说 mounted 的话，降级摘掉包之后它们会读起来像互相印证，而其实一个是装载前、
    // 一个是装载后。
    if (recipePkgs.manifests.length) log(`[stream] recipe packages: ${recipePkgs.manifests.length} sources read from disk (builtin=${recipesBuiltinDir} user=${recipesUserDir})`)
    // recipe package descriptors (dir/facility/sources) — 供配置分享导出内嵌 + 版本比对（user 同 facility 覆盖 builtin）。
    // holder 而非 const 快照：install 热挂载后 reloadRecipePackages 会重建 current，否则新装包的
    // rateLimit 活体读不到、bundle 导入去重表也看不到（2026-08-01 最终评审 I-1）。三处消费都经它读：
    //   ① 活体 FacilityRateLimiter ② install 的钳制源 recipeInstallDeps.facilityRateLimit ③ 分享导入去重表。
    const recipePackagesRef = { current: mergeRecipePackagesByFacility(recipesBuiltinDir, recipesUserDir, skipPackage, layerOptions) }
    // 送字节策略表：所有 recipe 包的 stream.serving 并成一张，thunk 现取（reloadRecipePackages 重建
    // current 后自动跟上；存结果 = 新装的包永远不走代理，且不报错）。
    setServingPolicySource(() => servingPoliciesOf(recipePackagesRef.current.list))
    // 包声明的 Provider 行并进身份表。**装配期一次，不是 thunk**（理由见 identities.ts 头注：
    // 下游 ensureSystemRows 会按表建行/删行）。provider 域 inject 了 'sources'，所以这一行
    // 必然早于 ensureSystemRows 跑。被拒的行要出声——静默丢一条 = 用户装了包却没有那个能力。
    for (const bad of setPackageIdentities(providerDeclarationsOf(recipePackagesRef.current.list))) {
      log(`[stream] package provider row rejected: ${bad.id} (from ${bad.facility}) — ${bad.reason}`)
    }
    // 链接认领表（spec 2026-09-26-link-recognition）：thunk 现取，热装的包下一次认领就生效。
    // 并表结果按「这一份包列表」缓存——reloadRecipePackages 换掉 current 才重算，撞主机 / 撞平台
    // 被拒的包也只在重算那一次出声（每次认领都喊一遍就成了噪音，没人会看）。
    let linkMemo: { list: RecipePackage[]; entries: LinkTableEntry[] } | null = null
    setLinkDeclarationSource(() => {
      const list = recipePackagesRef.current.list
      if (linkMemo?.list === list) return linkMemo.entries
      const table = linkTableOf(list)
      for (const bad of table.rejected) {
        log(`[stream] package links rejected: ${bad.package} — ${bad.reason}`)
        emitReload('links-rejected', '包的链接认领被拒', `${bad.package}：${bad.reason}`, false, [
          { label: '包', value: bad.package },
          { label: '原因', value: bad.reason, tone: 'bad' },
        ])
      }
      linkMemo = { list, entries: table.entries }
      return table.entries
    })
    setLinkDebugSink((e) => {
      const at = Date.now()
      config.onDebug?.({ id: `links:${e.key}@${at}`, at, channel: 'links', key: e.key, title: e.title, summary: e.summary, ok: e.ok, fields: [] })
    })
    // 资源搜索源元数据（展示键 / 标签 / 查询参数 / 形状）：同链接认领表，thunk 现取。
    setPackageSearchSources(() => searchSourcesOf(recipePackagesRef.current.list))
    // RSSHub 要的 cookie 环境变量名由包声明（`stream.rsshubCookieEnv`）。同 serving / 链接认领表，
    // thunk 现取：热装的包下一次取凭证就生效。本域不持有 cookieProvider（它在
    // ctx.credentials.cookieProvider），接的是模块级 thunk——不用拿到实例，这正是选 thunk 而不是
    // 构造参数的原因。
    setPackageCookieEnvSource(() => rsshubCookieEnvOf(recipePackagesRef.current.list))
    // 退役表来自包声明；catalog 在包快照之后解析才拿得到它。**边界**：目录只在启动与
    // applyRsshubCatalog 刷新时解析，新装一个带 retires 的包要到下一次刷新/重启才生效（记进 PACKAGE.md）。
    const retiredRoutes = () => retiredRoutesOf(recipePackagesRef.current.list)
    // 命名空间 normalizer 同理来自包声明。两个包认领同一个 ns 时 rsshubNamespaceNormalizersOf 抛，
    // 这里不吞——那是装载期的配置冲突，静默取一个会让渲染随磁盘顺序漂。
    const nsNormalizers = () => rsshubNamespaceNormalizersOf(recipePackagesRef.current.list)
    // 「标了 puppeteer 但带 cookie 纯 HTTP 能跑」的命名空间同理来自包声明（并集），生效边界同 retires。
    const noBrowserNamespaces = () => rsshubNoBrowserNamespacesOf(recipePackagesRef.current.list)
    // 三个解析点共用一份 opts：包认领撞上宿主自己那张 normalizer 表时被丢弃，而丢弃必须出声
    // ——静默换掉一批路由的渲染规则，表现是"这个源今天渲染对、明天不对"，没有一处会喊。
    const catalogOpts = () => ({
      retired: retiredRoutes(),
      namespaceNormalizers: nsNormalizers(),
      noBrowserNamespaces: noBrowserNamespaces(),
      onRefusedClaim: ({ ns, normalizer }: { ns: string; normalizer: string }) =>
        log(`[stream] RSSHub 命名空间认领被拒：包 ${normalizer} 认领 "${ns}"，但宿主自己已经认领了它`),
    })
    // catalog 有两个来源：我们自己落的缓存（发行安装唯一的一份，见 rsshub-catalog-cache.ts）
    // 和开发检出的构建产物 routes.json。缓存优先——它是运行时现取的，比检出那份构建产物新
    // （实测 1981 ns vs 1670）。两个都没有就只有 curated，不掀翻启动。
    let catalog: SourceManifest[] = []
    const cached = readCatalogCache(config.dataDir)
    if (cached) {
      try {
        catalog = parseRsshubCatalog(cached.data as Parameters<typeof parseRsshubCatalog>[0], catalogOpts())
      } catch (e) {
        log(`[stream] RSSHub catalog cache unreadable (${(e as Error).message}) — falling back to the checkout`)
      }
    }
    if (!catalog.length) {
      try {
        catalog = loadRsshubCatalog(config.rsshubCatalog, catalogOpts())
      } catch (e) {
        // 发行安装上这一档必然走到（RSSHub 用到才装，目录缓存那时才落）：话术说清「还没装」，
        // 别把开发检出的默认路径念给用户听（活体 2026-09-06 win-test 日志里出现过 C:\home\jagger\…）。
        const missing = (e as NodeJS.ErrnoException).code === 'ENOENT'
        log(missing
          ? '[stream] RSSHub catalog not loaded — RSSHub 还没装（第一次跑到 RSSHub 源时自动装，目录随之落盘）；curated sources only'
          : `[stream] RSSHub catalog not loaded (${(e as Error).message}) — curated sources only`)
      }
    }
    const registry = new Registry(sealManifests(curated, plugins), undefined, sealManifests(catalog, plugins))
    // 下面那行汇总要报的是**真的进了 registry 的那个数**。降级摘掉包之后它和装载时的快照数
    // 就分家了，而来查「我装的包怎么没了」的人最先看的就是这行：数字对得上，他会去别处找
    // 原因——通知发对了、日志却在骗人，比没有日志更糟。
    let mountedRecipeSources = recipePkgs.manifests.length
    try {
      registry.swapGroup('recipes', sealManifests(recipePkgs.manifests, plugins), recipePkgs.builtinIds)
    } catch (e) {
      // 装载本身过了、进 registry 却整组被拒（典型：某个包的 sourceId 和 curated 撞了）。
      // 退化成**逐包重试**，只把撞的那个包摘出去。swapGroup 是原子的（先验后改），
      // 所以每次重试都从一个干净的状态出发。
      log(`[stream] recipe group rejected (${(e as Error).message}) — retrying package by package`)
      let accepted = new Map<string, SourceManifest>()
      for (const pkg of recipePkgs.byPackage) {
        const trial = new Map(accepted)
        for (const m of pkg.manifests) trial.set(m.id, m)   // 同全名两层重叠（无 npm 名的本地包）= user 覆盖 builtin，不是冲突
        try {
          registry.swapGroup('recipes', sealManifests([...trial.values()], plugins), recipePkgs.builtinIds)
          accepted = trial
        } catch (err) {
          skipPackage(pkg.dir, err as Error)
          // 它的 manifest 进不了 registry，recipe 正文留着也没人取得到——一并摘掉，
          // 免得 liveRecipes 里躺着一份「查得到、但没有源指向它」的僵尸。
          for (const m of pkg.manifests) if (!accepted.has(m.id)) recipePkgs.recipes.delete(m.id)
        }
      }
      mountedRecipeSources = accepted.size
    }
    // 尾巴上那句是必需的：数字变小而不说原因，下一个人会以为是自己把包删了。
    const skipped = mountFailures.length ? ` (${mountFailures.length} package(s) skipped)` : ''
    log(`[stream] registry: ${curated.length} curated + ${mountedRecipeSources} recipe + ${catalog.length} RSSHub catalog sources${skipped}`)
    // 条目投影（包的 `stream.item` + 源目录 → 出线条目上的按钮 / 作者现取入口 / 源名 / 站点）：
    // thunk 现取，同 serving / trackUrl——热装的包下一次读列表就生效。registry 查源吃存量的
    // 任何 id 形状（全名 / 裸名 / `plugin:` 前缀）；裸名歧义会抛，这里当查不到（不投影），
    // 列表读口不该因为一条 item 的源名二义就整页 500。
    setItemProjectionSource(() => ({
      packages: recipePackagesRef.current.list,
      lookup: (id) => { try { return registry.get(id) } catch { return undefined } },
    }))
    setSourceSiteSource(() => sourceSitesOf(recipePackagesRef.current.list))

    // 源 runtime_config 的 row family（spec config-rows-slice3）：row id = `source:<ref>`。
    // schema 由 manifest 字段现场翻译、存储绑 runtimeConfigs[ref]——manifest 每次现查，
    // recipe 热重载天然跟上。resolve 认不出 → 404，这就是「任意 ref 写入 = 一个源能改掉
    // 别的源的 key」那条护栏在通用面上的等价物（旧端点的 effectiveConfigRef 护栏保留，双保险）。
    const settings = ctx.settings
    ctx.effect(() =>
      settings.rows.registerFamily({
        prefix: 'source',
        resolve: (ref) => {
          // 1) 精确命中某 manifest 的共享 ref（perInstance 源的共享层同样走这）
          let rc = registry.all().find((m) => m.runtime_config?.ref === ref)?.runtime_config
          // 2) per-instance 实例 ref：`<ns>:<instance>`，ns 必须被某个 perInstance 源显式申报
          if (!rc) {
            const sep = ref.indexOf(':')
            const ns = sep > 0 ? ref.slice(0, sep) : ''
            const instance = sep > 0 ? ref.slice(sep + 1) : ''
            if (ns && instance) {
              rc = registry
                .all()
                .find((m) => m.runtime_config?.perInstance && m.runtime_config.instanceNamespace === ns)
                ?.runtime_config
            }
          }
          if (!rc) return undefined
          return {
            schema: runtimeSpecToSchema(rc),
            // user 层含 SettingsStore.runtimeConfig 的旧键投影（tmdb/omdb/llm-openai）；
            // raw 是裸存量——分开是为了不把投影值复制成第二份真相。
            user: () => {
              const v = settings.runtimeConfig(ref)
              return Object.keys(v).length ? v : undefined
            },
            raw: () => settings.runtimeConfigRecord(ref),
            write: (record) => settings.setRuntimeConfigRecord(ref, record),
            clear: () => settings.clearRuntimeConfigRecord(ref),
          }
        },
      })
    )

    // recipe 热重载：改/加 recipe 免重启。watch 两个 recipe 目录，debounce 后整体 re-mount —
    // registry 里原位换掉 recipes 组（新源立即可见），liveRecipes 换 Map（replay 侧 store 每次
    // load 走 getter，正文改动下一次 fetch 即生效）。坏包/坏 JSON 只 log，旧的继续用。
    const liveRecipes: LiveRecipes = { current: recipePkgs.recipes }
    /**
     * 内置层那批 recipe 的**对象身份**集合（`secret_params` 闸 3 的判据）。
     *
     * 从装载方给的 `builtinRecipeIds`（带命名空间的全名）换算成对象——因为唯一分得清层的是
     * 装载方，而唯一对得上的是身份：recipe 体里的 `sourceId` 是局部名，跟这批全名永远不等。
     * 用户层同名顶掉内置那份时装载方已经把 id 摘掉了，这里换算不出对象，自然也就不在集合里。
     */
    const builtinRecipeObjects = (m: { recipes: Map<string, Recipe>; builtinRecipeIds: Set<string> }) => {
      const set = new Set<Recipe>()
      for (const id of m.builtinRecipeIds) {
        const r = m.recipes.get(id)
        if (r) set.add(r)
      }
      return set
    }
    const builtinRecipesRef = { current: builtinRecipeObjects(recipePkgs) }
    let recipeReloadTimer: ReturnType<typeof setTimeout> | undefined
    // 热重载**静默失效**过：改了 recipe 没反应，第一反应是「我 recipe 写错了」而不是
    // 「重载没跑」，于是去查一个不存在的 bug。整条链路上三件事在外面长得一模一样——
    // 监听器没收到事件 / 收到了但重载抛了（只 log，页面上看不见）/ 重载跑完了但装载数没变。
    // 所以三处都往 debug bus 发一条：`GET /api/debug/log?channel=recipe-reload` 就能分清是哪一种。
    // 裸名歧义（第三方装了个与内置同名的源）是**降级不是错误**：解析仍走内置那条，与写下那条
    // 存量记录时的原意一致。但不说出来的话，用户后面看到的现象是「我装的那个源没生效」，
    // 而这件事一行日志都不会有。走 recipe-reload 同族频道，排查路径不用分叉。
    registry.onAmbiguity((n) => {
      log(`[stream] source id "${n.localName}" is ambiguous — resolved to builtin ${n.chosen} (candidates: ${n.candidates.join(', ')})`)
      emitReload('ambiguous', '源 id 有同名候选', `裸名 "${n.localName}" 解析为内置的 ${n.chosen}`, false, [
        { label: '裸名', value: n.localName },
        { label: '解析为', value: n.chosen },
        { label: '候选', value: n.candidates.join(', '), tone: 'bad' },
      ])
    })
    // trackSync 'recipe-reload' span: the debounced re-mount parses EVERY recipe synchronously —
    // a known loop-lag suspect on large recipe dirs.
    // 运行中装进来、这一轮先不装的同名新版——每个名字只说一次，别每次热重载都念一遍。
    const announcedDeferred = new Set<string>()
    const reloadRecipePackages = () => trackSync('recipe-reload', () => {
      try {
        // 同名两层的日志这次由这里出（只报启动后新出现的对：启动那批 packages 域已经报过）。
        const next = mountRecipePackages(recipesBuiltinDir, recipesUserDir, undefined, { ...layerOptions, log })
        // 用户刚装的新版顶掉了一个内置包，而那个内置包的 `manifests.yaml` 还在 curated 里（不热换）
        // ——这一轮没装它（否则撞 Duplicate、之后每一轮重载都失败），重启后切换。说一句人话，
        // 否则用户看到的是"装好了却没生效"。
        for (const name of next.deferred) {
          if (announcedDeferred.has(name)) continue
          announcedDeferred.add(name)
          log(`[stream] package ${name}: user layer installed, takes over on restart (the builtin's curated sources stay registered until then)`)
        }
        registry.swapGroup('recipes', sealManifests(next.manifests, plugins), next.builtinIds)
        liveRecipes.current = next.recipes
        // 闸 3 的集合跟着换：不换的话，热重载之后所有 recipe 都是新对象，旧集合一个都认不出，
        // 凭据注入会在「改了一次 recipe」之后静默全线失效。
        builtinRecipesRef.current = builtinRecipeObjects(next)
        // I-1: 重建 facility 归并快照，否则新装包的 rateLimit / 导出内嵌只在重启后才生效。
        recipePackagesRef.current = mergeRecipePackagesByFacility(recipesBuiltinDir, recipesUserDir, undefined, layerOptions)
        log(`[stream] recipe packages reloaded: ${next.manifests.length} sources`)
        emitReload('remount', 'recipe 重载完成', `${next.manifests.length} 个源已装载`, true, [
          { label: '装载源数', value: String(next.manifests.length) },
          { label: '累计收到事件', value: String(recipeWatchEvents) },
        ])
      } catch (e) {
        log(`[stream] recipe reload failed (keeping previous mount): ${(e as Error).message}`)
        emitReload('failed', 'recipe 重载失败', `保留上一份装载：${(e as Error).message}`, false, [
          { label: '错误', value: (e as Error).message, tone: 'bad' },
        ])
      }
    })
    // 监听走 watchTree（逐层非递归），**别换回 `fs.watch({recursive:true})`**——
    // 那条路在这台机器上只投递头两轮事件就彻底静默，理由和实测数字见 replay/watch-tree.ts。
    // 撤销时两件都要收：watcher 本身，和那个还没到点的 debounce ——
    // 只收 watcher 的话，关停后它仍会跑一次重载去碰一个已经撤掉的 registry。
    ctx.effect(() => {
      const watcher = watchTree([recipesBuiltinDir, recipesUserDir], () => {
        recipeWatchEvents++
        emitReload('watch', '收到文件事件', `第 ${recipeWatchEvents} 次`, true, [
          { label: '事件序号', value: String(recipeWatchEvents) },
        ])
        clearTimeout(recipeReloadTimer)
        recipeReloadTimer = setTimeout(reloadRecipePackages, RECIPE_RELOAD_DEBOUNCE_MS)
      })
      return () => {
        watcher.close()
        clearTimeout(recipeReloadTimer)
      }
    })

    // npm recipe 包安装(preview→install 两步)。userSourceIds 靠 package.json#name 认包(不靠目录名)——
    // dirNameFor 会把 scope 里的 `/` 换成 `__`,目录名本身不是包名。跳过没有 name 的目录(手放的本地包)。
    const recipeRegistry = npmRegistryClient()
    const recipeInstallDeps: RecipeInstallDeps = {
      registry: recipeRegistry,
      officialRegistry: officialRegistryIfMirror(),
      userDir: recipesUserDir,
      // 覆盖告知的数据源：**内置层里有没有同 npm 名的包**（判据是包名，不是 sourceId）。
      // 与 mountRecipePackages 走同一条装载路径，所以这里算出来的「会被换掉的全名」就是它落地
      // 之后真正被换掉的那些。
      builtinPackageSourceIds: (pkgName) => loadRecipePackages(recipesBuiltinDir, BUILTIN_LAYER_SCAN)
        .descriptors.filter((d) => d.name === pkgName).flatMap((d) => d.sources.map((s) => s.id)),
      facilityRateLimit: (f) => recipePackagesRef.current.byFacility.get(f)?.rateLimit,
      hostVersion: readHostVersion(),
      // 已经被占掉的 id / adapter / normalizer 名——第三方撞上就拒装（否则装进来是 fail-closed
      // 的开不了机，还得让用户去翻文件系统删包）。**两层都要**：
      //  ① 内置：读启动时已经扫好、宿主自己正拿着跑的那份 `packages`（包域给的同一份快照），
      //     不现扫——加一个内置包这里自动就多几行，没有第二份名单要维护。
      //  ② 已装的第三方：只查内置只挡了一半——两个第三方包申报同一个 adapter 名各自装都成功，下次
      //     启动 activatePackages 按设计「两边都不激活」→ 抛 → 开不了机。这一层必须现扫 userDir
      //     （本次会话里刚装的包不在任何启动快照里），扫失败就让安装当场失败，不猜。
      //     剔掉正在装的那个包自己，否则升级 / 重装会被自己上一版占的名字挡住。
      //  **两层都按 npm 名剔掉正在装的包自己**：内置带 code 的包也发 npm（今天 4 个），`stream add
      //  @streamapp/<pkg>` 装到的是同一个包的新版本，它申报的名字与内置那份一字不差；不剔内置那份，
      //  这条自我升级路在安装门就被拒，`pick-layer.ts` 那把「同名两层只激活一层」的尺子永远轮不到。
      //  **这一处故意不接 `onPackageError`**（启动路径与读路径都接了）：这里问的是「这个名字被占了
      //  吗」，跳过一个读不动的包 = 把它占着的名字当成空的，于是放行一次本该被拒的安装——用一次
      //  静默的撞名换掉一次吵闹的失败。读不出来就该当场拒绝，不猜。
      occupiedNames: (selfPkgName) => withInstalled(
        occupiedByBuiltins(packages, selfPkgName),
        scanPackages(recipesUserDir, USER_LAYER_SCAN),
        selfPkgName,
      ),
    }
    const recipePackageOps: RecipePackageOps = {
      preview: (name: string, version?: string) => previewRecipePackage(recipeInstallDeps, name, version),
      install: async (name: string, version: string | undefined, confirm: string) => {
        const r = await installRecipePackage(recipeInstallDeps, name, version, confirm)
        reloadRecipePackages()   // 立即挂载,不等 watcher(首跑 userDir 不存在时 watcher 没挂上)
        return r
      },
      uninstall: async (name: string) => {
        // 容器由这条路收（终审 Minor 5）：只删目录的话它下次启动既不在 provision 名单也不在
        // standby 名册 → 永不回收的常驻容器，而且一行日志都不会提。**不看 manage_containers**：
        // 那个开关管"要不要替你建"，收自己建的东西不受它管。
        const removed = await uninstallRecipePackage({
          userDir: recipesUserDir,
          deprovision: (service) => deprovisionService(service),
          notify: (n) => config.notifyUninstall?.(n, name),
        }, name)
        if (removed) reloadRecipePackages()
        return removed
      },
      updates: () => checkRecipeUpdates({ userDir: recipesUserDir, builtinDir: recipesBuiltinDir, registry: recipeRegistry }),
      search: (q: string) => recipeRegistry.search(q),
      listInstalled: async () => listInstalledRecipePackages(recipesUserDir),
    }

    // 「每天查一次有没有新版」**不在这里起定时器**：周期任务一律归调度中心（`src/tasks/builtin.ts`
    // 的 `recipe-update-check`，serve.ts 把 `recipePackageOps` 接进 TaskDeps 时装配），那里有账本、
    // 能手动「立即跑一次」、随进程一起收；一条裸的 setTimeout 链三样都没有，也不随这个域 dispose。

    // Provider 成员的 key 配置状态：判定规则（含 perInstance 源的取层 ref）全在
    // credentials/key-state.ts，这里只把 manifest 与 TokenProvider 接上。**每次调用现查
    // registry**——热重载装进来的新源立刻算数。
    const keyState = (sourceId: string, memberParams?: Record<string, unknown>) =>
      keyStateOf(registry.get(sourceId)?.runtime_config, memberParams, (ref) => ctx.credentials.tokenProvider.layer(ref))

    // ref → 能替用户申请它的那条内置 recipe（见 SourcesService.configProvisionerFor 头注）。
    // 不建常驻索引、每次现扫：recipe 表本来就只有几十条，而一份缓存要跟着热重载失效——
    // 漏了那一步的表现是"装了新包但按钮不出来"，静音且难查，省下的那点时间买不起它。
    const configProvisionerFor = (ref: string): ConfigProvisioner | null => {
      const hits: ConfigProvisioner[] = []
      for (const [sourceId, recipe] of liveRecipes.current) {
        if (!builtinRecipesRef.current.has(recipe)) continue
        const slot = provisionedConfigSlot(recipe)
        if (!slot || slot.ref !== ref) continue
        // provisionedConfigSlot 已经确认这是一条 canonical browser recipe（只有它有 extract），
        // 所以 entryUrl/meta 一定在场；这里只做投影。
        const meta = (recipe as { entryUrl: string; meta?: { facility?: { label?: string }; params_schema?: Record<string, unknown> } })
        hits.push({
          sourceId,
          field: slot.field,
          entryUrl: meta.entryUrl,
          label: meta.meta?.facility?.label ?? ref,
          paramsSchema: meta.meta?.params_schema ?? {},
        })
      }
      hits.sort((a, b) => a.sourceId.localeCompare(b.sourceId))
      return hits[0] ?? null
    }

    ctx.provide('sources', {
      registry,
      recipePackages: () => recipePackagesRef.current,
      liveRecipes,
      isBuiltinRecipe: (recipe: Recipe) => builtinRecipesRef.current.has(recipe),
      configProvisionerFor,
      recipesBuiltinDir,
      recipesUserDir,
      recipePackageOps,
      reloadRecipePackages,
      mountFailures,
      rsshubCatalogNeedsRefresh: () => catalogNeedsRefresh(config.dataDir),
      retiredRoutes,
      applyRsshubCatalog: (raw) => {
        const next = sealManifests(
          parseRsshubCatalog(raw as Parameters<typeof parseRsshubCatalog>[0], catalogOpts()),
          plugins
        )
        registry.swapCatalog(next)
        // 先换 registry 再落盘：写盘失败只是下次还得再取一遍，而目录已经是新的了。
        try {
          writeCatalogCache(config.dataDir, raw)
        } catch (e) {
          log(`[stream] RSSHub catalog cache not written (${(e as Error).message}) — will refetch next time`)
        }
        log(`[stream] RSSHub catalog refreshed: ${next.length} sources`)
        return next.length
      },
      keyState,
    } satisfies SourcesService)
  },
}
