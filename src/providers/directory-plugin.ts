import type { Context } from 'cordis'
import type { UserStore } from '../store/user-store.ts'
import { ProviderDirectory } from './directory.ts'
import type { SystemIdentity } from './system/types.ts'

declare module 'cordis' {
  interface Context {
    /** Provider 读模型的唯一入口（`src/providers/directory.ts`）。 */
    providerDirectory: ProviderDirectory
  }
}

export interface ProviderDirectoryConfig {
  store: Pick<UserStore, 'listProviders' | 'getProvider'>
  systemIdentities: ReadonlyMap<string, SystemIdentity>
}

/**
 * 把 `ProviderDirectory` 挂成 `ctx.providerDirectory`。
 *
 * 依赖（store / 身份表）经 plugin config 进来而不是模块级 import：**同一个进程里可以有第二棵树**
 * （测试就是），全局单例会让它们互相看见对方的库。
 *
 * `ctx.provide` 返回的撤销登记在本 fiber 上，所以 `fiber.dispose()` 之后 `ctx.providerDirectory`
 * 自动消失——这正是内核要的：没接线和「接了又卸了」都是可观测态，不是一个 undefined 的哑巴。
 */
export function providerDirectoryPlugin(ctx: Context, config: ProviderDirectoryConfig): void {
  ctx.provide('providerDirectory', new ProviderDirectory(config.store, config.systemIdentities))
}
