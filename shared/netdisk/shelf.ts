/**
 * 文件货架：匹配/归档器眼里"文件住的地方"。**规划器只读 `traits`，不认来源类型**——想加一种
 * 来源（本地目录），实现五个动作、填这张表，规划器一行不改（spec 2026-09-03 §3.1）。
 * 表里每一格对应规划器里一条已经存在的分支，漏填是编译期缺字段，不会静默。
 */
export interface ShelfTraits {
  /** 名字比对是否区分大小写。false 的来源（Windows / macOS 默认卷）占位判据按折叠后的名字比。 */
  caseSensitive: boolean
  /** 删能不能撤（网盘回收站 / 本地挪进回收目录）。false 的来源上所有删一律降为确认档。 */
  hasTrash: boolean
  /** 列出来的是不是此刻的现状。false = 有缓存层，规划前必须 refresh（OpenList 30 分钟目录缓存）。 */
  listingIsLive: boolean
  /** 一份文件能否报"还在写"（`RFile.inProgress`）。 */
  reportsInProgress: boolean
}

export interface FileShelf {
  /** 这个货架的稳定标识（`'openlist'` / `'local'` …）。**决定账本的键带着它**：两个货架上同一个
   *  相对路径不是同一份文件，不分家就会互相顶掉对方的钉子。改一个已上线货架的 id = 它的存量决定
   *  整批掉钉（`fileKeyOf` 拼的键对不上了）。 */
  readonly id: string
  readonly traits: ShelfTraits
  /** `includeDirs`：把目录条目也收进结果（默认关，与 `OpenListClient.listDirRecursive` 同语义）。 */
  listDirRecursive: (path: string, maxDepth?: number, refresh?: boolean, includeDirs?: boolean) => Promise<{ name: string; size: number; isDir: boolean }[]>
  mkdir: (path: string) => Promise<void>
  move: (srcDir: string, dstDir: string, names: string[]) => Promise<void>
  remove: (dir: string, names: string[]) => Promise<void>
  /** 同目录改名（`newName` 只是文件名，不含目录）。归档器只用它加 `SxxExx - ` 编号前缀，绝不写标题。 */
  rename: (path: string, newName: string) => Promise<void>
  /** 路径 → 可直接 GET 的直链。时长探测用（可缺省：没有就跳过探测）。 */
  rawUrl?: (path: string) => Promise<string>
}

/** OpenList（夸克挂载）那份自述。**冻住**：它是一份共享的单例常量，谁就地改一格（测试里想换
 *  `hasTrash` 最容易这么干）就把所有拿着它的货架一起改了。要变体就 `{ ...OPENLIST_TRAITS, x }`。 */
export const OPENLIST_TRAITS: Readonly<ShelfTraits> = Object.freeze({ caseSensitive: true, hasTrash: true, listingIsLive: false, reportsInProgress: false })
