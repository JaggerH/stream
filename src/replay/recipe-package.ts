import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Recipe } from './recipe.ts'
import { assertStateIdPrefix, validateStateGraph, type StateGraph } from './state-graph.ts'
import { validateRecipe } from './recipe-store.ts'
import { recipeToManifest } from './recipe-manifest.ts'
import type { SourceManifest } from '../manifest/types.ts'
import { packageNamespace, scanPackages, type ScanPackagesOptions, type StreamPackage } from '../packages/scan.ts'
import { namespacedSourceId } from '../registry/source-id.ts'
import { clampRateLimit } from './facility-rate-limit.ts'
import { applyLayerPick, pickLayers, type LayerPick } from '../packages/pick-layer.ts'
import type { ServingPolicy } from '../media/serving.ts'
import type { ItemDeclaration, ProviderDeclaration, SearchSourceDeclaration } from '../packages/descriptor.ts'
import type { LinkHost, LinkPattern, LinksDeclaration } from '../packages/links.ts'

/** Highest recipe-package schema this interpreter understands. A package that
 *  declares a NEWER version is refused loudly — silently loading it would run
 *  actions under semantics we don't know (trust boundary), so the user is told
 *  to upgrade the app instead. */
export const RECIPE_PACKAGE_SCHEMA_VERSION = 1

/** 官方包的 npm scope。这个 scope 的包与内置层同等信任：npm 的 scope 归属就是 CLI 主包自己
 *  （`@streamapp/stream`）的信任根，这里不新增任何信任面。用途：用户层同名覆盖内置层时
 *  `secret_params` 闸 3 仍注入凭据（否则官方更新一装凭据就断）。 */
export const OFFICIAL_SCOPE = '@streamapp/'

/** 装包时写在包目录里的信任旁注（`<dir>/.stream-trust.json`）。**只在"装下来的官方 scope 包核不上
 *  官方源"时才写**：`STREAM_NPM_REGISTRY` 指着镜像时，镜像给什么就装什么——不多核一次，镜像就成了
 *  "谁能拿凭据"的信任根，而 OFFICIAL_SCOPE 头注说的信任根是 npm 官方的 scope 归属。核法在
 *  `recipe-install.ts` 的 `mirrorVerdict`：向官方源要同版的 `dist.integrity`，与实际 tarball 的哈希
 *  比；一致 = 官方（不写旁注）；不一致 / 官方源没这个版本 / 连不上 = 照装、但当第三方对待（写旁注，
 *  闸 3 不给凭据）。文件不存在 = 官方（手放的、官方源装的都走这条）；坏掉的文件当"不官方"读——
 *  一份读不出来的信任声明只会往低了错。 */
export const TRUST_SIDECAR = '.stream-trust.json'

export interface PackageTrust {
  official: boolean
  /** 为什么核不上——preview / update 把它念给用户听。 */
  reason?: string
}

export function readPackageTrust(dir: string): PackageTrust {
  const p = join(dir, TRUST_SIDECAR)
  if (!existsSync(p)) return { official: true }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<PackageTrust>
    return { official: raw.official === true, ...(typeof raw.reason === 'string' && { reason: raw.reason }) }
  } catch {
    return { official: false, reason: `${TRUST_SIDECAR} 读不出来` }
  }
}

/** 用户数据目录那一层的扫描立场：里面的无关 yaml 不是迁移遗漏，是用户自己的文件——跳过，
 *  别让它把后端启动整体拖垮（bootstrap 的挂载点没有 try/catch，而且也不该有：
 *  schemaVersion 上界那条信任边界必须照常抛出去）。 */
export const USER_LAYER_SCAN: ScanPackagesOptions = { leftovers: 'ignore' }

export interface LoadRecipePackagesOptions extends ScanPackagesOptions {
  /**
   * 这一层是**仓库自带的内置包目录**（`packages/`）。
   *
   * 为什么要分层：并轨后 `packages/` 里既住着 recipe 包也住着插件包，而插件包在这一层
   * **另有主人**——bootstrap 的 `curated`（= 插件描述的 `sources`）已经把它们的
   * `manifests.yaml` 挂进 registry 了。用户数据目录那一层没有这个主人。于是这里两件事变了：
   *
   * 1. **不出"没有对应 recipe 的纯 manifest 源"**。出了就是同一份 manifest 进两个 registry
   *    group，`Registry.swapGroup` 当场抛 `Duplicate manifest id`，后端起不来。用户层必须照出
   *    ——那是第三方包的 `manifests.yaml` 进 registry 的唯一一条路。
   * 2. **一格没填（无 recipe 无 source）的包不出描述**：那就是插件包。用户层反过来，必须照出
   *    ——`listInstalledRecipePackages` 靠它列"我装了什么"，漏一个 = 用户装了却看不见、卸不掉。
   *
   * 给某条 recipe 手写覆盖 manifest 那条能力（power-user escape hatch）两层都照常。
   */
  builtinLayer?: boolean
}

/** 仓库自带那一层（`packages/`）的立场：顶层残留 yaml 照旧大声拒绝（那里的 yaml 只可能是
 *  迁移遗漏），且它与插件投影共用一个目录（见 builtinLayer）。 */
export const BUILTIN_LAYER_SCAN: LoadRecipePackagesOptions = { builtinLayer: true }

export interface RecipePackage {
  /** 设施键（新形没有 facility 时由包 id 顶上） */
  facility: string
  /** 旧形声明的 schemaVersion；新形没声明 → 按当前上界记 */
  schemaVersion: number
  cookieDomain?: string
  /** 该 facility 的频率闸门 + 长时窗累计预算（见 FacilityRateLimiter）。不声明 = 不限。 */
  rateLimit?: { burst: number; perMinute: number; perHour?: number; maxWaitMs?: number }
  /** facility 级送字节策略（package.json#stream.serving），装载时已盖上 `label`。见 spec 2026-09-18 §2.1。 */
  serving?: ServingPolicy[]
  /** 这个包顶掉了哪些 RSSHub 目录路由（全 id → 理由）。见 spec 2026-09-18 §2.4。 */
  retires?: Record<string, string>
  /** 这个包出的 Provider 行（package.json#stream.providers）。见 spec 2026-09-18-facility-knowledge-stage2-design §2.2。 */
  providers?: ProviderDeclaration[]
  /** 资源搜索源元数据（package.json#stream.searchSources）。`source` **装载时已补成全名**。 */
  searchSources?: SearchSourceDeclaration[]
  /** 本包的源产出的条目上多带什么（package.json#stream.item）。投影在 `src/packages/item-projection.ts`。 */
  item?: ItemDeclaration
  /** `stream.homepage`——它的主机给源目录与条目的 `site` 格用（图标、站名）。 */
  homepage?: string
  /** 链接认领声明（package.json#stream.links，已归一；老 trackUrl / downloadPages 已翻译进来）。见 `linkTableOf`。 */
  links?: LinksDeclaration
  /** 这个包认领的 RSSHub 命名空间（normalizer 键 = facility）。 */
  rsshubNamespaces?: string[]
  /** 目录里标了 `requirePuppeteer`、但带 cookie 纯 HTTP 就能跑的命名空间——解析目录时不因那个标记丢掉。 */
  rsshubNoBrowserNamespaces?: string[]
  /** RSSHub 要的 cookie 环境变量名模板（`{CookieName}` 占位符换成同名 cookie 的值）。 */
  rsshubCookieEnv?: string
  /** npm package name/version, when declared in package.json root */
  name?: string
  version?: string
  /** `stream.name`——给人看的包名；serving 策略的 label 与被认领 RSSHub 命名空间的 facility.label 都用它。 */
  label?: string
  /** absolute path of the package folder */
  dir: string
  /** manifests.yaml entries (adapter: replay), pluginId NOT stamped — sealing is bootstrap's job */
  sources: SourceManifest[]
  /** 包自带的状态图（`<dir>/states.json`，spec 2026-09-11 §9.1）。没有这个文件 = 缺席，不是空图。 */
  states?: StateGraph
}

export interface LoadedRecipePackages {
  descriptors: RecipePackage[]
  /** recipe bodies keyed by sourceId, validated (Task 1.1 schema) */
  recipes: Map<string, Recipe>
}

/**
 * 描述符里**只有 recipe 层读得到**的那几格 facility 知识。
 *
 * 它有一份可执行的回补清单：`recipe-package.declares-knowledge.test.ts` 用
 * `STREAM_DECLARATION_KEYS`（从 zod schema 现取）减去一份「明确不属于这里」的白名单，断言剩下的
 * 恰好是这张表——所以往 `package.json#stream` 加一格声明而忘了回补判据，测试当场红。
 *
 * 逐格为什么在这儿：
 *  - `serving`（送字节策略）→ `servingPoliciesOf`
 *  - `retires`（退役的 RSSHub 路由）→ `retiredRoutesOf`
 *  - `providers`（Provider 行）→ `providerDeclarationsOf` → 合并身份表
 *  - `searchSources`（资源搜索源元数据）→ `searchSourcesOf` → `src/search/seeds.ts`
 *  - `item`（条目上的作者头像 / 可点动作）→ `src/packages/item-projection.ts`（经 `toClientItem` 现算）
 *  - `links`（链接认领表：主机 / 短链 / 曲目 / 下载中转页；老 `trackUrl` / `downloadPages` 装载时翻译进来）
 *    → `linkTableOf` → `src/links/recognize.ts`
 *  - `rsshubNamespaces`（认领的 RSSHub 命名空间）→ `rsshubNamespaceNormalizersOf`
 *  - `rsshubNoBrowserNamespaces`（标了 puppeteer 但带 cookie 纯 HTTP 能跑的命名空间）→ `rsshubNoBrowserNamespacesOf`
 *  - `rsshubCookieEnv`（RSSHub 要的 cookie 环境变量名模板）→ `rsshubCookieEnvOf`
 *  - `rateLimit`（facility 限速）→ 采集域的 `FacilityRateLimiter`
 *  - `cookieDomain`（这个 facility 的登录态域）→ 同一份描述符往下带
 *
 * 状态图（`states.json`）不在这张表里：它是盘上的一个文件，不是 `package.json` 的一格，
 * 由调用方单独传进来。
 */
export const FACILITY_KNOWLEDGE_FIELDS = [
  'serving', 'retires', 'providers', 'links', 'rsshubNamespaces', 'rsshubNoBrowserNamespaces', 'rsshubCookieEnv',
  'rateLimit', 'cookieDomain', 'searchSources', 'item',
] as const satisfies readonly (keyof StreamPackage)[]

/**
 * 这个包除了 recipe / source 之外，还带着**只有这一层读得到**的 facility 知识吗？
 *
 * 漏一格的表现**极安静**——`loadRecipePackages` 的内置层会把这个包整个跳过，于是那格声明
 * 从不生效：不报错、不降级、没有一处会喊，只是那个能力不在。第一个撞上的是一个**一份 recipe
 * 文件都没有**的包（它的清单走插件路径挂载），而它声明的 Provider 行只从这一层读——判据不加
 * `providers` 那一行，那条行就永远建不出来。
 * 见 spec 2026-09-18-facility-knowledge-stage2-design §2.2。
 */
export function declaresFacilityKnowledge(pkg: StreamPackage, states?: StateGraph): boolean {
  return !!states || FACILITY_KNOWLEDGE_FIELDS.some((field) => pkg[field] != null)
}

/**
 * Load every `<facility>/` recipe package under the data dir.
 * 目录遍历与描述解析都交给统一扫描器 scanPackages（插件包同一把尺）：`package.json#stream`
 * + 可选 `manifests.yaml` + `*.recipe.json`；子目录没有 package.json 就不是包（跳过）；
 * **同一个包内**重复的 sourceId 拒绝整次加载（跨包同名不是冲突：全名带包名前缀，
 * 两个包产不出同一个 id——见 `src/registry/source-id.ts`）。
 *
 * `opts.leftovers` 直通 scanPackages：仓库自带那层（`packages/`）保持默认 'throw'，
 * **用户数据目录**传 'ignore'（用户往自己的文件夹里放个无关 yaml 不该让后端起不来）。
 * 两层各自的立场见 `BUILTIN_LAYER_SCAN` / `USER_LAYER_SCAN`。
 */
export function loadRecipePackages(dir: string, opts?: LoadRecipePackagesOptions): LoadedRecipePackages {
  return loadScannedRecipePackages(scanPackages(dir, opts), opts)
}

/**
 * `loadRecipePackages` 的后半段：扫描结果已在手里时用。两层装载（`mountRecipePackages` /
 * `mergeRecipePackagesByFacility`）先各扫一遍、拿两层的 npm 名与版本去 `pickLayers` 判谁整包跳过，
 * 再把留下的喂进来——扫描不用做第二遍。
 */
export function loadScannedRecipePackages(scanned: readonly StreamPackage[], opts?: LoadRecipePackagesOptions): LoadedRecipePackages {
  const descriptors: RecipePackage[] = []
  const recipes = new Map<string, Recipe>()

  // 一个包一格（对齐 scanPackages 的同名选项）：给了 onPackageError，坏包报一条、跳过，
  // 其余照常装；不给就照旧整层抛。**跳过必须是干净的**——所以 recipe 先攒在包内的局部表里，
  // 整个包都过了才提交进 `recipes`，否则一个抛在半路的包会往全局表里留下半份。
  const loadOne = (pkg: StreamPackage): void => {
    const facility = pkg.facility ?? pkg.id
    // 全名的前缀。**recipe 文件里写的仍是局部名**——包作者不该在自己的文件里写自己的 npm
    // 包名（改包名就得改每一个 recipe 文件，本地开发时包名往往还没定），全名是宿主在这里
    // 合成的。这条边界与 `pluginId` 同构：派生字段在进 Registry 前写死，读取端零推导。
    const ns = packageNamespace(pkg)
    if (pkg.legacySchemaVersion != null && pkg.legacySchemaVersion > RECIPE_PACKAGE_SCHEMA_VERSION) {
      throw new Error(
        `recipe package "${facility}" declares schemaVersion ${pkg.legacySchemaVersion}, ` +
        `but this app supports ≤ ${RECIPE_PACKAGE_SCHEMA_VERSION} — upgrade the app to use it (refusing to guess)`,
      )
    }

    // manifests.yaml is OPTIONAL: a recipe self-describes via its `meta` block and the
    // loader synthesizes a SourceManifest (recipeToManifest) — so an agent-generated
    // recipe needs no hand-written manifest. When present (already merged into pkg.sources
    // by scanPackages, through the SAME manifestSchema plugin sources use), an entry is a
    // FULL OVERRIDE for that sourceId (power-user escape hatch) → synthesized and
    // hand-written sources meet the identical bar.
    // 手写 override 的 `id` 也是局部名，同样在这里加前缀后再与 recipe 的全名对齐。
    const overrides = new Map<string, SourceManifest>(
      (pkg.sources ?? []).map((m) => [namespacedSourceId(ns, m.id), { ...m, id: namespacedSourceId(ns, m.id) }]),
    )

    // 状态图是 recipe 契约的一个文件（PACKAGE.md §2.10）：读、校验、前缀核对，任一不过就拒**这个包**
    // （同 recipe 文件坏了的处置）——一张半对的状态图比没有更坏，它会让 identify 静默认错。
    let states: StateGraph | undefined
    const statesPath = join(pkg.dir, 'states.json')
    if (existsSync(statesPath)) {
      try {
        const raw = JSON.parse(readFileSync(statesPath, 'utf-8')) as StateGraph
        if (!Array.isArray(raw.states) || !Array.isArray(raw.transitions)) throw new Error('必须是 { states: [], transitions: [] }')
        for (const s of raw.states) assertStateIdPrefix(facility, s.id)
        validateStateGraph(raw)
        states = raw
      } catch (e) {
        throw new Error(`recipe package "${facility}": states.json: ${(e as Error).message}`)
      }
    }

    const pkgRecipes: Recipe[] = []
    // **同包内**查重。跨包重名在命名空间化之后不再是冲突（两个包的全名天然不同），但同一个包里
    // 两个文件写同一个局部名仍是作者的错——它们会合成出同一个全名，后一份静默盖掉前一份。
    const seenInPkg = new Set<string>()
    for (const f of readdirSync(pkg.dir)) {
      if (!f.endsWith('.recipe.json')) continue
      let recipe: Recipe
      try {
        recipe = validateRecipe(f, JSON.parse(readFileSync(join(pkg.dir, f), 'utf-8')))
      } catch (e) {
        throw new Error(`recipe package "${facility}": ${f}: ${(e as Error).message}`)
      }
      if (seenInPkg.has(recipe.sourceId)) {
        throw new Error(
          `recipe package "${facility}": sourceId "${recipe.sourceId}" appears in more than one recipe file — sourceIds must be unique within a package`,
        )
      }
      seenInPkg.add(recipe.sourceId)
      // **不在这里** `recipes.set` —— 整个包都过了才提交（见 loadOne 头注：跳过必须是干净的）。
      pkgRecipes.push(recipe)
    }

    // Each recipe → its override manifest if hand-written, else a synthesized one.
    // Override entries with no matching recipe are kept verbatim (a pure-manifest source).
    const sources: SourceManifest[] = pkgRecipes.map(
      (r) => overrides.get(namespacedSourceId(ns, r.sourceId)) ?? recipeToManifest(r, facility, ns),
    )
    const recipeIds = new Set(pkgRecipes.map((r) => namespacedSourceId(ns, r.sourceId)))
    if (!opts?.builtinLayer) {
      for (const [id, m] of overrides) if (!recipeIds.has(id)) sources.push(m)
    }

    // 内置层里一个 recipe 也没有、一条 source 也不出、**也没有别的 facility 知识**的包 =
    // 插件包，没填 recipe 槽位。留着它只会让下游拿到一串空描述：分享导出的依赖目录多出几个
    // 没内容的"recipe 包"，导入去重表也按它的名字占一格。用户层**不能**这么跳（见
    // builtinLayer）：那里一个空包也是用户装的，listInstalledRecipePackages 得列出来他才卸得掉。
    if (opts?.builtinLayer && !pkgRecipes.length && !sources.length && !declaresFacilityKnowledge(pkg, states)) return

    // 到这里这个包整份都过了 —— 现在才提交进跨包那张表（键是全名）。
    for (const r of pkgRecipes) recipes.set(namespacedSourceId(ns, r.sourceId), r)
    // `stream.name`——给人看的包名，缺省退到 facility。serving 策略的 label 与 descriptor 自己
    // 的 `label` 字段共用这一个值，避免两处各算一次而漂。
    const label = pkg.name ?? facility
    descriptors.push({
      facility,
      schemaVersion: pkg.legacySchemaVersion ?? RECIPE_PACKAGE_SCHEMA_VERSION,
      cookieDomain: pkg.cookieDomain,
      rateLimit: pkg.rateLimit,
      name: pkg.pkgName,
      version: pkg.pkgVersion,
      label,
      dir: pkg.dir,
      sources,
      ...(states ? { states } : {}),
      ...(pkg.serving ? { serving: pkg.serving.map((s) => ({ ...s, label })) } : {}),
      ...(pkg.retires ? { retires: pkg.retires } : {}),
      ...(pkg.providers ? { providers: pkg.providers } : {}),
      // `source` 是包作者写的局部名，全名在这里合成（同 recipe sourceId 的规矩）；`provider` 是行 id，不带命名空间。
      // 例外：含 `:` 的是 RSSHub 目录路由 id（`rsshub:<ns>/<path>`）——它不归任何包命名空间（PACKAGE.md §1.1），
      // 原样保留。局部名本来就不许含 `:`，所以这条判据没有二义。
      ...(pkg.searchSources ? { searchSources: pkg.searchSources.map((s) => (s.source && !s.source.includes(':') ? { ...s, source: namespacedSourceId(ns, s.source) } : s)) } : {}),
      ...(pkg.item ? { item: pkg.item } : {}),
      ...(pkg.homepage ? { homepage: pkg.homepage } : {}),
      ...(pkg.links ? { links: pkg.links } : {}),
      ...(pkg.rsshubNamespaces ? { rsshubNamespaces: pkg.rsshubNamespaces } : {}),
      ...(pkg.rsshubNoBrowserNamespaces ? { rsshubNoBrowserNamespaces: pkg.rsshubNoBrowserNamespaces } : {}),
      ...(pkg.rsshubCookieEnv ? { rsshubCookieEnv: pkg.rsshubCookieEnv } : {}),
    })
  }

  for (const pkg of scanned) {
    if (!opts?.onPackageError) { loadOne(pkg); continue }
    try {
      loadOne(pkg)
    } catch (e) {
      opts.onPackageError(pkg.dir, e as Error)
    }
  }

  return { descriptors, recipes }
}

export interface MergedRecipePackages {
  /** facility → 合并后的包描述（声明类字段版本高者为准，见 DECLARATION_FIELDS；rateLimit 取最严） */
  byFacility: Map<string, RecipePackage>
  /** byFacility 的值数组（分享导出内嵌 + 版本比对用） */
  list: RecipePackage[]
}

/**
 * 同 facility 两层（**不同 npm 名**）归并时**内置为准**的那几格——全是「宿主机制读的声明」，不是给人看的。
 *
 * 同 npm 名的两层（同一个包的两个版本）**不到这里**：`scanLayers` 已按版本只留一层（`pickLayers`，
 * `src/packages/pick-layer.ts`），赢的那层的声明就是全部。所以到归并点撞上的一定是不同 npm 名（第三方给
 * 这个 facility 的附加包），不同包的版本号不可比，这几格用内置的；内置**没声明**的格收用户层的（叠加，不是覆盖）。
 *
 * 为什么不让附加包顶掉内置的声明：内置包随宿主同版本出货，它的声明与宿主机制对得上；一个第三方附加包
 * 少一格声明就是**静默丢能力**——播放变 502（`serving` 没了、直链不再代理）、目录路由消失
 * （`rsshubNoBrowserNamespaces` 没了、带 puppeteer 标记的路由被丢掉）、Provider 行建不出来（`providers`
 * 没了），没有一处会喊。
 *
 * 边界：`rateLimit` 不在这张表里，它有自己的规则（两层都声明取最严，`clampRateLimit`）。`states` 在表里：
 * 状态图是 identify 的判据，半张旧图比没有更坏（`loadRecipePackages` 头注）。
 *
 * `code` / `credentials` 不在这里：它们不进 RecipePackage 描述符（走 `src/packages/` 的插件槽位装载），
 * 这一层归并从来碰不到它们。
 */
export const DECLARATION_FIELDS = [
  'serving', 'retires', 'providers', 'links', 'rsshubNamespaces', 'rsshubNoBrowserNamespaces', 'rsshubCookieEnv',
  'cookieDomain', 'states', 'searchSources', 'item',
] as const satisfies readonly (keyof RecipePackage)[]

/**
 * 把两层（builtin + user）的包描述按 facility 归并——bootstrap 与热重载共用这一把尺。
 * 抽成纯函数的意义：install 热挂载后必须重跑它重建快照，否则新装包的 rateLimit 活体读不到
 * （见 2026-08-01 最终评审 I-1）。
 *
 * **同 npm 名的两层先由 `scanLayers` 只留版本高的一层**（与 `mountRecipePackages` 同一个结论），
 * 所以到这里同 facility 撞上的一定是**不同 npm 名**的包（第三方给内置 facility 的附加包）：
 *  - `DECLARATION_FIELDS` 里的声明：内置为准，内置没声明的格收用户层的（叠加）；
 *  - `rateLimit` 取最严（clampRateLimit）；
 *  - `sources` 两层并集——按 sourceId 反查包的消费者（intervention 域）得能看到两层的源；
 *  - 其余（展示字段 name / version / label / dir …）user 层覆盖 builtin。
 * recipe 本身不经这里：由 `mountRecipePackages` 按全名装载。
 */
export function mergeRecipePackagesByFacility(
  builtinDir: string,
  userDir: string,
  onPackageError?: (pkgDir: string, err: Error) => void,
  opts?: LayerOptions,
): MergedRecipePackages {
  const byFacility = new Map<string, RecipePackage>()
  const layers = scanLayers(builtinDir, userDir, onPackageError, opts)
  for (const d of [...layers.builtin.descriptors, ...layers.user.descriptors]) {
    const prev = byFacility.get(d.facility)
    byFacility.set(d.facility, prev ? mergeFacilityDescriptors(prev, d) : d)
  }
  return { byFacility, list: [...byFacility.values()] }
}

/**
 * 两层装载（`mountRecipePackages` / `mergeRecipePackagesByFacility`）在「同 npm 名两层只留一层」这件事上
 * 的开关。全部可选：不传就是"现算、什么都不额外剔"（启动路径由 sources 域传启动那份结论）。
 */
export interface LayerOptions {
  /** 同名对的日志。只在**新出现的对**上说（`pick` 冻住时，启动那次已知的对不再报）。 */
  log?: (msg: string) => void
  /**
   * **冻住的取舍**——启动那次 `pickLayers` 的结论（`PackagesService.layerPick`），热重载传它、不现算。
   * 为什么不能现算：被顶掉的内置包的 `manifests.yaml` 走 curated 进 registry，而 curated 只在启动时建、
   * 不热换。运行中装进一个同名新版，现算会把内置那层摘掉、把用户层的清单塞进 recipes 组——与还留在
   * curated 里的那份撞成 `Duplicate manifest id`，**从此每一轮热重载都失败**（改 recipe、装别的包全都
   * 保留上一份）。冻住之后 curated 与 recipes 组对同一对包永远给同一个答案。
   */
  pick?: LayerPick
  /**
   * 用户层新版顶掉的那个内置包**被用户禁用了** → 用户层那份也不装。启用开关的全部机制是"禁用的插件
   * 不出 curated"，被顶掉的内置本来就不出 curated，不加这一条，用户层那份会从 recipes 组把它的源
   * 原样装回来——开关形同虚设。按 npm 名问，调用时现查（开关是活的）。
   */
  supersededBuiltinDisabled?: (pkgName: string) => boolean
  /**
   * `pick` 冻住时才有意义：这个内置包**此刻有 curated 清单在 registry 里**吗？运行中新装的同名新版，
   * 若它顶掉的内置有 curated 清单，这一轮**先不装它**（`MountedRecipePackages.deferred` 点名），重启后
   * 切换；没有就照常装（两层同全名时用户层盖住内置那条，swap 不会撞，无须等重启）。
   */
  builtinHasCurated?: (pkgName: string) => boolean
}

/** 两层扫描 + 同 npm 名只留版本高的一层 + 装载。`mountRecipePackages` 与
 *  `mergeRecipePackagesByFacility` 共用，两处才会对同一对包给出同一个答案。 */
interface ScannedLayers {
  builtin: LoadedRecipePackages
  user: LoadedRecipePackages
  /** 这一轮实际生效的取舍（`opts.pick` 给了就是它，否则现算）。 */
  pick: LayerPick
  /** 这一轮**先不装**的用户层同名新版（见 `LayerOptions.builtinHasCurated`）。 */
  deferred: string[]
}

/**
 * 同 npm 名的包两层都在 → 只装版本高的那一层的一切（`pickLayers`，`src/packages/pick-layer.ts` 头注）。
 * 在**扫描结果**上判、不在描述符上判：内置层里一个只有 `manifests.yaml` + 代码、没有 recipe 的包
 * 出不了描述符（它的清单归 curated 投影），但它照样是"同名的那一层"——用户装了它的新版，
 * 内置那份的清单就该从 curated 里摘掉，而这个结论 sources 域要从 `PackagesService.layerPick`
 * 拿到同一个。
 */
function scanLayers(
  builtinDir: string,
  userDir: string,
  onPackageError?: (pkgDir: string, err: Error) => void,
  opts: LayerOptions = {},
): ScannedLayers {
  // builtin 层是仓库自带的，顶层残留 yaml 照旧大声拒绝；user 层是用户自己的数据目录，无关 yaml 跳过。
  const builtinOpts = { ...BUILTIN_LAYER_SCAN, onPackageError }
  const userOpts = { ...USER_LAYER_SCAN, onPackageError }
  const builtin = scanPackages(builtinDir, builtinOpts)
  const user = scanPackages(userDir, userOpts)
  const frozen = opts.pick
  // 现算一份：冻住时它只用来认出**新出现的对**（日志 + 推迟），冻住的那份才决定内置层剔谁。
  const known = new Set([...(frozen?.skipBuiltinNames ?? []), ...(frozen?.skipUserNames ?? [])])
  const fresh = pickLayers(builtin, user, opts.log, known)
  // 用户层输了的整包剔掉永远安全（不会撞 curated），所以这一侧总用现算的；内置层剔谁必须跟 curated
  // 同一份（见 LayerOptions.pick）。
  const pick: LayerPick = frozen ? { skipBuiltinNames: frozen.skipBuiltinNames, skipUserNames: fresh.skipUserNames } : fresh
  const deferred: string[] = []
  const kept = applyLayerPick(pick, builtin, user)
  kept.user = kept.user.filter((p) => {
    const name = p.pkgName
    if (!name || !fresh.skipBuiltinNames.has(name)) return true
    // 顶掉了一个被禁用的内置 → 开关对它同样生效。
    if (opts.supersededBuiltinDisabled?.(name)) return false
    // 冻住时新出现的顶掉：内置那份的清单还在 curated 里 → 这一轮先不装它。
    if (frozen && !frozen.skipBuiltinNames.has(name) && opts.builtinHasCurated?.(name)) { deferred.push(name); return false }
    return true
  })
  return {
    builtin: loadScannedRecipePackages(kept.builtin, builtinOpts),
    user: loadScannedRecipePackages(kept.user, userOpts),
    pick,
    deferred,
  }
}

/**
 * 同 facility 的 builtin 描述符 + user 描述符 → 一份。规则见 `mergeRecipePackagesByFacility` 头注。
 *
 * **到这里一定是不同 npm 名**（同名的两层已由 `scanLayers` 只留一层；没有 npm 名的本地包 `name` 为
 * undefined，也不算同名）。不同包的版本号之间没有可比性——`@third/foo-extra@5.0.0` 不比
 * `@streamapp/foo@1.0.0` "新"，只是另一个包——所以声明**一律内置为准**，用户层只叠加内置没声明的格。
 */
export function mergeFacilityDescriptors(builtin: RecipePackage, user: RecipePackage): RecipePackage {
  const merged: RecipePackage = { ...user, rateLimit: clampRateLimit(builtin.rateLimit, user.rateLimit) }
  const slots = merged as unknown as Record<(typeof DECLARATION_FIELDS)[number], unknown>
  for (const field of DECLARATION_FIELDS) {
    // 内置声明了 → 用它的；内置没声明 → 收用户层的（叠加，不是覆盖）。
    // 两层都没声明就不动 `...user` 带来的形状（不写一个显式 undefined 键进去）。
    const value = builtin[field] != null ? builtin[field] : user[field]
    if (value != null) slots[field] = value
  }
  const sources = new Map<string, SourceManifest>()
  for (const m of builtin.sources) sources.set(m.id, m)
  for (const m of user.sources) sources.set(m.id, m)
  merged.sources = [...sources.values()]
  return merged
}

/** 所有包的 serving 声明并成一张策略表（`servingPolicyFor` 的数据源，调用时现取）。 */
export function servingPoliciesOf(pkgs: Array<Pick<RecipePackage, 'serving'>>): ServingPolicy[] {
  return pkgs.flatMap((p) => p.serving ?? [])
}

/** 所有包的 retires 并成一张表：RSSHub 目录 id → 退役理由（catalog 解析时用）。 */
export function retiredRoutesOf(pkgs: Array<Pick<RecipePackage, 'retires'>>): Map<string, string> {
  const out = new Map<string, string>()
  for (const p of pkgs) for (const [id, why] of Object.entries(p.retires ?? {})) out.set(id, why)
  return out
}

/** 一条包声明的 Provider 行 + 声明它的 facility（撞名拒绝时要说清是谁声明的）。
 *
 *  `packageName` 是 npm 名，会被盖进建出来那条行的 `options.declaredBy`——`ensureSystemRows`
 *  的清退分支靠它分清「代码删了这条行」和「这一轮这个包没装上」（见 `SystemIdentity.declaredBy`）。
 *  包的 `package.json` 没有 root `name` 时它就是缺席的，那条行退回按宿主行处理。 */
export interface DeclaredProviderRow { facility: string; packageName?: string; declaration: ProviderDeclaration }

/** 所有包声明的 Provider 行（声明序）。合并进身份表与撞名判决都在 `src/providers/identities.ts`。 */
export function providerDeclarationsOf(pkgs: Array<Pick<RecipePackage, 'facility' | 'name' | 'providers'>>): DeclaredProviderRow[] {
  return pkgs.flatMap((p) => (p.providers ?? []).map((declaration) => ({ facility: p.facility, packageName: p.name, declaration })))
}

/** 认领表里的一个包：它认领的主机、短链主机、路径类型。`package` = npm 名（没有就退到 facility）。 */
export interface LinkTableEntry { package: string; hosts: LinkHost[]; shortHosts: string[]; patterns: LinkPattern[] }
export interface LinkTable { entries: LinkTableEntry[]; rejected: Array<{ package: string; reason: string }> }

/**
 * 所有包的 `links` 并成一张认领表（`src/links/recognize.ts` 的数据源，调用时现取）。
 *
 * **一个主机、一个平台只归一个包**（spec 2026-09-26-link-recognition §3）：按声明序走，某包的任一主机
 * 已被别的包占了（全等）、或它的任一平台已归别的包 → 这个包的整份 `links` 拒掉，记进 `rejected`
 * 由调用方出声（同 Provider 行 `serveKeys` 撞键：后到的拒、先到的留）。不整份拒而只拒撞的那几条，
 * 会留下一个「主机归我、pattern 却在别人家」的半张表，那比没有更难查。
 * 嵌套主机（一个包认 `a.com`、另一个认 `m.a.com`）不算撞：认领时最长后缀胜。
 */
export function linkTableOf(pkgs: Array<Pick<RecipePackage, 'facility' | 'name' | 'links'>>): LinkTable {
  const hostOwner = new Map<string, string>()
  const platformOwner = new Map<string, string>()
  const entries: LinkTableEntry[] = []
  const rejected: LinkTable['rejected'] = []
  for (const p of pkgs) {
    if (!p.links) continue
    const pkg = p.name ?? p.facility
    const platforms = new Set([...p.links.hosts, ...p.links.patterns].map((x) => x.platform))
    const hostClash = p.links.hosts.find((h) => hostOwner.has(h.host) && hostOwner.get(h.host) !== pkg)
    const platformClash = [...platforms].find((pl) => platformOwner.has(pl) && platformOwner.get(pl) !== pkg)
    if (hostClash) {
      rejected.push({ package: pkg, reason: `主机 ${hostClash.host} 已归 ${hostOwner.get(hostClash.host)}` })
      continue
    }
    if (platformClash) {
      rejected.push({ package: pkg, reason: `平台 ${platformClash} 已归 ${platformOwner.get(platformClash)}` })
      continue
    }
    for (const h of p.links.hosts) hostOwner.set(h.host, pkg)
    for (const pl of platforms) platformOwner.set(pl, pkg)
    entries.push({ package: pkg, hosts: p.links.hosts, shortHosts: p.links.shortHosts, patterns: p.links.patterns })
  }
  return { entries, rejected }
}

/** 所有包的资源搜索源元数据并成一张表（`searchMetaBySourceId` 的包那一半，调用时现取）。 */
export function searchSourcesOf(pkgs: Array<Pick<RecipePackage, 'searchSources'>>): SearchSourceDeclaration[] {
  return pkgs.flatMap((p) => p.searchSources ?? [])
}

/**
 * RSSHub 命名空间 → normalizer 键（= 认领它的包 facility）。
 * **两个包认领同一个命名空间 → 抛**：那是两份互相看不见的渲染规则争同一批路由，先到先得会
 * 随磁盘顺序漂，而症状是「这个源今天渲染对、明天不对」。
 */
export interface NamespaceClaim {
  /** normalizer 键 = 认领它的包 facility */
  normalizer: string
  /** 目录路由的 facility.label 用它——RSSHub 自己那份命名空间名可能和认领它的包对不上（同一个
   *  命名空间下 RSSHub 按另一条产品线起名）；包认领了这批路由，标签就该是包的名字。 */
  label: string
}

export function rsshubNamespaceNormalizersOf(pkgs: Array<Pick<RecipePackage, 'facility' | 'label' | 'rsshubNamespaces'>>): Map<string, NamespaceClaim> {
  const out = new Map<string, NamespaceClaim>()
  for (const p of pkgs) {
    for (const ns of p.rsshubNamespaces ?? []) {
      const prev = out.get(ns)
      if (prev && prev.normalizer !== p.facility) {
        throw new Error(`[recipe-package] RSSHub 命名空间 "${ns}" 被两个包同时认领：${prev.normalizer} 与 ${p.facility}`)
      }
      out.set(ns, { normalizer: p.facility, label: p.label ?? p.facility })
    }
  }
  return out
}

/**
 * 「标了 `requirePuppeteer` 但带 cookie 纯 HTTP 能跑」的命名空间——各包声明的并集。
 * 两个包同时说同一个命名空间不需要浏览器不算冲突（说的是同一件事实），所以是 Set 而不是抛。
 */
export function rsshubNoBrowserNamespacesOf(pkgs: Array<Pick<RecipePackage, 'rsshubNoBrowserNamespaces'>>): Set<string> {
  const out = new Set<string>()
  for (const p of pkgs) for (const ns of p.rsshubNoBrowserNamespaces ?? []) out.add(ns)
  return out
}

/**
 * `inject.ref` → RSSHub cookie 环境变量名模板。
 *
 * 键 = 包 facility **加上它认领的每一个 RSSHub 命名空间**。查表的一侧（`CookieProvider`）用的是
 * catalog 推出来的 `inject.ref`，而那个 ref 是**命名空间**（见 `deriveCookieAuth`），命名空间和
 * facility 不一定同名（一个包可以叫 A 却认领 RSSHub 里按另一条产品线起名的命名空间）——只按
 * facility 建键，那个包声明的模板就永远查不到，且没有一处会喊。
 *
 * 同一个键被两个包写成不同模板：先到的赢，出声。静默覆盖会让这个变量名随磁盘顺序漂。
 */
export function rsshubCookieEnvOf(pkgs: Array<Pick<RecipePackage, 'facility' | 'rsshubNamespaces' | 'rsshubCookieEnv'>>): Map<string, string> {
  const out = new Map<string, string>()
  for (const p of pkgs) {
    if (!p.rsshubCookieEnv) continue
    for (const key of [p.facility, ...(p.rsshubNamespaces ?? [])]) {
      const prev = out.get(key)
      if (prev && prev !== p.rsshubCookieEnv) {
        console.warn(`[recipe-package] RSSHub cookie 环境变量模板冲突：键 "${key}" 已由另一个包声明为 ${prev}，忽略 ${p.facility} 的 ${p.rsshubCookieEnv}`)
        continue
      }
      out.set(key, p.rsshubCookieEnv)
    }
  }
  return out
}

export interface MountedRecipePackages {
  /** merged manifests, deduped by **全名**（同 npm 名两层已只剩版本高的一层；没有 npm 名的本地包同全名时 user 层盖） */
  manifests: SourceManifest[]
  /** merged recipe bodies keyed by **全名**（同上） */
  recipes: Map<string, Recipe>
  /**
   * 同一批 manifest，但**按包分好组**（顺序同 manifests：builtin 在前、user 在后）。
   * 启动期整组进 registry 抛了要退化成逐包重试，那时得知道「这条 manifest 是哪个包带来的」，
   * 否则只能整批放弃 = 一个坏包照样掀翻全部。
   */
  byPackage: { dir: string; manifests: SourceManifest[] }[]
  /** 这一批里出自**内置层**（`packages/`）的全名。裸名歧义时 Registry 靠它判胜者，
   *  而只有装载方分得清哪条来自哪层（合并之后就看不出来了）。 */
  builtinIds: Set<string>
  /**
   * 哪些 **recipe**（按 recipe 的 key，不是 manifest id）来自内置层——`secret_params` 闸 3 的判据：
   * 凭据只注入给内置包。用户层用同名顶掉内置那份时，这个 id **不在**集合里（跑的是用户那份），
   * 除非那是核得上官方源的 `@streamapp/` 包（`stream update` 那条路，见函数体内的注释）。
   */
  builtinRecipeIds: Set<string>
  /** 这一次装载里同 npm 名两层的取舍（`LayerOptions.pick` 给了就是它）。 */
  pick: LayerPick
  /** 这一轮**先不装**的用户层同名新版（npm 名）：它顶掉的内置的 curated 清单还在 registry 里，重启才切换。
   *  sources 域拿它说一句人话；不说的话用户看到的是"装好了却没生效"。 */
  deferred: string[]
}

/**
 * Mount the two package layers for bootstrap: builtin (shipped with the app)
 * and user (data dir). Missing dirs are fine (first run → empty mount).
 * Manifests missing a `facility` are stamped with their package's facility.
 *
 * **两层同一个 npm 名 → 整包只装版本高的那一层**（`pickLayers`）：用户从 npm 装 `@scope/pkg` 的
 * 新版 → 内置那份的 recipe / manifests / 声明一条都不装，用户层那份是唯一的一份；装的是旧版或
 * 同版 → 用户层整包跳过。不按 id 逐条覆盖，是因为内置包的 `manifests.yaml` 还有另一条进 registry
 * 的路（curated 投影），逐条覆盖管不到它，两份同 id 撞成 `Duplicate manifest id`。「不同包互相盖」
 * 不存在：全名带包名前缀，两个包产不出同一个 id。
 */
export function mountRecipePackages(
  builtinDir: string,
  userDir: string,
  onPackageError?: (pkgDir: string, err: Error) => void,
  opts?: LayerOptions,
): MountedRecipePackages {
  // user 层的顶层残留 yaml 跳过（见 USER_LAYER_SCAN）；builtin 层照旧大声拒绝，且它的
  // manifests.yaml 归 curated 投影（见 BUILTIN_LAYER_SCAN）。同 npm 名两层都在 → 只装版本高的
  // 那一层（`scanLayers`，开关见 `LayerOptions`）：输的那层的 recipe / manifests 一条都不进来，
  // "同全名用户层覆盖"只剩没有 npm 名的本地开发包、以及 pick 冻住后运行中新装的同名新版这两档。
  const scanned = scanLayers(builtinDir, userDir, onPackageError, opts)
  const builtin = scanned.builtin
  const layers = [builtin, scanned.user]

  const recipes = new Map<string, Recipe>()
  const byId = new Map<string, SourceManifest>()
  const byPackage: { dir: string; manifests: SourceManifest[] }[] = []
  for (const layer of layers) {
    for (const [id, recipe] of layer.recipes) recipes.set(id, recipe) // later layer (user) wins
    for (const pkg of layer.descriptors) {
      const stamped = pkg.sources.map((m) =>
        // manifest's own facility wins; else stamp from the package (label defaults to the key
        // until package.json#stream grows a label field)
        ({ ...m, facility: m.facility ?? { key: pkg.facility, label: pkg.facility } }))
      for (const m of stamped) byId.set(m.id, m)
      byPackage.push({ dir: pkg.dir, manifests: stamped })
    }
  }

  // 用户层新版顶掉了同名内置包的那些用户层包：它们**就是**内置包（同一个 npm 名，只是版本新），
  // 站到内置的位置上——裸名歧义仍按内置判胜（存量记录里的裸名以前解析到它，升级不该改这个答案）。
  const superseding = scanned.user.descriptors.filter((d) => d.name && scanned.pick.skipBuiltinNames.has(d.name))
  const supersedingPrefixes = superseding.map((d) => `${d.name}/`)
  const fromSuperseding = (id: string) => supersedingPrefixes.some((prefix) => id.startsWith(prefix))

  const builtinIds = new Set<string>()
  for (const pkg of [...builtin.descriptors, ...superseding]) for (const m of pkg.sources) builtinIds.add(m.id)

  // 「这份 **recipe** 来自内置层吗」——和上面那个 `builtinIds`（按 **manifest** 数的）是两件事：
  // 一个 recipe 包可以带 recipe 而不带 manifest 清单，那种 recipe 在 `builtinIds` 里查不到。
  // 这一份是 `secret_params` 闸 3 的判据（凭据只注入给内置包），所以它必须数 recipe 本身，
  // 而且必须在**分得清层**的这里算——合并之后就看不出来了。
  //
  // 一个用户包顶掉内置 recipe 就拿到凭据，是这一格最该防的事。两种顶掉：
  //  - 同 npm 名的新版（`scanLayers` 已把内置那层整包摘掉，用户层那份是这个 id 的唯一一份）；
  //  - 没有 npm 名的本地开发包与内置同全名（user 层后写入 `recipes`，盖掉内置那份）。
  // 两种都**默认不算内置**。例外：`OFFICIAL_SCOPE`（`@streamapp/`）的包算——官方内置 recipe 包的
  // npm 更新走的正是"用户层同名顶掉内置层"这条路（`stream update`），不算就等于一装官方更新凭据
  // 就断。scope 归属由 npm 自己把关（同信任根，见 OFFICIAL_SCOPE 头注），第三方 scope 照旧不算。
  // 再一个例外的例外：装包时被标成"核不上官方源"的官方 scope 包（见 TRUST_SIDECAR 头注）——名字
  // 是官方的，来源却是镜像自己说的，照第三方处置。
  const unverifiedPrefixes = layers[1].descriptors
    .filter((pkg) => pkg.name && !readPackageTrust(pkg.dir).official)
    .map((pkg) => `${pkg.name}/`)
  const trustedOfficial = (id: string) =>
    id.startsWith(OFFICIAL_SCOPE) && !unverifiedPrefixes.some((prefix) => id.startsWith(prefix))
  const builtinRecipeIds = new Set(builtin.recipes.keys())
  for (const [id, recipe] of recipes) {
    if (builtinRecipeIds.has(id) && builtin.recipes.get(id) !== recipe && !trustedOfficial(id)) {
      builtinRecipeIds.delete(id)
    }
    // 顶掉内置的官方新版：它的每一条 recipe 都算内置——包括新版**新加**的、内置那层从没有过的那些
    // （`stream update` 送来的新能力得能拿到凭据，否则更新等于装了个残的）。
    if (fromSuperseding(id) && trustedOfficial(id)) builtinRecipeIds.add(id)
  }

  return { manifests: [...byId.values()], recipes, byPackage, builtinIds, builtinRecipeIds, pick: scanned.pick, deferred: scanned.deferred }
}
