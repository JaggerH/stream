/**
 * `stream add <包>` / `stream remove <包>` / `stream update` —— 装 / 卸 / 更新一个能力包 / recipe 包。
 *
 * **安装逻辑只有一份**（`src/replay/recipe-install.ts` 的 preview / install / uninstall，
 * 纯函数 + fs）。这条命令有两档，区别只在**谁去调它**：
 *
 * - 后端在场 → 经 `POST /api/recipes/packages/{preview,install,uninstall}`。走 API 而不是
 *   自己动手，是因为后端那一侧的 install 还会**立刻热装**（`reloadRecipePackages`）、卸载还会
 *   **收掉容器**；绕过它就等于装了个没人挂上的包、留下一个没人回收的容器。
 * - 后端不在场 → 直接调同一份函数。**绝不第二次实现**白名单和撞名闸门：两套必然漂，而漂了
 *   没有一处会喊。
 */
import { join, dirname, resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import {
  previewRecipePackage,
  installRecipePackage,
  uninstallRecipePackage,
  checkRecipeUpdates,
  currentVersion,
  listBuiltinNamed,
  readHostVersion,
  dirNameFor,
  type RecipeInstallDeps,
  type RecipePackagePreview,
  type RecipeUpdateCandidate,
} from '../replay/recipe-install.ts'
import { npmRegistryClient, officialRegistryIfMirror } from '../replay/recipe-registry.ts'
import {
  loadRecipePackages,
  BUILTIN_LAYER_SCAN,
  USER_LAYER_SCAN,
  OFFICIAL_SCOPE,
  type LoadRecipePackagesOptions,
} from '../replay/recipe-package.ts'
import { scanPackages } from '../packages/scan.ts'
import { occupiedByBuiltins, withInstalled } from '../packages/activate.ts'
import { probeBackend } from '../../shared/mcp/probe-backend.ts'
import { createInterface } from 'node:readline'
import type { PendingChange } from '../packages/pending.ts'
import { DEFAULT_BACKEND_URL } from './mcp-command.ts'
import { defaultDataDir, type RestartFlag } from './cli.ts'

/** 装 / 卸 / 查更新要的那几件事。两档给的是同一组语义，调用方分不出自己在哪一档。 */
export interface PackageOps {
  preview(name: string, version?: string): Promise<RecipePackagePreview>
  install(name: string, version: string | undefined, confirm: string): Promise<{ dir: string; version: string }>
  /** 没装过返回 false（不是错误）。 */
  uninstall(name: string): Promise<boolean>
  /** 该更新的清单（内置层 + 已装第三方 vs npm 最新）。 */
  updates(): Promise<RecipeUpdateCandidate[]>
  /** 待生效清单（启动快照 vs 盘上现状，判据在后端 `packages/pending.ts`——这里不复刻）。
   *  没有后端就没有"启动快照"这回事，本地档恒为空。 */
  pending(): Promise<PendingChange[]>
  /** 重启后端。**不抛**，把状态码原样交给调用方分支：202 重启中、409 有任务在跑（是一个答案，
   *  不是失败）、其余才是失败。本地档没有可重启的，抛「后端不在场」。 */
  restart(force: boolean): Promise<{ status: number; body: unknown }>
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => undefined)
  return { ok: res.ok, status: res.status, json }
}

/** 后端给的错要**原样带出来**：`validation_error` 那句 message 就是用户唯一能读懂的东西
 *  （撞名、白名单拒了某个文件、hostVersion 不匹配…）。只报一个 400 等于什么都没说。 */
function errorOf(status: number, json: unknown): Error {
  const msg = (json as { error?: { message?: string } } | undefined)?.error?.message
  return new Error(msg ? msg : `后端返回 ${status}`)
}

export function apiPackageOps(backendUrl: string, fetchImpl: typeof fetch = fetch): PackageOps {
  const root = backendUrl.replace(/\/$/, '')
  return {
    async preview(name, version) {
      const r = await postJson(fetchImpl, `${root}/api/recipes/packages/preview`, { name, ...(version && { version }) })
      if (!r.ok) throw errorOf(r.status, r.json)
      return r.json as RecipePackagePreview
    },
    async install(name, version, confirm) {
      const r = await postJson(fetchImpl, `${root}/api/recipes/packages/install`, {
        name, ...(version && { version }), confirm,
      })
      if (!r.ok) throw errorOf(r.status, r.json)
      return r.json as { dir: string; version: string }
    },
    async uninstall(name) {
      const r = await postJson(fetchImpl, `${root}/api/recipes/packages/uninstall`, { name })
      // 404 = 本来就没装。那不是失败，是一个答案——调用方据此说人话。
      if (r.status === 404) return false
      if (!r.ok) throw errorOf(r.status, r.json)
      return true
    },
    async updates() {
      const r = await fetchImpl(`${root}/api/recipes/packages/updates`)
      const json = await r.json().catch(() => undefined)
      if (!r.ok) throw errorOf(r.status, json)
      // 响应体不是数组时别让它悄悄流进 `.filter`/`.some`（在很远的地方炸出一句 TypeError）——
      // 直接说清楚"后端回的不是我们认识的形状"。
      if (!Array.isArray(json)) throw new Error('后端回了不是清单的东西')
      return json as RecipeUpdateCandidate[]
    },
    async pending() {
      const r = await fetchImpl(`${root}/api/packages/pending`)
      const json = await r.json().catch(() => undefined)
      if (!r.ok) throw errorOf(r.status, json)
      const list = (json as { pending?: unknown } | undefined)?.pending
      if (!Array.isArray(list)) throw new Error('后端回了不是清单的东西')
      return list as PendingChange[]
    },
    async restart(force) {
      const res = await fetchImpl(`${root}/api/restart${force ? '?force=1' : ''}`, { method: 'POST' })
      const body = await res.json().catch(() => undefined)
      return { status: res.status, body }
    },
  }
}

export interface LocalOpsOptions {
  /** 可写状态的根。`<dataDir>/recipes/` 就是装进来的包住的地方。 */
  dataDir: string
  /** 内置包目录（发行形态里是 `<bin>/../resources/packages`）。撞名闸门要读它；读不到就只剩
   *  第三方那一层，所以调用方拿不到时要**说一句**，别静默把闸门开一半。 */
  builtinDir?: string
  registryBase?: string
}

/**
 * 后端不在场那一档。deps 逐格照抄 `src/kernel/plugins/sources.ts` 里那一份——**不是另一套判据**，
 * 只是没有后端进程时由这条命令自己把同样的东西喂进去。
 */
export function localPackageOps(opts: LocalOpsOptions): PackageOps {
  const userDir = join(opts.dataDir, 'recipes')
  const registry = npmRegistryClient(opts.registryBase)
  const deps: RecipeInstallDeps = {
    registry,
    officialRegistry: officialRegistryIfMirror(opts.registryBase),
    userDir,
    builtinPackageSourceIds: (pkgName) => (opts.builtinDir
      ? loadRecipePackages(opts.builtinDir, BUILTIN_LAYER_SCAN)
        .descriptors.filter((d) => d.name === pkgName).flatMap((d) => d.sources.map((s) => s.id))
      : []),
    // 速率限制是**运行期**按 facility 算出来的（后端拿着那份合并快照）。这条命令没有后端可问，
    // 给 undefined = 按包自己申报的那份钳制，与后端在场时的下限一致。
    facilityRateLimit: () => undefined,
    hostVersion: readHostVersion(),
    occupiedNames: (selfPkgName) => withInstalled(
      occupiedByBuiltins(opts.builtinDir ? scanPackages(opts.builtinDir, { leftovers: 'ignore' }) : []),
      scanPackages(userDir, USER_LAYER_SCAN),
      selfPkgName,
    ),
  }
  return {
    preview: (name, version) => previewRecipePackage(deps, name, version),
    install: (name, version, confirm) => installRecipePackage(deps, name, version, confirm),
    // **不收容器**：收容器要一个连得上 docker 的后端（`deprovisionService`）。这一档没有，
    // 所以 `runRemoveCommand` 会把这件事说出来，不假装收干净了。
    uninstall: (name) => uninstallRecipePackage({ userDir }, name),
    updates: () => checkRecipeUpdates({ userDir, builtinDir: opts.builtinDir, registry }),
    // 没有后端进程就没有"启动时装载了什么"可对账；装的东西一律"下次起来时生效"，那句由调用方说。
    pending: async () => [],
    restart: async () => { throw new Error('后端不在场，没有可重启的') },
  }
}

export interface AddCommandDeps {
  env?: NodeJS.ProcessEnv
  log?(line: string): void
  probe?(baseUrl: string, timeoutMs: number): Promise<boolean>
  fetchImpl?: typeof fetch
  /** 显式指定数据目录（`--data`）。不给就按 `defaultDataDir(env)`。 */
  dataDir?: string
  /** 这一份可执行入口的路径，用来推内置包目录。默认 `process.argv[1]`。 */
  selfEntry?: string
  /** 测试直接把两档的结果塞进来，不必真去探后端。 */
  ops?: PackageOps
  where?: 'backend' | 'local'
  /** 问用户一句 y/N。缺省 `defaultAsk`：stdin 是终端就 readline 问，**不是终端一律 false**——
   *  脚本 / CI 里没人能答，挂在那儿等输入比不重启难查得多。 */
  ask?(question: string): Promise<boolean>
  /** `--restart` / `--no-restart`：给了就不问。 */
  restartFlag?: RestartFlag
}

/** stdin 是终端才问；不是就当没点头（false）。**默认是不重启**：重启会打断后端上正在做的事，
 *  一个没人看着的回车不该触发它。 */
export async function defaultAsk(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve))
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/**
 * 打一次 `POST /api/restart`，把三种结果说成人话。退出码：202 → 0；409（有任务在跑）→ 2；
 * 其余 → 1。409 **不自动升级成 force**——8900 上跑着真金白银的定时任务（见 `/api/restart` 头注），
 * 装个包不是打断它的理由；要越过得用户自己敲 `--force`。
 */
async function doRestart(ops: PackageOps, force: boolean, log: (l: string) => void): Promise<number> {
  const r = await ops.restart(force)
  if (r.status === 202) {
    log(`[stream] 后端重启中（${(r.body as { mode?: string } | undefined)?.mode ?? '?'}）——几秒后 /api/health 的 started_at 会变。`)
    return 0
  }
  if (r.status === 409) {
    const running = (r.body as { running?: { label: string }[] } | undefined)?.running ?? []
    log(`[stream] 有任务正在跑：${running.map((x) => x.label).join('、')}。等它跑完，或 stream restart --force。`)
    return 2
  }
  const msg = (r.body as { error?: { message?: string } } | undefined)?.error?.message
  log(`[stream] 重启失败：HTTP ${r.status}${msg ? `（${msg}）` : ''}`)
  return 1
}

/**
 * 装 / 更 / 卸成功之后（后端在场那一档）：列出要重启才生效的变更、问一句、答 y 就替用户重启。
 * 清单从后端现算（`GET /api/packages/pending`），**不按这次装的是什么来猜**——上一次装完没重启的
 * 也在里面，而"这次装的是纯 recipe 包"不等于"没有待重启项"。
 * 这一步**永远不改变**装 / 卸本身的退出码：包已经落盘了，重启被拒（409）、用户答 n、甚至
 * `pending()` / `restart()` 抛错（503 没开包目录、网络断了），都是另一件事——回执里说清即可，
 * 不许把一次成功的安装报成「装 X 失败」。退出码 2 留给 `stream restart` 自己和 update 的「拦下」。
 */
async function offerRestart(ops: PackageOps, deps: AddCommandDeps, log: (l: string) => void): Promise<void> {
  try {
    const need = (await ops.pending()).filter((p) => p.needsRestart)
    if (!need.length) return
    log(`[stream] 以下变更要重启后端才生效：`)
    for (const p of need) log(`  - ${p.name}：${p.why}`)
    const go = deps.restartFlag === 'yes'
      ? true
      : deps.restartFlag === 'no'
        ? false
        : await (deps.ask ?? defaultAsk)('现在重启后端？[y/N] ')
    if (!go) {
      log(`[stream] 稍后 stream restart 即可。`)
      return
    }
    await doRestart(ops, false, log)
  } catch (e) {
    log(`[stream] 重启询问失败：${(e as Error).message}（包已装好，稍后 stream restart）`)
  }
}

/** 内置包目录：发行形态里是 `bin/stream.mjs` 旁边那份 `../resources/packages`。不在就返回
 *  undefined（源码树跑 / 手工布局），调用方据此少查一层并**说一句**。
 *
 *  **`selfEntry` 先 realpath 再取 dirname**：Unix 全局安装下 `<prefix>/bin/stream` 是 npm 建的
 *  软链，指向 `<prefix>/lib/node_modules/@streamapp/stream/bin/stream.mjs`——`resources/` 住在
 *  软链**指向的那个目录**旁边，不在软链自己所在的目录旁边。而 `process.argv[1]`（调用方通常喂
 *  给这里的那个值）就是那个软链路径本身，node 不会替它 realpath。不先解析就永远拼错，撞名闸门
 *  从此只剩已装的第三方那一层，而这件事不报错——`existsSync` 只是诚实地说"没有"。 */
export function builtinDirNear(selfEntry: string | undefined): string | undefined {
  if (!selfEntry) return undefined
  let real = selfEntry
  try {
    real = realpathSync(selfEntry)
  } catch {
    // 路径本身就不存在/没权限 realpath——退回原始路径，让下面 existsSync 走一次原判断
    // （源码树里跑 tsx 时 selfEntry 常是没有对应磁盘文件的合成路径，这条分支保它不炸）。
  }
  const dir = resolve(dirname(real), '..', 'resources', 'packages')
  return existsSync(dir) ? dir : undefined
}

const PROBE_TIMEOUT_MS = 2000

async function pickOps(
  deps: AddCommandDeps,
  // 撞名闸门只在**装**的时候有意义——`remove` 不查撞名，找不到内置包目录跟它没关系，
  // 照样打这句告警只会让用户以为卸载哪里不对劲。
  opts: { warnMissingBuiltinDir?: boolean } = {},
): Promise<{ ops: PackageOps; where: 'backend' | 'local' }> {
  if (deps.ops) return { ops: deps.ops, where: deps.where ?? 'backend' }
  const env = deps.env ?? process.env
  const log = deps.log ?? ((l: string) => void process.stdout.write(`${l}\n`))
  const backendUrl = env.STREAM_BACKEND_URL ?? DEFAULT_BACKEND_URL
  const probe = deps.probe ?? probeBackend
  if (await probe(backendUrl, PROBE_TIMEOUT_MS)) {
    return { ops: apiPackageOps(backendUrl, deps.fetchImpl), where: 'backend' }
  }
  const dataDir = deps.dataDir ?? defaultDataDir(env)
  const builtinDir = builtinDirNear(deps.selfEntry ?? process.argv[1])
  if (!builtinDir && opts.warnMissingBuiltinDir !== false) {
    log(`[stream] 找不到内置包目录，撞名检查只查已装的第三方那一层（把后端跑起来再装可以两层都查）。`)
  }
  return { ops: localPackageOps({ dataDir, builtinDir }), where: 'local' }
}

export async function runAddCommand(
  cmd: { name: string; version?: string },
  deps: AddCommandDeps = {},
): Promise<number> {
  const log = deps.log ?? ((l: string) => void process.stdout.write(`${l}\n`))
  try {
    const { ops, where } = await pickOps(deps)
    const preview = await ops.preview(cmd.name, cmd.version)
    // confirm 必须是**这次 preview 刚发的那一个**：它是 tarball 的 integrity，挡的是
    // "preview 之后包变了" 的 TOCTOU。写死一个常量或者省掉它，闸门就白设了。
    const r = await ops.install(cmd.name, cmd.version, preview.confirm)
    log(`[stream] ${cmd.name}@${r.version} 已装到 ${r.dir}`)
    if (preview.mirrorUnverified) log(`[stream] 注意：${preview.mirrorUnverified}——按第三方包对待，不注入登录态。`)
    log(where === 'backend'
      ? `[stream] 源立刻生效；能力包（工具）要等后端重载后才出现。`
      : `[stream] 后端没在跑——下次 \`stream\` 起来时生效。`)
    if (where === 'backend') await offerRestart(ops, deps, log)
    return 0
  } catch (e) {
    log(`[stream] 装 ${cmd.name} 失败：${(e as Error).message}`)
    return 1
  }
}

/**
 * `stream restart [--force]`。后端不在场就没有可重启的（退出码 1）；在场就打一次
 * `POST /api/restart`，退出码见 `doRestart`。
 */
export async function runRestartCommand(
  cmd: { force: boolean },
  deps: AddCommandDeps = {},
): Promise<number> {
  const log = deps.log ?? ((l: string) => void process.stdout.write(`${l}\n`))
  try {
    // 这条命令不装东西，撞名闸门那句「找不到内置包目录」跟它无关。
    const { ops, where } = await pickOps(deps, { warnMissingBuiltinDir: false })
    if (where === 'local') {
      log(`[stream] 后端没在跑，没有可重启的。`)
      return 1
    }
    return await doRestart(ops, cmd.force, log)
  } catch (e) {
    log(`[stream] 重启失败：${(e as Error).message}`)
    return 1
  }
}

export async function runRemoveCommand(
  cmd: { name: string },
  deps: AddCommandDeps = {},
): Promise<number> {
  const log = deps.log ?? ((l: string) => void process.stdout.write(`${l}\n`))
  try {
    const { ops, where } = await pickOps(deps, { warnMissingBuiltinDir: false })
    const removed = await ops.uninstall(cmd.name)
    if (!removed) {
      log(`[stream] ${cmd.name} 没装过（`+ '`stream add` 装过的包才在这儿）。')
      return 1
    }
    log(`[stream] ${cmd.name} 已卸载。`)
    if (where === 'backend') {
      // 装的回执说「要等后端重载」，卸的回执必须对称——否则用户以为卸完就干净了，而工具还在
      // `tools/list` 上、凭证域还在扩展的同步名单里。装载器只在 boot 时扫一遍目录，`host` 也
      // 没有卸载单个能力的入口：**目录删了，进程里那份还活着**，且没有任何一处会喊。
      log(`[stream] 重启后端后才真正卸掉——已装载的工具与凭证域申报在重启前仍在。`)
      await offerRestart(ops, deps, log)
    }
    if (where === 'local') {
      // 这一档只删了目录。带容器的包，它的容器还在跑，而下次启动它既不在 provision 名单里也不在
      // standby 名册里（包没了）——一个永不回收的常驻容器，没有任何一条日志会再提到它。
      log(`[stream] 后端没在跑，所以只删了目录：这个包如果带容器，先把 \`stream\` 跑起来再卸载才收得掉它。`)
    }
    return 0
  } catch (e) {
    log(`[stream] 卸载 ${cmd.name} 失败：${(e as Error).message}`)
    return 1
  }
}

/** 一个包"现在"这一版（内置那份 ∪ 用户层已装那份）已经拿到的权限——更新闸门拿新版和它比。 */
export interface UpdateBaseline {
  /** 各 recipe 的 `meta.effects` 并集。 */
  effects: Set<string>
  /** 当前版带不带代码格（`stream.code`）/ 能力格（`stream.capability`）。两格指的是同一个文件、
   *  同一种权限（进程内、完整权限、能取登录态——见 `RecipePackagePreview.capability` 头注），
   *  所以这里合成一个布尔：当前版**任一格**都没有，新版却带了 → 是权限升档，不是普通更新。 */
  code: boolean
}

export interface UpdateCommandDeps extends AddCommandDeps {
  /** 某个包"现在"的基线（副作用全集 + 有没有代码）。缺省从本机目录读（`readBaseline`）。 */
  baseline?: (name: string) => UpdateBaseline
  /** 测试专用：跳过真的探内置包目录，直接说"内置包目录在/不在"。只在没给 `baseline`
   *  时才有意义——给了 `baseline` 就是调用方自己负责基线，这个开关不介入。 */
  builtinDirAvailable?: boolean
}

/** 内置层或用户层里是否**认识**这个包——不看它有没有效果、有没有更新，只回答"认识它吗"。
 *  `stream update <一个从没装过的包名>` 要能和"已经是最新版"分开说：前者从没被 `ops.updates()`
 *  查过（不在候选清单里的理由是"压根不认识"，不是"查过发现没有更新"），混着说会让用户以为
 *  自己拼错的包名其实装着、只是恰好最新。
 *
 *  **内置层按 npm 名判，不按目录名**：内置包住 `packages/wechat/`（目录 = 包 id），
 *  `dirNameFor('@streamapp/wechat')` 那种改写只是用户层安装的落盘规则；拿它去内置层找永远
 *  找不到，于是一个已是最新的内置包会被说成「没装过（也不是内置包）」。用户层的目录名正是
 *  `installRecipePackage` 按 `dirNameFor` 写下的，按它找是准的。 */
function isKnownPackage(name: string, builtinDir: string | undefined, userDir: string): boolean {
  if (listBuiltinNamed(builtinDir).some((b) => b.name === name)) return true
  return existsSync(join(userDir, dirNameFor(name)))
}

/** 一个包现有的基线：内置目录那份 + 用户层已装那份（有就并进来）。
 *  两层都算是因为"当前版"可能是任一层——用户层盖住内置层时，用户批准过的是用户层那份。
 *  effects 走 recipe 装载器（`loadRecipePackages`），代码 / 能力格走包扫描器（`scanPackages`）：
 *  前者的描述只有 recipe 层字段，`stream.code` / `stream.capability` 是包层的，得从后者读。 */
export function readBaseline(name: string, builtinDir: string | undefined, userDir: string): UpdateBaseline {
  const effects = new Set<string>()
  let code = false
  const layers: Array<[string | undefined, LoadRecipePackagesOptions]> = [[builtinDir, BUILTIN_LAYER_SCAN], [userDir, USER_LAYER_SCAN]]
  for (const [dir, scan] of layers) {
    if (!dir || !existsSync(dir)) continue
    const loaded = loadRecipePackages(dir, { ...scan, onPackageError: () => {} })
    for (const [id, recipe] of loaded.recipes) {
      if (!id.startsWith(`${name}/`)) continue
      for (const e of (recipe.meta?.effects ?? []) as string[]) effects.add(e)
    }
    for (const p of scanPackages(dir, { ...scan, onPackageError: () => {} })) {
      if (p.pkgName === name && (p.code || p.capability)) code = true
    }
  }
  return { effects, code }
}

/**
 * `stream update [<pkg>…] [--yes]`。官方 scope、没有新增副作用、也没有新带代码的更新直接装；
 * 其余先看 preview，没有 `--yes` 不装（退出码 2）——同一个包的新版本多了一种副作用
 * （`send` → `send` + `purchase`）、或从纯数据包变成带代码 / 能力的包（进程内完整权限，
 * 权限阶梯里最响的那一档，见 `RecipePackagePreview` 头注），和第三方包一样都是"装了会多做
 * 一类事"，得让人点头。
 *
 * preview 与 install 都钉在 `latest` 那一版：`confirm` 是 preview 那份 tarball 的 integrity，
 * 两步之间 npm 上又发了一版的话，不钉版本就会拿新 tarball 去对旧 integrity——闸门是响的，
 * 但用户看到的是一句莫名其妙的"校验不过"。
 */
export async function runUpdateCommand(
  cmd: { kind?: 'update'; names: string[]; yes: boolean },
  deps: UpdateCommandDeps = {},
): Promise<number> {
  const log = deps.log ?? ((l: string) => void process.stdout.write(`${l}\n`))
  try {
    const { ops, where } = await pickOps(deps)
    const dataDir = deps.dataDir ?? defaultDataDir(deps.env ?? process.env)
    const builtinDir = builtinDirNear(deps.selfEntry ?? process.argv[1])
    const userDir = join(dataDir, 'recipes')
    // 只有在调用方没自己接管基线（没给 `baseline`）时，"内置包目录找不找得到"才关这条
    // 命令自己的事——它这时会去读 `builtinDir`，找不到就只剩用户层那份，一个**从来没装过内置层
    // 那份**的官方包会被读成"基线是空集"，于是它申报的每一条 effect 都被念成"新增"。这是假理由，
    // 不是真的多了副作用。给了 `baseline` 的调用方（测试）自己对这件事负责。
    const usingDefaultBaseline = !deps.baseline
    const builtinDirAvailable = deps.builtinDirAvailable ?? (builtinDir !== undefined)
    const baseline = deps.baseline ?? ((name: string) => readBaseline(name, builtinDir, userDir))
    const wanted = new Set(cmd.names)
    const all = await ops.updates()
    const candidates = wanted.size ? all.filter((c) => wanted.has(c.name)) : all
    for (const n of wanted) {
      if (all.some((c) => c.name === n)) continue
      log(isKnownPackage(n, builtinDir, userDir)
        ? `[stream] ${n}：已是最新。`
        : `[stream] ${n}：没装过（也不是内置包）。`)
    }
    if (candidates.length === 0) {
      // 用户点了名的，上面已经逐个回答过（已是最新 / 没装过）；再追一句总括的「都是最新的」
      // 会和「没装过」并排出现——一个拼错的包名读起来像"最新的"。只有全查时才说这句。
      if (wanted.size === 0) log(`[stream] 都是最新的，没有可更新的包。`)
      return 0
    }
    let held = 0
    for (const c of candidates) {
      const preview = await ops.preview(c.name, c.latest)
      const incoming = new Set(preview.recipes.flatMap((r) => r.effects))
      // 名字是官方 scope 还不够：从镜像装、核不上官方源的那份（`mirrorUnverified`）装上去是
      // 第三方待遇，这里也按第三方拦——否则"自动装"这条快车道就成了镜像投喂的入口。
      const official = c.name.startsWith(OFFICIAL_SCOPE) && !preview.mirrorUnverified
      // 这个候选只在内置层报到（没装过用户层那份）、而这条命令又读不到内置包目录 → 基线必然是
      // 空集，"新增副作用"是编出来的理由。fail-closed：一样拦，但说实话。
      const baselineUnreadable = usingDefaultBaseline && !builtinDirAvailable && !!c.builtin && !c.installed
      const have = baseline(c.name)
      const added = [...incoming].filter((e) => !have.effects.has(e))
      // 新版带代码 / 能力而当前版没有：这不是"多了一种副作用"，是从纯数据包升成进程内代码——
      // 权限阶梯里最响的一档（见 `RecipePackagePreview.code` / `.capability` 头注）。只查 effects
      // 的闸门看不见它：能力包的 recipes 可以一条 effect 都不申报，于是官方 scope 一路静默装上。
      const addedCode = !have.code && !!(preview.code || preview.capability)
      if (!cmd.yes && (baselineUnreadable || !official || added.length > 0 || addedCode)) {
        held++
        const reasons = [
          ...(added.length ? [`新增副作用 ${added.join('、')}`] : []),
          ...(addedCode ? [`新版带代码（${preview.code?.entry ?? preview.capability?.entry}，在后端进程内运行）`] : []),
        ]
        const reason = baselineUnreadable
          ? '基线读不到（找不到内置包目录）'
          : (official ? reasons.join('；') : (preview.mirrorUnverified ?? '第三方包'))
        log(`[stream] ${c.name} ${currentVersion(c)} → ${c.latest}：${reason}，先看清再装：`)
        for (const r of preview.recipes) log(`  - ${r.id}：${r.effects.join('、') || '无副作用'}`)
        log(`  确认无误就 stream update ${c.name} --yes`)
        continue
      }
      const r = await ops.install(c.name, c.latest, preview.confirm)
      log(`[stream] ${c.name} ${currentVersion(c)} → ${r.version} 已装到 ${r.dir}`)
      // 带容器的包：换清单 = 换镜像 tag（安装门不收浮动 tag），宿主接管在**下次启动**时按新 tag 重建
      // 容器（provisioner：镜像与声明不一致 → 删了重建）。不说这一句，用户会以为更新完就在跑新镜像。
      if (preview.backend) log(`[stream] 容器镜像 → ${preview.backend.image}：重启后端后按它重建容器（manage_containers 开着才会）。`)
    }
    if (held < candidates.length) {
      log(where === 'backend' ? `[stream] 源立刻生效。` : `[stream] 后端没在跑——下次 \`stream\` 起来时生效。`)
      if (where === 'backend') await offerRestart(ops, deps, log)
    }
    return held > 0 ? 2 : 0
  } catch (e) {
    log(`[stream] 更新失败：${(e as Error).message}`)
    return 1
  }
}
