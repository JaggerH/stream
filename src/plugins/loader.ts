import { packageNamespace, scanPackages, type StreamPackage } from '../packages/scan.ts'
import type { PluginDescriptor } from './types.ts'
import { validatePluginGrouping } from './grouping.ts'
import { namespacedSourceId } from '../registry/source-id.ts'

/**
 * 一个包 → 它的插件描述（**发给前端的目录形状**：没有、也不该有 `code` 槽位）。
 * 单独导出是给已经扫过一次的调用方（bootstrap 要包的原形去 activate，同一份 scan 结果
 * 直接 map 出描述即可）——否则同一个目录的 51 份 manifest 会被 zod 解析两遍。
 */
export function toPluginDescriptor(pkg: StreamPackage): PluginDescriptor {
  const plugin: PluginDescriptor = {
    id: pkg.id,
    name: pkg.name,
    required: pkg.required,
    tagline: pkg.tagline,
    description: pkg.description,
    homepage: pkg.homepage,
    repository: pkg.repository,
    docsUrl: pkg.docsUrl,
    backend: pkg.backend,
    sourceGrouping: pkg.sourceGrouping,
    credentials: pkg.credentials,
    capability: pkg.capability,
    normalizer: pkg.normalizer,
    // `manifests.yaml` 里写的是**局部名**，全名（`<npm 包名>/<局部名>`）在这里合成——
    // 这是插件包 curated 清单进 registry 的唯一一条路，所以前缀加在这里，`sealManifests`
    // 与 `new Registry(...)` 都在它之后。**这一格才是雷区本体**：那 59 个 curated id 个个是
    // 朴素名字（`fetch-url`、`quark-save`…），只给 recipe 加命名空间解决不了问题。
    sources: pkg.sources?.map((src) => ({
      ...src,
      id: namespacedSourceId(packageNamespace(pkg), src.id),
      pluginId: pkg.id,
    })),
  }
  for (const k of Object.keys(plugin) as (keyof PluginDescriptor)[]) {
    if (plugin[k] === undefined) delete plugin[k]
  }
  validatePluginGrouping(plugin)
  return plugin
}

/** `fillsPluginSlot` 只看这几格——单独命名是给不持有完整 `StreamPackage` 的调用方
 *  （安装期只有一份 `StreamDescriptor`）。加一格 = 同时改这里和 fillsPluginSlot 的实现。 */
export type PluginSlotFields = Pick<
  StreamPackage,
  'backend' | 'code' | 'normalizer' | 'sources' | 'sourceGrouping' | 'credentials' | 'capability'
>

/**
 * 这个包填没填**插件槽位**——即它有没有东西要经插件那条投影出去。
 *
 * 内置包目录并轨后（`packages/` 一层住着插件包和 recipe 包），"是不是插件"不能再靠目录判，
 * 只能靠槽位：容器（`backend`）、代码（`code`）、presenter（`normalizer`）、它自带的
 * Source 清单（`sources`，来自 `manifests.yaml` 或内联）、分组解析器（`sourceGrouping`）、
 * 凭证申报（`credentials`）、能力（`capability`）。纯 recipe 包一格都不填 —— 它对外的东西是 `*.recipe.json`
 * （走 recipe 那条投影），登录态那格它填的是 `cookieDomain`，不是 `credentials`。
 *
 * 名单**宁可宽**：漏掉一个包 = 它的容器不被接管、`/_p/<id>` 恒 404、凭证 token 不铸——
 * 这类缺失没有任何日志会提到（这条线上同一种缺陷已经犯过四次）。往 `StreamDescriptor`
 * 加一个"要宿主替它做点什么"的新槽位时，这里也要加一行。
 *
 * 一个包**两条槽位都填**是合法的（归一后的模型允许"带容器的 recipe 包"），它会同时出现在
 * 两个投影里——这正是按槽位判而不是按目录判的意义。
 *
 * 这条判据还有第二个消费者：安装期的 **id 撞名闸门**（`occupiedByBuiltins`）。id 是不是全局
 * 独占，取决于这个包有没有东西挂在按 id 索引的宿主设施上——那正好就是这几格。纯 recipe 包
 * 一格都不填，它的 id 撞上内置是**受支持的覆盖**（user 层按 facility / sourceId 盖 builtin 层），
 * 不是冲突。所以往这里加一行，也就是往"这个 id 不许第三方再用"里加一类包，两处一起动。
 */
export function fillsPluginSlot(pkg: PluginSlotFields): boolean {
  return !!(
    pkg.backend ||
    pkg.code ||
    pkg.normalizer ||
    pkg.sources ||
    pkg.sourceGrouping ||
    pkg.credentials ||
    // 能力（`stream.capability`）：宿主要动态 import 它、mount 它、把它的工具挂进 /api/mcp——
    // 正是"要宿主替它做点什么"，所以计入。
    pkg.capability
  )
}

/**
 * 装载一个目录下的全部 Stream 包，投影成插件描述。
 * 包的形状与解析归 `src/packages/`（descriptor.ts / scan.ts）——插件与 recipe 包共用那一份。
 * 这里只做插件侧的投影：挑出填了插件槽位的、给 sources 盖 pluginId、校验 grouping。
 */
export function loadPlugins(dir: string): PluginDescriptor[] {
  return scanPackages(dir).filter(fillsPluginSlot).map(toPluginDescriptor)
}
