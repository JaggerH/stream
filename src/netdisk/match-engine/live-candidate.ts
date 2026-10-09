import type { AskReason, VetoReason } from './types.ts'

/**
 * **「活候选」的剔除口径——判定层与处置层共用的那一处定义。**
 *
 * 两处在回答同一个问题，一旦口径分家，文件会被静默处理掉：
 *
 * · 判定层的闸（`resolve.ts` 的 `note()`）：这一集源站自己放得出（`needsSupply === false`）
 *   → 不发问句。正当性只有一条——**答案不改变动作**。
 * · 处置层的自动删（`reconcile/plan.ts` 的 `liveCandidateKeys`）：一份没被认领的文件，
 *   其**活候选**全都不需供货 → 直接删，不出卡。
 *
 * 不变量：**被处置层从活候选里剔掉的边，判定层必须照发问句**。那条边压根走不到自动删，
 * 所以"答案不改变动作"在这一档是假的（是这一集 → 换正主；不是 → 挪去下架）。
 *
 * 这张表就是那条对应关系。**归匹配器（判定层）定义、归档器读它**，方向不能反——
 * 项目规矩是判定只许有一个脑（`docs/MATCHING.md` "All decisions live on the matcher side"）。
 *
 * 活体事故（2026-08-02 怡楽）：`112.河南洛阳案.mp3` / `116.安特卫普金库案.mp3` 名字与节目单
 * 某一集一字不差、只是时长差 350 余秒，被静默搬去下架货架，一张卡都没有。当时的修法是在闸上
 * 写死一句"`duration-contradiction` 放行"，两侧只靠注释互指、没有任何测试守着——再加一种剔除
 * 理由，同一类静默下架会从新理由上原样再长一次。
 *
 * **加一种剔除理由 = 往这张表里加一行**，两侧的口径自动跟着走。
 */
export const NON_LIVE_VETO_TO_ASK: Partial<Record<VetoReason, AskReason>> = {
  /**
   * 横向时长矛盾：**事实级**否决（两侧都有时长且差出量级）。它和别的否决理由不是一回事——
   * `name-floor`/`below-threshold`/`no-margin` 是顺序性/门槛性的，证据仍指着那一集，
   * 那些边照旧是活候选、闸照旧关得住（`37.申与酉` 那三条时长命中免费集的问句，一张都不许多）。
   */
  'duration-contradict': 'duration-contradiction',
}

/** 事实级、但**不出问句**的否决：证据本身就足够说"不是"，没有什么可问人的。 */
export const SILENT_NON_LIVE_VETOES: readonly VetoReason[] = ['pure-cut-mismatch']
const NON_LIVE = new Set<string>([...Object.keys(NON_LIVE_VETO_TO_ASK), ...SILENT_NON_LIVE_VETOES])
const ASK_ANYWAY = new Set<string>(Object.values(NON_LIVE_VETO_TO_ASK))

/** 处置层：这条边的否决理由要不要把它从**活候选**里剔掉（剔掉 = 它走不到自动删）。 */
export const isNonLiveVeto = (reason: VetoReason | undefined): boolean => !!reason && NON_LIVE.has(reason)

/** 判定层：这一类问句要不要**掀开**「不需供货就不问」那道闸（掀开 = 照发）。 */
export const asksDespiteNoSupply = (reason: AskReason): boolean => ASK_ANYWAY.has(reason)
