import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync, rmSync, renameSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { untarGz, type TarEntry } from './untar.ts'
import type { RegistryClient } from './recipe-registry.ts'
import { clampRateLimit, type FacilityRateLimit } from './facility-rate-limit.ts'
import { loadRecipePackages, RECIPE_PACKAGE_SCHEMA_VERSION, USER_LAYER_SCAN, BUILTIN_LAYER_SCAN, OFFICIAL_SCOPE, TRUST_SIDECAR, type PackageTrust } from './recipe-package.ts'
import { validateRecipe } from './recipe-store.ts'
import { recipeToManifest } from './recipe-manifest.ts'
import { manifestSchema } from '../manifest/loader.ts'
import { parseStreamDescriptor, type StreamDescriptor } from '../packages/descriptor.ts'
import { PACKAGE_CODE_ENTRY } from '../packages/code-entry.ts'
import { scanPackages } from '../packages/scan.ts'
import { RESERVED_ADAPTER_NAMES, type OccupiedNames } from '../packages/activate.ts'
import { assignedServiceName, clampThirdPartyBackend, summarizeBackend, type BackendSummary } from '../packages/container-policy.ts'
import type { PluginBackend } from '../plugins/types.ts'
import { assertHostVersion } from './host-version.ts'
import type { Recipe } from './recipe.ts'
import { isValidPackageName } from '../../shared/recipe-market/package-name.ts'
import { namespacedSourceId } from '../registry/source-id.ts'

/** 第三方包唯一被放行的代码文件——**一个字面路径**，不是一条 pattern，也不是一个目录。
 *  白名单那条「任何含 `/` 的路径一律拒」的铁律只对这一个字符串开例外，用 `===` 比，所以
 *  `./dist/index.js`、`dist//index.js`、`DIST/INDEX.JS`、`dist/./index.js` 全都进不来
 *  （它们本来就是同一个文件的别名写法——放行别名等于放行一族路径）。
 *  常量本体住 `src/packages/code-entry.ts`：描述符 schema 也要拿它判 `stream.capability`，
 *  而 descriptor 反过来 import 本文件会成环。 */
export { PACKAGE_CODE_ENTRY } from '../packages/code-entry.ts'

/** Recipe packages carry DATA plus AT MOST one pre-built code entry (PACKAGE_CODE_ENTRY).
 *  Anything outside this whitelist is refused before a single byte reaches disk: the trust
 *  boundary is "npm registry", so we do not trust the tarball to only contain what it claims.
 *
 *  Every pattern is anchored to a SINGLE path segment with a closed extension set — `.`
 *  in a regex matches ANY character including `/`, so an unanchored `README(\..+)?`
 *  would happily pass `README.x/evil.js` or `README.js`. verifyTarball ALSO rejects any
 *  path containing `/` outright (belt-and-suspenders: even if a future pattern here were
 *  sloppy, no entry with a slash gets through) — the ONE exception is the literal
 *  PACKAGE_CODE_ENTRY string, and a file at that path is still refused unless the
 *  descriptor declared `stream.code` pointing at it, or declared `stream.capability`
 *  (the two slots name the same file — see the code-slot block in assertInstallable). */
const ALLOWED = [
  /^package\.json$/,
  /^[^/.][^/]*\.recipe\.json$/,
  /^README(\.(md|txt|markdown|rst))?$/i,
  /^LICEN[CS]E(\.(md|txt))?$/i,
  /^NOTICE(\.(md|txt))?$/i,
  /^CHANGELOG(\.(md|txt))?$/i,
  /^manifests\.yaml$/,
]

/** `name` 从 HTTP 上来、会变成文件系统路径、install 会递归删除那个目录——所以它在到达
 *  任何路径拼接或 registry 请求之前就必须过这道文法。判据本体在
 *  shared/recipe-market/package-name.ts（前端同一份，别在任何一侧复刻）。 */
export function assertValidPackageName(name: string): void {
  if (!isValidPackageName(name)) {
    throw new Error(`invalid package name "${name}" — does not match npm's name grammar, refusing`)
  }
}

// Decompression bombs / registry abuse guards. Checked here (not in untar.ts, which is a
// pure parser) because the limits are a policy call about recipe packages specifically —
// they are small, curated data bundles, never bulk archives.
const MAX_TARBALL_BYTES = 2 * 1024 * 1024
const MAX_UNPACKED_BYTES = 20 * 1024 * 1024
const MAX_ENTRIES = 200

/** 构建期注入的宿主版本（`scripts/build-server.mjs` 的 esbuild `--define`）。打包产物是单文件
 *  `server.mjs`，源码那条 `../../package.json` 在那个位置什么也指不到（发行包里不出货源码树）
 *  ——所以打包这条路的真相源只能是构建期注入。源码运行（tsx / vitest）时这个标识符不存在，`typeof` 对未声明标识符
 *  是安全的，走下面读文件那条。 */
declare const __STREAM_HOST_VERSION__: string | undefined

/** 宿主版本的真相源：构建期注入优先，源码运行时回落到仓库根 `package.json` 的 `version`
 *  （`src/replay/` → `../..`）。读文件而不是写死一个字面量：两个地方各存一份版本号，改版本时
 *  必然只改到一份。
 *
 *  **读不到一律返回 undefined，绝不抛。** 求值点在 `bootstrap()` 里是无条件的
 *  （`hostVersion: readHostVersion()`，没有 try/catch），抛一下就是整个后端起不来。版本未知时
 *  闸门在 `assertHostVersion` 里 fail-closed（拒装声明了 hostVersion 的包），不是静默放行。 */
export function readHostVersion(source = new URL('../../package.json', import.meta.url)): string | undefined {
  if (typeof __STREAM_HOST_VERSION__ === 'string') return __STREAM_HOST_VERSION__
  try {
    const version = (JSON.parse(readFileSync(source, 'utf-8')) as { version?: unknown }).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * 一份描述能不能被装进来——**tarball 与 zip 两条路共用这一把尺**。两条路各判一次就会出现
 * 「tarball 装不进、zip 能装进」这种静默不一致：同一个包换个入口就绕过了闸门。
 *
 * 五道闸门：旧形 schemaVersion 上界、hostVersion 下界、容器格（钳制，见下）、代码格
 * （申报与实物必须对上）、撞名（id / adapter / normalizer / enricher / connect 域名 / 容器 service 名）。
 *
 * **返回钳制后的 `backend`**（没声明容器就是 undefined）。调用方**必须**用这个返回值——落盘的
 * `package.json` 和确认页看到的都得是它，否则就回到了「校验的和落盘的不是同一份字节」。
 *
 * `ctx.occupied` 是**必填**的，没有默认值：默认值只可能是一张空表，而空表 = 什么都不占 =
 * 全放行——正是这道闸门要防的那件事。要它必填，新接一条安装路的人就必须显式回答
 * 「已经有谁占着」，而不是不写就悄悄退化成放行。它含**内置**和**已装的第三方**两层
 * （见 `withInstalled`）：只查内置就只挡了一半，两个第三方包申报同一个名字照样能各自装成功，
 * 然后一起把启动打挂。
 */
export function assertInstallable(
  name: string,
  desc: StreamDescriptor,
  ctx: { hostVersion: string | undefined; hasCodeEntry: boolean; occupied: OccupiedNames },
): PluginBackend | undefined {
  if (desc.legacySchemaVersion != null && desc.legacySchemaVersion > RECIPE_PACKAGE_SCHEMA_VERSION) {
    throw new Error(
      `package ${name} declares schemaVersion ${desc.legacySchemaVersion}, this app supports ≤ ${RECIPE_PACKAGE_SCHEMA_VERSION} — upgrade the app to use it`,
    )
  }
  assertHostVersion(desc.hostVersion, ctx.hostVersion, name)
  // 容器格：第三方能填，但只能填**钳制后**的那个形状。不合规 clampThirdPartyBackend 就抛，
  // 消息原样往上走（preview 的报错里用户看到的就是它）。
  let backend: PluginBackend | undefined
  if (desc.backend) {
    // service 名撞车要在钳制**之前**判：撞了就是装进来两边抢同一条 /_p/ 路由 + 同一个 standby
    // 名册位。重名在名册构造期抛，而 serve.ts 把那一抛降级成一行日志 ⇒ 后果不是开不了机，是
    // **全体** standby 失效（所有插件容器不再回收/唤醒，界面上一个字都不会提，只表现为内存
    // 慢慢变多）——正因为运行时那一道是静默的，这道安装期闸门才是真正承重的那个。
    // 内置那一侧的 service 名不一定等于它的 id，所以这道
    // 闸门查的是 occupied.services，不是 occupied.ids。
    const service = assignedServiceName(desc.id)
    if (ctx.occupied.services.has(service)) {
      throw new Error(
        `package ${name}: 容器 service 名 "${service}"（由包 id 指派）已被占用——` +
        `网关路由 /_p/${service}/ 和 standby 名册都是全局唯一的，装进来两边都会坏。请改一个别的 stream.id。`,
      )
    }
    backend = clampThirdPartyBackend(desc.id, desc.backend)
  }
  // 撞名：id / adapter / normalizer / enricher / connect 名一旦与已占的（内置 + 已装第三方）撞上，装进来就是一颗
  // 定时炸弹。撞 adapter/normalizer 名 → activatePackages 的撞名检查按设计「两边都不激活」→
  // **开不了机**，而恢复得让用户去翻文件系统删包。所以拒在装进盘之前，且说清撞了谁。
  //
  // id 那一格**只覆盖内置的插件包**（`occupied.ids` 只收 fillsPluginSlot 的那些）：那种包有东西
  // 挂在按 id 索引的宿主设施上（容器 service 默认名 / 凭证 token / presenter / source 清单），
  // id 必须独占。**纯 recipe 包的 id 撞名不拒**——那正是这条线一直支持的覆盖（用户层按 facility /
  // sourceId 盖内置层，被盖掉的 sourceId 会列进 preview 的 `overrides` 告知用户）。别把它退回成
  // 「所有内置包的 id 都占着」：官方随应用发布的每个 recipe 包会当场变成装不了也升不了。
  // 至于「撞 id 会把内置那个包拖去动态 import」——那是**旧**装载模型的事，现在装载按包对象身份
  // 路由（见 activate.ts 的 PackageEntries 头注），这条理由已经不成立。
  if (ctx.occupied.ids.has(desc.id)) {
    throw new Error(
      `package ${name}: stream.id "${desc.id}" 与内置插件包同名——内置那个已经占着这个 id，装进来两边都会坏。请改一个别的 id。`,
    )
  }
  for (const n of desc.code?.adapters ?? []) {
    if (ctx.occupied.adapters.has(n)) {
      throw new Error(
        `package ${name}: 申报的 adapter "${n}" 已被占用（内置包、已装的第三方包，或宿主自己的 ${[...RESERVED_ADAPTER_NAMES].join('/')}）——请改一个别的名字。`,
      )
    }
  }
  for (const n of desc.code?.normalizers ?? []) {
    if (ctx.occupied.normalizers.has(n)) {
      throw new Error(
        `package ${name}: 申报的 normalizer "${n}" 已被占用（内置包或已装的第三方包）——请改一个别的名字。`,
      )
    }
  }
  // enricher 名 / connect 域名与上面两格同罪：activatePackages 第一段撞上就「两边都不激活」→ 抛。
  // 装进来的表现是**下次启动**才炸，用户看不出是哪个包，恢复得去翻文件系统——所以拒在这里。
  for (const n of desc.code?.enrichers ?? []) {
    if (ctx.occupied.enrichers.has(n)) {
      throw new Error(
        `package ${name}: 申报的 enricher "${n}" 已被占用（内置包、已装的第三方包，或宿主自己的 /api/enrich 源）——请改一个别的名字。`,
      )
    }
  }
  // 域名按小写比：activatePackages 判归属就是按小写的，大小写不同的两条在它眼里是同一条。
  for (const d of desc.code?.connect ?? []) {
    if (ctx.occupied.connect.has(d.toLowerCase())) {
      throw new Error(
        `package ${name}: 申报的 connect 域名 "${d}" 已被占用（内置包或已装的第三方包）——同一个站点只能有一个包提供一键订阅。`,
      )
    }
  }
  // 代码格：申报与实物必须严格对上。三种不对上都是拒——尤其「有文件没申报」，那是夹带。
  //
  // **两格都申报同一个文件**：`stream.code`（activate 模块，注册 adapter/normalizer）与
  // `stream.capability`（一个 `Capability`，注册工具）指的是同一个字面路径。所以放行条件是
  // 「任一格声明了」，缺文件的判定也对两格各说各的话——只认 code 的话，一个能力包带着它
  // 全部的内容会被当成夹带拒掉。
  if (desc.code) {
    if (desc.code.entry !== PACKAGE_CODE_ENTRY) {
      throw new Error(
        `package ${name}: stream.code.entry 是 "${desc.code.entry}"——第三方包只能带一个代码入口且必须正好是 "${PACKAGE_CODE_ENTRY}"`,
      )
    }
    if (!ctx.hasCodeEntry) {
      throw new Error(`package ${name}: 声明了 stream.code 但包里没有 "${PACKAGE_CODE_ENTRY}"`)
    }
  }
  // `capability` 的取值由 schema 钉成字面量（descriptor.ts），这里只查实物在不在。
  if (desc.capability && !ctx.hasCodeEntry) {
    throw new Error(`package ${name}: 声明了 stream.capability 但包里没有 "${PACKAGE_CODE_ENTRY}"`)
  }
  if (!desc.code && !desc.capability && ctx.hasCodeEntry) {
    throw new Error(
      `package ${name}: 包里有 "${PACKAGE_CODE_ENTRY}" 却没有声明 stream.code 或 stream.capability——夹带代码，拒绝安装`,
    )
  }
  return backend
}

/** 白名单本体（tarball 与 zip 共用）：一个路径受不受理。
 *  `\` 与 `/` 同等对待、一律拒（`dist/index.js` 那一个字面例外除外）：Windows 上 `\` 就是路径
 *  分隔符，而 untarGz 的越界检查只按 `/` 切段——桌面端后端正是 Windows sidecar，`a\..\..\evil
 *  .recipe.json` 这种 entry 内容是一份合法 recipe JSON、路径却爬得出包目录。 */
export function isAllowedPackageFile(path: string): boolean {
  if (path === PACKAGE_CODE_ENTRY) return true
  if (path.includes('/') || path.includes('\\')) return false
  return ALLOWED.some((re) => re.test(path))
}

/** Shape of a tarball that has passed every gate (whitelist + schema + parse). Not
 *  produced as a distinct value internally (resolveAndVerify's return carries the same
 *  facts plus install-time extras like the confirm token), but kept as a named export so
 *  downstream code (the HTTP layer) has a stable name to describe "a verified package" by. */
export interface VerifiedRecipePackage {
  desc: { name: string; version: string; stream: StreamDescriptor }
  recipes: Recipe[]
  files: TarEntry[]
}

export interface RecipePackagePreview {
  name: string
  version: string
  facility: string
  cookieDomain?: string
  rateLimit?: FacilityRateLimit
  /** 这个包会让 Stream **后端**替它去连的主机（`stream.serving` 的 match ∪ hosts）。空 = 不代理任何东西。
   *  确认页必须亮它：代理是后端出站，与 302 给浏览器不是同一档权限（spec 2026-09-18 §4）。 */
  proxies: string[]
  /** 这个包声明的 Provider 行 id（`stream.providers[].id`）。非空 ⇒ 确认页要说「重启后端后才出现」：
   *  身份表是启动期快照，热装不会建行。 */
  providers: string[]
  recipes: Array<{ id: string; description: string; capabilities: string[]; effects: string[]; params: string[] }>
  /** 「你正在把内置的这个包换成 npm 上的这一版，被换掉的全名有这些」。非空 ⇒ 包名与某个内置包
   *  相同 ⇒ 这是一次**升级**，不是李代桃僵（不同包之间已经盖不到彼此了）。 */
  overrides: string[]
  /** 这个包带代码时才有：入口 + 它申报会注册的 adapter / normalizer 名。安装确认页据此
   *  把「含代码」做成最响的一档——纯数据包与代码包在权限上不是同一件东西。 */
  code?: { entry: string; adapters: string[]; normalizers: string[] }
  /**
   * 这个包填了**能力槽位**（`stream.capability`）时才有：入口路径，以及——**如果拿得到**——
   * 它会注册的工具名。
   *
   * 为什么必须单独有这一格，而不是靠 `code` 兼着：确认页把「含代码」做成最响的一档，判据就是
   * `preview.code` 在不在。能力包不声明 `stream.code`（它导出的是一个 `Capability`，不是
   * adapter/normalizer），于是同一份字节——**在后端进程内以完整权限运行、能取用户浏览器里的
   * 登录态**——会被当成纯数据包一路静默装上。两格指的是同一个文件、同一种权限，确认页上就得
   * 是同一档。
   *
   * `tools` 通常**缺席**：工具名只有把模块 import 进来、mount 过才知道，而安装确认发生在那
   * 之前。缺席不等于"没有工具"，所以确认页那一句话说的是权限本身（进程内 / 完整权限 /
   * 可取登录态），不是数一数它有几个动词——用一个数不出来的数字当风险量纲会让人误以为 0 个
   * 工具就是安全的。
   */
  capability?: { entry: string; tools?: string[] }
  /** 这个包带容器时才有：**钳制后**的那份声明的摘要（service 名已指派、卷已加包前缀、standby
   *  已兜底）。展示的必须是钳制后的值——落盘、provisioner 读到的都是它，确认页给的是别的一份
   *  就等于用户批准的和实际跑的不是同一个东西。env 只给键名，值不外泄。 */
  backend?: BackendSummary
  /** 这个包申报的凭证域——它能取到的**登录态**边界（`ctx.cookieFor` 只放行这里申报过的域；
   *  带容器时宿主还会给它一个 broker token，同一份名单）。不在 `backend` 摘要里，是因为它是
   *  **包级**申报：代码格的包没有容器也吃它。没申报就整格缺席，不给一个空数组——空数组和
   *  「没有这一格」在确认页上是两句不同的话。 */
  credentials?: string[]
  /** 官方 scope 的包从镜像装、却核不上官方源（见 `mirrorVerdict`）——值是原因。照装，但装上去
   *  是第三方待遇（不注入凭据）。官方源装的 / 核得上的没有这一格。 */
  mirrorUnverified?: string
  confirm: string
}

export interface RecipeInstallDeps {
  registry: RegistryClient
  /** **只在 `registry` 是镜像时才有**（接线用 `officialRegistryIfMirror`）：指着 npm 官方源，
   *  给 `@streamapp/` 包多核一次校验和。没有 = 主 registry 就是官方源，不核。 */
  officialRegistry?: RegistryClient
  userDir: string
  /** 「内置层有没有一个同 npm 名的包，它出了哪些全名」。**判据是包名，不是 sourceId**：
   *  用户从 npm 装 `@scope/pkg` → 与内置层那个包**包名相同** → 全名逐条相同 → 用户层整包
   *  盖住内置层，这正是官方随应用发布的每个 recipe 包都装得了也升得了的那条路。没有同名内置包
   *  就返回空 —— 命名空间化之后，不同包之间不可能互相盖。 */
  builtinPackageSourceIds: (pkgName: string) => string[]
  facilityRateLimit: (facility: string) => FacilityRateLimit | undefined
  /** 宿主自己的版本，用来判包声明的 hostVersion。注入而不是就地读文件：安装口在测试里
   *  必须能把宿主版本摆到任意一侧，生产接线见 bootstrap（`readHostVersion()`）。
   *  undefined = 读不到（见 readHostVersion），闸门据此 fail-closed。 */
  hostVersion: string | undefined
  /** 已经被占掉的名字（id / adapter / normalizer / enricher / connect 域名 / service），撞上就拒装。**两层都要有**：内置那一层
   *  （`occupiedByBuiltins(packages)`）+ 已装的第三方那一层（`withInstalled(...)`）——只查内置
   *  就只挡了一半，两个第三方包申报同一个 adapter 名照样各自装成功，然后一起把启动打挂。
   *
   *  参数是**正在装的那个包自己的 npm 包名**，接线方据此把它自己从表里剔除，否则升级 / 重装会被
   *  自己上一版占的名字挡住。
   *
   *  表是**注入**的，不在安装侧现扫：现扫失败（EACCES、目录被换掉…）在这道闸门上只有两种收场，
   *  要么静默放行（正是要防的），要么把所有安装都拒了。真要是这个 getter 抛了，这里**不 catch**
   *  ——安装当场失败，不猜。接线见 bootstrap。 */
  occupiedNames: (selfPkgName: string) => OccupiedNames
}

/** Keeps the leading `@` — do NOT strip it. npm's own name grammar (`isValidPackageName`
 *  in shared/recipe-market/package-name.ts) only permits `@` as the very first character
 *  of a SCOPED name; an unscoped name can
 *  never start with `@`. Stripping it here would let an unscoped `scope__pkg` collide
 *  with the scoped `@scope/pkg` (both mangle to the same directory name), letting an
 *  attacker register the unscoped twin and have install silently overwrite the scoped
 *  package's directory (rmSync + rename, no sourceId overlap to catch it). Keeping `@`
 *  makes the two mangled names permanently distinguishable. */
export function dirNameFor(name: string): string {
  return name.replace(/\//g, '__')
}

/** `userDir`-relative dir a package's files live under, with a hard containment check —
 *  even though `name` is already validated against `isValidPackageName` by the time this runs,
 *  this is the last line of defense before any write/delete touches disk. */
function resolvedDirFor(userDir: string, name: string): string {
  const dir = join(userDir, dirNameFor(name))
  const root = resolve(userDir) + sep
  if (!resolve(dir).startsWith(root)) {
    throw new Error(`package name "${name}" resolves outside the install root — refusing`)
  }
  return dir
}

/** Minimal semver-ish comparator — just enough to tell "is `b` newer than `a`", not a full
 *  semver implementation (no dependency added for this, project has none). Splits off any
 *  `-prerelease` suffix, compares the `major.minor.patch` numeric fields left-to-right, and
 *  only when those are equal does the suffix break the tie: a build with a suffix is
 *  considered LOWER than the same numeric version without one (matches semver's own
 *  "pre-release < release" ordering), and two suffixed builds at the same numeric version
 *  compare as equal (we don't attempt full pre-release identifier comparison). */
function isNewerVersion(candidate: string, installed: string): boolean {
  const parse = (v: string) => {
    const [core, ...rest] = v.split('-')
    const prerelease = rest.length > 0
    const parts = core.split('.').map((n) => Number.parseInt(n, 10) || 0)
    return { parts, prerelease }
  }
  const c = parse(candidate)
  const i = parse(installed)
  for (let idx = 0; idx < 3; idx++) {
    const cn = c.parts[idx] ?? 0
    const ii = i.parts[idx] ?? 0
    if (cn !== ii) return cn > ii
  }
  if (c.prerelease !== i.prerelease) return !c.prerelease // release > prerelease at same numeric version
  return false // equal (or two prereleases at the same numeric version) — not "newer"
}

// Two installs racing (B starts while A is still mid-write) must not have B's startup
// cleanup delete A's in-flight scratch dir out from under it. Unconditionally nuking the
// whole `.tmp` root on every install start (the old behavior) does exactly that. Age is the
// only signal available here to tell "orphan from a crashed prior install" apart from "a
// sibling install that is still running": a fresh entry could be either, but a crash orphan
// stays fresh for at most as long as that OTHER install takes to finish, whereas a genuine
// crash orphan sits untouched forever. An hour is comfortably longer than any single
// install (network fetch + untar + write of a package capped at MAX_TARBALL_BYTES /
// MAX_UNPACKED_BYTES), so it never mistakes a live sibling for a crash orphan, while still
// reliably reclaiming real ones on the next install that comes along.
const STALE_SCRATCH_AGE_MS = 60 * 60 * 1000

function sweepStaleScratch(scratchRoot: string): void {
  if (!existsSync(scratchRoot)) return
  const now = Date.now()
  for (const entry of readdirSync(scratchRoot, { withFileTypes: true })) {
    const path = join(scratchRoot, entry.name)
    try {
      const stat = statSync(path)
      if (now - stat.mtimeMs > STALE_SCRATCH_AGE_MS) rmSync(path, { recursive: true, force: true })
    } catch {
      // vanished already (e.g. another install's own cleanup/rename raced us here) — fine
    }
  }
}

function verifyTarball(
  name: string,
  entries: TarEntry[],
  hostVersion: string | undefined,
  occupied: OccupiedNames,
): { stream: StreamDescriptor; facility: string; pkgJson: Record<string, unknown>; recipes: Recipe[]; backend: PluginBackend | undefined } {
  const bad = entries.filter((e) => !isAllowedPackageFile(e.path))
  if (bad.length) {
    throw new Error(
      `package ${name}: files outside the whitelist: ${bad.map((e) => e.path).join(', ')} — a package carries data plus at most one declared code entry (${PACKAGE_CODE_ENTRY})`,
    )
  }
  // 重复 path 直接拒。**tar 是一串条目，没有"键唯一"这回事**：校验这边取的是第一个同名条目
  // （`find`），写盘那边顺序遍历、后写覆盖先写——同一个 tarball 里放两份 `package.json`，
  // 用户在确认页看到的是第一份、盘上和下次启动装载的是第二份。借此能换掉 stream.id / npm name /
  // code 申报名单（申报一个保留名 → 启动 activatePackages 直接抛 → 后端起不来，只能手删文件）。
  //
  // 为什么是"拒"而不是"先收进 Map 再校验+写"（zip 那条路的做法）：Map 里"后者胜"是一条**约定**，
  // 靠的是校验和写盘都去读那个 Map；下一个人只要在写盘处用回 `entries` 数组，漏洞就原样回来了。
  // 拒掉之后 `entries` 里 path 唯一是一条**不变量**，不管下游遍历哪个集合都不可能分家。
  // 真实的 `npm pack` 产物也从不含重复 path，所以这道闸门不误伤任何正常包。
  const seenPaths = new Set<string>()
  const dupes = new Set<string>()
  for (const e of entries) {
    if (seenPaths.has(e.path)) dupes.add(e.path)
    seenPaths.add(e.path)
  }
  if (dupes.size) {
    throw new Error(
      `package ${name}: duplicate entries in tarball: ${[...dupes].join(', ')} — 同一个路径出现多次时，` +
      `校验读到的和落盘的会是两份不同的字节，拒绝安装`,
    )
  }
  const pkgEntry = entries.find((e) => e.path === 'package.json')
  if (!pkgEntry) throw new Error(`package ${name}: no package.json in tarball`)
  const pkgJson = JSON.parse(pkgEntry.data.toString()) as Record<string, unknown>
  if (pkgJson.name !== name) {
    throw new Error(`package ${name}: tarball's package.json declares name "${String(pkgJson.name)}" — refusing (name mismatch)`)
  }
  // 统一描述：旧形（type:'recipe' + schemaVersion）与新形（id）同一把尺。目录扫描早就受理
  // 新形了，安装口卡在旧形就会出现「手放进目录能加载、走安装口被拒」。
  const stream = parseStreamDescriptor(pkgJson, `${name}'s package.json`)
  const backend = assertInstallable(name, stream, {
    hostVersion,
    hasCodeEntry: entries.some((e) => e.path === PACKAGE_CODE_ENTRY),
    occupied,
  })
  const facility = stream.facility ?? stream.id
  const recipes = entries
    .filter((e) => e.path.endsWith('.recipe.json'))
    .map((e) => validateRecipe(e.path, JSON.parse(e.data.toString())))

  // Two recipe files in the SAME package declaring the same sourceId install clean (the
  // cross-package conflict check below only looks at OTHER packages) but then blow up
  // loadRecipePackages at bootstrap — its `owner` map is per-load, not per-package, so a
  // self-collision throws `appears in both package X and X` and takes every other recipe
  // package down with it. Catch it here, before it ever reaches disk.
  const seenSourceIds = new Set<string>()
  for (const r of recipes) {
    if (seenSourceIds.has(r.sourceId)) {
      throw new Error(`package ${name}: sourceId "${r.sourceId}" appears in more than one recipe file — sourceIds must be unique within a package`)
    }
    seenSourceIds.add(r.sourceId)
  }

  // Install-time gate must be AT LEAST as strict as load-time — a package that installs
  // clean but then fails mountRecipePackages() at bootstrap takes every OTHER recipe
  // down with it (loadRecipePackages refuses the whole load on one bad package). Run the
  // exact same synthesis/validation here so a bad package never reaches disk.
  // 前缀用**它自己的 npm 包名**——装载期合成的是同一个（`packageNamespace` 读 package.json#name），
  // 两边用不同的前缀就等于这道预检验的不是将来真会装载的那份。
  for (const r of recipes) recipeToManifest(r, facility, name)
  const manifestsEntry = entries.find((e) => e.path === 'manifests.yaml')
  if (manifestsEntry) {
    const raw = parseYaml(manifestsEntry.data.toString())
    if (raw != null) {
      if (!Array.isArray(raw)) throw new Error(`package ${name}: manifests.yaml must be a list of sources`)
      raw.forEach((item, i) => {
        const parsed = manifestSchema.safeParse(item)
        if (!parsed.success) {
          const issue = parsed.error.issues[0]
          const path = issue?.path.join('.') || '(root)'
          throw new Error(`package ${name}: manifests.yaml[${i}]: ${path} — ${issue?.message}`)
        }
      })
    }
  }

  return { stream, facility, pkgJson, recipes, backend }
}

/** 镜像信任核对（TRUST_SIDECAR 头注讲了为什么）：向官方源要 `name@v` 的 `dist.integrity`，与
 *  实际 tarball 的哈希比。返回 undefined = 官方；返回字符串 = 核不上的原因。**连不上也算核不上**
 *  （fail-closed）：这里判的是"能不能拿凭据"，拿不到证据就不给，包本身照装。 */
async function mirrorVerdict(deps: RecipeInstallDeps, name: string, v: string, actual: string): Promise<string | undefined> {
  if (!deps.officialRegistry || !name.startsWith(OFFICIAL_SCOPE)) return undefined
  let official: string | undefined
  try {
    const packument = await deps.officialRegistry.packument(name)
    const info = Object.hasOwn(packument.versions, v) ? packument.versions[v] : undefined
    if (!info) return `官方源上没有 ${name}@${v}`
    official = info.dist.integrity
  } catch (e) {
    return `官方源连不上（${(e as Error).message}）`
  }
  if (!official) return `官方源没给 ${name}@${v} 的 integrity`
  return official === actual ? undefined : `镜像上的 ${name}@${v} 与官方源校验和不一致`
}

async function resolveAndVerify(deps: RecipeInstallDeps, name: string, version?: string) {
  assertValidPackageName(name)
  const packument = await deps.registry.packument(name)
  if (version === undefined && !packument['dist-tags']) {
    throw new Error(`package ${name}: registry returned no dist-tags`)
  }
  const v = version ?? packument['dist-tags'].latest
  // Object.hasOwn, not `packument.versions[v]` directly: `v` traces back to the registry
  // response (or caller-supplied version), and a bare index access resolves inherited
  // properties like `__proto__`/`constructor` off Object.prototype — an attacker-controlled
  // key should never be able to smuggle a truthy-looking "version info" out of the prototype.
  const info = Object.hasOwn(packument.versions, v) ? packument.versions[v] : undefined
  if (!info) throw new Error(`package ${name}: version ${v} not in registry`)
  const tgz = await deps.registry.tarball(info.dist.tarball)
  if (tgz.length > MAX_TARBALL_BYTES) {
    throw new Error(`package ${name}: tarball too large (${tgz.length} bytes > ${MAX_TARBALL_BYTES} limit)`)
  }
  const actual = `sha512-${createHash('sha512').update(tgz).digest('base64')}`
  if (info.dist.integrity && info.dist.integrity !== actual) {
    throw new Error(`package ${name}: tarball integrity mismatch`)
  }
  const integrity = info.dist.integrity ?? actual
  const mirrorUnverified = await mirrorVerdict(deps, name, v, actual)
  const entries = untarGz(tgz)
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`package ${name}: too many files in tarball (${entries.length} > ${MAX_ENTRIES} limit)`)
  }
  const unpackedBytes = entries.reduce((sum, e) => sum + e.data.length, 0)
  if (unpackedBytes > MAX_UNPACKED_BYTES) {
    throw new Error(`package ${name}: unpacked size too large (${unpackedBytes} bytes > ${MAX_UNPACKED_BYTES} limit)`)
  }
  const { stream, facility, pkgJson, recipes, backend } = verifyTarball(name, entries, deps.hostVersion, deps.occupiedNames(name))
  // 覆盖告知：这个包与内置层某个包**同名**时，两边全名逐条相同的那些会被换掉。
  // **「已被另一个已装包占着 → 拒装」那道闸门撤了**：sourceId 命名空间化之后，两个不同的包
  // 不可能产出同一个全名（全名相同 ⇒ npm 名相同 ⇒ 是同一个包），它挡的那个冲突已不存在。
  // 同包内 sourceId 重复那一半留着，在上面 `seenSourceIds` 那一段。
  const incoming = new Set(recipes.map((r) => namespacedSourceId(name, r.sourceId)))
  const overrides = deps.builtinPackageSourceIds(name).filter((id) => incoming.has(id))
  const rateLimit = clampRateLimit(stream.rateLimit, deps.facilityRateLimit(facility))
  return { v, integrity, entries, stream, facility, pkgJson, recipes, overrides, rateLimit, backend, mirrorUnverified }
}

export async function previewRecipePackage(
  deps: RecipeInstallDeps,
  name: string,
  version?: string,
): Promise<RecipePackagePreview> {
  const r = await resolveAndVerify(deps, name, version)
  return {
    name,
    version: r.v,
    facility: r.facility,
    cookieDomain: r.stream.cookieDomain,
    rateLimit: r.rateLimit,
    proxies: [...new Set((r.stream.serving ?? []).flatMap((s) => [s.match, ...(s.hosts ?? [])]))],
    providers: (r.stream.providers ?? []).map((p) => p.id),
    recipes: r.recipes.map((rec) => {
      const meta = (rec as { meta?: Record<string, unknown> }).meta ?? {}
      return {
        // 展示**全名**：用户批准的名字必须和装上之后它真正叫什么一致。
        id: namespacedSourceId(name, rec.sourceId),
        description: String(meta.description ?? ''),
        capabilities: (meta.capabilities as string[]) ?? ['timeline'],
        effects: (meta.effects as string[]) ?? [],
        params: Object.keys((meta.params_schema as Record<string, unknown>) ?? {}),
      }
    }),
    overrides: r.overrides,
    ...(r.stream.code && {
      code: {
        entry: r.stream.code.entry,
        adapters: r.stream.code.adapters ?? [],
        normalizers: r.stream.code.normalizers ?? [],
      },
    }),
    // 能力槽位。`stream.capability` 的取值由 schema 钉成 PACKAGE_CODE_ENTRY 那个字面量，
    // 这里原样交出去——确认页显示的必须是它真正会 import 的那条路径。
    ...(r.stream.capability && { capability: { entry: r.stream.capability } }),
    // 摘要取自**钳制后**的声明（`r.backend`），不是 `r.stream.backend`——后者是包自己写的原始
    // 形状，展示它就等于让用户批准一份与落盘不同的东西。
    ...(r.backend && { backend: summarizeBackend(r.backend) }),
    ...(r.stream.credentials?.length && { credentials: r.stream.credentials }),
    ...(r.mirrorUnverified && { mirrorUnverified: r.mirrorUnverified }),
    confirm: r.integrity,
  }
}

export async function installRecipePackage(
  deps: RecipeInstallDeps,
  name: string,
  version: string | undefined,
  confirm: string,
): Promise<{ dir: string; version: string }> {
  const r = await resolveAndVerify(deps, name, version)
  if (confirm !== r.integrity) {
    throw new Error(`confirm token mismatch for ${name}@${r.v} — run preview again (package may have changed)`)
  }
  const dir = resolvedDirFor(deps.userDir, name)
  // Scratch lives under userDir/.tmp/<random>, NOT as a `<dir>.tmp-<random>` SIBLING of the
  // real package dirs. Two reasons a sibling scratch dir is actively dangerous:
  //  1. It has a full package.json + *.recipe.json sitting one level under userDir, same as
  //     a real package — bootstrap's recursive watch (debounced ~300ms) can fire mid-write
  //     and hand it to loadRecipePackages as a SECOND package with the same sourceId, which
  //     throws and takes builtin + every other user package down with it.
  //  2. Its name carries a random suffix, so the OLD `rmSync(tmp)` "clean up before we
  //     start" line was dead code — a crash never left behind a dir with THAT SAME random
  //     name, so nothing was ever actually swept. An orphan from a crashed install just sat
  //     there forever, permanently duplicate-sourceId-poisoning every future load.
  // `.tmp/` itself has no package.json (loadRecipePackages only reads ONE level deep, and
  // stops at "no package.json" — see recipe-package.ts), so it is invisible to the loader
  // by construction, not by convention.
  const scratchRoot = join(deps.userDir, '.tmp')
  sweepStaleScratch(scratchRoot) // sweep only STALE orphans — a concurrent install's own
  // still-being-written scratch dir under the same root must survive (see sweepStaleScratch
  // doc comment for why age, not "sweep everything", is the right test).
  const tmp = join(scratchRoot, randomBytes(8).toString('hex'))
  mkdirSync(tmp, { recursive: true })
  try {
    for (const e of r.entries) {
      const target = join(tmp, e.path)
      mkdirSync(dirname(target), { recursive: true })
      if (e.path === 'package.json') {
        // 落盘的是钳后限流 + 钳后容器声明——即使 merge 语义有闪失，盘上包也超不过 builtin 声明。
        // 铺的是**原始** stream 对象（只覆盖 rateLimit / backend），不是解析产物：解析产物是宿主
        // 内部形状（丢 type/schemaVersion、补 id），写回去等于把用户的包改写成另一形，而下一次
        // 装载读的就是这份。
        //
        // `backend` 必须写钳制后的那份：装载器和 provisioner 读的就是盘上这个文件，写原始声明
        // 就等于「用户在确认页看到的」和「实际跑起来的容器」是两份不同的字节——service 名没指派、
        // 卷没加前缀（两个包的 `data:` 变成同一个 docker 卷）、standby 缺省成常驻。
        const rawStream = (r.pkgJson.stream ?? {}) as Record<string, unknown>
        const pkg = {
          ...r.pkgJson,
          stream: {
            ...rawStream,
            ...(r.rateLimit && { rateLimit: r.rateLimit }),
            ...(r.backend && { backend: r.backend }),
          },
        }
        writeFileSync(target, JSON.stringify(pkg, null, 2) + '\n')
      } else {
        writeFileSync(target, e.data)
      }
    }
    // 信任旁注只在核不上时才写（TRUST_SIDECAR 头注）。写在 scratch 里、随整棵树一起换过去——
    // 它必须和包文件同一次原子落地，否则"包换了新版、旁注还是旧版的"两种错向都可能出现。
    if (r.mirrorUnverified) {
      const trust: PackageTrust = { official: false, reason: r.mirrorUnverified }
      writeFileSync(join(tmp, TRUST_SIDECAR), JSON.stringify(trust, null, 2) + '\n')
    }
    // Atomic swap: build the full new tree under a scratch name first, THEN remove the old
    // dir and rename the scratch into place. A crash mid-write leaves the scratch dir
    // orphaned (harmless, cleaned up on next install attempt) instead of a half-written
    // package sitting at the real path.
    rmSync(dir, { recursive: true, force: true })
    renameSync(tmp, dir)
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    throw err
  }
  return { dir, version: r.v }
}

/** package.json's `name` field of an installed dir, or undefined for a hand-placed
 *  local package (no name = not npm-managed, skip it). */
function installedName(userDir: string, dirName: string): { name?: string; version?: string } {
  const pkgPath = join(userDir, dirName, 'package.json')
  if (!existsSync(pkgPath)) return {}
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>
    return { name: typeof pkg.name === 'string' ? pkg.name : undefined, version: typeof pkg.version === 'string' ? pkg.version : undefined }
  } catch {
    return {}
  }
}

/** `entry.isDirectory()` is false for a symlink dirent REGARDLESS of what it points to (it
 *  reports the dirent's own type, symlink, not the target's) — so a package hand-symlinked
 *  into userDir (a common way to develop a recipe package locally against a real checkout)
 *  is invisible to a naive dir-only filter. Follow the symlink with `statSync` to check
 *  what it actually points to; a dangling symlink makes `statSync` throw, which we treat as
 *  "not a directory" (skip it) rather than letting the exception escape. */
function isDirEntry(userDir: string, entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return statSync(join(userDir, entry.name)).isDirectory()
  } catch {
    return false // dangling symlink
  }
}

function findInstalledDir(userDir: string, name: string): string | undefined {
  if (!existsSync(userDir)) return undefined
  const matches: string[] = []
  for (const entry of readdirSync(userDir, { withFileTypes: true })) {
    if (!isDirEntry(userDir, entry)) continue
    if (installedName(userDir, entry.name).name === name) matches.push(join(userDir, entry.name))
  }
  if (matches.length > 1) {
    throw new Error(`multiple installed directories claim package name "${name}": ${matches.join(', ')} — remove the duplicate manually`)
  }
  return matches[0]
}

function listInstalled(userDir: string): Array<{ name: string; version: string }> {
  if (!existsSync(userDir)) return []
  const out: Array<{ name: string; version: string }> = []
  for (const entry of readdirSync(userDir, { withFileTypes: true })) {
    if (!isDirEntry(userDir, entry)) continue
    const { name, version } = installedName(userDir, entry.name)
    if (name && version) out.push({ name, version })
  }
  return out
}

/** 卸载时要说给用户听的一句话（形状与 EventInput 同款，调用方直接 emit）。 */
export interface UninstallNotice {
  /**
   * 这是哪一种话。**必须编进调用方的 dedupeKey**：事件层对同一个 key 的未读事件是"原地刷新
   * 时间戳"，新的标题和正文会被**丢掉**。两种话共用一个 key 时，一条还没读的
   * 「卷留在原地」(info) 会把后来那条「容器没能清掉」(warn) 悄悄吃掉——用户看到的还是那句
   * 旧的、语气轻的，真正要他动手的那句从来没出现过。
   */
  kind: 'container-left' | 'volumes-left'
  severity: 'info' | 'warn' | 'error'
  title: string
  body?: string
}

export interface UninstallDeps extends Pick<RecipeInstallDeps, 'userDir'> {
  /**
   * 停并删这个包的容器（`src/plugins/deprovision.ts` 的 `deprovisionService`）。
   * 不给 = 不收容器（老调用方 / 单测），行为与接这段之前一字不差。
   */
  deprovision?: (service: string) => Promise<'removed' | 'absent' | 'unavailable' | 'failed'>
  /** 收容器没收成时把这件事说出去。不给就只能沉默——沉默正是这条缺陷的形状。 */
  notify?: (n: UninstallNotice) => void
}

/**
 * 卸载一个装进来的包：**先收容器，再删目录**。
 *
 * 为什么容器这一步不能省（终审 Minor 5）：只删目录的话容器继续跑，而下次启动它既不在 provision
 * 名单里也不在 standby 名册里（包没了）——它变成一个**永不回收的常驻容器**，没有任何一条日志
 * 会再提到它，用户唯一的线索是内存少了一块。
 *
 * 不受 `manage_containers` 管：那个开关管的是"要不要替你建"，这里是"我建的东西我自己收"。
 *
 * docker 够不着**不让卸载失败**（用户已经拍过板了），改成发一条通知说清要手工 `docker rm` 什么。
 * 命名卷不动：那是数据，删掉不可逆，通知里一并说明。
 */
export async function uninstallRecipePackage(deps: UninstallDeps, name: string): Promise<boolean> {
  assertValidPackageName(name)
  const dir = findInstalledDir(deps.userDir, name)
  if (!dir) return false

  // 目录还在的时候读它的 backend 声明——删完就没得读了。读不出来（手改坏了 package.json）
  // 不该挡住卸载：卸载本来就是收拾残局的动作。
  const backend = deps.deprovision ? backendOf(dir) : undefined
  if (backend && deps.deprovision) {
    const { service, volumes } = backend
    const outcome = await deps.deprovision(service)
    if (outcome !== 'removed' && outcome !== 'absent') {
      deps.notify?.({
        kind: 'container-left',
        severity: 'warn',
        title: `${name} 的后端容器没能清掉`,
        body:
          outcome === 'unavailable'
            ? `包已经卸载，但后端连不上 Docker，所以它的容器还在。请手工执行 \`docker rm -f stream-${service}\`（它的命名卷不会被自动删除，确认不再需要那份数据后用 \`docker volume ls | grep ${service}\` 找出来自行清理）。`
            : `包已经卸载，但删除它的容器时出错了。请手工执行 \`docker rm -f stream-${service}\`。`,
      })
    } else if (outcome === 'removed' && volumes.length) {
      // 容器收干净了，**卷是故意留着的**（那是数据，删掉不可逆）——但留了就必须说。
      // 不说的话，用户机器上多出一个再也不会有人提起的卷：卸载报的是成功、docker ps 干净、
      // 日志一个字没有，唯一的线索是磁盘慢慢变少。2026-08-07 真机冒烟正是这么撞出来的
      // （卸载后 `docker volume ls` 里 smoke-container_data 还在，界面上没有任何提示）。
      deps.notify?.({
        kind: 'volumes-left',
        severity: 'info',
        title: `${name} 已卸载，它的数据卷留在原地`,
        body:
          `容器已经删掉了，但它的命名卷没有动——那里面是数据，删掉不可逆，所以留给你决定：` +
          `${volumes.map((v) => `\`${v}\``).join('、')}。确认不再需要后执行 ` +
          `\`docker volume rm ${volumes.join(' ')}\`。`,
      })
    }
  }

  rmSync(dir, { recursive: true, force: true })
  return true
}

/** 这个已安装目录声明的 service 名 + 它挂的命名卷名（没有 backend → undefined）。
 *  读不出来一律 undefined，不抛。
 *  卷这一格给的是**卷名**（`name:/path` 的 name 段），不是挂载串——它要被拼进
 *  `docker volume rm`，给整串就是一条用户照着敲会失败的命令。 */
function backendOf(dir: string): { service: string; volumes: string[] } | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as unknown
    const d = parseStreamDescriptor(raw, dir)
    if (!d.backend) return undefined
    return {
      // 落盘的字节是钳制后的（service 已被指派 = 包 id），`?? d.id` 只是防手改。
      service: d.backend.service ?? d.id,
      // 宿主路径 bind 在安装期就被拒了，落盘的只可能是命名卷；`?? ''` 之后的空名过滤掉，
      // 免得手改出来的畸形声明拼出一条 `docker volume rm` 后面跟着空白的命令。
      volumes: (d.backend.volumes ?? []).map((m) => m.split(':')[0] ?? '').filter(Boolean),
    }
  } catch {
    return undefined
  }
}

export interface RecipeUpdateCandidate {
  name: string
  /** 内置层那份的版本（发行包随 CLI 出货的快照）；用户层没装同名包时它就是"当前版"。 */
  builtin?: string
  /** 用户层已装的版本；有它时它才是"当前版"（它盖住内置那份）。 */
  installed?: string
  latest: string
}

/**
 * 一个候选的"当前版"：用户层已装的 ?? 内置的。用户层同名包整包盖住内置层（`mountRecipePackages`），
 * 所以有已装版时它才是真正在跑的那份。**这条判据只有这一处**——CLI 输出、启动日志、决策函数
 * 都从这里取；各自写一遍 `installed ?? builtin`，改一处漏一处时两边会报出不同的"当前版"。
 *
 * 候选是 `planRecipeUpdates` 造出来的，两格至少有一格（没有当前版的包进不了清单），所以这里
 * 返回 `string` 而不是 `string | undefined`；`?? ''` 只是给类型一个收口，不会真的走到。
 */
export function currentVersion(c: Pick<RecipeUpdateCandidate, 'builtin' | 'installed'>): string {
  return c.installed ?? c.builtin ?? ''
}

/**
 * 三份版本表 → 该更新的清单。纯函数：查 npm 的那一半在 `checkRecipeUpdates`。
 * "当前版"的定义见 `currentVersion`：拿内置版和 npm 比就会把已经装过的更新再报一遍。
 */
export function planRecipeUpdates(
  builtins: Array<{ name: string; version: string }>,
  installed: Array<{ name: string; version: string }>,
  latestOf: (name: string) => string | undefined,
): RecipeUpdateCandidate[] {
  const byName = new Map<string, { builtin?: string; installed?: string }>()
  for (const b of builtins) byName.set(b.name, { ...byName.get(b.name), builtin: b.version })
  for (const i of installed) byName.set(i.name, { ...byName.get(i.name), installed: i.version })
  const out: RecipeUpdateCandidate[] = []
  for (const [name, v] of byName) {
    const current = currentVersion(v)
    const latest = latestOf(name)
    if (!current || !latest || !isNewerVersion(latest, current)) continue
    out.push({ name, ...(v.builtin && { builtin: v.builtin }), ...(v.installed && { installed: v.installed }), latest })
  }
  return out
}

/**
 * 内置层里带 npm 名的包（`resources/packages` 下各包 package.json 有 name+version 的）。没有内置目录 = 空。
 *
 * **判"是不是内置包"用它，别用目录名**：内置包住 `packages/wechat/`（目录名是包 id），不是
 * `dirNameFor('@streamapp/wechat')` 那种由 npm 名改写出来的目录名——后者只是用户层安装时的落盘
 * 规则。拿目录名去内置层找，永远找不到，于是每个内置包都被判成"不认识"。
 */
export function listBuiltinNamed(builtinDir: string | undefined): Array<{ name: string; version: string }> {
  if (!builtinDir) return []
  return loadRecipePackages(builtinDir, { ...BUILTIN_LAYER_SCAN, onPackageError: () => {} }).descriptors
    .flatMap((d) => (d.name && d.version ? [{ name: d.name, version: d.version }] : []))
}

export async function checkRecipeUpdates(
  deps: Pick<RecipeInstallDeps, 'userDir' | 'registry'> & { builtinDir?: string },
): Promise<RecipeUpdateCandidate[]> {
  const builtins = listBuiltinNamed(deps.builtinDir)
  const installed = listInstalled(deps.userDir)
  const latest = new Map<string, string>()
  // 并发查 packument：内置层就有 30+ 个包，串行一个个等 registry 往返，一轮要好几十秒。
  // `allSettled` 保住原来的隔离语义——单包查询失败（私有 / 下架 / 网络抖动）只让那一个包
  // 缺席，不阻塞、也不掀翻其余包。
  const names = [...new Set([...builtins, ...installed].map((p) => p.name))]
  const results = await Promise.allSettled(names.map((name) => deps.registry.packument(name)))
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return
    const v = r.value['dist-tags']?.latest
    if (v) latest.set(names[i]!, v)
  })
  return planRecipeUpdates(builtins, installed, (name) => latest.get(name))
}

/** 启动日志那一行。没有候选给 null——启动日志一个字都不多打。 */
export function formatRecipeUpdateNotice(candidates: RecipeUpdateCandidate[]): string | null {
  if (candidates.length === 0) return null
  const items = candidates.map((c) => `${c.name} ${currentVersion(c)} → ${c.latest}`).join('、')
  return `[stream] ${candidates.length} 个包有更新：${items}。运行 \`stream update\` 安装。`
}

export interface InstalledRecipePackage {
  name: string
  version: string
  facility: string
  sourceIds: string[]
  /** 这个包带不带代码入口（`stream.code`）。卸载确认要靠它说实话：代码格的包卸载得重启才生效
   *  （ESM 模块缓存卸不掉），纯数据包不用——两档不能混成一句话，否则警示被稀释。 */
  hasCode: boolean
}

/** 已装清单：走 loader 的 descriptors——与 bootstrap 装载用**同一把尺**，不另造一套目录扫描
 *  （descriptors 顺带给出 facility 与该包带进来的源，正是列表要展示的东西）。没有 name/version
 *  的目录是手放的本地包（非 npm 管理），跳过。
 *  `hasCode` 取自同一把尺的另一半：recipe 层的 descriptor 不带 `stream.code`（那是包层的字段），
 *  所以按包目录 join 一次 scanPackages 的结果，而不是自己再解析一遍 package.json。 */
export function listInstalledRecipePackages(userDir: string): InstalledRecipePackage[] {
  // 读不动的包跳过，别让这条**读路径**整份抛：抛出去是 `GET /api/recipes/packages` 整页 500，
  // 一个包都列不出来、也就一个都卸不掉——而问题只出在其中一个。跳过它不会让它无处可查：
  // 「包」页的目录（`buildPackageInventory`）把它连同原因单独列一行。
  const skip = { onPackageError: () => {} }
  const coded = new Map(scanPackages(userDir, { ...USER_LAYER_SCAN, ...skip }).map((p) => [p.dir, p.code != null]))
  return loadRecipePackages(userDir, { ...USER_LAYER_SCAN, ...skip }).descriptors.flatMap((d) =>
    d.name && d.version
      ? [{
          name: d.name,
          version: d.version,
          facility: d.facility,
          sourceIds: d.sources.map((s) => s.id),
          hasCode: coded.get(d.dir) ?? false,
        }]
      : [],
  )
}
