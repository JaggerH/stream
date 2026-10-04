import type { StreamPackage } from './scan.ts'
import { packageNamespace } from './scan.ts'
import { localSourceIdProblem, namespacedSourceId } from '../registry/source-id.ts'

/**
 * `ctx.readSource` 的形状（见 `PluginContext.readSource`）。**没有 `userInitiated`**：包代码不是
 * 用户当场的一次点击，动作 recipe（`meta.action:true`）经这条路照常撞 `ActionRecipeBlockedError`；
 * 用户点击触发的动作走 `POST /api/recipes/action`，不走包代码。
 */
export type PackageReadSource = (
  sourceId: string,
  params: Record<string, string>,
  opts?: { signal?: AbortSignal },
) => Promise<unknown[]>

/** 宿主那一侧真正去读源的实现（Scheduler.readSource 的形状收窄到本文件需要的那几格）。 */
export type ReadSourceImpl = (
  sourceId: string,
  params: Record<string, unknown>,
  opts?: { signal?: AbortSignal },
) => Promise<unknown[]>

type PackageIdentity = Pick<StreamPackage, 'pkgName' | 'dir'>

/**
 * 把包代码写下的 sourceId 限定到**这个包自己**的命名空间。
 *
 * 与 recipe `meta.uses` / `sourceId` 同一条规矩（`recipe-manifest.ts`）：包作者写局部名，全名由
 * 宿主用包的 npm 名（没有 npm 名的手放包用 `local/<目录名>`）合成——两处不许各写一份，漂了就是
 * 「recipe 里能引到、包代码里引不到」的静默错位。
 *
 * 带 `/` 的全名必须以本包前缀开头，否则**抛**：一个包不许借 `ctx` 去跑别人的 recipe——那等于
 * 绕开别家的 rateLimit 与账本。前缀比的是 `<ns>/`（带斜杠），`@t/alpha-x/…` 不算 `@t/alpha` 的。
 */
export function qualifyOwnSourceId(pkg: PackageIdentity, sourceId: string): string {
  const ns = packageNamespace(pkg)
  if (sourceId.includes('/')) {
    if (!sourceId.startsWith(`${ns}/`)) {
      throw new Error(
        `ctx.readSource("${sourceId}")：包 ${ns} 只能运行自己声明的源（全名须以 "${ns}/" 开头）`,
      )
    }
    return sourceId
  }
  const problem = localSourceIdProblem(sourceId)
  if (problem) throw new Error(`ctx.readSource：${problem}`)
  return namespacedSourceId(ns, sourceId)
}

/**
 * 造一个包专用的 `readSource`。`impl` 是 **thunk**：Scheduler 在装配序上晚于 packages 域，
 * 装配期根本没有那个对象；由 scheduling 域建完 Scheduler 后回填（`setPackageReadSource`），
 * 这里每次调用现取——与 `ctx.login` / `facilityLogin` 同一形状。回填之前调用就抛，不静默回空：
 * 空数组会被包读成"这条源没内容"，而真相是宿主还没接线。
 */
export function makePackageReadSource(pkg: PackageIdentity, impl: () => ReadSourceImpl | undefined): PackageReadSource {
  return async (sourceId, params, opts = {}) => {
    const fullId = qualifyOwnSourceId(pkg, sourceId)
    const fn = impl()
    if (!fn) {
      throw new Error(
        `ctx.readSource("${fullId}")：读源能力还没接线（scheduling 域没起来）——不能静默回空，` +
        `包会把空数组当成"这条源没内容"`,
      )
    }
    return fn(fullId, params, { signal: opts.signal })
  }
}
