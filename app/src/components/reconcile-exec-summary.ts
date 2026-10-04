// 执行确认弹窗那句「将…」——**知情同意**的全部内容。用户就凭它决定按不按下去。
//
// 为什么单独一个模块、而不是在弹窗里手写几个数：那正是它坏掉的方式。原来那句写死了三个
// counts 字段（move/deleteDup/deleteLoser），后来后端加了 `delete-redundant`（免费集副本判删）,
// 没有任何东西提醒这句话该跟着改——弹窗于是写着「删除 0 条重复、0 条同集落选副本」,
// 而那一轮实际删掉 4 个文件（活体 2026-08-02）。
//
// 现在的形状让"下次再加一类"变成**编译错误**：措辞表是 `Record<ExecutedKind, …>`,键集由
// `ReconcilePlanAction['kind']` 减去 `pending` 派生。动作类型加一个而这里不给措辞 → tsc 报
// "Property 'xxx' is missing"。反证钉在 reconcile-exec-summary.test.ts 里。
//
// 编译期护栏管的是"前端已经知道这个类型"。后端比前端新的那半边（`kind` 还没进 types.ts 的
// 镜像）编译器看不见，所以运行时还有一道：认不出的 kind **不许静默漏掉**，归到「另有 N 条」
// 里说出来。少说一类 = 骗用户按下删除键，这两道都是为这一条服务的。
import type { ReconcilePlanAction } from '../lib/types.ts'
import { fmtBytes } from './reconcile-action-row.tsx'

/**
 * 执行档动作 = `pending` 之外的全部——`executePlan`（`src/netdisk/reconcile/execute.ts`）
 * 会真动网盘文件的那些。`pending` 那一档执行器只计数不动手，所以不在这句话里。
 */
export type ExecutedKind = Exclude<ReconcilePlanAction['kind'], 'pending'>

/**
 * 这句话的**前提**：它说的是「人点这个按钮」那条路,而那条路上五类全都真动手。
 *
 * `delete-loser` 与 `replace` 属确认档,受执行器的 `losers` 开关管（`execute.ts` 的 `ExecOptions`）：
 * `losers:false` 时它们不执行、转 `pending`。但传 false 的只有**定时轮**（`service.ts` 的
 * `runScheduled`,那条路根本没有弹窗）；手点执行走 `executeShow` → `executePlan(actions, deps)`
 * 不传 opts → 默认 `losers:true`,五类照办。后端两条都钉着测试：`service.test.ts` 的
 * 「executeBinding 真删落选那份」与「runScheduled autoExecute=true 也不删 delete-loser;显式
 * execute 才删」。
 *
 * 所以这里可以说"一定会执行"。**哪天手点这条路也开始传 `losers:false`,这句话就成了谎**——
 * 改那一行的人请连这张表一起改（把那两类降级成"要另行确认"的措辞）。
 */
export interface ExecCopy {
  /**
   * 动词。**同动词的几类在句子里合并说一次**——「删除 1 条 A、1 条 B」而不是
   * 「删除 A、删除 B」：三类删除各带一遍动词读起来像三件互不相干的事,而用户此刻要判断的
   * 恰恰是"这一轮一共删掉什么"。
   */
  verb: string
  /** 「N 条」后面那半句：这一类到底是什么。 */
  noun: string
  /**
   * 这一条动作会让多少字节从网盘上消失。**取不到就返回 undefined，绝不返回 0**——
   * 0 的意思是"这条不占空间"，undefined 的意思是"这条多大不知道"，混起来会把汇总说小。
   */
  frees: (a: ReconcilePlanAction) => number | undefined
}

/**
 * 每一类执行档动作在确认弹窗里怎么被说出来。**这张表必须是全集**：
 * `Record<ExecutedKind, …>` 少一项就编译不过。
 *
 * 措辞按「用户看得懂的后果」写，不按内部动作名——`delete-redundant` 说的是"免费集副本"
 * 而不是"冗余删除"，因为用户要判断的是"删了我还听不听得到"。
 */
export const EXEC_ACTIONS: Record<ExecutedKind, ExecCopy> = {
  // 搬运不让任何字节消失——它只换个位置，`frees` 恒为 undefined（不是 0：见上面那条注释，
  // 这里返回 undefined 表达的正是"这条压根不属于释放空间那笔账"）。
  move: { verb: '移动', noun: '', frees: () => undefined },
  // 原地加编号前缀：不挪窝、不删字节，`frees` 同 `move` 恒 undefined。
  rename: { verb: '改名', noun: '', frees: () => undefined },
  'delete-dup': { verb: '删除', noun: '字节全等的重复', frees: (a) => a.src.size },
  'delete-loser': { verb: '删除', noun: '同集落选副本', frees: (a) => a.src.size },
  'delete-redundant': { verb: '删除', noun: '免费集副本（源站自己放得出）', frees: (a) => a.src.size },
  // 换正主删掉的恰恰是**现任**（`oldPath`），体量得去 compare 的并排数据里按路径找——
  // 行本身带的 `src.size` 是**留下**那份的大小，拿它顶替会把"换上来的那份"报成省下的空间，
  // 方向正好反了。
  replace: {
    verb: '换掉',
    noun: '库里的旧版本（删旧的、新的上位）',
    frees: (a) => (a.oldPath ? a.compare?.candidates.find((c) => c.path === a.oldPath)?.size : undefined),
  },
}

/**
 * 这一轮会释放多少字节。只算真会消失的那些（见各类的 `frees`）。
 * 一个 size 都取不到 → `null`，调用方整段不显示：**宁可不说，绝不出 0 GiB / NaN**。
 */
export function reclaimedBytes(actions: ReconcilePlanAction[]): number | null {
  let total = 0
  let known = false
  for (const a of actions) {
    const size = EXEC_ACTIONS[a.kind as ExecutedKind]?.frees(a)
    if (typeof size === 'number' && Number.isFinite(size)) { total += size; known = true }
  }
  return known && total > 0 ? total : null
}

/**
 * 确认弹窗那句话（不含末尾的风险提示）。为 0 的类别整段省略——写「删除 0 条重复」既没信息量，
 * 又正好是原来那个 bug 骗过用户的方式（一串 0 读起来像"什么都不删"）。
 *
 * `actions` 传的必须是**这次按下去真会执行的那批**（面板里的 `auto`，即 `kind !== 'pending'`），
 * 不是 `counts` 里的数字：`plan` 是原始事实，`counts` 是它的投影，而投影的字段可能在老后端上
 * 整个缺席（`counts.deleteRedundant?`）——从投影读就得处理"缺席 vs 真是 0"，从事实读没这回事。
 */
export function execConfirmSummary(actions: ReconcilePlanAction[]): string {
  const byKind = new Map<string, number>()
  for (const a of actions) byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1)

  // 同动词的几类并成一段（段内 `、`，段间 `，`），段的先后按 EXEC_ACTIONS 的声明顺序。
  const groups: { verb: string; items: string[] }[] = []
  for (const kind of Object.keys(EXEC_ACTIONS) as ExecutedKind[]) {
    const n = byKind.get(kind) ?? 0
    byKind.delete(kind)
    if (n === 0) continue
    const { verb, noun } = EXEC_ACTIONS[kind]
    const last = groups[groups.length - 1]
    const item = `${n} 条${noun}`
    if (last?.verb === verb) last.items.push(item)
    else groups.push({ verb, items: [item] })
  }
  // 剩下的都是这一版前端不认识的 kind（`pending` 不该进来，进来了也一样按"说不出名字"报）。
  // 静默丢掉它们 = 又一次「删了 4 个却说删 0 个」，所以宁可说得笨也要说出来。
  let unknown = 0
  for (const n of byKind.values()) unknown += n
  if (unknown > 0) groups.push({ verb: '另有', items: [`${unknown} 条本版本还说不出名字的动作（后端比前端新）`] })

  if (groups.length === 0) return '这一轮没有要执行的动作。'
  const parts = groups.map((g) => `${g.verb} ${g.items.join('、')}`)
  const freed = reclaimedBytes(actions)
  return `将${parts.join('，')}。${freed != null ? `预计释放 ${fmtBytes(freed)}。` : ''}`
}
