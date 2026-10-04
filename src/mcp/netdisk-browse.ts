/**
 * 「让 AI 看见网盘」——`netdisk_browse` 工具的形状层（spec 2026-08-25-reconcile-as-conversation §4.1）。
 *
 * 在这之前 agent 手里的网盘工具面只有绑定/残差/规则/整理三件套，**没有一个能列目录**：
 * 它连 `/quark/来自：分享/播客付费节目合集` 底下有什么都看不见，于是"用户口喷一句、AI 自己去
 * 网盘里挑那个文件夹"根本不成立。
 *
 * **不设深度上限、条数上限取 5000**（用户 2026-08-25 拍板）：这是给 AI 挑目录用的，挑之前
 * 不知道要挖多深，限制只会让"看不见"换个形式回来。
 *
 * **但真正的约束不在 AList 那一端，在上下文**：5000 条 `{name,size,isDir}` 是几十万字符，
 * 一次就能吃掉对话上下文一大块。所以目录一大就**先给形状再给清单**（多少文件/多少目录、
 * 扩展名分布、大小区间、一小撮样本名），让 AI 自己决定要不要往下钻。
 *
 * 这不是限流——限流是"不让你拿"，这里是**别用一个它读不完的答案回答它**。要精确清单的场合
 * （真正的配对、去重）压根不经过这条路：那些扫描跑在服务端（`ReconcileService.scanFiles`），
 * 文件名从头到尾没进过模型的上下文。
 */

/** 一条目录项（与 `AlistFile` 同形，此处不 import 以免形状层反向依赖网盘实现）。 */
export interface BrowseEntry {
  name: string
  size: number
  isDir: boolean
}

/**
 * 递归的深度闸门。**这不是产品限制，是防跑飞的保险丝**——网盘偶有环形/超深目录，
 * 没有这个数一趟递归可以永远走下去。取 32 是"真实网盘不可能到达"的量级，
 * 与 `scanFiles` 那个 `maxDepth=5`（为一次整轮扫描设的性能预算）不是一回事，别对齐。
 */
export const BROWSE_MAX_DEPTH = 32
/** 条数上限（用户拍板）。到顶要**如实报总数并标 truncated**——否则"看到 5000 条"会被读成"总共 5000 条"。 */
export const BROWSE_MAX_ENTRIES = 5000
/** 超过这个数就不给逐条清单、只给形状。200 条约 10–20 KB，还在"读得完"这一侧。 */
export const BROWSE_LIST_THRESHOLD = 200
/** 形状档附带的样本名条数——让 AI 认得出"这是什么样的一堆文件"，不是让它逐条读。 */
export const BROWSE_SAMPLE = 20

/** 目录的"形状"：不逐条列，但足够 AI 判断该不该往下钻。 */
export interface BrowseShape {
  files: number
  dirs: number
  /** 扩展名 → 条数，多到少排序；无扩展名的归到 `''`。只留前 12 种，长尾并进 `其他`。 */
  byExt: Record<string, number>
  /** 文件大小（字节）区间与合计；一个文件都没有时缺席。 */
  sizeBytes?: { min: number; max: number; total: number }
}

export interface BrowseResult {
  path: string
  recursive: boolean
  /** 这一层/这棵子树实际有多少条（**上限截断之前**的真数）。 */
  total: number
  /** 命中 `BROWSE_MAX_ENTRIES` 上限时为 true——`entries`/`shape` 都只覆盖前 5000 条。 */
  truncated?: true
  /** 少于 `BROWSE_LIST_THRESHOLD` 时给逐条清单；否则缺席，看 `shape`。 */
  entries?: BrowseEntry[]
  /** 多于阈值时给形状 + 样本名。 */
  shape?: BrowseShape
  sample?: string[]
}

const extOf = (name: string): string => {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  // 前导点的隐藏文件（`.DS_Store`）没有扩展名——`dot > 0` 而不是 `>= 0`。
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

const EXT_KEEP = 12

export function shapeOf(entries: readonly BrowseEntry[]): BrowseShape {
  const files = entries.filter((e) => !e.isDir)
  const counts = new Map<string, number>()
  for (const f of files) counts.set(extOf(f.name), (counts.get(extOf(f.name)) ?? 0) + 1)
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const byExt: Record<string, number> = {}
  for (const [ext, n] of ranked.slice(0, EXT_KEEP)) byExt[ext] = n
  const tail = ranked.slice(EXT_KEEP).reduce((sum, [, n]) => sum + n, 0)
  if (tail > 0) byExt['其他'] = tail
  const shape: BrowseShape = { files: files.length, dirs: entries.length - files.length, byExt }
  if (files.length) {
    const sizes = files.map((f) => f.size)
    shape.sizeBytes = {
      min: Math.min(...sizes),
      max: Math.max(...sizes),
      total: sizes.reduce((a, b) => a + b, 0),
    }
  }
  return shape
}

/**
 * 把一次目录列举整成给模型看的答案。
 * @param path - 列的是哪个目录（原样回给调用方，好让多轮浏览里认得出是哪一条）。
 * @param recursive - 是否递归列的（形状的含义随它变：递归时 `dirs` 是整棵子树的目录数）。
 * @param all - 列出来的全部条目（**截断之前**）。
 */
export function browseResult(path: string, recursive: boolean, all: readonly BrowseEntry[]): BrowseResult {
  const kept = all.slice(0, BROWSE_MAX_ENTRIES)
  const out: BrowseResult = { path, recursive, total: all.length }
  if (all.length > BROWSE_MAX_ENTRIES) out.truncated = true
  if (kept.length <= BROWSE_LIST_THRESHOLD) {
    out.entries = kept.map((e) => ({ name: e.name, size: e.size, isDir: e.isDir }))
    return out
  }
  out.shape = shapeOf(kept)
  // 样本取目录优先：挑目录这件事上，"底下有哪几个子文件夹"比"头 20 个文件叫什么"信息量大得多。
  const dirs = kept.filter((e) => e.isDir).slice(0, BROWSE_SAMPLE)
  const files = kept.filter((e) => !e.isDir).slice(0, BROWSE_SAMPLE - dirs.length)
  out.sample = [...dirs.map((d) => `${d.name}/`), ...files.map((f) => f.name)]
  return out
}
