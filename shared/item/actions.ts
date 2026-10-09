/**
 * 条目投影的出线形状——后端在 `toClientItem` 里现算附上，前端照着渲染。
 *
 * 住 `shared/`：图标词表是**宿主定的封闭词表**，后端装载期拿它拒掉不认识的图标，前端拿它挑组件。
 * 两份各写一张的话，后端放行了一个前端画不出来的图标，表现是按钮静默消失，两边单看都正常。
 *
 * 声明方是包（`package.json#stream.item`，契约见 docs/PACKAGE.md §0.5 与 "The host/package boundary" 一节）。
 */

/** 条目动作按钮能用的图标。加一个 = 两侧同时多认一个（前端 `ItemActionButtons` 的映射表由类型逼着补）。 */
export const ITEM_ACTION_ICONS = ['heart', 'bookmark'] as const
export type ItemActionIcon = (typeof ITEM_ACTION_ICONS)[number]

/**
 * 一个条目上的可点动作（已代入参数）。点一下走通用动作路由 `POST /api/recipes/action`，
 * `sourceId = recipe`，参数 = `params` 再加 `action`：未按下时发 `toggle[0]`、已按下时发 `toggle[1]`。
 */
export interface ItemActionView {
  id: string
  icon: ItemActionIcon
  label: string
  /** 动作 recipe 的**全名**（`<包名>/<局部名>`），装载期已核过属于声明它的那个包。 */
  recipe: string
  params: Record<string, string>
  toggle: [string, string]
}

/** 「作者头像 / 主页去哪取」：前端拿它调 `/api/enrich?source=<source>&<params…>`，回 `{ name?, face?, url? }`。 */
export interface AuthorEnrichView {
  source: string
  params: Record<string, string>
}

/** 条目所属源的站点：名字给人看，域名给图标服务用。 */
export interface SourceSiteView {
  name: string
  domain: string
}
