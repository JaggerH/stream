import { describe, it, expect } from 'vitest'
import { countsOf } from './counts.ts'
import type { PlanAction } from './plan.ts'

/**
 * `counts` 是 `plan` 的**投影**：同一件事的两种说法，而 `plan` 天生完备。
 *
 * 它原先是一串 if/else，末尾 `else counts.pending++`——**加一类动作时没有任何东西会喊**，
 * 而且新动作不是漏数，是被塞进"等你拍板"那一格：报告会说"N 条等你决定"，其实那 N 条要删文件。
 * 同款缺口在前端已经修过（`EXEC_ACTIONS` 的键集从动作类型派生）；这里是后端那一半。
 *
 * 真事故（2026-08-02）：执行确认弹窗写「删除 0 条重复、0 条同集落选副本」，那一轮**实际删了
 * 4 个文件**（`delete-redundant`，当时刚加的一类）。
 *
 * **编译期那道闸才是真护栏**（`countsOf` 里的 `never` 检查）：加一类动作不更新这里 → 类型报错。
 * 下面这些用例守的是运行期那一半——每一类各进各的格子，别串味。
 */

const f = (path: string, size = 100) => ({ path, name: path.slice(path.lastIndexOf('/') + 1), size })
const SHELVES = { claimed: '/lib/付费', secondary: '/lib/下架' }

/** 每类动作各一条。加了新类型而没在这里补一行，`countsOf` 的 never 检查会先在编译期拦住。 */
const ONE_OF_EACH: PlanAction[] = [
  { kind: 'move', src: f('/src/a.mp3'), dstDir: '/lib/付费', basis: 'x' },
  { kind: 'rename', src: f('/lib/付费/S01/i.mkv'), newName: 'S01E01 - i.mkv', basis: 'x' },
  { kind: 'move', src: f('/src/b.mp3'), dstDir: '/lib/下架', basis: 'x' },
  { kind: 'delete-dup', src: f('/src/c.mp3'), dupOf: '/lib/付费/c.mp3', basis: 'x' },
  { kind: 'delete-loser', src: f('/src/d.mp3'), keptPath: '/lib/付费/d.mp3', basis: 'x' },
  { kind: 'delete-redundant', src: f('/src/e.mp3'), basis: 'x' },
  { kind: 'replace', src: f('/src/g.mp3'), oldPath: '/lib/付费/g.mp3', dstDir: '/lib/付费', basis: 'x' },
  { kind: 'pending', src: f('/src/h.mp3'), pendingKind: 'replace', reason: 'x' },
] as PlanAction[]

describe('countsOf', () => {
  it('每一类各进各的格子', () => {
    expect(countsOf(ONE_OF_EACH, SHELVES)).toEqual({
      move: 2, rename: 1, deleteDup: 1, deleteLoser: 1, deleteRedundant: 1, replace: 1, pending: 1,
      moveClaimed: 1, moveSecondary: 1, movePureCut: 0,
    })
  })

  // 只加编号前缀的改名是自己一格：混进 move 会让"搬了几份"这个数把原地没挪窝的也算进去。
  it('rename 单独计数', () => {
    const plan: PlanAction[] = [{ kind: 'rename', src: { path: '/lib/S01/a.mkv', name: 'a.mkv', size: 1 }, newName: 'S01E01 - a.mkv', basis: 'prefix:S01E01' }]
    expect(countsOf(plan, { claimed: '/lib' })).toMatchObject({ rename: 1, move: 0, pending: 0 })
  })

  // 带 `newName` 的 move / replace 执行时**真的会改一次名**（`executePlan` 的 `tryRename`）。
  // 不把它们算进 `rename`，预览说"改名 0 份"、执行完回来说"改名 44 份"——同一轮两个数，
  // 而用户是照预览那个数点的确认。
  it('带 newName 的 move / replace 也算进 rename（预览与执行报同一个数）', () => {
    const plan: PlanAction[] = [
      { kind: 'move', src: f('/src/a.mkv'), dstDir: '/lib/付费/S01', newName: 'S01E01 - a.mkv', basis: 'x' },
      { kind: 'move', src: f('/src/b.mkv'), dstDir: '/lib/付费/S01', basis: 'x' },
      { kind: 'replace', src: f('/src/c.mkv'), oldPath: '/lib/付费/S01/c.mkv', dstDir: '/lib/付费/S01', newName: 'S01E03 - c.mkv', basis: 'x' },
      { kind: 'rename', src: f('/lib/付费/S01/d.mkv'), newName: 'S01E04 - d.mkv', basis: 'x' },
    ] as PlanAction[]
    // move 仍是 2（改名不让它变成两份搬运），replace 仍是 1；rename 数的是"会改几次名"。
    expect(countsOf(plan, SHELVES)).toMatchObject({ move: 2, replace: 1, rename: 3 })
  })

  /**
   * 这是那次事故的形状：`delete-redundant` 曾经落进 `pending`。锁死它——
   * 一个会删文件的动作被数成"等你拍板",报告就在骗人。
   */
  it('delete-redundant 单独一格，绝不落进 pending', () => {
    const c = countsOf([{ kind: 'delete-redundant', src: f('/src/e.mp3'), basis: 'x' }] as PlanAction[], SHELVES)
    expect(c.deleteRedundant).toBe(1)
    expect(c.pending).toBe(0)
  })

  it('空计划 → 每一格都是 0，不是缺席（"缺席 vs 真是 0" 分不开正是老 counts 的二义性）', () => {
    expect(countsOf([], SHELVES)).toEqual({
      move: 0, rename: 0, deleteDup: 0, deleteLoser: 0, deleteRedundant: 0, replace: 0, pending: 0,
      moveClaimed: 0, moveSecondary: 0, movePureCut: 0,
    })
  })

  /**
   * 纯享货架（`<认领货架>/纯享/S<nn>`）住在认领货架**里面**，但它装的不是剧集——
   * 混进 `moveClaimed` 就会让"这一轮给剧集归了几集"多报，而那个数正是用户点确认的依据。
   */
  it('纯享货架的搬运单独一格，不算进 moveClaimed', () => {
    const c = countsOf([
      { kind: 'move', src: f('/src/第1期纯享版.mkv'), dstDir: '/lib/付费/纯享/S02', basis: 'pure-cut:S02' },
      { kind: 'move', src: f('/src/第1期.mkv'), dstDir: '/lib/付费/S02', basis: 'authority:k' },
    ] as PlanAction[], SHELVES)
    expect(c).toMatchObject({ move: 2, movePureCut: 1, moveClaimed: 1, moveSecondary: 0 })
  })

  /** `moveClaimed`/`moveSecondary` 是仅有的两个 plan 单独推不出的数——要知道货架路径才分得开。 */
  it('搬运按目标货架分开数；子目录算在认领货架里', () => {
    const c = countsOf([
      { kind: 'move', src: f('/src/a.mp3'), dstDir: '/lib/付费/玄关笔记', basis: 'x' },
      { kind: 'move', src: f('/src/b.mp3'), dstDir: '/lib/下架', basis: 'x' },
    ] as PlanAction[], SHELVES)
    expect(c).toMatchObject({ move: 2, moveClaimed: 1, moveSecondary: 1 })
  })

  it('没有第二货架的绑定（影视）→ moveSecondary 恒 0，不误把别处的搬运算进去', () => {
    const c = countsOf([
      { kind: 'move', src: f('/src/a.mp3'), dstDir: '/lib/付费', basis: 'x' },
    ] as PlanAction[], { claimed: '/lib/付费' })
    expect(c).toMatchObject({ moveClaimed: 1, moveSecondary: 0 })
  })
})
