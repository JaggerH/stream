/**
 * 条目投影：包的 `stream.item` 声明 + 源目录 → 出线条目上的 `author_enrich` / `actions` /
 * `source_label` / `source_site`（spec 2026-09-26-host-package-boundary-design §4）。
 *
 * **投影时现算，不在 normalize 时写进 content**：content 是入库时定格的，写进去就要对存量跑
 * renormalize，而 renormalize 对某些源会用旧 raw 抹掉派生值。现算 = 存量立刻生效、包升级也立刻生效。
 *
 * 唯一的调用点是出线口 `toClientItem`（`src/http/client-item.ts`）——四条 item 读口全经它。
 * 这里是纯函数：包列表与「源 id → 源目录那条」的查法由调用方现取递进来，不持有任何状态。
 */
import type { ItemDeclaration } from './descriptor.ts'
import { ITEM_PLACEHOLDER_RE } from './descriptor.ts'
import type { AuthorEnrichView, ItemActionView, SourceSiteView } from '../../shared/item/actions.ts'

/** 投影要看的那几格包描述（`RecipePackage` 的子集）。 */
export interface ItemOwnerPackage {
  facility: string
  label?: string
  homepage?: string
  rsshubNamespaces?: string[]
  item?: ItemDeclaration
}

/** 源目录里的一条（`SourceManifest` 的子集）。 */
export interface ItemSourceEntry {
  id: string
  title?: string
  facility?: { key: string; label?: string }
}

export interface ItemProjectionSource {
  packages: readonly ItemOwnerPackage[]
  /** 源 id（任何存量形状：全名 / 裸名 / `plugin:` 前缀）→ 源目录那条；查不到回 undefined，**不抛**。 */
  lookup: (sourceId: string) => ItemSourceEntry | undefined
}

/** 投影能看的条目字段。 */
export interface ProjectableItem {
  source_id?: string
  author?: string
  author_avatar?: string
}

export interface ItemProjection {
  author_enrich?: AuthorEnrichView
  actions?: ItemActionView[]
  source_label?: string
  source_site?: SourceSiteView
}

/**
 * 这条源归哪个包。两条路，都不看站名：
 *  - RSSHub 目录路由（`rsshub:<ns>/…`）→ 在 `rsshubNamespaces` 里认领了 `<ns>` 的包；
 *  - 其余 → 源目录那条的 `facility.key` 等于包 facility 的那个包（包的源、recipe 派生的源都带它）。
 * 按 facility 而不是按 npm 名判：同一 facility 两层包（内置 + 第三方附加包）的声明本来就按 facility
 * 归并（`mergeRecipePackagesByFacility`），归属判据跟着同一把尺。
 */
export function ownerPackageOf(entry: ItemSourceEntry, pkgs: readonly ItemOwnerPackage[]): ItemOwnerPackage | undefined {
  if (entry.id.startsWith('rsshub:')) {
    const ns = entry.id.slice('rsshub:'.length).split('/')[0]
    const claimer = pkgs.find((p) => p.rsshubNamespaces?.includes(ns))
    if (claimer) return claimer
  }
  const key = entry.facility?.key
  return key ? pkgs.find((p) => p.facility === key) : undefined
}

/** 顺着点路径从对象上取一个值；只认非空字符串与有限数字（数字转串）。 */
function valueAt(obj: unknown, path: string): string | undefined {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  if (typeof cur === 'string') return cur || undefined
  if (typeof cur === 'number' && Number.isFinite(cur)) return String(cur)
  return undefined
}

/** 把参数里的 `{点路径}` 换成条目上的值。**任何一个取不到 → null**：参数残缺的按钮不画。 */
export function fillPlaceholders(params: Record<string, string>, item: object): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const [k, tpl] of Object.entries(params)) {
    let missing = false
    const v = tpl.replace(ITEM_PLACEHOLDER_RE, (_, path: string) => {
      const got = valueAt(item, path)
      if (got === undefined) missing = true
      return got ?? ''
    })
    if (missing) return null
    out[k] = v
  }
  return out
}

/** 包的站点：名字 = 包名，域名 = `homepage` 的主机（去掉 `www.`）。没写 homepage 就没有。 */
export function siteOf(pkg: ItemOwnerPackage): SourceSiteView | undefined {
  if (!pkg.homepage) return undefined
  let host: string
  try { host = new URL(pkg.homepage).hostname } catch { return undefined }
  return { name: pkg.label ?? pkg.facility, domain: host.replace(/^www\./, '') }
}

/** 「这条源的站点是什么」的查法（源目录 `publicSource` 的 `site` 格用），包列表现取后闭包进来。 */
export function sourceSitesOf(pkgs: readonly ItemOwnerPackage[]): (entry: ItemSourceEntry) => SourceSiteView | undefined {
  return (entry) => {
    const owner = ownerPackageOf(entry, pkgs)
    return owner ? siteOf(owner) : undefined
  }
}

/** 源在条目上给人看的名字：源目录的标题，前面带上站名（标题里已有站名就不重复）。 */
export function sourceLabelOf(entry: ItemSourceEntry): string | undefined {
  const title = entry.title && entry.title !== entry.id ? entry.title : undefined
  const site = entry.facility?.label
  if (title && site && !title.includes(site)) return `${site} · ${title}`
  return title ?? site
}

export function projectItem<T extends ProjectableItem>(item: T, src: ItemProjectionSource): T & ItemProjection {
  if (!item.source_id) return item
  const entry = src.lookup(item.source_id)
  if (!entry) return item
  const out: T & ItemProjection = { ...item }
  const label = sourceLabelOf(entry)
  if (label) out.source_label = label
  const owner = ownerPackageOf(entry, src.packages)
  if (!owner) return out
  const site = siteOf(owner)
  if (site) out.source_site = site
  const decl = owner.item
  if (decl?.authorEnrich && !item.author_avatar && item.author) {
    const params = fillPlaceholders(decl.authorEnrich.params, item)
    if (params) out.author_enrich = { source: decl.authorEnrich.enricher, params }
  }
  const actions = (decl?.actions ?? []).flatMap((a): ItemActionView[] => {
    const params = fillPlaceholders(a.params, item)
    return params ? [{ id: a.id, icon: a.icon, label: a.label, recipe: a.recipe, params, toggle: [a.toggle[0], a.toggle[1]] }] : []
  })
  if (actions.length) out.actions = actions
  return out
}
