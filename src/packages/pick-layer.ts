import type { StreamPackage } from './scan.ts'
import { isStrictlyHigher } from '../../shared/package-sdk/semver.ts'

/**
 * 同一个 npm 名的包两层都在（内置 `packages/<id>` + 用户 `stream add` 装的新版）时，
 * **只装载版本高的那一层的一切**——代码 / `manifests.yaml` / recipe / 声明——另一层整体跳过并留
 * 一行日志。这里是那个决定的唯一出处；三个消费者只拿结论：
 *
 *  - `pickCodeLayer`（本文件）→ `activatePackages` 跑哪份代码；
 *  - `mountRecipePackages` / `mergeRecipePackagesByFacility`（`src/replay/recipe-package.ts`）→ 哪一层的
 *    recipe / manifests / 声明进 registry 与归并快照；
 *  - sources 域的 curated 投影（`src/kernel/plugins/sources.ts`）→ 被顶掉的内置包的 `manifests.yaml`
 *    不再从插件描述那条路进 registry。
 *
 * 为什么必须整层一起挑，而不是各条路各自"同 id 用户层覆盖"：内置包的 `manifests.yaml` 走 curated
 * 投影进 registry，用户层同一份 `manifests.yaml` 走 recipes 组进——**两条路、同一批 id**，
 * `Registry.swapGroup` 判成 `Duplicate manifest id`，用户装的那个包整包被跳过（活体 2026-09-20：
 * `stream add` 一个带 manifests.yaml 的内置包新版之后，它声明的 Provider 行从 `/api/providers` 消失）。
 * 而代码那条路早就是"只挑
 * 一层"（两层都激活 = 同一批 adapter / enricher 名申报两次，整批拒绝激活）。四条路只有一把尺才不会
 * 出现「Provider 行是新的、adapter 是旧的」这种两边单看都正常的错位。
 *
 * 尺子（`shared/package-sdk/semver.ts`）：用户层严格更高才是用户层；相等 / 更低 / 任一层版本不合法
 * → 内置。看不懂的版本号不许赢——猜赢了就是拿一个来路不明的包顶掉随宿主同版本出货的内置。
 *
 * 判据是 **npm 名**（`pkgName`），不是 `stream.id`：id 是包自己写的字符串，第三方随手写成 `xhs`
 * 就撞上内置；npm 名的唯一性由 registry 保证。两侧任一没有 npm 名（手放的本地开发包）就不算同一
 * 个包，各走各的（撞名由各条路自己的闸门拒）。
 */
export interface LayerPick {
  /** 内置层里被用户层同名新版顶掉的包（npm 名）——整包跳过。 */
  skipBuiltinNames: ReadonlySet<string>
  /** 用户层里输给内置同名包的包（npm 名）——整包跳过。 */
  skipUserNames: ReadonlySet<string>
}

export type LayerCandidate = Pick<StreamPackage, 'pkgName' | 'pkgVersion'>

/**
 * 两层扫描结果 → 每个同名对该跳哪一层。**日志由传 `log` 的那一个调用方出**：启动时 packages 域算一遍
 * 并报每一对；sources 域启动时拿的是同一份结论（`PackagesService.layerPick`）不再报；热重载时
 * sources 域现算一份认新出现的对，把启动已知的对放进 `quietNames`，只报新的。
 */
export function pickLayers(
  builtin: readonly LayerCandidate[],
  user: readonly LayerCandidate[],
  log?: (msg: string) => void,
  quietNames: ReadonlySet<string> = new Set(),
): LayerPick {
  const builtinByName = new Map<string, LayerCandidate>()
  for (const p of builtin) if (p.pkgName) builtinByName.set(p.pkgName, p)

  const skipBuiltinNames = new Set<string>()
  const skipUserNames = new Set<string>()
  for (const u of user) {
    const b = u.pkgName ? builtinByName.get(u.pkgName) : undefined
    if (!b) continue
    const bv = b.pkgVersion ?? '(none)'
    const uv = u.pkgVersion ?? '(none)'
    const say = quietNames.has(u.pkgName!) ? undefined : log
    if (isStrictlyHigher(u.pkgVersion, b.pkgVersion)) {
      skipBuiltinNames.add(u.pkgName!)
      say?.(`[stream] package ${u.pkgName}: user layer ${uv} supersedes builtin ${bv}`)
    } else {
      skipUserNames.add(u.pkgName!)
      say?.(`[stream] package ${u.pkgName}: builtin ${bv} kept, user layer ${uv} skipped`)
    }
  }
  return { skipBuiltinNames, skipUserNames }
}

/** 按 `pickLayers` 的结论把两层过一遍：被跳过的整包剔除。 */
export function applyLayerPick<T extends LayerCandidate>(pick: LayerPick, builtin: T[], user: T[]): { builtin: T[]; user: T[] } {
  return {
    builtin: builtin.filter((p) => !(p.pkgName && pick.skipBuiltinNames.has(p.pkgName))),
    user: user.filter((p) => !(p.pkgName && pick.skipUserNames.has(p.pkgName))),
  }
}

export interface PickedCodeLayers {
  /** `pickLayers` 的结论——sources 域的 curated 投影也吃它（`PackagesService.layerPick`）。 */
  pick: LayerPick
  /** 这一轮要激活的内置层（同名被用户层顶掉的已剔除）。 */
  builtin: StreamPackage[]
  /** 这一轮要激活的用户层带 code 包（同名被内置留住的已剔除；不带 code 的对装载器来说不存在）。 */
  user: StreamPackage[]
}

/**
 * 代码那条路的消费者：两层全部包进来（不只带 code 的——判「谁高」看的是整个包，一个纯 recipe 的
 * 内置 9.0.0 也能把用户装的带 code 的 1.0.0 整包压掉），出去的用户层只剩带 code 的。
 */
export function pickCodeLayer(
  builtin: StreamPackage[],
  user: StreamPackage[],
  log: (msg: string) => void,
): PickedCodeLayers {
  const pick = pickLayers(builtin, user, log)
  const kept = applyLayerPick(pick, builtin, user)
  return { pick, builtin: kept.builtin, user: kept.user.filter((p) => p.code) }
}
