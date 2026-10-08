import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { parse as parseYaml } from 'yaml'
import type { Context } from 'cordis'
import { requiredCookieDomains } from './credentials/required-domains.ts'
import { validateSessionExport, type SessionExportSpec } from './credentials/session-export.ts'
import { wireArticleCache } from './content/extract.ts'
import { wireOcrImageCache } from './content/images/ocr-cache.ts'
import { wireFaviconCache } from './adapters/favicon.ts'
import { RSSHUB_CHECKOUT_PKG } from './rsshub-client.ts'

import { basename, dirname, join, resolve } from 'node:path'
import { makeRuntimeConfigResolver, runtimeConfigPlugin } from './kernel/plugins/runtime-config.ts'
import { createKernel } from './kernel/context.ts'
import { settingsPlugin } from './kernel/plugins/settings.ts'
import { packagesPlugin } from './kernel/plugins/packages.ts'
import { sourcesPlugin } from './kernel/plugins/sources.ts'
import { credentialsPlugin } from './kernel/plugins/credentials.ts'
import { storagePlugin } from './kernel/plugins/storage.ts'
import { eventsPlugin } from './kernel/plugins/events.ts'
import { lazyNotify, type EventsService } from './events/service.ts'
import { harvestPlugin } from './kernel/plugins/harvest.ts'
import { authPlugin } from './kernel/plugins/auth.ts'
import { adaptersPlugin } from './kernel/plugins/adapters.ts'
import { providerPlugin, type ProviderService } from './kernel/plugins/provider.ts'
import { llmPlugin } from './kernel/plugins/llm.ts'
import { interventionPlugin } from './kernel/plugins/intervention.ts'
import type { ProbeRunner } from './intervention/repair-session.ts'
import { isCanonicalBrowserRecipe } from './intervention/repair-manager.ts'
import type { CanonicalBrowserRecipe } from './replay/recipe.ts'
import { netdiskPlugin } from './kernel/plugins/netdisk.ts'
import { applyCollectionPolicy } from './store/collection-policy.ts'
import { searchFanoutPlugin, type SearchFanoutService } from './kernel/plugins/search-fanout.ts'
import { conversionsPlugin } from './kernel/plugins/conversions.ts'
import { agentPlugin, type AgentDomain } from './kernel/plugins/agent.ts'
import { schedulingPlugin, type SchedulingDomain } from './kernel/plugins/scheduling.ts'
import { makeResolveDownload } from './audio/resolve-download.ts'
import type { AppConfig, StreamItem } from './types.ts'
import type { SourceType } from './manifest/types.ts'
import { writeTags } from './audio/tag-writer.ts'

export type Logger = (...args: unknown[]) => void

/**
 * `bootstrap()` 的返回值——**两格，终态**。
 *
 * 它曾经有 97 格：每一个被装配出来的对象都往这里挂一份，于是"谁依赖谁"完全看不出来，
 * 而 serve.ts / stdio-entry / doctor 三个消费者各自从这张平表上摸自己要的那些。
 * 现在服务全部住在内核上（`src/kernel/plugins/*.ts` 一域一插件，域内 `ctx.effect()` 登记
 * 句柄），所以这里只剩下**内核本身**，加上一份没有归属域的 config。
 *
 * **别再往这里加格。** 新能力属于某一个域；答不出"属于哪个域"就是设计还没想清楚，
 * 而不是"先挂在 Boot 上回头再说"。
 */
export interface Boot {
  /** 这次装配读到的配置（`loadConfig()` 的产物）。它不是服务，没有域，所以留在这儿——
   *  serve.ts 拿它取 item_db 目录、vault_root 这些启动期常量。 */
  config: AppConfig
  /** 这次装配用的内核。调用方传了就是他那棵（serve.ts 建的），没传就是 bootstrap 自建的一棵——
   *  **总是有一棵**，因为服务已经住在它上面了。关停路径拿它去销毁（`quiesceKernel`）：
   *  库句柄、定时器、adapter 子进程、采集标签的归还，全部是域内 effect，一次全撤。 */
  kernel: Context
}

export interface BootOptions {
  /** fired (in addition to the item-store write) for each newly-persisted item */
  onItem?: (item: StreamItem, type: SourceType) => void
  /** push a debug entry (download queue diagnostics) to the frontend DebugBox over the WS */
  onDebug?: (entry: import('./debug.ts').DebugEntry) => void
  /** push an arbitrary event to every connected frontend over the WS (facility auth-needed,
   *  login challenge/success/failure) — high-timeliness surface, no polling (spec I3) */
  broadcast?: (msg: unknown) => void
  /** Task-boundary attribution (op-track, created in serve.ts beside the debug bus): injected
   *  into the scheduler (harvest:<streamId>) and download queue (download:<jobId>). */
  track?: <T>(name: string, fn: () => Promise<T>) => Promise<T>
  /** Sync twin of `track` — the scheduler wraps a harvest's sub-second synchronous phases
   *  (`normalize:<sourceId>` / `store:<sourceId>`) with it, giving loop-lag spans short enough
   *  to be convicted (`contained`) instead of the always-spanning `harvest:<streamId>`. */
  trackSync?: <T>(name: string, fn: () => T) => T
  /** 进程内内核（`src/kernel/context.ts` 的根 context，serve.ts 建）。**不传就自建一棵**——
   *  服务已经住在内核上了，没有"没有内核"这一档。传它的意义只有一个：让关停路径
   *  （serve.ts 的 `quiesceKernel`）销毁的是同一棵树。单测直接 bootstrap 不传它照旧。 */
  kernel?: Context
  /**
   * 「该同步哪些 cookie 域」的**第三个来源**：已挂载的能力包自己申报的那些
   * （`Capability.credentials`）。serve.ts 传一个读活宿主的 thunk 进来。
   *
   * 为什么走 option 而不是在 bootstrap 里直接问能力宿主：宿主要用到本函数产出的凭证域，
   * 建在 bootstrap 之前，两边不能互相 import。
   *
   * **必须是 thunk**：可选包在 bootstrap 之后才装载，取一次快照等于永远只认内置那半。
   */
  extraCookieDomains?: () => string[]
  /**
   * agent 修复会话要用的 MCP 端点（`/api/mcp` + api token）——ACP 的 `session/new` 把它递给
   * agent，agent 才能回头看一眼活着的页面。**thunk 且只有 serve.ts 传**：口和 token 是它才
   * 知道的东西，bootstrap 自己拼一个就会拼出一个指着别处的 URL。缺席 = 不给 agent MCP，
   * 会话照跑（如实，不编）。
   */
  mcpEndpoint?: () => { url: string; token: string } | undefined
}

type RawConfig = Partial<AppConfig> & {
  /** 目录并轨前的两个字段。仍然受理（见 loadConfig），因为别人的部署可能写了。 */
  plugins_dir?: string
  recipes_dir?: string
}

/** STREAM_DATA_DIR names a writable data directory (Docker/standalone backend);
 *  config.yaml lives there. If absent, the directory is created and config.yaml
 *  simply doesn't exist yet — code defaults apply until the user writes one (no
 *  bundled template to seed from: the embedded-exe model that shipped
 *  config.default.yaml as a sidecar resource has been retired). Dev (no
 *  STREAM_DATA_DIR) is untouched — './config.yaml' as always. */
function resolveConfigPath(dataDir: string | undefined): string {
  if (process.env.STREAM_CONFIG) return process.env.STREAM_CONFIG
  if (!dataDir) return './config.yaml'
  const target = join(dataDir, 'config.yaml')
  if (!existsSync(target)) mkdirSync(dataDir, { recursive: true })
  return target
}

/**
 * 可写状态的根目录（items/dedup/settings/recipes/**包凭证 token**…）。
 *
 * **这是唯一的算法**——后端运行时（`bootstrap()`）和 `stream plugins compose` CLI 必须调同一个
 * 函数。别在别处复刻 `dirname(config.item_db)`：CLI 铸的包 token 写进 compose、后端从这个目录
 * 读回来认，两边各算一次一旦分家，**容器永远 401，而两边单看都正常**——最难查的那种静默错位。
 *
 * STREAM_DATA_DIR 的作用在上游 `loadConfig()` 里就并进了 `item_db`（既选 config.yaml 的位置，
 * 也给 item_db 的默认值垫前缀），这里不再叠一层。config.yaml 里写的相对路径（`./data/items.db`）
 * 在这里对 **process.cwd()** 定死成绝对路径，免得后续任何 chdir 让同一个 config 指向两个地方。
 */
export function resolveDataDir(config: Pick<AppConfig, 'item_db'>): string {
  return resolve(dirname(config.item_db))
}

/**
 * 内置包目录：一个字段 `packages_dir`（default `./packages`）。
 *
 * 并轨前是两个（`plugins_dir` / `recipes_dir`）。旧字段仍然受理——别人的部署可能写了，
 * 而"配置里写的那行被静默忽略"是最难查的一类故障（既不报错也不生效）。写了旧字段就用它，
 * 并说清新名字；两个都写且指向不同目录时只有一个能生效，那必须吵出来，别替他挑。
 */
function resolvePackagesDir(cfg: RawConfig, underResource: (rel: string) => string): string {
  if (cfg.packages_dir) return cfg.packages_dir
  const legacy = cfg.plugins_dir ?? cfg.recipes_dir
  if (!legacy) return underResource('./packages')
  if (cfg.plugins_dir && cfg.recipes_dir && cfg.plugins_dir !== cfg.recipes_dir) {
    throw new Error(
      `config.yaml 同时写了 plugins_dir (${cfg.plugins_dir}) 和 recipes_dir (${cfg.recipes_dir}) 且指向不同目录，` +
      `但内置包目录现在只有一个：把两处的包合并进同一个目录，改用 packages_dir 声明它`,
    )
  }
  console.warn(
    `[stream] config.yaml 的 ${cfg.plugins_dir ? 'plugins_dir' : 'recipes_dir'} 是旧字段名，` +
    `内置包目录现在只有一个 packages_dir（插件包与 recipe 包同住一层）——本次仍按它读 ${legacy}`,
  )
  return legacy
}

/** loadConfig **读**的地址键。其余一切 `*_url` 顶层键都没人读。 */
const READ_URL_KEYS = new Set(['mineru_url'])

/** 网盘底座的两个旧键。底座只有内置托管一种形态：地址由宿主现取、凭证由接管序列维护。 */
const RETIRED_NETDISK_BASE_KEYS = ['alist_url', 'alist_token']

/**
 * config.yaml 里**已经没人读**的地址键（`*_url`，不在 `READ_URL_KEYS` 里）：带容器的包的地址由包
 * 自己经 `ctx.backendUrl` 现取（插件目标 / 该包 README 写明的环境变量），loadConfig 不传任何这类
 * 字段。写了它的旧部署不会报错——地址只是静默不生效，表现成「配了却还是连插件目标」。所以在这里
 * 喊一声（只 warn，不 throw：一条陈旧的键不该拦住整个后端起来）。
 *
 * 按「读不读」判而不是列退役键名：宿主源码不认识任何 facility 的名字（`src/no-facility-names.guard.test.ts`
 * 大小写不敏感地扫，键名本身就会命中），而这条规则确实是整类的。往 loadConfig 加一个读的地址键
 * 就得往 `READ_URL_KEYS` 加一行，否则用户写了它会被误报——`load-config.test.ts` 钉着两个现役键不喊。
 */
function warnRetiredContainerUrlKeys(cfg: Record<string, unknown>): void {
  // 这两个键单独说：通用那句让人「改用环境变量」，而网盘底座没有任何显式覆盖的入口。
  const netdiskBase = RETIRED_NETDISK_BASE_KEYS.filter((k) => k in cfg)
  if (netdiskBase.length > 0) {
    console.warn(
      `[stream] config.yaml 里的 ${netdiskBase.join(' / ')} 已不再被读取：网盘底座由 Stream 托管，`
      + `地址和凭证都自动维护，没有可配的项`,
    )
  }
  const stale = Object.keys(cfg)
    .filter((k) => k.endsWith('_url') && !READ_URL_KEYS.has(k) && !RETIRED_NETDISK_BASE_KEYS.includes(k))
  if (stale.length === 0) return
  console.warn(
    `[stream] config.yaml 里的 ${stale.join(' / ')} 已不再被读取；容器地址的显式覆盖用环境变量`
    + `（见 packages 里那个容器包的 README）`,
  )
}

export function loadConfig(path = resolveConfigPath(process.env.STREAM_DATA_DIR)): AppConfig {
  // Writable user state (vault/dedup/items) resolves under STREAM_DATA_DIR when set.
  // Read-only assets (manifests/plugins/RSSHub catalog) resolve relative to the
  // process cwd — the same in Docker and dev. The embedded-exe resource-dir
  // reverse-derivation (STREAM_RESOURCE_DIR / argv[1]) was retired along with the
  // node sidecar.
  const dataDir = process.env.STREAM_DATA_DIR
  const underData = (rel: string) => (dataDir ? join(dataDir, rel.replace(/^\.\//, '')) : rel)
  const underResource = (rel: string) => rel
  const cfg = existsSync(path) ? (parseYaml(readFileSync(path, 'utf-8')) as RawConfig) : ({} as RawConfig)
  warnRetiredContainerUrlKeys(cfg)
  const itemDb = cfg.item_db ?? underData('./data/items.db')
  return {
    vault_root: cfg.vault_root ?? underData('./vault'),
    vault_enabled: cfg.vault_enabled ?? true,
    dedup_db: cfg.dedup_db ?? underData('./data/dedup.db'),
    item_db: itemDb,
    packages_dir: resolvePackagesDir(cfg, underResource),
    // 默认 false —— 没写就是今天的行为（容器归 compose 管，后端一个 docker 写操作都不发）。
    manage_containers:
      cfg.manage_containers ??
      (process.env.STREAM_MANAGE_CONTAINERS === '1' || process.env.STREAM_MANAGE_CONTAINERS === 'true'),
    mineru_url: cfg.mineru_url, // unset → MineruClient falls back to MINERU_URL env / plugin target
    // catalog（RSSHub 全量路由长尾）只有开发检出里有：`assets/build/routes.json` 是 RSSHub 的
    // 构建产物，**不在 npm 包 `rsshub` 的 tarball 里**（那里只有 `dist-lib/`）。所以发行安装是
    // 「curated + recipe，无 catalog」——RSSHub 本体照跑，只是选源页没有那 3000 条长尾。
    // 路径从检出常量派生，别在这儿再写一遍那个机器本地路径。
    rsshub_catalog:
      cfg.rsshub_catalog ?? (RSSHUB_CHECKOUT_PKG ? RSSHUB_CHECKOUT_PKG.replace(/\/lib\/pkg\.ts$/, '/assets/build/routes.json') : ''),
    api_token: cfg.api_token,
    ad_filter: cfg.ad_filter,
    audio_archive_db: cfg.audio_archive_db ?? join(dirname(itemDb), 'audio-archive.db'),
    // 缺省落在 Stream 根目录下（和 vault / 各库同一个家）；只有用户自己设了才去别处——要放 NAS 就在
    // config.yaml 或 AUDIO_ARCHIVE_ROOT 里写明（用户 2026-09-27 拍板：默认位置一律在 Stream 根目录下）。
    audio_archive_root: cfg.audio_archive_root ?? process.env.AUDIO_ARCHIVE_ROOT ?? underData('./music'),
    // 不给默认值：缺席就是「用 RecipeSessionManager 自己的默认」。在这里也写一份数字，就等于
    // 把同一个上限写进两个地方，而它们迟早会漂（这个仓库为同类漂移付过多次代价）。
    browser_lanes: cfg.browser_lanes,
    // 这两行以前漏了，和上面 alist_* 那次一模一样：`AppConfig` 声明了字段、下面那处
    // 在读 `config.desktop?.session_wait_ms`，loadConfig 却不往外传 —— 于是 config.yaml
    // 里写什么都是静默无效（既不报错也不生效，只是那个上限永远是代码里的默认值）。
    desktop: cfg.desktop,
    session_exports: cfg.session_exports,
    // 能力包的配置：原样透传（见 AppConfig.capabilities）。
    capabilities: cfg.capabilities,
  }
}

/**
 * agent 交出候选 recipe 之后那一趟活体 probe 的执行器：**就是采集用的那个执行入口**
 * （`harvest.sessionRecipes`），不是另起一条验证专用的路——两条路会各自漂，而「验的时候过了、
 * 采的时候不过」查起来无从下手。
 *
 * **必须是调用时现取**：harvest 域的浏览器可能比这条 run 晚就绪（用户还没开 Chrome）。
 * 取不到就回 `undefined`，让校验那一格如实显示 `skipped-no-executor`——**没跑 ≠ 过**，
 * 但也不该被算成不过（补一个会抛错的执行器就是后者，那会把提议永远卡住）。
 */
function probeFor(kernel: Context): ProbeRunner | undefined {
  const sessionRecipes = kernel.harvest?.sessionRecipes
  if (!sessionRecipes) return undefined
  return async (recipe) => {
    // 到不了这儿（哪条 recipe 能走这条路由 repair-manager 判），留一道是为了万一判据分了家时
    // 报一句说得清的话，而不是在执行器深处炸一个看不懂的错。
    if (!isCanonicalBrowserRecipe(recipe)) throw new Error(`活体 probe 只跑 canonical browser 档，这份是 ${String((recipe as { kind?: string }).kind)}`)
    const o = await sessionRecipes.execute(recipe as CanonicalBrowserRecipe, {})
    return { outcome: o.outcome, ...(o.reason ? { reason: o.reason } : {}), items: o.items.length }
  }
}

/**
 * Wire the whole stack from config. `log` lets the MCP entry route logs to
 * stderr (stdout is the stdio JSON-RPC channel) while the daemon uses stdout.
 */
export async function bootstrap(
  config: AppConfig,
  log: Logger = console.error,
  opts: BootOptions = {}
): Promise<Boot> {
  // op-track gate helpers: attribution is a bystander — with no tracker wired they are identity,
  // so tests that bootstrap without one see zero behavior change.
  const track = opts.track ?? (<T,>(_name: string, fn: () => Promise<T>) => fn())
  const trackSync = opts.trackSync ?? (<T,>(_name: string, fn: () => T) => fn())
  // 内核：调用方那棵，或自建一棵。域插件往它上面挂服务、把句柄登记成 effect；
  // 关停时一次 `quiesceKernel` 全撤（serve.ts）。
  const kernel = opts.kernel ?? createKernel()
  // 设置覆盖层（settings.json）——infra 最底下那一格，凭证/运行时配置/插件开关都读它。
  await kernel.plugin(settingsPlugin, {
    path: join(resolveDataDir(config), 'settings.json'),
    trackSync: opts.trackSync,
  })
  const settings = kernel.settings
  // 凭证域（登录态 + BYOK key）。构造与那几个热配置的行为都住在插件里；这里只保留装配序上
  // 下游要用的引用。`requiredDomains` 是前向引用的惰性 thunk——它从 registry + 已订阅流推，
  // 那两样在装配序上远在这之后（见下面 requiredCookieDomainsNow）。
  await kernel.plugin(credentialsPlugin, {
    dataDir: resolveDataDir(config),
    log,
    requiredDomains: () => requiredCookieDomainsNow(),
  })
  const credentials = kernel.credentials
  const { cookieProvider, tokenProvider, resolver } = credentials
  /** 这台 Stream 需要同步哪些 cookie 域——从它**实际装着的东西**推，不是一份手抄清单。
   *
   *  取 curated（手写 manifests + builtin + 装好的 recipe 包）+ 已订阅流的成员 source，**不取
   *  RSSHub 全目录**：目录里有几百个要登录的站，把它们报给扩展等于让它去读用户浏览器里几百个
   *  域的 cookie。订阅了目录里某个源，它就随订阅进这份清单。 */
  const requiredCookieDomainsNow = (): string[] => {
    // 采集调度域比这里晚挂（它要 Provider 执行面）——**调用时才解引用**，而这个函数只在扩展
    // 问「该同步哪些域」时才跑，那时它早就在了。装配期真有人调就是「还没有订阅流」，不是错。
    const subscribed = ((kernel.scheduling as SchedulingDomain | undefined)?.scheduler.list() ?? [])
      .flatMap((s) => s.sources)
      .map((m) => m.source_id ?? m.source_template_id)
      .filter((id): id is string => !!id)
      .map((id) => registry.get(id))
    // 第二个来源：登录态导出声明的域（`config.session_exports`）。它不是任何 Source 的 auth，
    // 漏掉这一并集 = 导出每轮都拿到空 cookie，且没有任何一处会报错（见 requiredCookieDomains
    // 的 `extra` 头注）。
    // 第三个来源：已挂能力包申报的域（`Capability.credentials`）。能力包是**一等的登录态
    // 消费者**——它经 `streamBrowserCookies` 取用户浏览器里的 cookie，和一份 manifest 的
    // `auth` 同级。漏掉它 = 扩展根本不去读那个域，而包拿到的空 cookie 和"用户没登录"
    // 一字不差，没有任何一处会喊。
    return requiredCookieDomains(
      [...registry.curated(), ...subscribed],
      [...sessionExports.map((s) => s.domain), ...(opts.extraCookieDomains?.() ?? [])],
    )
  }
  /**
   * 登录态导出的声明（`config.yaml` 的 `session_exports`）。**装载期就体检**：一条写错的
   * 声明（URL 跨域 / 指向内网 / 缺字段）在这里当场喊出来，否则要等到下一个整点才发现，
   * 而症状只是"那个文件没更新"——没人看得出是配置写错了。坏的那条剔掉、其余照跑。
   */
  const sessionExports = (config.session_exports ?? []).filter((s) => {
    const bad = validateSessionExport(s)
    if (bad) log(`[session-export] 声明无效，已跳过：${bad}`)
    return !bad
  })

  const dataDir = resolveDataDir(config)
  /**
   * 「静音缺陷」的通知入口，给**比事件层先装配起来的**那两个域用（包域的取址答空、采集运输
   * 面的 relay 超时）。事件层在下面几百行才挂，所以这里传的是一个**调用时才解引用**的函数
   * ——存成实例就等于永远发不出去，且一个字都不报（spec 2026-08-19-silent-failure-notifications §5）。
   */
  const notifyDefect = lazyNotify(() => kernel.streamEvents as EventsService | undefined)
  /**
   * 包这一域整块进内核（`src/kernel/plugins/packages.ts`）：两层扫描 → 描述符投影 →
   * plugin-target 接线 → 容器接管 → AList 接管 → 包自己的 `activate()`。
   * **那几步的先后是有语义的**（AList 要排在 activate 之前等），全在插件内部保序，
   * 这里只保留装配序上下游还要用的那几个引用。
   */
  await kernel.plugin(packagesPlugin, {
    packagesDir: config.packages_dir,
    dataDir,
    manageContainers: config.manage_containers === true,
    log,
    // 前向引用的惰性 thunk：目录住在采集调度域的 `StreamService`（那一域晚挂），而这个只在
    // 翻开关那一刻才调。
    catalogSummary: (id) => kernel.scheduling.service.plugins().find((p) => p.id === id),
    track: opts.track,
    onDebug: opts.onDebug,
    notify: notifyDefect,
  })
  const packageActivationFailures = kernel.packages.activated.failures

  /**
   * Source 这一域整块进内核（`src/kernel/plugins/sources.ts`）：三层来路合成 `Registry`
   * （curated / recipe 包 / RSSHub 长尾）+ recipe 热重载 + npm 包安装面。
   * 它 inject packages 域——curated 只收**启用**的包，判据从那边来。
   */
  await kernel.plugin(sourcesPlugin, {
    builtinDir: config.packages_dir,
    dataDir,
    rsshubCatalog: config.rsshub_catalog,
    log,
    trackSync: opts.trackSync,
    onDebug: opts.onDebug,
    // 前向引用：事件层在下面才建，而这句话只在用户点卸载时才说。
    notifyUninstall: (n, name) => void events.emit({
      type: 'plugin.container',
      severity: n.severity,
      title: n.title,
      body: n.body,
      // kind 必须编进 key：事件层对同一个 key 的未读事件只刷时间戳、丢掉新正文，
      // 两种话共用一个 key 会让轻的那条把重的那条吃掉（见 UninstallNotice.kind）。
      dedupeKey: `uninstall:${n.kind}:${name}`,
    }),
  })
  const { registry, liveRecipes, recipesBuiltinDir, recipesUserDir, recipePackageOps } = kernel.sources
  // `keyState`（Provider 成员的 key 配没配）住 Source 域——它问的是一个 Source 的事。
  // serve.ts 直接读 `kernel.sources.keyState`。

  const streamDb = join(dataDir, 'stream.db')
  // cache.db = the regenerable side (items + dedup fingerprints). items.db converges by
  // file rename (105MB — never row-copied); legacy dedup file adopts via table copy.
  const cacheDb = join(dataDir, 'cache.db')
  // 落盘状态整域进内核：建库、一次性迁移、每个句柄一个 effect（关停由 quiesceKernel 接管）。
  await kernel.plugin(storagePlugin, {
    dataDir,
    streamDb,
    cacheDb,
    legacyItemDb: config.item_db,
    legacyDedupDb: config.dedup_db,
    audioArchiveRoot: config.audio_archive_root,
    audioArchiveDb: config.audio_archive_db,
    log,
    /**
     * stream.db 的一列 JSON 读坏了 → 那一行降级读出来（不消失），并**告诉用户**。
     *
     * 只写日志不通知，正是这条缺陷要治的静默：频道还在但里面是空的，用户会以为自己的配置
     * 丢了，而没有任何入口知道是"某一格数据坏了、可以修"。dedupeKey 按「哪一行的哪一列」
     * 编——同一个坏格子每次开机、每次 `listChannels()` 都会读到，不去重就是把铃铛按住不放。
     *
     * `notifyDefect` 是 `lazyNotify`（上面几百行）：事件层比存储域晚装配，这里存实例等于永远
     * 发不出去且一个字都不报。
     */
    onRowDegraded: ({ table, rowId, column, fallback, raw }) => notifyDefect({
      type: 'store.row-degraded', severity: 'warn',
      title: `数据读坏了一格：${table} / ${rowId}`,
      body: `这一行的「${column}」不是合法数据，已按空的算（${fallback}）继续用；` +
        `其余数据不受影响。这一项要恢复得重新设置一次。`,
      detail: `table=${table}\nrow=${rowId}\ncolumn=${column}\nfallback=${fallback}\nraw=${raw}`,
      dedupeKey: `store-row-degraded:${table}:${rowId}:${column}`,
    }),
    downloadQueueDeps: ({ archive, channels }) => ({
      archive,
      // 业务层只调 Provider：按平台派发选出的取歌 Provider 行解析出可下载网址（音质取梯子最高档）；
      // 播客等 item 自带的直链音频用 pageUrl。队列拿到 {url,headers} 后自己 fetch 落盘。
      //
      // **Provider 面是调用时才从内核取的**（`makeResolveDownload` 收的是 thunk 不是实例）：
      // 队列住存储域，执行器住 provider 域，后者晚几百行才挂上。装配期解引用的下场是
      // "启动后前几分钟解析不出网址、之后自愈、零报错"；服务还没挂时它显式抛，由队列记进
      // last_error 并重排，而不是把装配序问题伪装成"这首歌没资源"。
      resolveDownload: makeResolveDownload(() => kernel.provider as ProviderService | undefined),
      syncEnabled: (id) => !!((channels.getStream(id)?.options as any)?.autoDownload),
      setSyncEnabled: (id, enabled) => {
        const s = channels.getStream(id)
        if (s) {
          const options = { ...(s.options as any) }
          if (enabled) options.autoDownload = true
          else delete options.autoDownload
          channels.putStream({ ...s, options })
        }
      },
      refMeta: () => ({}),
      emitDebug: opts.onDebug,
      track: opts.track,
      writeTags,
    }),
  })
  const stores = kernel.stores
  const { dedup, itemStore, storyFold: storyFoldStore, contentCache, audioArchive: archive,
    sourceHealth, channels, seenStore, collections, watchProgress, downloadQueue,
    discoveredChannels } = stores
  // 消费模块在自己的 `wire*` 里注册命名空间——spec 挨着它描述的那份投影，所以接线留在这儿，
  // 不进存储域（那一域只管建库和句柄）。
  // 前两个把一个**模块级指针**指向这份句柄，所以要跟着装配一起撤销（disposer 只在指针还是
  // 自己时才回滚，避免撤销序把别人刚接上的那份抹掉）。第三个只登记规格，随句柄自灭。
  const unwireArticle = wireArticleCache(contentCache)
  const unwireFavicon = wireFaviconCache(contentCache)
  kernel.effect(() => () => {
    unwireArticle()
    unwireFavicon()
  })
  wireOcrImageCache(contentCache)
  // 四个消费点（此处 + Scheduler + ResolveEngine + 分集索引）共用同一个引用——曾经是四份逐字
  // 相同的内联闭包，改一处漏三处的表现只是"部分路径吃旧默认"，不报错。
  const runtimeConfigFor = makeRuntimeConfigResolver({ settings })
  // 设置库经 inject 从内核取（见 runtimeConfigPlugin），所以这里不再喂 config。
  void kernel.plugin(runtimeConfigPlugin)
  // 采集运输面整域进内核（两条中继 / Transport / lane 管理器 / recipe 执行器 / 看动页面 /
  // xhs 两个动作）。`recipeSessions.closeAll()` 随之变成域内 effect——关停时把标签还给用户
  // 这件事，不再挂在下面 shutdown() 的手写清单上。
  await kernel.plugin(harvestPlugin, {
    dataDir,
    log,
    browserLanes: config.browser_lanes,
    harvestBrowser: config.harvest_browser,
    hostSessionWaitMs: config.desktop?.session_wait_ms,
    onDebug: opts.onDebug,
    notify: notifyDefect,
    broadcast: opts.broadcast,
    // 介入域（下面 llm 之后才建）：**经 config 传 thunk，不写 inject、也不在插件里读 `ctx.intervention`**
    // ——Cordis 不许绕过 inject 惰性取服务（`cannot get property "intervention" without inject`，
    // 活体 2026-09-11 一次搜索当场撞上）；而 inject 它会让本域等一个比自己晚挂的域。同 netdisk 域那条
    // `scheduling` 的先例：从根 kernel 现取。
    intervention: () => kernel.intervention,
    // 同一个理由：LLM 网关（下面才建）inject `provider`，provider inject
    // `adapters`，而 adapters 吃本域——写成 `inject: ['llm']` 就是环。传函数 = 桌面 recipe
    // 真跑到 `see` 的 model 段那一刻才解引用，那时整棵树早就装完了。
    // `STREAM_DESKTOP_SEE_MODEL=off`：把 see 梯子的模型段整个拿掉，只剩本地能力（控件树 / OCR /
    // 模板）。识别层拿不到 llm 就不调模型，「没找到」那句话会如实报"没配视觉模型"。用途是量本地
    // 能力单独能走多远、或者不想为桌面 recipe 花一分钱的机器。调用点绑定不能为空（fixed 模式恰好
    // 一个 provider），所以开关只能放这里。
    ...(process.env.STREAM_DESKTOP_SEE_MODEL === 'off'
      ? {}
      : { llmForTask: (callsiteId, input, opts) => kernel.llm.forTask(callsiteId, input, opts) }),
  })
  if (process.env.STREAM_DESKTOP_SEE_MODEL === 'off') console.log('[desktop-see] STREAM_DESKTOP_SEE_MODEL=off：视觉模型段停用，只用控件树 / OCR / 模板')
  // bootstrap 自己一格都不再解：`mcpExtras` 那张转发表随 agent 域搬走后，运输面只剩下游域
  // （adapters / auth / agent 经 inject 从 `ctx.harvest` 自取）与 serve.ts（直接读内核）在吃。
  // Serializes the re-login flow per facility (two concurrent logins on one site fight over the
  // same tab). Just lockfiles — Stream owns no browser profile any more.
  const locksRoot = join(dataDir, 'locks')
  // ── 事件层（通知中心）：落盘 + WS 推送的统一发布门，spec 2026-07-23 ──
  // 整域进内核。**服务挂在 `ctx.streamEvents` 上，不是 `ctx.events`**——后者是 cordis 本体的
  // 服务，抢不过来（provide 静默无效），理由和实测见 kernel/plugins/events.ts 的声明处。
  await kernel.plugin(eventsPlugin, {
    path: join(dataDir, 'events.json'),
    broadcast: (msg) => opts.broadcast?.(msg),
  })
  const events = kernel.streamEvents
  // 上面攒着的「第三方包这次没装起来」——事件层建好了才发得出去。用户看得见的唯一一处：
  // 只有日志的话，表现就是「装了但没生效」，用户根本不知道去哪找。
  for (const f of packageActivationFailures) {
    events.emit({
      type: 'package.activate-failed', severity: 'error',
      title: `扩展包未生效：${f.id}`,
      body: `这个包的代码这次没能装载起来，它带的 adapter / normalizer 全部不可用（Stream 其余部分照常）。原因：${f.error.message}`,
      dedupeKey: `package-activate:${f.id}`,
    })
  }
  // 同上：启动装载 recipe 包时被跳过的坏包。跳过本身是对的（一个坏包不该让后端起不来），
  // 但只写日志就等于没说——用户看到的现象是「我装的那个源不见了」，而日志他不会去看。
  // **同一个目录上面已经报过就不再报**：`package.json` 坏掉的包两个域都会跳过它（包域读不出
  // 描述、sources 域装不出 recipe），而对用户那是**一个**坏包，不是两件事。
  const reportedDirs = new Set(packageActivationFailures.map((f) => f.dir))
  for (const f of kernel.sources.mountFailures) {
    if (reportedDirs.has(f.dir)) continue
    events.emit({
      type: 'package.activate-failed', severity: 'error',
      title: `recipe 包未装载：${basename(f.dir)}`,
      body: `这个包这次被跳过，它带的源不可用（Stream 其余部分照常）。修好或删掉 ${f.dir} 后重启即可。原因：${f.error.message}`,
      dedupeKey: `recipe-mount:${f.dir}`,
    })
  }
  // 同上：启动时接管插件容器的结果（建了 / 起了 / 起不来 / 镜像对不上要你拍板）。开关关着时
  // 这个数组恒为空。只有日志的话，表现就是「插件容器莫名其妙不在」，用户无从查起。
  for (const n of kernel.packages.provisionNotices) {
    events.emit({
      type: 'plugin.container', severity: n.severity,
      title: n.title, body: n.body,
      dedupeKey: n.dedupeKey,
    })
  }
  // 授权健康整域进内核：横幅（活投影，不存登录态）/ 对账 / 重登 provider / cookie 取数。
  // **建在 harvest 域的产物上**（extRelay / recipeSessions / transport），所以它 inject harvest；
  // 也在事件层之后 —— 「需要登录」要发一条通知。
  await kernel.plugin(authPlugin, {
    dataDir,
    log,
    onDebug: opts.onDebug,
    broadcast: opts.broadcast,
    requiredCookieDomains: requiredCookieDomainsNow,
  })
  const auth = kernel.auth

  // adapter 装配整域进内核：四个宿主 adapter（builtin/rsshub/browser/replay）手织 + 带 code
  // 槽位的包自己交出来的那些汇进同一张 Map。**建在 harvest 域的产物上**，所以在它之后。
  // bootstrap 自己一格都不解：下游域经 inject 从 `ctx.adapters` 自取（进程内实现的注册面
  // `register()` 在 Provider 域里，采集调度域吃这张 Map）。
  // `intervention` 同 harvest 那处：经 config 递 thunk，从根 kernel 现取，不在插件里读 `ctx.intervention`。
  await kernel.plugin(adaptersPlugin, { dataDir, log, runtimeConfigFor, onDebug: opts.onDebug, intervention: () => kernel.intervention })

  // ── Provider 执行面整域进内核 ──────────────────────────────────────────────
  // 解析面（resolveEngine / intentResolver / radarMatcher）+ 进程内成员的注册 + 读模型 /
  // 执行器 / 种子行 / 绑定 / 各能力面，全在 `ctx.provider` 上。`providerStats` 的 sqlite
  // 句柄随之变成域内 effect（搬进来之前从没人关它）。
  await kernel.plugin(providerPlugin, {
    cacheDb,
    log,
    runtimeConfigFor,
    mineruUrl: config.mineru_url,
    onDebug: opts.onDebug,
  })
  // 同上：Provider 执行面在 bootstrap 里也一格都不再解（最后两个消费者——mcpExtras 的解析面
  // 三格与 agent 段的梯子/网盘验活——随 agent 域一起走了）。下游全部经 inject 自取。

  // ── LLM 网关整域进内核（`src/kernel/plugins/llm.ts`）───────────────────────
  // 在 `ctx.provider.llmForTask` 外面裹一层用量账本（cache.db 的 `llm_usage` 表）。
  // 排在 provider 域之后：它 inject `provider`。
  await kernel.plugin(llmPlugin, { cacheDb, onDebug: opts.onDebug })

  // ── AI 介入域（`src/kernel/plugins/intervention.ts`）────────────────────────
  // 排在 llm 之后：Broker 问模型走 `ctx.llm.forTask`（调用点 intervention.ask）。adapters / harvest
  // 早于它装配，那两处经 forwardingRepairRunner **调用时**现取 `ctx.intervention`。
  await kernel.plugin(interventionPlugin, {
    dataDir,
    log,
    ...(opts.mcpEndpoint ? { mcpEndpoint: opts.mcpEndpoint } : {}),
    probe: () => probeFor(kernel),
    // 探索面骑的三个 cdp 动词住 agent 域的 `mcpExtras`，而那个域是装配序上最后一个（下面
    // 第 689 行）——所以这里只能是 thunk，探索真起一条的那一刻才解引用。**三个不全就回
    // undefined**：补齐一半的 surface 会让探索在一张点不动的页面上"成功"跑完一整轮。
    cdp: () => {
      const x = (kernel.agent as AgentDomain | undefined)?.mcpExtras
      if (!x?.cdpLook || !x.cdpAct || !x.cdpShot) return undefined
      // 探索面递进来的是一份已经拼好的动作（kind/domain 都在），只是类型上它是宽的
      // `Record<string, unknown>`——这一处窄回 router 的形状，别把宽类型推给 cdp-router。
      const act = x.cdpAct
      return { look: x.cdpLook, act: (a) => act(a as unknown as Parameters<typeof act>[0]), shot: x.cdpShot }
    },
  })

  // ── 采集调度整域进内核（`src/kernel/plugins/scheduling.ts`）─────────────────────
  // Scheduler + StreamService **同一个插件装两件**：两者互为对方的依赖（service 吃 scheduler
  // 的实例，scheduler 的 `onFeedTitle` 回调调 service.updateResourceStream），这个真环只有在
  // 同一个 apply 里才闭得上——搬家前它是靠 bootstrap 的函数作用域勉强兜住的。
  // `health` / `lastHarvestAt` / `baseAdRules` 同域（都只是 scheduler + registry 上的读）。
  // scheduler 的 `stop()` 与 `shutdownAdapters()` 随之变成域内 effect：bootstrap 的手写
  // `shutdown()` 与 `gracefulShutdown` 里那行 `scheduler.stop()` 一起归零。
  await kernel.plugin(schedulingPlugin, {
    adFilter: config.ad_filter,
    vaultRoot: config.vault_root,
    vaultEnabled: config.vault_enabled,
    runtimeConfigFor,
    onItem: opts.onItem,
    track: opts.track,
    trackSync: opts.trackSync,
    onDebug: opts.onDebug,
  })
  // 只解下游装配还要用的那两格（搜索扇出的两个 thunk、agent 域的 service 与 readSource）。
  // 其余三格（baseAdRules / health / lastHarvestAt）只有 serve.ts 要，它直接读内核。
  const { scheduler, service } = kernel.scheduling

  // 网盘（AList 对齐层）整域进内核（`src/kernel/plugins/netdisk.ts`）：一库 netdisk.db +
  // 绑定同步 + 归档器 + AI 判读。**门在插件内部**——未配 AList token 时下面两个字段是
  // undefined（播放路由自动跳过），域本身照挂。
  // `rescheduleStream`：`reconcile_open` 给订阅补完下架来源之后要让调度器认这条新成员，
  // 否则那个目录到进程重启前一次都不会被采。调度域上面刚挂完，直接递函数进去——**别改成
  // inject**，理由见 NetdiskConfig 上那个字段的注释。
  await kernel.plugin(netdiskPlugin, {
    dataDir,
    log,
    // **经判据走，不无条件重排班**：`openReconcile` 不要求这条流已经归属哪个频道，而
    // `POST /api/netdisk/reconcile/open` 与 MCP 的 `reconcileOpen` 都收任意 streamId——
    // 递一条 research（live present，现读不落库）的流进来是够得到的，无条件 remove+add
    // 会把它放回采集队列，一直采到进程重启。判据出处见 store/collection-policy.ts。
    rescheduleStream: (streamId) =>
      applyCollectionPolicy(kernel.stores.channels, service, [streamId], { reschedule: true }),
    // 追更找新分享用的资源搜索。**搜索扇出域在下面几行才挂**，所以这里只能是一个调用时才
    // 解引用的 thunk——装配期取值就是把 undefined 冻住，症状是追更永远只回访旧源、一条新源都
    // 搜不到，而账本里只有一行「资源搜索未装配」没人看。`kernel.search` 的读法与 `kernel.scheduling`
    // 同一形式；此处它还没被 provide，类型上先断言（域声明在 search-fanout.ts）。
    videoSearch: () => (kernel as { search?: SearchFanoutService }).search?.videoSearch,
  })
  // bootstrap 自己不解任何一格：转写取音频那条腿在转换域里经 inject 自取，netdisk_* 四个
  // MCP 工具随 mcpExtras 走了 agent 域，`subtitleCacheDir` 只有 serve.ts 要（直接读内核）。

  // 搜索扇出整域进内核（`src/kernel/plugins/search-fanout.ts`）：内容搜索 + 资源搜索
  // （批量/流式两条路）+ 两个归一化口。两个吃 Scheduler 的口仍以 thunk 下传：真身此刻已经
  // 在内核上了，thunk 只是不把它冻成快照（本域 dispose/重挂时不会拿着一个死引用）。
  await kernel.plugin(searchFanoutPlugin, {
    log,
    normalizeRaw: (sourceId, raw) => scheduler.normalizeRaw(sourceId, raw),
    readSource: (sourceId, params) => scheduler.readSource(sourceId, params),
  })

  // 转换底座整域进内核（`src/kernel/plugins/conversions.ts`）：一张表 + 一套队列，上面挂
  // extract（转写 / OCR / 网页正文三分支）/ identify / frames / summary 四个 kind。三条 sqlite
  // 句柄（conversions 表所在的 stream.db、jobs.db、voiceprint.db）与两处没有 stop 面的定时器
  // （runner 重排、story-fold 巡检）随之变成域内 effect。
  await kernel.plugin(conversionsPlugin, {
    dataDir,
    streamDb,
    log,
    // **thunk 而不是值，而且是跨域的运行时解引用**：摘要 prompt 的状态面住 agent 域，它比本域
    // 晚挂——但这个函数只在真跑一次 summary 转换时才调，那时它早就在了。装配期冻结的话改完
    // prompt 得重启才算数，而没有一处会报错。
    summaryPrompt: () => (kernel.agent as AgentDomain | undefined)?.summaryPrompt(),
    // 与 provider 域注册 `ocr-mineru` 成员用的同一个显式 override；这里只拿它判 MinerU 可达性。
    mineruUrl: config.mineru_url,
    onDebug: opts.onDebug,
  })
  // 归堆的后台工（`storyFoldWorker`）住本域。采集调度域比它早挂，那边的
  // `StoryFoldRecorder.onQueued` **调用时**才从 `ctx.conversions` 取它——前向 `let` 已删。

  // 对话 / 搜索 agent / 意图跟踪整域进内核（`src/kernel/plugins/agent.ts`）：会话库 + 心愿单 +
  // llm.chat 端点解析 + 摘要 prompt 状态面 + 三条网页搜索腿的梯子 + search agent + 意图服务 +
  // **mcpExtras 那张 25 格的逐项转发表**（本批主险，格数在插件里自检）。agent-runs.db 那条
  // sqlite 句柄随之变成域内 effect。
  // 它是装配序上最后一个域：吃前面十个域的产物，其中 `service` 来自采集调度域（已挂，直接给
  // 实例），`readSource` 仍是 thunk（不冻快照）。
  await kernel.plugin(agentPlugin, {
    dataDir,
    log,
    service,
    // thunk：三条网页搜索腿全部经 scheduler → registry → replay adapter → 用户的 Chrome。
    readSource: (sourceId, params) => scheduler.readSource(sourceId, params),
    // 同 harvest / adapters 两处：经 config 递 thunk 从根 kernel 现取，不在插件里 inject
    // `intervention`——五个 `graph_*` 工具的注册门读它，写死就是它们永远不注册。
    intervention: () => kernel.intervention,
  })

  return { config, kernel }
}
