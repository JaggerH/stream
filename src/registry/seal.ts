/**
 * Seal — 装载时把派生展示字段写死进 SourceManifest,进 Registry 前的最后一步。
 * 之后全系统读 m.pluginId / m.pluginName / m.title 均为已填,读取端零推导。
 * 边界铁律:SourceManifest 出了 src/registry/ 后是只读、已填满的。
 */
import type { SourceManifest } from '../manifest/types.ts'
import type { PluginDescriptor } from '../plugins/types.ts'
import { resolveSourceGroup } from '../plugins/grouping.ts'

/** descriptor → plugin id。就是 `package.json#stream.id`（目录名）本身：包 id 是唯一键，宿主不替
 *  任何包维护别名。保留这个函数是为了让 16 处调用点只认一个「descriptor 的 plugin id」入口——
 *  以后要是真需要归一（比如包改名），改这里一处即可。 */
export function pluginIdForDescriptor(d: PluginDescriptor): string {
  return d.id
}

/** manifest → plugin id：seal 前显式填的 pluginId 优先；否则 adapter 名就是包 id（包内 manifests
 *  的 adapter 与包目录同名）；两者都没有的是手写 custom 源。两级都用 `||`：空串等于没填
 *  （`pluginId: ''` 落到 adapter，`adapter: ''` 落到 custom），空串当 id 会让 `byPluginId` 查不到
 *  任何描述符、`pluginName` 也成空。 */
function pluginIdOf(m: SourceManifest): string {
  return m.pluginId || m.adapter || 'custom'
}

/** 展示标题:显式 title 优先;否则取 description 最后一个破折号段(曾是 mcp/tools.ts sourceTitle)。 */
function titleOf(m: SourceManifest): string {
  if (m.title) return m.title
  return (m.description || m.id).split(/\s+[—–-]\s+/).pop()?.trim() || m.description || m.id
}

/** 装载时填满 pluginId / pluginName / title / facility。纯函数、幂等、不改输入。
 *  facility 是平台归属（图标/分组的权威来源）：显式声明优先,否则由插件的 sourceGrouping
 *  resolver 推导（如 rsshub 的 namespace→{key,label}）。让读取端零推导、零 id 反猜。 */
export function sealManifests(manifests: SourceManifest[], descriptors: PluginDescriptor[]): SourceManifest[] {
  const names = new Map<string, string>()
  const byPluginId = new Map<string, PluginDescriptor>()
  for (const d of descriptors) {
    const id = pluginIdForDescriptor(d)
    if (!names.has(id)) names.set(id, d.name ?? d.id)
    if (!byPluginId.has(id)) byPluginId.set(id, d)
  }
  return manifests.map((m) => {
    // A cookie auth must self-describe its injection — the loader's zod guard covers yaml
    // manifests; this belt also catches catalog-derived/programmatic manifests before they
    // reach the registry, so a missing inject can never silently resolve to nothing.
    if (m.auth.type === 'cookie' && !(m.auth as { inject?: unknown }).inject) {
      throw new Error(`Source "${m.id}" has cookie auth without an inject (domain ${m.auth.domain})`)
    }
    const pluginId = pluginIdOf(m)
    const descriptor = byPluginId.get(pluginId)
    const facility = m.facility ?? (descriptor ? resolveSourceGroup(m, descriptor) : undefined)
    return { ...m, pluginId, pluginName: names.get(pluginId) ?? pluginId, title: titleOf(m), ...(facility ? { facility } : {}) }
  })
}
