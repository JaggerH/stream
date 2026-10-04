import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Adapter } from '../adapters/types.ts'
import { hasNormalizer, registerNormalizer, type Normalizer } from '../content/normalize.ts'
import type { StreamPackage } from './scan.ts'
import { assignedServiceName } from './container-policy.ts'
import { fillsPluginSlot, type PluginSlotFields } from '../plugins/loader.ts'
import { assertPackageActions, type PackageAction, type PackageActionEntry } from '../tasks/package-actions.ts'
import type { Stream } from '../streams/types.ts'
import { HOST_ENRICH_SOURCES } from '../content/enrich/index.ts'
import { sanitizeEnrichment } from '../content/sanitize.ts'
import type { Article } from '../content/types.ts'
import type { PackageReadSource } from './read-source.ts'

/** `ctx.readArticle` 的答案：正文抽取给得出的那几格（抽取不产 `media`）。`sdk/plugin-sdk` 里有一份
 *  逐字段的镜像（`ArticleContent`），两边由 `plugin-sdk-compat.test.ts` 双向钉着。 */
export type ReadArticleResult = Omit<Article, 'media'>

/**
 * 宿主交给一个包的全部能力。包**只**通过它够到宿主——没有别的门，所以往这里加一个字段
 * 就是往「包能做什么」里加一条，加之前先问这条该不该给所有包。
 * 权威设计：docs/superpowers/specs/2026-08-05-package-unification-design.md
 */
export interface PluginContext {
  /** 这个包声明的 backend service 的可达地址（compose 档容器 DNS / host 档 loopback）。
   *  没有 backend 的包拿到 undefined。 */
  backendUrl: (service?: string) => string | undefined
  /** standby 唤醒：容器睡着了先叫醒再打。 */
  withAwake: <T>(service: string, fn: () => Promise<T>) => Promise<T>
  /** 这个域的 Cookie 头。**只放行该包 `credentials` 里申报过的域**，其余抛错。 */
  cookieFor: (domain: string) => Promise<string | undefined>
  /**
   * 把某个 facility 的登录态**登回来**：宿主找到那条 `meta.login` 的 recipe、在用户自己的
   * Chrome 里跑掉、跑完强制刷新 cookie 快照。成功即返回，任何一档失败都抛。
   *
   * ### 调它的地方是"建立会话"那一步，不是整个动作外面
   *
   * 宿主刻意**不**替包做"失败了就整个重跑一遍"：那件事安不安全只有包知道。一个已经下过一半
   * 单的动作被自动重跑，就是重复下单。正确的形状是包自己把它收窄到**没有副作用的那一段**：
   *
   * ```ts
   * const open = async () => await openSession(await ctx.cookieFor(DOMAIN))
   * try { return await open() }
   * catch (e) {
   *   if (!(e instanceof SessionExpired)) throw e
   *   await ctx.login('eastmoney')   // 宿主去登
   *   return await open()            // 只重做"建会话"，它没有副作用
   * }
   * ```
   *
   * 没有登录 recipe 的 facility 会抛（而不是静默返回"登好了"）——分不清"登上了"和"没登上"的
   * 返回值比抛错危险得多：调用方拿到前者就会去重做那件事，而那件事可能是下一笔单。
   */
  login: (facility: string) => Promise<void>
  /**
   * 运行**这个包自己声明的**一条源（recipe / manifest），拿回归一化前的原始条目。
   *
   * - 裸名按包名限定（`'x-detail'` → `<npm 名>/x-detail`，与 recipe `meta.uses` 同一规则）；
   *   带 `/` 的全名必须以本包前缀开头，否则抛——一个包不许借 `ctx` 去跑别人的 recipe，
   *   那等于绕开别家的 rateLimit 与账本。判据住在 `read-source.ts`。
   * - **不带 `userInitiated`**：动作 recipe（`meta.action:true`）经这条路照常撞
   *   `ActionRecipeBlockedError`。用户点击触发的动作走 `POST /api/recipes/action`，不走包代码。
   * - `signal` 一路传到 recipe runner，真的把运行停掉（调用方放弃这次结果时用）。
   * - 有 `locate` 步的 recipe 不用传 `ordered`：运行时按 facility 从 feed 账本填。
   */
  readSource: PackageReadSource
  /**
   * 一个公开网页的正文（宿主那一份 Defuddle 抽取，与 `/api/enrich?source=link` 同一个实现、同一份
   * 缓存）。抽不出 → null。不带登录态，谁都可以用——包里别再带第二份正文抽取器。
   * 返回的 html 未必干净：包交出的 enricher 结果由宿主统一消毒（见 `sanitizeEnricher`）。
   */
  readArticle: (url: string) => Promise<ReadArticleResult | null>
  log: (msg: string) => void
  /** 宿主解析好的、这个包自己的部署配置。 */
  config: Record<string, unknown>
}

/**
 * 一个具名富化处理器：`/api/enrich?source=<申报的名字>` 命中它时，宿主把**整袋 query**
 * 交过来，返回值原样 JSON 发出去。
 *
 * 宿主不校验参数——什么参数算合法只有包知道。参数不对时**抛 `ValidationError`**，
 * 宿主翻成 400；其余异常翻成 502。两者分开是因为它们的处置完全不同：前者是调用方写错了，
 * 后者是上游坏了。
 *
 * 第二参 `signal` 是调用方放弃这次结果的信号（WS 现取协议里新点击顶掉旧的靠它）；HTTP 面
 * 一参调用、不带信号。不读它的 enricher 签名照样兼容——参数可选。
 */
export type Enricher = (query: Record<string, string>, signal?: AbortSignal) => Promise<unknown>

/**
 * 一键订阅：`POST /api/credentials/<域名>/connect` 命中它时调一次，返回一条待订阅的
 * Stream（宿主负责 `subscribe`），`extra` 并进回执 JSON。
 *
 * **键是域名，而且必须出现在这个包的 `credentials` 里**——「我能一键订阅这个域」的前提
 * 就是「我拿得到这个域的登录态」，两者分家的话会出现一个包替它没申报过的站建订阅。
 */
export type ConnectFn = () => Promise<{ stream: Stream; extra?: Record<string, unknown> }>

/** 「调用方给错了参数」。包抛它，宿主翻 400；其余异常一律 502。
 *  类本体住 `shared/package-sdk/errors.ts`（宿主与包同吃一份；包 bundle 里是复制品，所以宿主
 *  判定只用 `isValidationError` 鸭子判，不用 `instanceof`）。这里 re-export 给宿主既有 import 点。 */
export { ValidationError, isValidationError } from '../../shared/package-sdk/errors.ts'

/** 一个包 activate 之后交出来的东西。键就是注册名，必须与 `stream.code` 里申报的名单一致。 */
export interface PackageActivation {
  adapters?: Record<string, Adapter>
  normalizers?: Record<string, Normalizer>
  /**
   * 这个包能干的**动作**——可以被一条用户定时任务调用（`UserTaskRow.action`）。键是动作名，
   * 全局名 = `<包 id>:<键>`。
   *
   * **包不自带排期**：什么时候跑、跑不跑、用哪一格账号，全是用户任务行的事（住 db，UI 里改）。
   * 判据见 `src/tasks/package-actions.ts` 头注。
   *
   * **不在 `stream.code` 里申报**：adapter / normalizer 要申报是因为它们注册进**全局**命名空间
   * （撞名必须早于执行就确认，那是信任边界）；动作名前缀是包 id，而带 code 槽位的包 id 全局
   * 独占，所以包与包之间从形状上就撞不了名——再加一份申报名单，只是多一份会漂的东西。
   */
  actions?: Record<string, PackageAction>
  /** 具名富化处理器，键 = `/api/enrich?source=` 的名字。在 `stream.code.enrichers` 申报。 */
  enrichers?: Record<string, Enricher>
  /** 按域名的一键订阅，键 = 域名。在 `stream.code.connect` 申报，且必须在 `credentials` 里。 */
  connect?: Record<string, ConnectFn>
}

export type ActivateFn = (ctx: PluginContext) => PackageActivation

/**
 * 宿主自己的四件 adapter 名——`bootstrap.ts` 手工织的 `builtin` / `rsshub` / `replay` / `browser`。
 * 任何包都不许申报这几个名字：normalizer 那一侧有 `hasNormalizer` 前置检查挡着（宿主的
 * normalizer 在模块加载时就注册了），adapter 这一侧本该有对等物——`activatePackages` 只查
 * 包与包之间的撞名，宿主自己的四件是**回填进 bootstrap 那张 Map 之后**才落地的，所以一个包
 * 只要申报其中一个就会静默顶掉宿主那件。顶掉 `builtin` 尤其糟：bootstrap 后面那一串
 * `builtinAdapter.register(...)` 会注册到一个已经被遮蔽的实例上，表现成一堆 mode 神秘消失。
 * 这不是防呆，是供应链攻击面（spec §7 R1）：P4 一开第三方包，这几个名字就是现成的靶子。
 */
export const RESERVED_ADAPTER_NAMES = new Set(['builtin', 'rsshub', 'replay', 'browser'])

/** 内置那一层已经占掉的名字。安装侧据此拒绝第三方包（见 `assertInstallable`）。 */
export interface OccupiedNames {
  /**
   * 内置**插件包**的 id（填了插件槽位的那些，见 `fillsPluginSlot`）——**不含纯 recipe 包**。
   *
   * 纯 recipe 包的 id 撞名是**受支持的覆盖**，不是冲突：用户层的包按 facility / sourceId 盖
   * 掉内置层同名的那份（`mountRecipePackages` / `mergeRecipePackagesByFacility`），安装期还会
   * 把盖掉的 sourceId 列进 preview 的 `overrides` 给用户看。把它们也算进 ids，等于**官方随应用
   * 发布的每一个 recipe 包，用户都装不了也升不了**——29 个内置包里 19 个是这一类。
   *
   * 反过来，填了插件槽位的包 id 必须独占：它有东西挂在按 id 索引的宿主设施上（容器 service
   * 默认名 / 凭证 token / presenter / source 清单）。
   */
  ids: ReadonlySet<string>
  /** 内置包申报的 adapter 名 + 宿主自己的四件（RESERVED_ADAPTER_NAMES） */
  adapters: ReadonlySet<string>
  /** 内置包申报的 normalizer 名 */
  normalizers: ReadonlySet<string>
  /**
   * 已被占掉的**容器 service 名**（`/_p/<service>` 网关路由 + standby 名册 + compose service key
   * 三处共用的那个全局命名空间）。
   *
   * 为什么它不能并进 `ids` 了事：内置包的 service 名**不一定等于它的 id**——id 是包目录名
   * （可以带大写和下划线），service 名是 compose 的 key（惯例全小写连字符），两者常常不同。
   * id 闸门查的是 id，所以一个 id 正好等于某个内置包 service 名的第三方包能过 id 闸门装进来，
   * 然后跟内置那个抢同一条 `/_p/` 路由和同一个 standby 名册位。
   */
  services: ReadonlySet<string>
  /**
   * 已被占掉的富化处理器名（`stream.code.enrichers`，= `/api/enrich?source=` 的名字）+ 宿主
   * 自己的几个（HOST_ENRICH_SOURCES）。`activatePackages` 第一段对撞名的处置是「两边都不激活」
   * → 抛 → 整个 packages 域起不来，所以要拒在安装门。
   */
  enrichers: ReadonlySet<string>
  /**
   * 已被占掉的一键订阅域名（`stream.code.connect`），**一律小写**——`activatePackages` 就是按
   * 小写判归属的，这里不小写会让 `Example.com` 从闸门漏过去然后在启动时撞上。
   */
  connect: ReadonlySet<string>
}

/**
 * 内置那一层占了哪些名字——**从内置包自己申报的 `stream.code` 推出来**，不是另写一份名单。
 * 加一个内置包 = 目录里多一个包 = 这里自动多几行，没有第二处要跟着改（一份手抄名单必然漂）。
 *
 * 传进来的应当是**内置包**那一批（bootstrap 的 `scanPackages(config.packages_dir)`）。别把用户
 * 目录那批也混进来：第三方覆盖第三方是另一条判据（`userSourceIds`），不归这里。
 *
 * **id 那一格只收填了插件槽位的包**（见 `ids` 字段头注 + `fillsPluginSlot`）；adapter /
 * normalizer / service 三格照收全部——那三个名字本来就只有填了槽位的包才会有。
 *
 * `excludePkgName` = **正在装的那个包自己的 npm 名**：内置带 code 的包也发 npm（今天 4 个），用户
 * `stream add @streamapp/<pkg>` 装到的是**同一个包的另一个版本**——它申报的 id / adapter / normalizer
 * 名与内置那份一字不差，本来就该如此。不剔除，这条自我升级路在安装门就被拒（"与内置插件包同名"），
 * §2.5 那把「同名两层只激活一层」的尺子永远轮不到。只剔同 npm 名的那一个内置包：第三方把
 * `stream.id` 写成 `xhs` 照样被内置 xhs 挡住（npm 名不同）。
 */
export function occupiedByBuiltins(
  pkgs: Iterable<Pick<StreamPackage, 'id'> & PluginSlotFields & { pkgName?: string }>,
  excludePkgName?: string,
): OccupiedNames {
  const ids = new Set<string>()
  // 宿主自己的四件本来就不许任何包申报（activatePackages 会拒 → 开不了机）。装之前就拒，
  // 用户才不用去翻文件系统删包。
  const adapters = new Set<string>(RESERVED_ADAPTER_NAMES)
  const normalizers = new Set<string>()
  const services = new Set<string>()
  // 宿主自己的 /api/enrich 源同理：activatePackages 见到就拒（开不了机），装之前先挡。
  const enrichers = new Set<string>(HOST_ENRICH_SOURCES)
  const connect = new Set<string>()
  for (const pkg of pkgs) {
    if (excludePkgName != null && pkg.pkgName === excludePkgName) continue
    if (fillsPluginSlot(pkg)) ids.add(pkg.id)
    for (const n of pkg.code?.adapters ?? []) adapters.add(n)
    for (const n of pkg.code?.normalizers ?? []) normalizers.add(n)
    for (const n of pkg.code?.enrichers ?? []) enrichers.add(n)
    for (const d of pkg.code?.connect ?? []) connect.add(d.toLowerCase())
    // service 名的默认值就是包 id（见 PluginBackend.service），显式写了就以显式的为准——
    // 两种都占着同一个全局命名空间，所以两种都要记。
    if (pkg.backend) services.add(pkg.backend.service ?? pkg.id)
  }
  return { ids, adapters, normalizers, services, enrichers, connect }
}

/**
 * 已装第三方包也进占用表。安装期闸门只查内置 = 只挡了一半：两个第三方包申报同一个 adapter /
 * normalizer 名时**各自装都成功**，下次启动 `activatePackages` 按设计「两边都不激活」→ 抛 →
 * 后端起不来，而恢复得让用户去翻文件系统删包。内置那道闸门写下来就是为了防这件事。
 *
 * `excludePkgName` = **正在装的那个包自己**（npm 包名）。不剔除它，一个包的升级 / 重装就会被
 * 它自己上一版占的名字挡住。
 *
 * 只并 adapter / normalizer / enricher / connect 域名 / service 名，**不并 id**：两个第三方包 id
 * 相同本身不坏事——装载按包对象身份路由（不按 id），真正会撞的那几样（容器 service 名、
 * adapter / normalizer / enricher 名、connect 域名）各有自己的一格挡着。
 *
 * service 名要并：第三方的 service 名由宿主指派 = 它的包 id，两个已装的第三方包 id 相同且都带
 * 容器时，`/_p/<service>` 路由和 standby 名册就撞了（名册重名在构造期抛，而 serve.ts 把这一抛
 * 降级成一行日志 ⇒ **全体** standby 失效：所有插件容器不再回收/唤醒，没有任何界面会提）。
 */
export function withInstalled(
  base: OccupiedNames,
  installed: Iterable<Pick<StreamPackage, 'code' | 'pkgName' | 'backend'> & { id?: string }>,
  excludePkgName?: string,
): OccupiedNames {
  const adapters = new Set(base.adapters)
  const normalizers = new Set(base.normalizers)
  const services = new Set(base.services)
  const enrichers = new Set(base.enrichers)
  const connect = new Set(base.connect)
  for (const pkg of installed) {
    if (excludePkgName != null && pkg.pkgName === excludePkgName) continue
    for (const n of pkg.code?.adapters ?? []) adapters.add(n)
    for (const n of pkg.code?.normalizers ?? []) normalizers.add(n)
    for (const n of pkg.code?.enrichers ?? []) enrichers.add(n)
    for (const d of pkg.code?.connect ?? []) connect.add(d.toLowerCase())
    if (pkg.backend && pkg.id) services.add(assignedServiceName(pkg.id))
  }
  return { ids: base.ids, adapters, normalizers, services, enrichers, connect }
}

/** 一个包在**执行期**失败了（只可能是动态那一档，见 runPlans 的头注）。 */
export interface PackageActivationFailure {
  id: string
  dir: string
  error: Error
}

export interface ActivateResult {
  /** adapter 名 → 实例。bootstrap 拿它填 adapters Map，也可按名取回实例自用。 */
  adapters: Map<string, Adapter>
  /** 执行期失败、这一轮不生效的第三方包。调用方必须把它说出去（日志 + 事件层），
   *  否则表现成"装了但没生效"——这条链路上最难查的一种。 */
  failures: PackageActivationFailure[]
  /** 包自己交出来的动作（带交它的包 id）。调用方汇成名录，供任务行的 `action` 字段查。 */
  actions: PackageActionEntry[]
  /** 包交出来的富化处理器（全局名就是键——撞名在第一段已经拒过了）。 */
  enrichers: Map<string, Enricher>
  /** 包交出来的一键订阅（键 = 域名）。 */
  connect: Map<string, ConnectFn>
}

/**
 * `ctx.cookieFor` 的申报闸门：**只放行该包 `credentials` 里申报过的域**，其余抛错。
 *
 * 为什么抛而不是返回 undefined：静默返回空会让包看起来"这个域没登录态"，于是它去走降级路径，
 * 最终表现成一次莫名其妙的采集失败——而真正的原因（少写了一行申报）离现场十万八千里。
 * 申报是这个包能碰哪些登录态的**唯一**依据，越界必须当场吵。
 */
export function makeCookieFor(
  pkg: Pick<StreamPackage, 'id' | 'credentials'>,
  cookieString: (domain: string) => Promise<string | null | undefined>,
): (domain: string) => Promise<string | undefined> {
  return async (domain) => {
    // 大小写不敏感（DNS 如此）：申报 `example.com`、请求 `EXAMPLE.COM` 不该拒。
    //
    // 这是**唯一**一条包能碰到登录态的路，而且它是宿主主动交出来的能力（`ctx.cookieFor`，
    // 进程内、宿主全程在场）。曾经还有一条「容器带 token 反过来打 broker」的 HTTP 路，已撤销——
    // 方向反了，见 src/http/app.ts 里那段说明。
    const wanted = domain.toLowerCase()
    if (!pkg.credentials?.some((d) => d.toLowerCase() === wanted)) {
      throw new Error(
        `Stream package "${pkg.id}" asked for cookies of "${domain}" without declaring it in credentials`,
      )
    }
    return (await cookieString(wanted)) ?? undefined
  }
}

/** 申报名单与实际返回的键必须一字不差——两边的差集都要吵出来。 */
function assertDeclaredMatches(pkgId: string, kind: string, declared: string[], actual: string[]): void {
  const declaredSet = new Set(declared)
  const actualSet = new Set(actual)
  const undeclared = actual.filter((n) => !declaredSet.has(n))
  const missing = declared.filter((n) => !actualSet.has(n))
  if (undeclared.length === 0 && missing.length === 0) return
  const parts: string[] = []
  if (undeclared.length > 0) parts.push(`returned undeclared ${kind} [${undeclared.join(', ')}]`)
  if (missing.length > 0) parts.push(`declared but did not return ${kind} [${missing.join(', ')}]`)
  throw new Error(
    `Stream package "${pkgId}" activate() ${parts.join('; ')} — stream.code must declare exactly what it registers`,
  )
}

/**
 * 取模块的两条来路。
 * - `builtin`：**内置包**（仓库 `packages/`）的静态 import 表，字面量 import，打包期就定死。
 * - `dynamic`：**第三方包**（用户数据目录里装进来的）**包对象本身**的集合——它们的代码在盘上，
 *   运行时 `import(file://…/dist/index.js)` 取。
 *
 * 一个包只能属于其中一条：`dynamic` 里有它就走动态，否则必须在 `builtin` 表里，两边都没有 =
 * 抛错（不是跳过）。裸 `Map` 仍受理，等价于「全是内置、没有动态」。
 *
 * **为什么装的是包对象而不是 id**：id 是包**自己** package.json 里写的字符串，第三方随手写成
 * `alist` 就跟内置那个包重名。按 id 建集合时这一撞会把**内置** alist 也判成动态，于是去
 * `import()` 它的 `./activate.ts`——源码文件，发行 bundle 里根本不出货 → 后端起不来，恢复
 * 还得让用户去翻文件系统删包。对象身份是**宿主**给的（谁扫出来的就是谁），包里写什么都伪造
 * 不了，所以撞 id 这条路从形状上就没有了。同理别把它换成 `layer: 'builtin'|'user'` 这类
 * **写在包对象上的字段**：字段会跟着 package.json 的解析走，下一个人顺手让它透传就又能被包
 * 自己申报了。
 */
export interface PackageEntries {
  builtin: Map<string, ActivateFn>
  dynamic?: ReadonlySet<StreamPackage>
}

/** 一个包在第一段里定好的装载方案——第二段只按它执行，不再做任何判断。 */
type LoadPlan =
  | { pkg: StreamPackage; kind: 'static'; fn: ActivateFn }
  | { pkg: StreamPackage; kind: 'dynamic'; entryPath: string }

/**
 * 装载带代码的包：先**全量核对申报名单**，全过了才开始逐个取模块 + 调 `activate`。
 *
 * 两段式不是洁癖：`activate` 一被调用，包的代码就已经在本进程里跑了；对第三方包更狠——
 * `import()` 本身就执行模块顶层代码，`activate` 都不用被调。所以「这个名字能不能注册」的确认
 * 必须早于执行，撞名只能靠 `stream.code` 里的静态名单判，不能靠「先跑再看它返回了什么」
 * （spec §7 R1）。同理，声明了 `code` 却两条来路都没有也是**抛错**而不是跳过——内置包漏进
 * import 表会表现成「某个 source 突然解析不到 adapter」，静默极难查。
 *
 * **返回 Promise，但第一段的错误是同步抛的**（本体不是 `async function`，检查跑在返回那个
 * Promise 之前）。这不是花招，是把不变量写进了控制流：**凡是同步抛出来的，一定发生在任何
 * `import()` 之前**——调用方 `expect(() => …).toThrow()` 能钉住的就是这条。
 *
 * adapter 实例**交还调用方**（宿主别处还要按名取回其中某个实例自用）；normalizer 因为有全局
 * registry，就地 `registerNormalizer` 注册。
 */
export function activatePackages(
  packages: StreamPackage[],
  entries: Map<string, ActivateFn> | PackageEntries,
  makeCtx: (pkg: StreamPackage) => PluginContext,
): Promise<ActivateResult> {
  const builtin = entries instanceof Map ? entries : entries.builtin
  const dynamic: ReadonlySet<StreamPackage> =
    (entries instanceof Map ? undefined : entries.dynamic) ?? new Set<StreamPackage>()
  const coded = packages.filter((p) => p.code)

  // ── 第一段：只读检查，一行包代码都还没跑 ────────────────────────────────
  const plans: LoadPlan[] = []
  const adapterOwner = new Map<string, string>()
  const normalizerOwner = new Map<string, string>()
  const enricherOwner = new Map<string, string>()
  const connectOwner = new Map<string, string>()
  for (const pkg of coded) {
    if (dynamic.has(pkg)) {
      // `code.entry` 是**包自己写的字符串**，不许它指到包目录外面去（`../../…`、绝对路径）。
      // resolve 之后比前缀，比的是归一化后的真实路径，所以 `a/../../b` 这类写法也会被抓到。
      const root = resolve(pkg.dir)
      const entryPath = resolve(root, pkg.code!.entry)
      if (entryPath !== root && !entryPath.startsWith(root + sep)) {
        throw new Error(
          `Stream package "${pkg.id}" declares code entry "${pkg.code!.entry}" which resolves outside its own ` +
          `directory (${entryPath} ⊄ ${root}) — refusing to load`,
        )
      }
      plans.push({ pkg, kind: 'dynamic', entryPath })
    } else {
      const fn = builtin.get(pkg.id)
      if (!fn) {
        throw new Error(
          `Stream package "${pkg.id}" declares stream.code (entry ${pkg.code!.entry}) but has no entry in the ` +
          `activate import table — wire it in, a package with code must never be silently skipped`,
        )
      }
      plans.push({ pkg, kind: 'static', fn })
    }
    for (const name of pkg.code!.adapters ?? []) {
      if (RESERVED_ADAPTER_NAMES.has(name)) {
        throw new Error(
          `Stream package "${pkg.id}" declares adapter "${name}", which is reserved for the host — ` +
          `"builtin", "rsshub", "replay", "browser" belong to Stream's own adapters, a package must not shadow them`,
        )
      }
      const prev = adapterOwner.get(name)
      if (prev) {
        throw new Error(
          `Stream packages "${prev}" and "${pkg.id}" both declare adapter "${name}" — refusing to activate either`,
        )
      }
      adapterOwner.set(name, pkg.id)
    }
    for (const name of pkg.code!.normalizers ?? []) {
      const prev = normalizerOwner.get(name)
      if (prev) {
        throw new Error(
          `Stream packages "${prev}" and "${pkg.id}" both declare normalizer "${name}" — refusing to activate either`,
        )
      }
      if (hasNormalizer(name)) {
        throw new Error(
          `Stream package "${pkg.id}" declares normalizer "${name}", which is already registered — ` +
          `refusing to activate (a package must not shadow another's normalizer)`,
        )
      }
      normalizerOwner.set(name, pkg.id)
    }
    for (const name of pkg.code!.enrichers ?? []) {
      if (HOST_ENRICH_SOURCES.has(name)) {
        throw new Error(
          `Stream package "${pkg.id}" declares enricher "${name}", which is one of the host's own ` +
          `/api/enrich sources — refusing to activate (a package must not shadow the host's enrichment)`,
        )
      }
      const prev = enricherOwner.get(name)
      if (prev) {
        throw new Error(
          `Stream packages "${prev}" and "${pkg.id}" both declare enricher "${name}" — refusing to activate either`,
        )
      }
      enricherOwner.set(name, pkg.id)
    }
    for (const domain of pkg.code!.connect ?? []) {
      const declared = pkg.credentials?.some((d) => d.toLowerCase() === domain.toLowerCase())
      if (!declared) {
        throw new Error(
          `Stream package "${pkg.id}" declares connect for "${domain}" without declaring that domain in ` +
          `credentials — "I can one-tap subscribe this site" presupposes "I can read this site's login"`,
        )
      }
      const prev = connectOwner.get(domain.toLowerCase())
      if (prev) {
        throw new Error(
          `Stream packages "${prev}" and "${pkg.id}" both declare connect for "${domain}" — refusing to activate either`,
        )
      }
      connectOwner.set(domain.toLowerCase(), pkg.id)
    }
  }

  // ── 第二段：执行（到这里，名字全部确认过了）────────────────────────────
  return runPlans(plans, makeCtx)
}

/**
 * 第三方包的代码入口：`import(file://…)`。**失败一律带包 id 抛出去**——文件不存在 / 语法错 /
 * 没导出 `activate` 全算失败。抛给 runPlans，由它按「动态 = per-package 捕获、静态 = 致命」
 * 分档（见 runPlans 头注）；这里不做分档，也绝不静默返回一个空 activate。
 */
async function loadDynamicActivate(pkg: StreamPackage, entryPath: string): Promise<ActivateFn> {
  let mod: Record<string, unknown>
  try {
    mod = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>
  } catch (e) {
    throw new Error(
      `Stream package "${pkg.id}": failed to load code entry ${entryPath} — ${(e as Error).message}`,
    )
  }
  const fn = mod.activate ?? (mod.default as Record<string, unknown> | undefined)?.activate
  if (typeof fn !== 'function') {
    throw new Error(
      `Stream package "${pkg.id}": ${entryPath} does not export activate() — a package with stream.code must ` +
      `export a function named activate`,
    )
  }
  return fn as ActivateFn
}

/**
 * 第二段：执行。**失败分两档，差别在"这是谁的代码"**：
 *
 * - **`static`（内置包，仓库 `packages/`）→ 致命，照抛。** 那是我们自己的代码，坏了就该起不来：
 *   它没有"这次不生效"这种收场（宿主别处按名取实例），而且一次发布就能修。
 * - **`dynamic`（用户装的第三方包）→ per-package 捕获。** 少打包一个依赖
 *   （`ERR_MODULE_NOT_FOUND`）、模块顶层抛错、没导出 `activate`、交出来的名单与申报对不上——
 *   全是第三方包自己的问题，不该掀翻整个后端（掀翻了用户在 UI 里恢复不了，只能翻文件系统删包）。
 *   这个包这次不生效，记进 `failures`，调用方负责说出去。
 *
 * 注意这一档只覆盖**执行期**。名字检查（撞名 / 保留名 / 代码入口路径越界）全在第一段，发生在任何
 * 包代码跑起来之前，是信任边界的一部分，**仍然 fail-closed 且致命**，不许降级到这里来。
 */
/**
 * 包交出的 enricher 一律过这一层：结果里的 `article.html` 与每条 `comments[].html`（含嵌套回复）
 * 由宿主消毒，再交给 HTTP / WS 两个出口。
 *
 * 为什么在这里而不是各包自己消毒：前端对这两格是 `dangerouslySetInnerHTML` 原样渲染，**它信的是
 * 宿主**。包——尤其第三方包——交出来的 html 不经这一层，就是一段别人写的脚本直接进了用户的页面。
 * 收口在装载处，两个出口（`/api/enrich` 与 WS `enrich.open`）都吃同一份，不会一边消毒一边漏。
 * 不是富化形状的返回值（比如作者信息对象）原样放过。
 */
export function sanitizeEnricher(fn: Enricher): Enricher {
  return async (query, signal) => sanitizeEnrichment(await fn(query, signal))
}

async function runPlans(
  plans: LoadPlan[],
  makeCtx: (pkg: StreamPackage) => PluginContext,
): Promise<ActivateResult> {
  const adapters = new Map<string, Adapter>()
  const failures: PackageActivationFailure[] = []
  const actions: PackageActionEntry[] = []
  const enrichers = new Map<string, Enricher>()
  const connect = new Map<string, ConnectFn>()
  for (const plan of plans) {
    const pkg = plan.pkg
    try {
      const activate = plan.kind === 'static' ? plan.fn : await loadDynamicActivate(pkg, plan.entryPath)
      const produced = activate(makeCtx(pkg)) ?? {}
      assertDeclaredMatches(pkg.id, 'adapters', pkg.code!.adapters ?? [], Object.keys(produced.adapters ?? {}))
      assertDeclaredMatches(pkg.id, 'normalizers', pkg.code!.normalizers ?? [], Object.keys(produced.normalizers ?? {}))
      assertDeclaredMatches(pkg.id, 'enrichers', pkg.code!.enrichers ?? [], Object.keys(produced.enrichers ?? {}))
      assertDeclaredMatches(pkg.id, 'connect', pkg.code!.connect ?? [], Object.keys(produced.connect ?? {}))
      // 动作先整批校验再收——一个不合格就整个包这次不生效，不要收一半。半批比没有更坏：
      // 缺席的那个动作会让引用它的任务行永远报"没有这个动作"，而其余照跑，看起来只是"某条坏了"。
      assertPackageActions(pkg.id, produced.actions ?? {})
      for (const [name, adapter] of Object.entries(produced.adapters ?? {})) adapters.set(name, adapter)
      for (const [name, normalizer] of Object.entries(produced.normalizers ?? {})) registerNormalizer(name, normalizer)
      for (const [local, run] of Object.entries(produced.actions ?? {})) actions.push({ pkgId: pkg.id, local, run })
      for (const [name, fn] of Object.entries(produced.enrichers ?? {})) enrichers.set(name, sanitizeEnricher(fn))
      for (const [domain, fn] of Object.entries(produced.connect ?? {})) connect.set(domain.toLowerCase(), fn)
    } catch (e) {
      if (plan.kind === 'static') throw e
      const error = e as Error
      failures.push({ id: pkg.id, dir: pkg.dir, error })
      // 这里就吵一次（不等调用方）：这条日志是"装了但没生效"唯一的现场。
      console.error(`[stream] package "${pkg.id}" failed to activate — 这个包这次不生效：${error.message}`)
    }
  }
  return { adapters, failures, actions, enrichers, connect }
}
