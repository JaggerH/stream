import { localNameOf } from '../registry/source-id.ts'
import type { SearchSourceDeclaration } from '../packages/descriptor.ts'


/** How a search source's raw items are extracted + displayed. Stable, code-level
 *  metadata (not user data): bindings decide WHICH sources search, this decides HOW.
 *  `digest` = 一条是一篇「片名 + 一串网盘链接」的合集体（带频道名，进发现池）；`flat` = 一行一个种子。 */
export type SearchKind = 'digest' | 'flat'

export interface SearchSourceMeta {
  /** manifest id the flow points at */
  source_id: string
  /** stable display slug — tags Release.source; the UI maps it to label + badge */
  key: string
  label: string
  /** the source's primary query param name (keyword/query/name) */
  param: string
  kind: SearchKind
  nsfw: boolean
  /** the source's own search page for click-through badges; omit if none */
  searchUrl?: (q: string) => string
  /**
   * **这里不放墙钟上限。** 「一个源封顶多久」只有一个真相源：manifest 的
   * `member_timeout_ms`（源自己申报，recipe 写在 `meta.member_timeout_ms`）。这张表以前也有
   * 一列 `timeoutMs`，于是同一个源在批量/MCP 路（executor → `member-pipeline`，读 manifest）
   * 和流式路（`search-fanout.ts` 的 `searchOneGroup`，读这里）拿到两个不同的答案——**两边
   * 单看都对，只在某一条路上静默被砍**。要给一个源放宽上限就改它的 manifest/recipe，别在这里加列。
   */
}

const enc = encodeURIComponent

/** Look up search metadata by the flow's source_id.
 *
 *  **整张表都来自包的声明**（`package.json#stream.searchSources`，装配层以 thunk 挂进来）——宿主
 *  不认识任何资源站；RSSHub 目录路由的那几条由 `packages/rsshub` 声明。内容搜索源不在这里登记：
 *  content 档的成员由 `content-search` 行按 `provides: [search-content]` 自动收，那条路不读这张表。
 *
 *  声明里的源是**全名**（宿主自己的代码不吃裸名——第三方装一个 `pansou-search` 就能把它推进
 *  歧义分支）。但库里那些在命名空间化之前落地的 Flow 行存的仍是裸名，所以精确没中时再按
 *  **局部名**对一次：查不中的后果是标签退化成裸键，静默且只在界面上看得出来。
 *
 *  局部名那一档**只对不含 `:` 的 id 生效**：catalog 路由（`rsshub:nyaa/search/:query?`）的最后
 *  一段是路由参数，`rsshub:nyaa/search/:query?` 和 `rsshub:nyaa/sukebei/search/:query?` 的
 *  「局部名」一模一样，按它对会张冠李戴。 */
export function searchMetaBySourceId(sourceId: string): SearchSourceMeta | undefined {
  const table = packageSearchMeta()
  const exact = table.find((m) => m.source_id === sourceId)
  if (exact) return exact
  if (sourceId.includes(':')) return undefined
  const local = localNameOf(sourceId)
  return table.find((m) => !m.source_id.includes(':') && localNameOf(m.source_id) === local)
}

let packageSearchSource: () => SearchSourceDeclaration[] = () => []

/**
 * 装配层把「所有包的 `searchSources` 声明」以 thunk 挂进来（`src/kernel/plugins/sources.ts`）。
 * **每次查都现取**（同链接认领表 / serving）：热装的包下一次搜索就认得。
 */
export function setPackageSearchSources(source: () => SearchSourceDeclaration[]): void {
  packageSearchSource = source
}

/** 声明 → 表行。`source`（装载期已是全名）或 `provider`（行 id）就是 source_id——组合体成员在
 *  扇出里的寻址键就是行 id（`executor.resolvedMembers` 的 kind:'provider'）。 */
function packageSearchMeta(): SearchSourceMeta[] {
  return packageSearchSource().map((d) => {
    const tpl = d.searchUrl
    return {
      source_id: (d.source ?? d.provider)!,
      key: d.key,
      label: d.label,
      param: d.param,
      kind: d.kind,
      nsfw: d.nsfw ?? false,
      ...(tpl ? { searchUrl: (q: string) => tpl.split('{q}').join(enc(q)) } : {}),
    }
  })
}

/** Look up search metadata by a Provider member's **寻址键**（`name ?? sourceId`,即 executor
 *  的 miss.member 报的那个键）——先按寻址键在 `members` 里找出真 source_id,再查 meta。成员带
 *  实例名（同源多实例进梯子）时寻址键 ≠ source_id,直接拿寻址键去查会查不中，label 会退化成
 *  裸键；成员没实例名时寻址键本就是 source_id，行为不变。找不到成员或找不到 meta 都回落
 *  `undefined`，调用点自己决定回落裸键。 */
export function searchMetaByMemberKey(
  key: string,
  members: Array<{ name: string; sourceId: string }>,
): SearchSourceMeta | undefined {
  const sourceId = members.find((m) => m.name === key)?.sourceId ?? key
  return searchMetaBySourceId(sourceId)
}

/** facetResources 的 timing 行——结构与 video/types.ts 的 VideoSourceTiming 一致，故意不 import
 *  它（search 域不用扒 video 域的类型），调用点（bootstrap.ts）赋值时结构兼容即可。 */
export interface MissTiming {
  key: string
  label: string
  ms: number
  count: number
  dropped: number
  status: 'ok' | 'empty' | 'error' | 'timeout'
}

/** miss（executor 未产出结果的成员）→ 展示用 timing 行。miss.member 是**寻址键**，得先按
 *  `providerId` 这一行**现查**出的 `resolvedMembers` 换回真 source_id 才能查中
 *  包声明的元数据（换算逻辑复用 searchMetaByMemberKey，不重复一遍）。行不由调用方预先展开、
 *  而是这里现查——保证用的是"这一次实际扇出的那一行"，槽位覆盖时它可能不是默认行，硬编码
 *  展开会用错行建出错的映射。`Row` 用泛型而非直接 import ProviderRecord：调用方传什么形状的
 *  getProvider/resolvedMembers，这里就按什么形状用，不耦合 store 层的具体类型。 */
export function missTimings<Row>(
  misses: Array<{ member: string; reason: string }>,
  providerId: string,
  deps: {
    getProvider: (id: string) => Row | null
    resolvedMembers: (row: Row) => Array<{ name: string; sourceId: string }>
  },
): MissTiming[] {
  if (!misses.length) return []
  const row = deps.getProvider(providerId)
  const members = row ? deps.resolvedMembers(row) : []
  return misses.map((miss) => {
    const meta = searchMetaByMemberKey(miss.member, members)
    const status: MissTiming['status'] =
      miss.reason === 'declined (no result)' ? 'empty' : /timed out/.test(miss.reason) ? 'timeout' : 'error'
    return { key: meta?.key ?? miss.member, label: meta?.label ?? miss.member, ms: 0, count: 0, dropped: 0, status }
  })
}

