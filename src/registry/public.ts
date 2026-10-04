/**
 * Public — SourceManifest 的唯一对外 pick。作用只有一个:挡住内部字段
 * (route / fixed_params / matchers / provides / priority / 原始 params_schema 形状)不出网。
 * 展示字段(pluginId/pluginName/title)由 seal.ts 在装载时填好,这里零推导。
 * 任何 HTTP/MCP 端点要吐 Source 展示字段,只能经过这里 — 禁止自己拼。
 */
import type { Capability, Facility, RuntimeConfigSpec, SourceManifest } from '../manifest/types.ts'
import type { SourceSiteView } from '../../shared/item/actions.ts'

/**
 * 「这条源是哪个站」——由认领它的包说（`stream.homepage` 的主机 + 包名，见
 * `src/packages/item-projection.ts` 的 `siteOf`）。前端拿它画图标、写站名，不再按 id 前缀猜站。
 * 由 sources 域挂进来，**每次现取**（热装的包立刻生效）；没挂 / 没有包认领 → 不带这一格，
 * 前端退回按 RSSHub 命名空间查它自己那张生成的目录表。
 */
type SiteLookup = (entry: { id: string; facility?: Facility }) => SourceSiteView | undefined
let siteSource: (() => SiteLookup) | null = null
export function setSourceSiteSource(source: (() => SiteLookup) | null): void {
  siteSource = source
}

export interface SourceSummary {
  id: string
  pluginId: string
  pluginName: string
  adapterId?: string
  title: string
  description?: string
  categories: string[]
  facility?: Facility
  site?: SourceSiteView
  capabilities: Capability[]
  auth: string
  badges?: string[]
  paramCount: number
  requiredParamCount: number
}

export interface SourceDetail extends SourceSummary {
  paramsSchema: Record<string, unknown>
  runtimeConfig?: RuntimeConfigSpec
  docs?: {
    markdown?: string
    url?: string
  }
  examples?: Array<{ title?: string; params: Record<string, string> }>
  credentials?: Array<{ domain: string; required: boolean; reason?: string }>
}

function requiredParamCount(schema: Record<string, unknown>): number {
  return Object.values(schema).filter((spec) => Boolean((spec as { required?: boolean }).required)).length
}

function sourceDocsUrl(m: SourceManifest): string | undefined {
  if (!m.id.startsWith('rsshub:')) return undefined
  const ns = m.id.slice('rsshub:'.length).split('/')[0]
  return ns ? `https://docs.rsshub.app/routes/${ns}` : 'https://docs.rsshub.app/routes/'
}

export function publicSource(m: SourceManifest): SourceSummary {
  const badges = [
    m.nsfw ? 'nsfw' : undefined,
    m.requireConfig ? 'needs_config' : undefined,
  ].filter(Boolean) as string[]
  const site = siteSource?.()({ id: m.id, facility: m.facility })
  return {
    ...(site ? { site } : {}),
    id: m.id,
    pluginId: m.pluginId ?? 'custom',
    pluginName: m.pluginName ?? m.pluginId ?? 'custom',
    adapterId: m.adapter,
    title: m.title ?? m.id,
    description: m.description,
    categories: m.categories ?? [],
    facility: m.facility,
    capabilities: m.capabilities,
    auth: m.auth.type,
    badges,
    paramCount: Object.keys(m.params_schema).length,
    requiredParamCount: requiredParamCount(m.params_schema),
  }
}

/** registry 查不到的 source id(孤儿成员)兜底成一个最小 SourceSummary。
 *  与 publicSource 同源,供每个"手里只有 id、拿不到 manifest"的边界共用。 */
export function fallbackSource(id: string): SourceSummary {
  return {
    id, pluginId: 'custom', pluginName: 'custom', title: id,
    categories: [], capabilities: [], auth: 'none', paramCount: 0, requiredParamCount: 0,
  }
}

export function publicSourceDetail(m: SourceManifest): SourceDetail {
  const detail: SourceDetail = {
    ...publicSource(m),
    paramsSchema: m.params_schema,
    runtimeConfig: m.runtime_config,
  }
  const markdown = m.docsMarkdown?.trim() || m.notes?.trim()
  const url = sourceDocsUrl(m)
  if (markdown || url) detail.docs = { markdown, url }
  if (m.example_queries[0]) detail.examples = [{ title: m.example_queries[0], params: {} }]
  if (m.auth.type === 'cookie') detail.credentials = [{ domain: m.auth.domain, required: true, reason: 'cookie auth' }]
  return detail
}
