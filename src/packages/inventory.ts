import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { StreamPackage } from './scan.ts'
import { fillsPluginSlot } from '../plugins/loader.ts'
import type { PluginStatus } from '../plugins/status.ts'
import { packageRole, type PackageRole } from '../netdisk/base-package.ts'

/**
 * 「这台机器上装了什么」的读模型 —— `GET /api/packages` 的形状。
 *
 * 与另外两个投影的关系（三者交集只有 id，见
 * docs/superpowers/specs/2026-08-07-unified-packages-page-design.md §3）：
 *  - `/api/plugins`（`toPluginDescriptor` + `fillsPluginSlot`）= **插件目录 + 它带的 Source**，
 *    纯 recipe 包不在那儿。
 *  - `/api/recipes/packages`（`listInstalledRecipePackages`）= **npm 管理面**，只扫用户层。
 *  - 这一份 = 两层全部的包 + 它们各填了哪几格槽位，不带 Source 清单、不带装卸操作。
 *
 * 包的目录遍历与解析仍走 `scanPackages`（同一把尺），这里只做投影。
 */

export type PackageLayer = 'builtin' | 'user'

/** 这个包填了哪几格。没填的槽位**不出现在对象里**（`recipes: 0` 和"没有 recipe 槽"是一回事，
 *  但前端画 chip 时前者会画出一个 `recipe×0` 的空标记）。 */
export interface PackageSlots {
  /** Source 清单条数（`manifests.yaml` 或内联 `stream.sources`） */
  sources?: number
  /** `*.recipe.json` 份数 */
  recipes?: number
  /** 那几份 recipe 各叫什么（文件名去掉 `.recipe.json`），按名排序。
   *  配方行要能说出「是哪几条」——只给一个「4 条」，用户还是得去翻目录才知道装进来的是什么。 */
  recipeNames?: string[]
  code?: true
  /**
   * 能力槽位的入口路径（`stream.capability`）。**和 `code` 不是一回事**：`code` 那格注册
   * adapter/normalizer，这一格交出一个 `Capability`（工具 + 服务）。两格权限相同（后端进程内、
   * 完整权限、可取登录态），所以界面上要一起摆——只画 `code` 的话，一个能力包在「包」页上
   * 和一份纯数据的 recipe 包长得一模一样。
   */
  capability?: string
  /**
   * 这个能力包**此刻**挂在工具面上的动词。填这一格的数据源是活着的能力宿主
   * （`mergeCapabilityTools`），不是包目录——工具名只有 mount 过才知道。
   *
   * 有 `capability` 却 `tools: []`，说的是"声明了能力但没装载/没注册工具"，是一句真话，
   * 不是缺数据；`capability` 缺席的包这一格也缺席。
   */
  tools?: string[]
  backend?: true
  /** 申报的 cookie 域（非空才有） */
  credentials?: string[]
  /**
   * 这个包的 recipe 声明了要用户填的配置（`meta.runtime_config.ref`），去重后排序。
   *
   * **消费者是定时任务的编辑器**：一条任务要说清"我用的账号在哪一格"，得先有一份
   * 「这台机器上有哪些可填的凭据格」的清单，这就是那份清单。后端其余部分早就通了
   * （配置 row 引擎按 `source:<ref>` 现场解出 schema），缺的一直是"谁把用户领过去"。
   */
  config?: string[]
}

export type PackageRuntimeState = 'running' | 'idle' | 'error' | 'unknown'

export interface PackageRuntime {
  state: PackageRuntimeState
  /** 声明的镜像（状态行右侧的次要信息） */
  image: string
  /** standby 记的最后使用时刻（epoch ms）。没用过 / 不归 standby 管 → 不带这个键。 */
  lastUsed?: number
}

export interface PackageSummary {
  id: string
  /** 显示名，缺 `stream.name` 时回落 id —— 前端不该拿到空标题 */
  name: string
  description?: string
  layer: PackageLayer
  /** npm 包名（用户层才有；卸载靠它认包，不靠目录名） */
  pkgName?: string
  version?: string
  slots: PackageSlots
  /** **分段判据**，见 isHostedPackage */
  hosted: boolean
  /**
   * 这个包在宿主里扮演的角色（今天只有网盘底座 `netdisk-base`，判据 `src/netdisk/base-package.ts`）。
   * 前端按它决定给不给「网盘挂载 + 绑定」那块配置——**前端不按包 id 分支**。没有角色的包不带这一格。
   */
  role?: PackageRole
  /** 启用开关现值。只有填了插件槽位的包才有（纯 recipe 包没有可翻的开关）。 */
  enabled?: boolean
  /** 只有带容器的包才有。骨架在 summarizePackage 里建好，state 由 mergePackageRuntime 填。 */
  runtime?: PackageRuntime
  /**
   * 这个包**读不动**（`package.json` 不合法 / manifests.yaml 不过 schema），值是人能读的原因。
   *
   * 它必须**出现在目录里**而不是消失：目录整份 500 和悄悄少一行都是把问题藏起来——用户看不见
   * 自己刚装的包，只会以为没装上，去装第二遍。有它时 `slots` 恒空（描述都解析不出来，谈不上槽位）。
   */
  unreadable?: string
}

/**
 * 这个包**会不会在运行时坏** —— 「包」页的分段判据。
 *
 * 有容器（起不来、镜像和声明对不上）或要用户登录态（会过期）= 会坏，宿主在替它跑东西，
 * 所以给它状态行和开关。其余只是数据，装上就在那儿。
 *
 * **别拿 `fillsPluginSlot` 当这条用**：那条问的是"宿主要不要替这个包做点什么"，它还包含
 * 只提供 Source 清单 / normalizer 的 `rsshub` / `builtin` / `browser` / `replay`——那四个
 * 不会坏，摆进「需要照料」区就是在骗人去照料它们。两条判据回答两个不同的问题，别合并。
 *
 * 数字由 `inventory.real.test.ts` 钉着（内置层的包数与 hosted 的那份名单都在那儿）。
 */
export function isHostedPackage(pkg: Pick<StreamPackage, 'backend' | 'credentials'>): boolean {
  return !!(pkg.backend || pkg.credentials?.length)
}

/** 一个包目录里的 `*.recipe.json` 各叫什么（去后缀，按名排序）。
 *  目录读不到（被删/权限）返回空数组——一个坏目录不该掀翻整页。
 *  排序不是洁癖：`readdirSync` 的顺序随文件系统而变，不排就会出现"刷新一下顺序变了"。 */
export function listRecipeNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.recipe.json'))
      .map((f) => f.slice(0, -'.recipe.json'.length))
      .sort()
  } catch {
    return []
  }
}

/**
 * 这个包的 recipe 各自声明了哪个 `runtime_config.ref`（去重、排序）。
 *
 * **就地读 JSON，不问 registry**：registry 里那份 manifest 是投影过的，且按 sourceId 索引——
 * 从 sourceId 反推"它是哪个包带来的"要再造一张映射表，而这里手上本来就有包目录。
 *
 * 坏 JSON / 读不动一律跳过，不抛：这一格是**附加信息**，为它把整份包目录打成 500，
 * 代价远大于少列一个可选项（而包读不动本来就有 `unreadable` 那一格在说话）。
 */
export function listRecipeConfigRefs(dir: string, recipeNames: string[]): string[] {
  const refs = new Set<string>()
  for (const name of recipeNames) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, `${name}.recipe.json`), 'utf8')) as {
        meta?: { runtime_config?: { ref?: unknown } }
      }
      const ref = raw.meta?.runtime_config?.ref
      if (typeof ref === 'string' && ref !== '') refs.add(ref)
    } catch { /* 见头注：附加信息，读不动就当没有 */ }
  }
  return [...refs].sort()
}

/**
 * 从 `pluginStatus` 的一行推出状态。**不新起探活**：`aggregatePluginStatus` 已经决定了
 * "standby 管的服务读快照就够、不做 HTTP 探活"，这里只做投影。多一套探活 = 多一份会和
 * `/api/plugins` 说法不一致的真相。
 *
 * standby 的非 `awake` 态是 **idle 不是 error**：它只是没被唤醒，下次用到会自愈。
 */
export function runtimeStateOf(status: PluginStatus | undefined): PackageRuntimeState {
  if (!status) return 'unknown'
  if (status.standby) return status.standby.state === 'awake' ? 'running' : 'idle'
  if (status.health === 'ok') return 'running'
  if (status.health === 'down') return 'error'
  return 'unknown'
}

/** 一个扫出来的包 → 它的目录条目。 */
export function summarizePackage(pkg: StreamPackage, layer: PackageLayer): PackageSummary {
  const recipeNames = listRecipeNames(pkg.dir)
  const slots: PackageSlots = {}
  if (pkg.sources?.length) slots.sources = pkg.sources.length
  if (recipeNames.length) {
    slots.recipes = recipeNames.length
    slots.recipeNames = recipeNames
    const configRefs = listRecipeConfigRefs(pkg.dir, recipeNames)
    if (configRefs.length) slots.config = configRefs
  }
  if (pkg.code) slots.code = true
  if (pkg.capability) slots.capability = pkg.capability
  if (pkg.backend) slots.backend = true
  if (pkg.credentials?.length) slots.credentials = [...pkg.credentials]

  const out: PackageSummary = {
    id: pkg.id,
    name: pkg.name ?? pkg.id,
    description: pkg.tagline ?? pkg.description,
    layer,
    pkgName: pkg.pkgName,
    version: pkg.pkgVersion,
    slots,
    hosted: isHostedPackage(pkg),
    role: packageRole(pkg.id),
  }
  // 容器包自带一条状态行的骨架；没有容器就没有 runtime 键（给个 unknown 状态行是凭空制造焦虑）。
  if (pkg.backend) out.runtime = { state: 'unknown', image: pkg.backend.image }
  for (const k of Object.keys(out) as (keyof PackageSummary)[]) if (out[k] === undefined) delete out[k]
  return out
}

export interface BuildPackageInventoryInput {
  /** 内置层（仓库自带 `packages/`，运行时不会变——用启动时那份扫描结果即可） */
  builtin: StreamPackage[]
  /** 用户层（`<dataDir>/recipes`）。**必须现扫**：刚装的包不在任何启动快照里。 */
  user: StreamPackage[]
  /** 启用开关现值。只对填了插件槽位的包有意义——absent → 所有包都不带 enabled 字段。 */
  enabled?: (id: string) => boolean
  /** 这个包有没有可翻的开关。默认 `fillsPluginSlot`——`/api/plugins/:id/enabled` 认的正是那批，
   *  纯 recipe 包翻了也没有东西会响应。 */
  togglable?: (pkg: StreamPackage) => boolean
  /** 用户层里**读不动**的那些目录（扫描时跳过的）。它们照样出一行，见 `PackageSummary.unreadable`。 */
  unreadableUser?: { dir: string; error: Error }[]
}

/**
 * 两层合流成一份目录，按 id 排序。**用户层同 id 覆盖内置层**——装了第三方版就该看到第三方
 * 那份（与 recipe 层 user 盖 builtin 的立场一致）。
 */
export function buildPackageInventory(input: BuildPackageInventoryInput): PackageSummary[] {
  const byId = new Map<string, PackageSummary>()
  const togglable = input.togglable ?? fillsPluginSlot
  const add = (pkg: StreamPackage, layer: PackageLayer) => {
    const s = summarizePackage(pkg, layer)
    if (input.enabled && togglable(pkg)) s.enabled = input.enabled(pkg.id)
    byId.set(pkg.id, s)
  }
  for (const p of input.builtin) add(p, 'builtin')
  for (const p of input.user) add(p, 'user')
  // 读不动的包**盖不掉**同 id 的好包（它连 id 都是从目录名猜的），所以只在没人占那一格时补进去。
  for (const u of input.unreadableUser ?? []) {
    const id = basename(u.dir)
    if (byId.has(id)) continue
    byId.set(id, { id, name: id, layer: 'user', slots: {}, hosted: false, unreadable: u.error.message })
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * 把能力宿主此刻的工具表填进各条目的 `slots.tools`。
 *
 * **为什么是一步 merge 而不是 `summarizePackage` 里读**：`summarizePackage` 只认包目录，
 * 而工具名要 import + mount 之后才存在，且用户可以在运行期装卸——写进那一层就等于把
 * 「boot 那一刻有哪些工具」冻住（AGENTS.md「装配期取的值 = 冻住的答案」）。
 *
 * 入参按**包 id**索引（宿主自己按能力名分组，接线处负责换算）。**声明了能力槽位却不在这份
 * 表里 → `tools: []`**：那说的是"装载没成/没注册工具"，是一句真话；缺这一格才是"没数据"，
 * 两者在界面上是两句不同的话。
 */
export function mergeCapabilityTools(list: PackageSummary[], toolsByPackage: Record<string, string[]>): PackageSummary[] {
  return list.map((p) => {
    if (!p.slots.capability) return p
    return { ...p, slots: { ...p.slots, tools: [...(toolsByPackage[p.id] ?? [])] } }
  })
}

/** 把 `pluginStatus()` 的说法填进各条目的 runtime 骨架。没有骨架的包原样返回。 */
export function mergePackageRuntime(list: PackageSummary[], statusRows: PluginStatus[]): PackageSummary[] {
  const byId = new Map(statusRows.map((r) => [r.id, r]))
  return list.map((p) => {
    if (!p.runtime) return p
    const status = byId.get(p.id)
    const lastUsed = status?.standby?.lastUsed
    return {
      ...p,
      runtime: {
        ...p.runtime,
        state: runtimeStateOf(status),
        ...(typeof lastUsed === 'number' ? { lastUsed } : {}),
      },
    }
  })
}
