import type { Context } from 'cordis'
import type { PluginDescriptor } from '../../plugins/types.ts'

declare module 'cordis' {
  interface Context {
    /** 「这台机器上所有带 backend 的包」的唯一合并名单（本文件的 `BackendDirectory`）。 */
    backendDirectory: BackendDirectory
  }
}

/**
 * 「这台机器上所有带 backend 的包」——内置那层（`packages/`）+ 用户装的第三方那层，
 * **合并一次、各处引用**。
 *
 * 为什么必须只有一份：`/_p` 网关（serve.ts）、target resolver（bootstrap）、standby 名册、
 * 「包」页的容器动作，四处各自合并过一次。漏一处的事故形状是**静默的**——容器被 provision、
 * 被 standby 管着、健康检查绿着，`/_p/<包 id>` 却恒 404，没有任何日志会提这件事
 * （同型缺陷已犯四次，见 AGENTS.md「加了一份名单」节）。合并语义住在一个具名类里之后，
 * 「谁吃了这份名单」才有一个可扫的搜索键。
 *
 * **内置排在前**：`resolvePluginTarget` / 网关的 known 判据都是 `find`（第一个胜）。万一第三方的
 * 包 id 与某个内置 service 撞上，赢的必须是内置——第三方不能顶掉一个已经存在的服务名。
 * （安装期的撞名闸门已经挡在前面，这里是顺序上的兜底。）
 *
 * 快照语义：构造时合并一次、之后不变。descriptors 本来就是启动期扫出来的一份静态名单，
 * 第三方包装/卸载要重启才进容器那两条线。
 */
export class BackendDirectory {
  readonly #all: PluginDescriptor[]

  constructor(builtin: PluginDescriptor[], thirdParty?: PluginDescriptor[]) {
    this.#all = thirdParty?.length ? [...builtin, ...thirdParty.filter((p) => p.backend)] : [...builtin]
  }

  /** 合并后的完整名单（内置在前）。四个消费点吃的都是它。 */
  all(): PluginDescriptor[] {
    return this.#all
  }
}

export interface BackendDirectoryConfig {
  /** bootstrap 已经建好的那一份实例。 */
  directory: BackendDirectory
}

/**
 * 把 `BackendDirectory` 挂成 `ctx.backendDirectory`。
 *
 * 与 `providerDirectoryPlugin`（拿原料在插件里自己 new）不同，这里**注入现成实例**：本类存在的
 * 全部意义就是「这份名单只合并一次」，插件里再合并一次等于把要消灭的东西复制一份。
 *
 * `ctx.provide` 的撤销登记在本 fiber 上，`fiber.dispose()` 之后 `ctx.backendDirectory` 自动消失。
 */
export function backendDirectoryPlugin(ctx: Context, config: BackendDirectoryConfig): void {
  ctx.provide('backendDirectory', config.directory)
}
