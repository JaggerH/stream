// `counts` = `plan` 的投影。分出来单独一个文件，是为了它能被直接测到每一类动作
// （在 service 里当私有方法时，要凑齐六类动作得先把整条管线跑出那六类来）。
import { PURE_CUT_DIR, type PlanAction } from './plan.ts'

/** 货架路径。`moveClaimed`/`moveSecondary` 是仅有的两个 `plan` 单独推不出的数——
 *  要知道两个货架各在哪，才分得开一条 move 搬去了哪一侧。 */
export interface CountsShelves {
  claimed: string
  secondary?: string
}

export type Counts = {
  move: number
  /**
   * 本轮**会改几次名**。与 `move` 分开：改名不挪窝，混进去会让"搬了几份"把原地没动过窝的也算上。
   *
   * 三种动作都数：原地的 `rename`，以及带 `newName` 的 `move` / `replace`——后两种在
   * `executePlan` 里先在源目录 `tryRename` 一次再搬，那一次改名与原地改名在盘上没有任何区别。
   * 只数第一种的话，预览说「改名 0 份」而执行完回来说「改名 44 份」，**而用户是照预览那个数
   * 点的确认**。带 `newName` 的搬运仍只算一份 `move`（它确实只搬了一份）。
   */
  rename: number
  deleteDup: number
  /** 同集择优判删的落选副本数（`delete-loser`）——与字节全等的 `deleteDup` 分开报：
   *  前者是"质量比出来的"，删之前必须过一次人眼确认（spec §5）。
   *  **`paid` 集的字节全等副本也记在这里**：它按 `verdict: 'dup'` 入账（它确实是字节全等），
   *  但动作被降级成确认档，所以按动作计数落在 `deleteLoser` 而不是 `deleteDup`——
   *  这两个数分别回答"删了几份"和"其中几份不用人点头"，降级后它确实需要人点头。 */
  deleteLoser: number
  /** 换正主（`replace`：删旧的 + 新的上位）。与 `deleteLoser` 同属确认档，定时轮不执行。 */
  replace: number
  /** 免费集副本判删（`delete-redundant`：那一集源站自己放得出，网盘这份是冗余）。
   *  **不进确认档**，定时轮照删——所以它必须单独有个数：混进 `deleteDup` 就说不清
   *  "这一轮删掉的哪些是同一份文件、哪些是源站已经能播的整集"。 */
  deleteRedundant: number
  pending: number
  moveClaimed: number
  moveSecondary: number
  /**
   * 搬进纯享货架（`<认领货架>/纯享/S<nn>`）的份数。**必须从 `moveClaimed` 里分出来**：
   * 那个目录住在认领货架里面，但装的不是剧集——混在一起，"这一轮给剧集归了几集"就多报，
   * 而那个数正是用户点确认时看的。三格仍然互斥，加起来等于 `move`。
   */
  movePureCut: number
}

/** 动作类型 → 计数字段。**键集由 `PlanAction['kind']` 派生**：少一类编译期就报错（TS2741），
 *  这才是这次改动的正主。原先那串 if/else 的末尾是 `else counts.pending++`——加一类动作时
 *  没有任何东西会喊，而且新动作不是漏数，是被塞进"等你拍板"那一格。真事故（2026-08-02）：
 *  弹窗写「删除 0 条重复、0 条同集落选副本」，那一轮实际删了 4 个 `delete-redundant`。 */
const BUCKET: Record<PlanAction['kind'], keyof Counts> = {
  move: 'move',
  rename: 'rename',
  'delete-dup': 'deleteDup',
  'delete-loser': 'deleteLoser',
  'delete-redundant': 'deleteRedundant',
  replace: 'replace',
  pending: 'pending',
}

/**
 * 从 `plan` 现算这一轮的汇总数字。
 *
 * **每一格恒有值（缺省 0）**：老实现里"这一格没出现"和"真的是 0"分不开，读的人只能猜。
 */
export function countsOf(plan: PlanAction[], shelves: CountsShelves): Counts {
  const counts: Counts = {
    move: 0, rename: 0, deleteDup: 0, deleteLoser: 0, replace: 0, deleteRedundant: 0, pending: 0,
    moveClaimed: 0, moveSecondary: 0, movePureCut: 0,
  }
  const pureCutRoot = `${shelves.claimed.replace(/\/$/, '')}/${PURE_CUT_DIR}`
  for (const a of plan) {
    const bucket = BUCKET[a.kind]
    // 运行期兜底：响应里冒出一个本版本不认识的 kind（跨版本读旧账本）时**丢掉**，
    // 绝不倒进 pending——把一个会删文件的动作数成"等你拍板"，报告就在骗人。
    if (!bucket) continue
    counts[bucket]++
    // 搬/换正主顺带改的那次名（见 `Counts.rename` 头注）——它落在自己那一格之外，额外记一笔。
    if ((a.kind === 'move' || a.kind === 'replace') && a.newName) counts.rename++
    if (a.kind !== 'move') continue
    // 纯享货架先判：它是认领货架的**子目录**，顺序反了就全被算成 moveClaimed。
    if (a.dstDir === pureCutRoot || a.dstDir.startsWith(`${pureCutRoot}/`)) counts.movePureCut++
    else if (shelves.secondary && a.dstDir === shelves.secondary) counts.moveSecondary++
    else if (a.dstDir === shelves.claimed || a.dstDir.startsWith(`${shelves.claimed}/`)) counts.moveClaimed++
  }
  return counts
}
