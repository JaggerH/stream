import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Circle, Copy, Pause, Play, X } from 'lucide-react'
import { Badge } from './acrylic/badge.tsx'
import { Button } from './acrylic/button.tsx'
import { Card, CardFooter, CardTitle } from './acrylic/card.tsx'
import { Item, ItemContent, ItemGroup, ItemMedia } from './acrylic/item.tsx'
// 包装版 sonner（不裸 import 'sonner'：那样 status 图标会掉进 32px fallback）。
import { toast } from './acrylic/sonner.tsx'
import { EvidenceButton } from './reconcile-evidence-card.tsx'
import { conflictCandidatesOf, fmtDur, verdictChainOf, type ChainSignal, type VerdictChain } from './reconcile-verdict-chain.ts'
import type { ReconcilePreview, ReconcilePlanAction, RowExplain } from '../lib/types.ts'
// 一张卡的文案里最多点名几个集——后端拼 `evidence-conflict` 那句用的是同一份。
import { MAX_CARD_EPISODES } from '@reconcile/card-limits.ts'

// `fmtDur` 的家在 `reconcile-verdict-chain`（判据链要用它拼实测值），这里 re-export 只为不惊动
// 既有 import 方（`reconcile-evidence-card`）。**别在这儿再定义一份**——两份实现分家之后，
// 同一个时长会在证据卡和判据链里显示成两个值，而这两处正是拿来互相核对的。
export { fmtDur }

/**
 * 整理计划里**一条动作的呈现**——「整理」面板的「可以自动完成」「要你决定」与「将删清单」
 * 共用这一份，不各写一份。三处摆的是同一批 `ReconcilePlanAction`，问的是同一个问题：这一集
 * 涉及哪几份文件、谁留谁走、凭什么（只是「要你决定」那一档的答案由人给）。分成几套渲染的下场
 * 已经发生过两次：将删清单先改了形状，整理面板还是旧的两行 truncate；「要你决定」自己排了一套
 * `Item`，那上面的 ✓ 表示"时长命中"，而同一个弹窗里另外两组的 ✓ 表示"这份留下"——同一个符号
 * 在同一屏里指两件事。
 *
 * **一条动作 = 一张 `Card`**（`ActionCard`）：Card 的边界圈住的正好是**一个决定单元**——
 * 这一集要不要这么处置。里面是 ① 集名（`CardTitle`）② 涉事的每一份 / 去向
 * （各一个 `Item`，一个文件一个）④ 凭什么（`CardFooter`，要人回答的那类把答案按钮摆在这一行）。
 *
 * 以前整张 Card 包着**一堆**决定、每个决定是一个 Item，层级正好反了：卡片的边界本该是
 * "这件事从哪儿到哪儿"，圈住一整组就等于没圈。现在外层只剩一个纯标题行（不是 Card）。
 *
 * **行位固定，不随动作变**，处置方向只由行首那个 ✓/✗ 说死：`replace` 删的恰恰是 ②（`oldPath`）、
 * 留的是 ③，和删除类正好相反。顺序一旦承载语义，用户对着确认按钮点下去的就可能是反的那件事。
 */

/**
 * 清单里一份文件的完整身份。**每一行的两个主体都得摆全**：光有文件名答不了"这是库里那份还是
 * 我刚转存进来那份"，光有路径答不了"哪个音质好"。四样东西各管一件事——路径说是哪一份、
 * 库内/来源说它现在归哪边、时长说是不是这一集、码率（`size×8÷时长`，前端纯算）说音质谁好。
 */
export interface FileFacts {
  path: string
  size?: number
  durationS?: number
  /** `null` = 判不出（后端没下发货架地址）——那一格就不显示，绝不猜。 */
  where: 'lib' | 'source' | null
}

/**
 * 卡片里一个 `Item` 的形状：一份文件（带处置标记），或一个去向目录（`move` 没有"另一份"）。
 *
 * 文件行的处置标记是**一个图标**：`gone`→✗（destructive）、`kept`→✓（`--acr-green`）、
 * `undecided`→○（muted）。第三档是「要你决定」那类卡片用的：那上面的候选**一个都还没定**，
 * 借 ✓ 表示"时长命中"会和这套里 ✓＝"留下"撞成两个意思——同一个符号在同一个面板里指两件事，
 * 是这套卡片最不能出的错。○ 只说"候选，未定"，方向留白正是它要表达的东西。
 *
 * `mark` 那个词（移出/保留/上位/删除/搬入/待定）不再印在界面上，但**必须留在 DOM 里**（`sr-only`）——
 * 图标对眼睛够用，读屏用户得到的不能比看得见的人少。"换"还是"删"由标题行那个类别标记答。
 * 没有"行位"标签：`现任`/`另一份` 那对灰标签是纯冗余，行位本来就由行序说死。
 * 去向行的 `slot`（「去向」）留着：那一行只有一个光秃秃的目录路径，不说它是什么就读不出来。
 */
export type RowSlot =
  /**
   * `swap`：这一行参与**一次换手**（同一个位置上，`out` 那份走、`in` 那份来）。
   *
   * 它替掉的是原先夹在两行中间的那条散文桥（「↓ 本轮删掉它，下一轮这份落位」）。桥的毛病是
   * **逃出了整张卡的语言**：上下每一份文件都是"图标 + 路径 + 元数据 + 试听"，到它那儿突然变成
   * 一句话，而且**每张换手卡都一字不差地重复一遍**。更要命的是它把两个时长（96:48 与 36:04）
   * 从上下相邻掰成隔着一条横线——而那一眼恰恰是这张卡最有价值的证据。
   *
   * 现在时序长在行自己身上：`in` 那行行尾一枚「下轮落位」徽章，两行左侧各带一段轨（走的那份红、
   * 来的那份天蓝），红→蓝本身就是方向，不用箭头也不用字。**徽章只给 `in`**：卡上其余每一行都是
   * 本轮的动作，唯一异时态的就是它，给"走"那行也挂一枚只会把这个唯一性稀释掉，
   * 而且措辞还得跟着动作类别变（删除/移出/搬走），必然出现说反的一天。
   */
  | { kind: 'file'; mark: string; tone: 'gone' | 'kept' | 'undecided' | 'incoming'; facts: FileFacts; swap?: 'out' | 'in' }
  | { kind: 'dest'; slot: string; dir: string }
  /**
   * 一个**候选集**（不是文件）：`evidence-conflict` 那张卡问的是"这份文件到底属于哪一集"，
   * 并排摆的自然是几个集。每行带**它自己**命中了什么——没有这一栏，一串光秃秃的集名让人点，
   * 那才是抓阄（这正是那张卡以前只给"都不是"的理由）。
   */
  | { kind: 'episode'; leftKey: string; title: string; evidence: string }

export interface ActionRow {
  /** react key：同一路径可能在多条绑定里各出现一次，前缀隔开。 */
  key: string
  /**
   * ① 动作类别：换正主 / 删除同集副本 / 删除重复 / 移入<去向>；待定那两类摆的是**问句**
   * （是不是这一集 / 留哪一份）——那正是它们的"类别"，用户要做的事就是回答它。
   * **不是判据**——判据在 ④。它是标题行上的**次要标记**，不和文件行抢视觉。
   */
  label: string
  /** ① 标记底色：删=红、换正主=琥珀、搬入=天蓝、要你决定=紫。动作类别一眼可分。 */
  labelTone: 'delete' | 'swap' | 'move' | 'decide'
  /**
   * ① **这条建议是怎么来的**（后端 `origin`，照抄不解析）：`authority` = 某一集去清单里找自己的
   * 文件、`file` = 没有集认领它，只能从它自己的证据边反推。
   *
   * 它和 `label` 是**正交的两问**：label 答"要做什么"（换/删/搬/问你），这个答"这事是谁挑起的"。
   * 同一个「移入下架」既可能是某一集裁定它不是自己（集侧），也可能是压根没人惦记它（文件侧）——
   * 光看动作分不出，而用户对这两种的判断标准完全不同。缺席 = 老后端没下发，整格不渲染。
   */
  origin?: 'authority' | 'file'
  /** ① 作品/节目名——聚合视图恒显；单作品视图只在这一条没有主角（集名/文件名都没有）时
   *  退化补位（撑住 `CardTitle`）。 */
  groupLabel?: string
  /** ① `CardTitle` 的正文：节目单里那一集的名称。 */
  episode?: string
  /**
   * ① **从网盘文件出发那一档的标题**：那份文件的文件名（不含目录——全路径在下面的文件行里）。
   *
   * 只有 `origin === 'file'` 才有它。那一档的主角本来就是**这份文件**：建议针对它、用户要判断的
   * 也是它。以前没有这一格时，填不出集名的卡就退化成作品名当标题——活体 2026-08-02 那张卡顶着
   * 「怡楽播客」，而它讲的是 `37.申与酉.mp3` 这一份文件该不该删，标题答的完全是另一个问题。
   *
   * 它**不排挤 `episode`**：文件侧也有确定集名的一档（`size-dup-of:`，判据是两份文件自己的字节数，
   * 但集名是知道的）。那时集名退成定语，和聚合视图里的作品名同一个位置——换的是主次，不是删信息。
   */
  fileName?: string
  authorityDurationS?: number
  /**
   * ②… 涉事的每一份各占一个 `Item`，**行位固定、按数组顺序渲染**：删除/换正主是"现任 + 这份"
   * 两行，搬入是"这份 + 去向"两行，要你决定则是**全部候选**（活体见过三份）——候选数不是二，
   * 硬塞进两个固定槽位就得砍掉一份，而那一份恰恰可能是答案。
   */
  slots: RowSlot[]
  /** 被删掉那份的体量——"共省多少"只算它；`move` 没有。 */
  goneSize?: number
  /** ④ 原因：`basis` 前缀 + `compare` 现算的人话，**绝不解析中文 `reason`**。
   *  `chain` 在场时它退居幕后（只进复制文本），界面上摆的是判据链。 */
  reason: string
  /**
   * ④ 的**首选形态**：判据链（一列带实测值的信号 + 结论 + 灰的解释）。
   * 拿不出来（老账本行没有 `explain`、或这一类还没接）时缺席，界面退回 `reason` 那一句。
   *
   * 为什么它比 `reason` 优先：那句散文是判决书的**二次转述**，转述途中会丢东西——活体 05 案里
   * 「这份时长与命中那集一秒不差」和「同名的那一集只有 36:03」两条最硬的证据，后端都量到了、
   * 都记在 `explain` 里，那句话一个字没提。链直接从 `explain` 渲染，丢不了。
   */
  chain?: VerdictChain
  /**
   * 后端那句**机器可读的判据原文**（`quality-upgrade:<path>` / `authority-duration:…` / …）。
   * **界面上不显示**——它是给机器看的，摆出来只会挤掉人话；但**复制出去必须带上**：
   * 一条决策被复制走多半是拿去诊断"它凭什么这么判"，而 ④ 那句人话是前端现编的，
   * 回答不了"后端到底走了哪个分支"。
   */
  basis?: string
  /**
   * ⓘ 证据卡的数据：后端判决书（裁决轨迹的切片，按 `src.path` 取）。
   *
   * **缺席是常态，不是异常**——老账本行没有它，豁免/字节全等那两档的文件压根没进过证据图。
   * 那时**连图标都不渲染**（无占位）：一个点开来说"没有证据"的按钮比没有按钮更糟。
   */
  explain?: RowExplain
}

/**
 * 预览响应 → 路径查判决书。**两处账本行都要合进来**：主池的 `ledger.rows` 与下架复核那一趟的
 * `ledger.secondaryReview.rows`——复核的行走的是它自己那张证据图，漏了这一半，下架复核出来的
 * 那几张卡片就永远没有 ⓘ（而它们恰恰是最需要解释"凭什么动它"的一类）。
 *
 * 老响应没有 `rows` → 恒查不到 → 全都不渲染 ⓘ（优雅降级，绝不补算）。
 */
export function explainLookup(preview?: ReconcilePreview | null): (path: string) => RowExplain | undefined {
  const rows = [...(preview?.ledger?.rows ?? []), ...(preview?.ledger?.secondaryReview?.rows ?? [])]
  const byPath = new Map(rows.flatMap((r) => (r.explain ? [[r.path, r.explain] as const] : [])))
  return (path) => byPath.get(path)
}

/**
 * 一条动作执行完**腾出来的那个位置**（那份文件从此不在原处）。没有就 `null`。
 *
 * `replace` 腾出的是 `oldPath` 而不是 `src`——那一类里 `src` 是上位的那份、`oldPath` 才是被删的。
 * 按 `src` 一把抓会把"上位那份的老位置"当成腾出来的位置，正好反了。
 */
function vacatedBy(a: ReconcilePlanAction): string | null {
  if (a.kind === 'replace') return a.oldPath ?? null
  if (a.kind === 'move' || a.kind === 'delete-dup' || a.kind === 'delete-loser' || a.kind === 'delete-redundant') {
    return a.src.path
  }
  return null
}

/**
 * 把本轮的等位（`swap-hold`）分成两半：**有主的**（占位者就在本轮计划里，位置会腾出来）
 * 和**卡住的**（占位者本轮谁都不动）。
 *
 * 这两半的去处完全不同，所以判定必须在一处做完：有主的挂到腾位那条动作上当后果（`unblocks`），
 * 卡住的进「要你决定」（`stranded`）。**卡住的绝不许静默丢掉**——后端那句"等它腾空后下一轮
 * 自然落位"对它是假话，没人会去腾它，不摆出来就是让一份文件永远落不了位且没人知道。
 *
 * `blockedBy` 缺席（老后端）→ 对不上号 → 按卡住处理。宁可多问一次，不许悄悄消失。
 */
export function splitSwapHolds(
  actions: ReconcilePlanAction[],
  holds: ReconcilePlanAction[],
): { unblocks: (a: ReconcilePlanAction) => ReconcilePlanAction[]; stranded: ReconcilePlanAction[] } {
  // 一份占位文件可能同时挡着好几条（同集的几份都指着货架上那一份）——所以是数组，不是单值。
  const byOccupant = new Map<string, ReconcilePlanAction[]>()
  for (const h of holds) {
    if (!h.blockedBy) continue
    const list = byOccupant.get(h.blockedBy) ?? []
    list.push(h)
    byOccupant.set(h.blockedBy, list)
  }
  const claimed = new Set<ReconcilePlanAction>()
  for (const a of actions) {
    const p = vacatedBy(a)
    if (p) for (const h of byOccupant.get(p) ?? []) claimed.add(h)
  }
  return {
    unblocks: (a) => {
      const p = vacatedBy(a)
      return p ? byOccupant.get(p) ?? [] : []
    },
    stranded: holds.filter((h) => !claimed.has(h)),
  }
}

/**
 * 路径 → 「库内」/「来源」。判据是**目录前缀**，货架地址与来源目录都由后端下发。
 * 不许拿 `compare.candidates[].inLib` 顶替：那个字段说的是"此刻在认领货架上"，第二货架（下架）
 * 上的文件也是 `false`，照它渲染会把库里的文件说成来源里的。
 */
export function whereIn(
  shelves?: { claimed: string; secondary?: string } | null,
  sourceDirs?: string[],
): (path: string) => 'lib' | 'source' | null {
  if (!shelves) return () => null
  const libDirs = [shelves.claimed, ...(shelves.secondary ? [shelves.secondary] : [])]
  const sources = sourceDirs ?? []
  const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)
  return (path) => {
    if (libDirs.some((d) => under(path, d))) return 'lib'
    if (sources.some((d) => under(path, d))) return 'source'
    return null
  }
}

export interface BuildRowsOptions {
  /** 路径归属判定（`whereIn` 造出来的）——拿不到货架地址时给一个恒 `null` 的即可。 */
  where: (path: string) => 'lib' | 'source' | null
  /** 作品/节目名。 */
  groupLabel?: string
  /** 恒显作品名（聚合了多条绑定时用来分辨这一行属于谁）。 */
  showGroupLabel?: boolean
  /** react key 前缀（多绑定聚合时用 bindingId 隔开）。 */
  keyPrefix?: string
  /** 路径 → 判决书（`explainLookup` 造出来的）。不传 = 这一批行都不出 ⓘ。 */
  explainOf?: (path: string) => RowExplain | undefined
  /** 这条动作腾出的位置上等着落位的那些文件（`splitSwapHolds` 造出来的）。不传 = 不出换手那两行。 */
  unblocks?: (a: ReconcilePlanAction) => ReconcilePlanAction[]
  /** 本轮码率基线（`kbpsBaselineOf` 算出来的）。不传 = 判据链不标反常码率。 */
  kbpsBaseline?: number
}

/**
 * plan action → 一张 `ActionCard` 的数据。形状不全的动作（`replace` 少了 `oldPath`）落空——
 * 宁可这一条不出现，也不渲染一个说不清"另一份是谁"的块。
 *
 * **待定里要人回答的那两类**（`duration-collision` / `replace`）也走这一份：它们摆的是同一批
 * 文件、问的是同一个问题的另一半（"这几份里哪个是这一集"），只是答案由人给。以前它们在整理面板里
 * 另写了一套 `Item` 排版——同一条 plan action 在同一个弹窗里长成两副样子，两边的 ✓ 还指着不同的
 * 意思（那边是"时长命中"、这边是"留下"）。其余待定（`swap-hold`/`no-duration`/`suspect-dir`）
 * 不进来：它们是**状态**，不问用户任何问题，也没有并排候选可摆。
 *
 * **`move` 是否要出现由调用方决定**：把 `move` 过滤掉再传进来就行（「将删清单」那边只问删，
 * 混进搬运会让"将删 N 份"这句汇总说谎）。
 */
export function buildActionRows(actions: ReconcilePlanAction[], opts: BuildRowsOptions): ActionRow[] {
  return actions.flatMap((a): ActionRow[] => {
    // 体量/时长：本行主角自带（`src`），另一份只有路径 —— 去并排数据里取（后端两侧都带上了）。
    const facts = (path: string, own?: { size: number; durationS?: number }): FileFacts => {
      const c = a.compare?.candidates.find((x) => x.path === path)
      return { path, size: c?.size ?? own?.size, durationS: c?.durationS ?? own?.durationS, where: opts.where(path) }
    }
    const src = facts(a.src.path, a.src)
    // ① 从网盘文件出发那一档的主角：这份文件的文件名。**不是拿它冒充集名**——它另占一格
    // （`fileName`），措辞与配色都由 `ActionCard` 分开处理；集名那一格照旧只装节目单给的名字。
    const fileName = a.origin === 'file' ? baseName(a.src.path) : undefined
    const head = {
      // ① 集名来自节目单（后端 `episode`）——缺席时退化成"动作标签 + 作品名"，
      // 绝不拿文件名冒充集名，也不渲染一行空的。
      // 作品名的退化补位判据跟着**主角**走（集名或文件名）：主角在场时它只是定语，
      // 只有聚合视图（多部作品同屏）才需要它出来分辨这一条属于谁。
      groupLabel: opts.showGroupLabel || !(a.episode || fileName) ? opts.groupLabel : undefined,
      episode: a.episode,
      fileName,
      // 来路照抄后端那个机器可读的值——前端不许从 basis 前缀反推（后端文案一改就静默错位）。
      origin: a.origin,
      authorityDurationS: a.compare?.authorityDurationS,
      // 判据原文照抄，不解析、不翻译——复制出去做诊断时它是唯一能说清"后端走了哪个分支"的东西。
      basis: a.basis,
      // 判决书按**本行主角**（`src`）取：账本一行 = 一个文件，而这条动作正是因它而起。
      // `replace` 里 `src` 是上位的那份、`delete-loser` 里是被删的那份——两类都是被裁决的主体。
      explain: opts.explainOf?.(a.src.path),
      // ④ 首选形态：判据链。拿不出来就是 undefined，界面自动退回下面各分支现编的 `reason`。
      chain: verdictChainOf(a, opts.explainOf?.(a.src.path), { kbpsBaseline: opts.kbpsBaseline }) ?? undefined,
    }
    // 换手的下半截：这条动作腾出的位置上、下一轮要落位的那几份。**一份一行**——同一份占位文件
    // 可能同时挡着几条，合成一行就得挑一个说，而被略掉的那份恰恰也在等这一下。
    const incoming = (opts.unblocks?.(a) ?? []).map((h): RowSlot => ({
      kind: 'file',
      mark: '下轮搬入',
      tone: 'incoming',
      swap: 'in',
      facts: { path: h.src.path, size: h.src.size, durationS: h.src.durationS, where: opts.where(h.src.path) },
    }))
    /**
     * 换手的上半截：**本轮走掉、把位置腾出来的那一份**。判据只有 `vacatedBy` 一处
     * （`replace` 腾的是 `oldPath` 不是 `src`，按行序或按 tone 反推都会翻车）。
     * 没有等位者时整个不成立——一份文件走了、没人在等，那就不是换手，不该染上换手的轨。
     */
    const vacated = incoming.length > 0 ? vacatedBy(a) : null
    const swapOut = (f: FileFacts) => (f.path === vacated ? { swap: 'out' as const } : {})
    const keyOf = (other: string) => [opts.keyPrefix, a.kind, other, a.src.path].filter(Boolean).join('|')

    if (a.kind === 'move' && a.dstDir) {
      // 带 `newName`（只加编号前缀）时目标不止是目录——落地文件名也变了，去向那格得说清楚，
      // 不然「搬进去之后叫什么」只能靠猜。
      const dstShown = a.newName ? `${a.dstDir}/${a.newName}` : a.dstDir
      return [{
        key: keyOf(a.dstDir),
        label: `移入${dirLabel(a.dstDir)}`,
        labelTone: 'move',
        ...head,
        // 搬入只有一个主体：这份文件。两行退化成「它是谁」+「它去哪」，行位照旧一一对应。
        slots: [
          { kind: 'file', mark: '搬入', tone: 'kept', facts: src, ...swapOut(src) },
          { kind: 'dest', slot: '去向', dir: dstShown },
          ...incoming,
        ],
        reason: moveReason(a),
      }]
    }

    // 原地加编号前缀：不挪窝，只改名——单主体、单行，「搬入/去向」那套形状不适用。
    // 形状不全（没有 `newName`）落空，同 `replace` 少了 `oldPath` 那条规则一致。
    if (a.kind === 'rename' && a.newName) {
      return [{
        key: keyOf(a.newName),
        label: `改名为 ${a.newName}`,
        labelTone: 'move',
        ...head,
        slots: [{ kind: 'file', mark: '改名', tone: 'kept', facts: src, ...swapOut(src) }, ...incoming],
        reason: `原地加编号前缀，改名为 ${a.newName}`,
      }]
    }

    if (a.kind === 'pending') return decideRow(a, opts, head, keyOf)

    // 免费集副本：**只有一个主体**——留下的那份不是文件，是源站自己。硬凑成两行就得给"保留"
    // 那一格编一个路径出来，而它不存在；退化成"删这一份 + 一句为什么"，行位照旧一一对应。
    if (a.kind === 'delete-redundant') {
      return [{
        key: keyOf('origin'),
        label: '删除免费集副本',
        labelTone: 'delete',
        ...head,
        slots: [{ kind: 'file', mark: '删除', tone: 'gone', facts: src, ...swapOut(src) }, ...incoming],
        goneSize: src.size,
        reason: redundantReason(a.candidateEpisodes),
      }]
    }

    const build = (incumbent: FileFacts, swap: boolean): ActionRow => ({
      key: keyOf(incumbent.path),
      label: actionLabel(a),
      labelTone: swap ? 'swap' : 'delete',
      ...head,
      slots: [
        { kind: 'file', mark: swap ? '移出' : '保留', tone: swap ? 'gone' : 'kept', facts: incumbent, ...swapOut(incumbent) },
        { kind: 'file', mark: swap ? '上位' : '删除', tone: swap ? 'kept' : 'gone', facts: src, ...swapOut(src) },
        ...incoming,
      ],
      goneSize: swap ? incumbent.size : src.size,
      reason: reasonOf(a, incumbent, src, swap),
    })
    if (a.kind === 'delete-dup' || a.kind === 'delete-loser') return [build(facts(keptOf(a)), false)]
    if (a.kind === 'replace' && a.oldPath) return [build(facts(a.oldPath), true)]
    return []
  })
}

/**
 * ④ 免费集副本判删的原因。**"凭什么删"的全部依据是那几集源站自己放得出**——卡片必须把那几集
 * 的名字说出来，否则用户手里只剩一个文件名（活体 2026-08-02：卡上只有付费集 `37.申与酉`，
 * 用户读完那句写死的「这一集源站自己能播」，以为是付费判断出错了）。
 *
 * **一个候选和多个候选是两句话，不是一句话套模板**：
 *  · 一个 → 机器确实只指着那一集，可以说「实际对应「X」」。
 *  · 多个 → 机器**不知道**是哪一集，它的逻辑是"这几集都不需要网盘供货，所以不论是哪一集都该删"。
 *    措辞必须如实反映：明说"不论是哪一集"，**绝不许**挑第一个说成"实际对应"——那是把推测
 *    伪装成结论，而这张卡后面接的是删除。截断一个字都不改这层意思。
 *
 * **名单点名到 `MAX_CARD_EPISODES` 为止，其余归入「等 N 个集」**——活体见过一份文件沾上
 * 二十几集，全列出来那句话长到没法读。截的**只有这句文案**：机器可读的那两份
 * （`candidateEpisodes` 字段、`basis` 里那串 leftKey）照旧全量，它们是回传/诊断的凭据，
 * 少一个就对不回去。
 *
 * 候选名单缺席（认领成立那一条 `redundant-free:<leftKey>`，以及老后端）→ 照旧那句：
 * 那一档的集名本来就在标题上，这里不需要重复，更不许编一个出来。
 */
function redundantReason(candidates?: string[]): string {
  const tail = '删除，夸克回收站里还能捞回来'
  if (!candidates || candidates.length === 0) return `这一集源站自己能播，网盘这份是冗余——${tail}`
  if (candidates.length === 1) return `实际对应「${candidates[0]}」，这一集源站自己能播，网盘这份是冗余——${tail}`
  const shown = candidates.slice(0, MAX_CARD_EPISODES)
  const list = shown.map((e) => `「${e}」`).join('')
  const more = candidates.length > shown.length ? `等 ${candidates.length} 个集` : ''
  return `证据指向这几集之一：${list}${more}。它们源站都自己能播，所以不论是哪一集，网盘这份都是冗余——${tail}`
}

/** 待定里那两个**问句**的类别标记。用户在这张卡上要做的事就是回答它，所以标签写成问题本身。 */
const DECIDE_LABEL: Partial<Record<NonNullable<ReconcilePlanAction['pendingKind']>, string>> = {
  'duration-collision': '是不是这一集',
  // 问法与上面那条不同：那个已经锁定了一集、问"是不是"；这个连该问哪一集都还没定
  // （名字指 A、时长指 B）。标签写成"哪一集"而不是"是不是"，问题才没被偷换。
  'evidence-conflict': '到底是哪一集',
  replace: '留哪一份',
}

/**
 * 「要你决定」的一张卡。和处置类的差别只有两处：**候选是 N 份不是两份**，以及**一份都还没定**
 * （全部 `undecided`，没有 ✓/✗）。其余一切共用——集名当标题、节目单时长当尺子、每份的
 * 库内/来源 · 时长 · 体量 · 码率、右上角复制。
 *
 * ④ 的原因**直接用后端那句**（不像处置类那样按 `basis` 现编）：这两类的"为什么问你"是后端判出来的
 * 上下文（撞上了哪一集、第二货架上那份叫什么），前端手里没有重编它的材料。照抄不等于解析——
 * 分组、措辞、按钮一律只认 `pendingKind`，绝不去 `reason` 字符串里找线索。
 */
function decideRow(
  a: ReconcilePlanAction,
  opts: BuildRowsOptions,
  head: Pick<ActionRow, 'groupLabel' | 'episode' | 'authorityDurationS' | 'basis' | 'explain' | 'origin' | 'chain'>,
  keyOf: (other: string) => string,
): ActionRow[] {
  // **卡住的等位**（占位者本轮谁都不动）。只有这一半会走到这里——有主的那一半由
  // `splitSwapHolds` 挂到腾位那条动作上，压根不进这个函数（调用方只把 `stranded` 传进来）。
  //
  // 后端那句 reason 在这里**不能照抄**：它以"等它腾空后下一轮自然落位"结尾，而这一条恰恰
  // 等不到——没有任何一条动作会去腾它。照抄就是把一句当场失效的承诺摆给用户看。
  if (a.pendingKind === 'swap-hold') {
    return [{
      key: keyOf('swap-hold'),
      label: '位置被占着',
      labelTone: 'decide',
      ...head,
      // 主角是**等着的那份文件**。不跟着 `origin === 'file'` 那条判据走：这张卡问的就是
      // "这一份怎么办"，来路是另一回事。退化成作品名的话，一屏几张卡顶着同一个标题，
      // 得逐张读文件行才知道哪张说的是哪一份。
      // 后端带来的集名（认领已成立那一档）由 `...head` 原样保留，在 `ActionCard` 里退成定语——
      // 主次换了，信息一个字没丢；没有集认领它的那些照旧缺席，绝不拿文件名冒充集名。
      fileName: baseName(a.src.path),
      groupLabel: opts.showGroupLabel ? opts.groupLabel : undefined,
      slots: [
        { kind: 'file', mark: '待定', tone: 'undecided', facts: { path: a.src.path, size: a.src.size, durationS: a.src.durationS, where: opts.where(a.src.path) } },
        // 挡路的那份**要摆完整路径**：用户下一步得自己去处置它（删掉/改名/挪走），
        // 光有文件名找不到它在哪个文件夹。后端没给（老响应）就整行不出现，绝不猜。
        ...(a.blockedBy ? [{ kind: 'dest' as const, slot: '占位', dir: a.blockedBy }] : []),
      ],
      reason: a.blockedBy
        ? '这个位置被上面那份占着，而本轮计划里没有任何一条动作会挪走它——它不会自己腾空，这一份也就搬不进去。先处置占位的那份，或者「不再提醒」。'
        : '位置被货架上另一份占着，本轮搬不进去（后端没说是哪一份）。',
    }]
  }
  const label = a.pendingKind ? DECIDE_LABEL[a.pendingKind] : undefined
  // 状态类待定（探时长 / 目录熔断 / 判不出季 `season-unresolved`）不问问题，没有并排候选可摆——
  // 它们由 `ReconcilePanel` 的兜底那一组（「认不出」）逐行列出来，不进「要你决定」。
  // **`season-unresolved` 刻意不进 `DECIDE_LABEL`**：它没有可并排的候选（只有它自己一份），
  // 摆成一张择一卡就是问一个没有选项的问题；出路在文件夹那一层（改名 / 挪进 `S<nn>/`）。
  if (!label) return []
  // compare 缺席（老后端/老数据）→ 至少把这份文件自己摆出来，别退化成一张只有标题的空卡。
  const candidates = a.compare?.candidates ?? [{ path: a.src.path, size: a.src.size, durationS: a.src.durationS }]
  return [{
    key: keyOf(a.pendingKind!),
    label,
    labelTone: 'decide',
    ...head,
    slots: [
      ...candidates.map((c): RowSlot => ({
        kind: 'file',
        mark: '待定',
        tone: 'undecided',
        facts: { path: c.path, size: c.size, durationS: c.durationS, where: opts.where(c.path) },
      })),
      // 「到底是哪一集」那张卡还要摆**相争的那几集**：文件行答"是哪几份"，集行答"是哪几集"，
      // 问的既然是后者，就不能只摆前者。每行带它自己的证据——否则一串集名让人点就是抓阄。
      ...(a.pendingKind === 'evidence-conflict'
        ? conflictCandidatesOf(a.conflictsWith ?? [], opts.explainOf?.(a.src.path))
          .map((c): RowSlot => ({ kind: 'episode', ...c }))
        : []),
    ],
    reason: a.reason ?? '',
  }]
}

/**
 * 元数据续行的缩进：对齐到 `✗ 移出 ` 之后（✗ 1 + 空格 1 + 两个全角字 4 + 空格 1 = 7 列）。
 * 复制出去的文本多半落进等宽环境，这一缩进让元数据看起来是路径的续行，而不是又一条记录。
 */
const META_INDENT = ' '.repeat(7)

/**
 * 一条决策 → **一段可以直接贴给别人看的纯文本**。用户的原话是"主要是我要复制给你看"，
 * 所以它要能被独立读懂并据此诊断，而不只是个名字。
 *
 * 两条硬约束：
 * ① **从数据拼，绝不读 DOM 的 `innerText`**——那会把 `sr-only` 的动作词、布局空白、
 *    甚至折行一起卷进来，拼出一段看着像样、其实对不上原文的东西。
 * ② **末行必须带 `basis` 原文**：界面上只有 ④ 那句人话（前端按 basis 现编的），
 *    答不了"后端到底走了哪个分支"，而那正是要诊断的东西。缺 basis 就整行不出现。
 */
export function copyTextOf(row: ActionRow): string {
  const lines: string[] = []
  // 抬头：来路 · 动作类别 · 作品名 · 集名（节目单时长）。缺席的段直接不出现，不留空的分隔符。
  // 来路排在最前：贴出去的人先要知道"这条建议是谁挑起的"，才读得懂后面那个动作为什么合理。
  const head = [row.origin && ORIGIN_LABEL[row.origin], row.label, row.groupLabel, row.episode, row.fileName].filter(Boolean).join(' · ')
  const dur = row.authorityDurationS != null ? `（节目单 ${fmtDur(row.authorityDurationS)}）` : ''
  lines.push(`${head}${dur}`)

  for (const slot of row.slots) {
    if (slot.kind === 'episode') {
      // 候选集连同它自己的证据一起复制出去：这段被贴给别人看，多半问的就是"该选哪一个"。
      lines.push(`? ${slot.title || slot.leftKey}`)
      lines.push(`${META_INDENT}${slot.evidence}`)
      continue
    }
    if (slot.kind === 'dest') {
      lines.push(`→ ${slot.slot} ${slot.dir}`)
      continue
    }
    // ✗/✓/○ 与界面同一套判据（tone），动作词照旧带着——纯文本里没有颜色，光一个 ✗ 说不出是"移出"还是"删除"。
    lines.push(`${TONE_GLYPH[slot.tone]} ${slot.mark} ${slot.facts.path}`)
    const meta = metaOf(slot.facts)
    if (meta.length > 0) lines.push(`${META_INDENT}${meta.join(' · ')}`)
  }

  // ④ 复制出去的必须是**界面上摆的那一份**：有链就抄链（逐条信号 + 结论 + 解释），
  // 没链才抄那句 `reason`。两边各说各的，粘出来的东西就对不上他正看着的卡片。
  if (row.chain) {
    // 字形与界面同一份映射（`SIGNAL_TONE`），别另写一套：复制出去那段正是拿来对界面的。
    for (const s of row.chain.signals) lines.push(`${SIGNAL_TONE[s.tone].glyph} ${s.label} ${s.value}`)
    if (row.chain.conclusion) lines.push(`⇒ ${row.chain.conclusion}`)
    if (row.chain.hint) lines.push(`· ${row.chain.hint}`)
  } else {
    lines.push(`原因：${row.reason}`)
  }
  if (row.basis) lines.push(`判据：${row.basis}`)
  return lines.join('\n')
}

/**
 * 复制这条决策到剪贴板。**失败绝不静默**：`navigator.clipboard` 在非安全上下文（既不是 https
 * 也不是 localhost）下整个是 `undefined`，写入也可能被权限挡下——两种都得说出来，不然用户
 * 以为复制成功了，粘出来却是上一次的内容。
 */
function copyRow(row: ActionRow): void {
  const fail = (description: string) => toast.error('复制失败', { description })
  const write = navigator.clipboard?.writeText(copyTextOf(row))
  if (!write) {
    fail('浏览器不允许在当前上下文写剪贴板（需要 https 或 localhost）')
    return
  }
  write.then(
    () => toast.success('已复制这条决策'),
    (e: unknown) => fail(e instanceof Error ? e.message : String(e)),
  )
}

/**
 * 来路的措辞：**说成"从哪儿出发"而不是"集侧/文件侧"**——用户读的是一句能直接理解的话，
 * 不是一个需要先学会的术语。两句话前四个字就分岔（清单 / 网盘文件），一眼扫得出不同。
 */
const ORIGIN_LABEL: Record<NonNullable<ActionRow['origin']>, string> = {
  authority: '从清单出发',
  file: '从网盘文件出发',
}

/**
 * 来路标记的配色。**不进 `LABEL_TONE` 那四色（红/琥珀/天蓝/紫）**：那四色说的是"要做什么"，
 * 来路是另一问，共用一套色就成了第五种动作类别。这里用两个低饱和度、彼此拉得开的色相：
 * 青（清单——权威那一侧）与中性灰（网盘文件——它自己那一侧）。
 */
const ORIGIN_TONE: Record<NonNullable<ActionRow['origin']>, string> = {
  authority: 'bg-teal-500/15 text-teal-400',
  file: 'bg-zinc-500/20 text-zinc-300',
}

const LABEL_TONE: Record<ActionRow['labelTone'], string> = {
  delete: 'bg-red-500/15 text-red-400',
  swap: 'bg-amber-500/15 text-amber-400',
  move: 'bg-sky-500/15 text-sky-500',
  // 「要你决定」自成一色：它和另外三个不是同类——那三个是"机器要做什么"，这个是"轮到你了"。
  decide: 'bg-violet-500/15 text-violet-400',
}

/** 界面图标与复制文本共用同一套 tone → 字形映射，别各写各的（复制出去的那段正是拿来对界面的）。 */
const TONE_GLYPH: Record<Extract<RowSlot, { kind: 'file' }>['tone'], string> = {
  gone: '✗',
  kept: '✓',
  undecided: '○',
  incoming: '✓',
}

/**
 * 一条动作 = 一张 Card。`key` 由调用方从 `row.key` 取（React 要求 key 挂在 map 出来的元素上）。
 *
 * **不用 `CardHeader`/`CardContent`**：那几个 sub-part 自带 `px-6`（24px），是为独立成页的大卡设计的；
 * 这里一屏要摞下五六张，padding 直接吃掉半屏。照 acrylic 的 `card-nested` 示例来——Card 自己给
 * `p-2.5`，里面用 `CardTitle` + 普通 div 排版。`CardFooter` 用了但把 `px-6` 抹成 `px-0`，
 * 图的是它那个稳定的 `data-slot="card-footer"`（④ 原因在测试里有名有姓地被取用）。
 */
export function ActionCard({ row, actions, onPickEpisode, busy }: {
  row: ActionRow
  actions?: ReactNode
  /**
   * 「就是这一集」——**行级**的答案，只有候选集行（`kind: 'episode'`）用得上。
   *
   * 为什么是行级而不是卡片级：这张卡问的是"到底是哪一集"，答案本身就要指名道姓。摆到卡片底部
   * 就得再做一个选择器，而选择的依据（各自的证据）明明就在每一行上——按钮长在它作用的那一行，
   * 才不用把两样东西对着看。不传 = 不出这个按钮（例如聚合视图里只读地摆着）。
   */
  onPickEpisode?: (leftKey: string) => void
  busy?: boolean
}) {
  return (
    <Card className="flex flex-col gap-1.5 p-2">
      {/* ① 这是哪一集。**名称先行，两个标记跟在后面**——一屏扫下来读到的第一个东西是集名，
          而不是每张卡都长一样的类别词。右上角留给复制按钮。 */}
      <div className="flex items-start justify-between gap-2">
        <CardTitle className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 self-start text-[13px] leading-snug">
          {/* **集名才是这张卡的标题**，所以它吃 CardTitle 的 foreground + semibold，不许压成 muted。
              作品名只有在同屏摆着多部作品（聚合视图）时才需要，那时它是**定语**不是标题——压成 muted
              让集名先被读到；而这一条没有集名时它顶上来当标题，就得跟着亮回去。 */}
          {row.groupLabel && (
            <span className={`min-w-0 break-words ${row.episode || row.fileName ? 'font-normal text-muted-foreground' : ''}`}>{row.groupLabel}</span>
          )}
          {/* 集名：从清单出发那一档它就是主角；从网盘文件出发那一档（`fileName` 在场）它退成定语——
              主次换了，信息一个字没删。 */}
          {row.episode && (
            <span
              {...(row.fileName ? {} : { 'data-testid': 'action-subject' })}
              className={`min-w-0 break-words ${row.fileName ? 'font-normal text-muted-foreground' : ''}`}
            >
              {row.episode}
            </span>
          )}
          {/* 文件名：**从网盘文件出发那一档的主角**。等宽字体——它是文件名不是作品名，和下面
              文件行里那条路径读的是同一个东西，字形一致才对得起来。 */}
          {row.fileName && (
            <span data-testid="action-subject" className="min-w-0 break-all font-mono text-[12px]">{row.fileName}</span>
          )}
          {/* 来路紧挨着动作类别（**在它左边**）：两个标记连起来读就是一句完整的话——
              「从网盘文件出发 · 删除免费集副本」。摆在这儿而不是标题最前面，是因为集名才是这张卡的
              标题；来路和动作类别同属"这是件什么事"，该在一起。缺席（老后端）整格不渲染，不留占位。 */}
          {row.origin && (
            <span
              data-testid="action-origin"
              data-origin={row.origin}
              className={`shrink-0 rounded px-1 py-px text-[9px] font-medium ${ORIGIN_TONE[row.origin]}`}
            >
              {ORIGIN_LABEL[row.origin]}
            </span>
          )}
          {/* 动作类别退成名称后面的小标记：✓/✗ 已经说清哪份留哪份走，它只答"这是换还是删"。 */}
          <span className={`shrink-0 rounded px-1 py-px text-[9px] font-medium ${LABEL_TONE[row.labelTone]}`}>{row.label}</span>
          {/* 节目单时长：这一集的**尺子**（下面每份文件的时长都对着它读）。用 Badge 的 `size="sm"`
              紧凑档，**不许拿 text-[11px] 之类的字号覆盖**——那会连 `leading-none` 一起剥掉，
              badge 当场撑大（见 acrylic badge.tsx）。没有 authorityDurationS 就整个不渲染。 */}
          {row.authorityDurationS != null && (
            <Badge variant="secondary" size="sm" className="shrink-0 tabular-nums">
              节目单 {fmtDur(row.authorityDurationS)}
            </Badge>
          )}
        </CardTitle>
        {/* 右上角两个次要动作：**ⓘ 在复制左边**。ⓘ 答"凭什么这么判"（读），复制答"拿去给别人看"
            （写）——读在写前面，且 ⓘ 没有判决书时整个不出现，那时这一角只剩复制、不留空占位。
            尺寸轴是 mini/small/medium/large/xl，从 mini 往上两档就是 `medium`（16px→24px 的圆钮、
            图标 12px→16px）。**别再往上加**：这个按钮一旦高过标题行的文字（18px），它就成了决定
            卡片高度的那一个——实测 medium 卡高 156、large 160，而收紧之前本来就是 156。
            也就是说 large 会把刚收掉的密度连本带利吐回去，为一个次要动作的按钮不值当。 */}
        <span className="flex shrink-0 items-center">
          {row.explain && <EvidenceButton explain={row.explain} />}
          <Button icon size="medium" variant="ghost" aria-label="复制这条决策" onClick={() => copyRow(row)}>
            <Copy />
          </Button>
        </span>
      </div>
      {/* ② 一个文件一个 Item，行位固定，处置方向由行首 ✓/✗ 说死。删除不可逆——"删这份"必须
          同时说清"留的是哪份"，两边都得摆全，否则这个确认按钮无从按起。 */}
      <ItemGroup className="gap-0.5">
        {row.slots.map((slot, i) => (
          <SlotLine key={slotKey(slot, i)} slot={slot} onPickEpisode={onPickEpisode} busy={busy} />
        ))}
      </ItemGroup>
      {/* ④ 凭什么。**判据链优先**（一列带实测值的信号），拿不出链才退回那一句现编的人话。
          要人回答的那类卡片把答案按钮摆在最后一行右边：**紧挨着理由**，读完"为什么问你"
          手就落在答案上，不用再往回找。 */}
      {row.chain ? (
        <VerdictChainBlock chain={row.chain} actions={actions} />
      ) : (
        <CardFooter className="flex items-end justify-between gap-2 px-0 text-[10px] leading-snug text-muted-foreground">
          <span className="min-w-0">原因：{row.reason}</span>
          {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
        </CardFooter>
      )}
    </Card>
  )
}

/**
 * ④ 判据链那一块：信号列 → 结论 → 灰的解释。
 *
 * **一条信号一行、左栏定宽**：竖着扫得出哪一条成立、哪一条卡住，而这正是这张卡唯一要答的问题。
 * 排成散文时读者得先把四件事从一句话里拆开（活体用户原话：「说明原因比较冗长」）。
 *
 * 结论坐在一块浅底上（`bg-muted/50`）：它是链的**落点**，不是又一条信号；而解释退成
 * `text-[9.5px]` 的灰——它是**猜测**（"可能是贴错了名字"），和实测值同权重会读成同等确定。
 */
function VerdictChainBlock({ chain, actions }: { chain: VerdictChain; actions?: ReactNode }) {
  return (
    <div data-testid="action-chain" className="flex flex-col gap-1">
      <div className="flex flex-col gap-px">
        {chain.signals.map((s) => (
          <SignalLine key={`${s.label}:${s.value}`} signal={s} />
        ))}
      </div>
      {chain.conclusion && (
        <p data-testid="chain-conclusion" className="rounded bg-muted/50 px-1.5 py-1 text-[10px] leading-snug text-foreground">
          {chain.conclusion}
        </p>
      )}
      <div className="flex items-end justify-between gap-2">
        {chain.hint
          ? <span data-testid="chain-hint" className="min-w-0 text-[9.5px] leading-snug text-muted-foreground">{chain.hint}</span>
          : <span />}
        {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
      </div>
    </div>
  )
}

/** 信号的字形与配色。`warn` 用 amber 而不是 red：它**不下结论**（码率低也可能是单声道口播），
 *  只把一个反常的数摆出来让人看见。红色会读成"机器判它坏了"。 */
const SIGNAL_TONE: Record<ChainSignal['tone'], { glyph: string; cls: string }> = {
  ok: { glyph: '✓', cls: 'text-[var(--acr-green)]' },
  no: { glyph: '✗', cls: 'text-destructive' },
  warn: { glyph: '!', cls: 'text-amber-500' },
}

function SignalLine({ signal }: { signal: ChainSignal }) {
  const t = SIGNAL_TONE[signal.tone]
  return (
    <span data-testid="chain-signal" data-tone={signal.tone} className="flex items-baseline gap-1.5 text-[10px] leading-snug">
      <span className={`w-2.5 shrink-0 text-center font-bold ${t.cls}`}>{t.glyph}</span>
      {/* 左栏定宽 + 不换行：三四个字的标签折了行，右边那列实测值就对不齐，没法竖着比。 */}
      <span className="w-11 shrink-0 whitespace-nowrap text-[9.5px] text-muted-foreground">{signal.label}</span>
      <span className="min-w-0 tabular-nums text-muted-foreground">{signal.value}</span>
    </span>
  )
}

/**
 * 一条路径：**目录段退到 muted、文件名保持 foreground**（信息一个字不删，只换权重）。
 *
 * 同一块里的两条路径常常只差最后那几个字符——活体里真出现过
 * `…/玄关笔记/52.财生官杀、伤官见官.mp3` 和 `…/玄关笔记/53.财生官杀、伤官见官.mp3`：
 * 前 55 个字符一模一样，而那一块问的恰恰是"留哪份"。整条同色时，最响的是每行都一样的公共前缀，
 * 最该被看见的文件名反而淹在末尾。
 *
 * **路径绝不 truncate**（被省掉的那截正是"哪个文件夹里的哪一份"），只靠 `break-all` 铺开。
 * 注意分成两段之后，测试里不能再用 `getByText(整条路径)` 取它——RTL 只看**直接文本子节点**，
 * 整条路径已经不在同一个文本节点里了；按 `textContent` 全等取（那也正好断言"整条完整摆着"）。
 */
function PathText({ path }: { path?: string }) {
  const p = path || '（未知）'
  const cut = p.lastIndexOf('/') + 1
  return (
    <span className="min-w-0 break-all font-mono text-[10px] text-muted-foreground">
      {p.slice(0, cut)}
      <span className="font-medium text-foreground">{p.slice(cut)}</span>
    </span>
  )
}

/**
 * 文件行 / 去向行共用的内容列：**上下两行**——路径一行、元数据一行，左边缘天然对齐（同一个 flex 列）。
 * 元数据**恒定独占一行**，不按路径长短决定折不折：同一张卡里有的行折了有的没折，那一列时长/体量
 * 就对不齐，没法竖着扫——而"这几份谁大谁长"正是竖着比出来的。
 *
 * **别把这两行塞回 `ItemDescription`**（旧形状踩过）：它自带 `line-clamp-2`，而 `line-clamp-*` 与
 * `flex` 是 tailwind-merge 的同一组（`line-clamp` 自己就设 `display`），`cn()` 会把 `flex` 直接
 * **删掉**，gap 随即变成 block 上的死代码，一行里的字段首尾相连，渲染成 `100:4492.3 MiB128k`；
 * 而且 `line-clamp-2` 会把长路径吞掉——路径绝不 truncate。`ItemContent` 只有 `min-w-0 flex-1`、
 * 不带任何 display 类，两个类从此不在同一个元素上，没得可冲突。
 *
 * 这个坑不会被文本断言抓到：`textContent` 不管有没有 flex 都是同一串（gap 不产生文本节点），
 * 所以测试里那条查的是 class。
 */
function SlotColumn({ children }: { children: ReactNode }) {
  return <ItemContent className="flex flex-col gap-y-0.5">{children}</ItemContent>
}

function SlotLine({ slot, onPickEpisode, busy }: {
  slot: RowSlot
  onPickEpisode?: (leftKey: string) => void
  busy?: boolean
}) {
  if (slot.kind === 'episode') {
    // 集行和文件行**长得要能分出来**：文件行的主体是等宽的路径，这里是集名（正常字体）+ 一行证据。
    // 图标位空着而不是给个 ○：那一列在这张卡上说的是"这几份文件谁留谁走"，集不参与那件事。
    return (
      <Item variant="muted" size="xs" className="items-start" data-testid="episode-slot" data-left-key={slot.leftKey}>
        <SlotColumn>
          <span className="min-w-0 break-words text-[11px] font-medium">
            {slot.title || <span className="font-mono text-[10px] text-muted-foreground">{slot.leftKey}</span>}
          </span>
          <span className="text-[10px] leading-snug text-muted-foreground">{slot.evidence}</span>
        </SlotColumn>
        {onPickEpisode && (
          <Button size="mini" variant="ghost" disabled={busy} onClick={() => onPickEpisode(slot.leftKey)}>
            就是它
          </Button>
        )}
      </Item>
    )
  }
  if (slot.kind === 'dest') {
    return (
      // 去向没有"留还是走"可言（它是个目录，不是被处置的一份），所以没有 ✓/✗ 那一格,
      // 形状照旧：一个「去向」标签 + 一条目录路径。
      <Item variant="muted" size="xs" className="items-start">
        <SlotColumn>
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            <span className="shrink-0 rounded bg-muted px-1 py-px text-[9px] font-medium text-muted-foreground">{slot.slot}</span>
            {/* 去向是**目录**,没有文件名那一段——整条都是"末级最重要",所以按同一套渲染即可
                （`PathText` 会把最后一段当文件名加重,对目录来说正好是落地的那个文件夹名）。 */}
            <PathText path={slot.dir} />
          </span>
        </SlotColumn>
      </Item>
    )
  }
  return <FileLine {...slot} />
}

/**
 * 一份文件占一个 `Item`：**处置图标**（✗ 走 / ✓ 留）+ **完整路径** + 库内/来源 · 时长 · 体量 · 码率。
 *
 * 承重的是那个图标（✗=没了、✓=留下）：**方向只由它说死**，不许靠行序反推——`replace`
 * 删的恰好是 ② 现任这一行，和删除类正好相反，反推必然翻车。图标坐在 `ItemMedia`（Item 的前导
 * 槽位），于是两行的图标与路径各自成列，一眼竖着扫得出"这张卡里谁走谁留"。
 *
 * 颜色走 token（`--acr-green` / `--destructive`），不写死色值：三套主题（light/dark/acrylic）
 * 各有自己的绿和红，写死的那个只在其中一套里对。
 *
 * `mark` 那个词（移出/保留/上位/删除/搬入）转成 `sr-only`：✓/✗ 对眼睛够用，但读屏用户不能只
 * 听到"图标"——它同时也让"这一行是被换掉还是被删掉"在无障碍树里保持可分。
 *
 * `data-tone` 是给测试的**稳定抓手**：方向（谁走谁留）是这张卡最不能错的一件事，断言必须钉在
 * 它身上，而不是去查 lucide 那个 svg 的内部（图标库一换形状就全红，且查不出语义）。
 *
 * 路径**绝不 truncate**：被省掉的那一截恰恰是"这是哪个文件夹里的哪一份"——两份同名文件一个在
 * 库里一个在来源里时，省略号一加，这一行就退化成"删一个叫 X 的文件"，用户答不出该不该点确认。
 * 长路径靠 `break-all` 换行铺开，宁可占两行也别吞。缺的字段整格不显示（别渲染 NaN / "未知"堆料）。
 *
 * 末尾那串元数据（库内/来源 · 时长 · 体量 · 码率）**拼成一段带 `·` 的文字，不是四个各自为政的
 * span**：光靠 flex 的 gap，一旦这段折到下一行行首，三个数字读起来仍是一串
 * （`100:4492.3 MiB128k`）——分隔符得写进文本里，才在任何折行位置都成立。
 */
/**
 * 一份文件末尾那串元数据：库内/来源 · 时长 · 体量 · 码率。缺的字段整格不出现（绝不 NaN / 空括号）。
 * **界面和复制文本共用这一份**——各拼各的必然分叉，而用户复制走的那段正是拿来对着界面核对的。
 */
function metaOf(facts: FileFacts): string[] {
  const kbps = kbpsOf(facts)
  return [
    facts.where ? (facts.where === 'lib' ? '库内' : '来源') : null,
    facts.durationS != null ? fmtDur(facts.durationS) : null,
    facts.size != null ? fmtBytes(facts.size) : null,
    kbps != null ? `${kbps}k` : null,
  ].filter((x): x is string => !!x)
}

/**
 * 换手那两行左侧的轨：走的那份红、来的那份天蓝，**红在上、蓝在下**——方向由颜色本身给出，
 * 不需要箭头也不需要一句话。轨画在行自己身上（`border-l`）而不是外面套一个绝对定位的渐变条：
 * 中间可能隔着别的行（`move` 那类是「这份 · 去向 · 等位的那份」），套一个整块的渐变就会把
 * 不参与换手的行也框进去，说出一层不存在的关系。
 */
const SWAP_RAIL = {
  out: 'border-l-2 border-l-destructive/45',
  in: 'border-l-2 border-l-sky-500/50',
} as const

const TONE_ICON = { gone: X, kept: Check, undecided: Circle, incoming: Check } as const
const TONE_CLASS = {
  gone: 'text-destructive',
  kept: 'text-[var(--acr-green)]',
  // 未定就该是灰的：候选里任何一份被染上绿/红，都等于替用户先答了一半。
  undecided: 'text-muted-foreground',
  // 下一轮才落位的那份：同样是 ✓（它确实是这个位置要留的那份），但染成「搬入」的天蓝——
  // 绿 ✓ 在这套卡片里只表示"**本轮**留下"，两者混用就把时间差抹掉了。
  incoming: 'text-sky-500',
} as const

/**
 * `<audio>` 放得了的容器。**只对音频出试听按钮**：mkv 之类它压根解不了，给一个点下去必然
 * 失败的按钮比没有更糟——用户会以为文件坏了，而真相只是浏览器不解这个容器。视频那一侧的
 * "这是哪一集"走播放器那条路。
 */
const AUDIBLE_RE = /\.(mp3|m4a|m4b|aac|flac|wav|ogg|opus|weba)$/i

/**
 * 同一时刻只许一个音频在响。一屏摞着五六张卡，两个声音叠着就什么都听不出来——而"听得清"
 * 正是这个按钮存在的全部理由。**模块级一个把手**（不是 context）：这几张卡本来就散在
 * 「可以自动完成」「要你决定」「将删清单」三处，共享一个 Provider 反而要把它们绑到同一棵子树上。
 */
let nowPlaying: { stop: () => void } | null = null

/**
 * 试听这一份文件。**它是这张卡上唯一能证伪机器判断的东西**：文件名、时长、体量、码率全对得上，
 * 里面装的仍可能是另一集——活体 2026-08-02 那份 `37.申与酉.mp3` 装的其实是
 * 《037.三谈身边灵异事》，编号是搬文件时按名字错配的，任何元数据都看不出来。
 *
 * `preload="none"`：一屏五六张卡，谁都不点也不该去网盘拉字节。取链失败（文件已删/AList 断）
 * 由 `onError` 弹一句人话——**不静默**：一个点了没反应的播放按钮会被当成"这文件坏了"，
 * 而真因可能只是登录态过期。
 */
function PlayButton({ path }: { path: string }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [on, setOn] = useState(false)
  // 把手的身份要跨渲染稳定（`nowPlaying === self.current` 是"正在响的是不是我"的判据），
  // 而停的动作每次渲染都重新绑一次最新的 setter。
  const self = useRef<{ stop: () => void }>({ stop: () => {} })
  self.current.stop = () => {
    audio.current?.pause()
    setOn(false)
  }
  // 卡片被换掉/面板关掉时把台子让出来，否则下一个人按下播放会去 stop 一个已经卸载的组件。
  useEffect(() => {
    const me = self.current
    return () => {
      me.stop()
      if (nowPlaying === me) nowPlaying = null
    }
  }, [])

  const toggle = () => {
    if (on) {
      self.current.stop()
      if (nowPlaying === self.current) nowPlaying = null
      return
    }
    if (nowPlaying && nowPlaying !== self.current) nowPlaying.stop()
    nowPlaying = self.current
    setOn(true)
    audio.current?.play()?.catch((e: unknown) => {
      setOn(false)
      toast.error('放不出来', { description: e instanceof Error ? e.message : String(e) })
    })
  }

  return (
    <>
      <Button
        icon
        size="medium"
        variant="ghost"
        data-testid="action-play"
        data-playing={on}
        aria-label={on ? '暂停' : '试听这份文件'}
        onClick={toggle}
      >
        {on ? <Pause /> : <Play />}
      </Button>
      <audio
        ref={audio}
        preload="none"
        src={`/api/netdisk/raw?path=${encodeURIComponent(path)}`}
        onEnded={() => setOn(false)}
        onError={() => {
          if (!on) return // 没点过就报错 = 浏览器自己去探了一下，别弹给用户
          setOn(false)
          toast.error('放不出来', { description: '取不到这份文件的直链（文件已删，或网盘登录态过期）' })
        }}
      />
    </>
  )
}

function FileLine({ mark, tone, facts, swap }: Extract<RowSlot, { kind: 'file' }>) {
  const meta = metaOf(facts)
  const Glyph = TONE_ICON[tone]
  return (
    <Item
      variant="muted"
      size="xs"
      className={`items-start ${swap ? SWAP_RAIL[swap] : ''}`}
      {...(swap ? { 'data-swap': swap } : {})}
    >
      {/* size 覆盖必须带上 `group-data-[size=xs]/item:` 这个修饰前缀:ItemMedia 自己就是用带修饰的
          类设的尺寸(xs → size-7),裸写一个 `size-4` 在 tailwind-merge 眼里是另一个键,盖不掉它。 */}
      <ItemMedia
        data-tone={tone}
        className={`self-start group-data-[size=xs]/item:size-4 ${TONE_CLASS[tone]}`}
      >
        <Glyph strokeWidth={2.5} />
        <span className="sr-only">{mark}</span>
      </ItemMedia>
      <SlotColumn>
        <PathText path={facts.path} />
        {meta.length > 0 && <span className="tabular-nums text-[10px] text-muted-foreground">{meta.join(' · ')}</span>}
      </SlotColumn>
      {/* 换手里**下一轮才落位**的那一份：卡上其余每一行都是本轮的事，只有它是异时态，
          所以徽章只挂在它身上（见 `RowSlot` 头注）。「轮」= 一次整理，不是一次采集——
          执行完再预览一次它就落位，定时轮也会跑到；那句话进 title，不占行内的字。 */}
      {swap === 'in' && (
        <span
          data-testid="slot-phase"
          title="删掉上面那份、位置腾空后，下一次整理时自动搬进来——再预览一次即可，定时轮也会跑到"
          className="shrink-0 self-start rounded bg-sky-500/15 px-1 py-px text-[9px] font-medium leading-relaxed text-sky-500"
        >
          下轮落位
        </span>
      )}
      {/* 试听坐在**行尾**、贴着这一份文件：一张卡上可能摆着两三份（留哪个 / 换正主），
          按钮必须和它作用的那一份在同一行，摆到卡片抬头上就说不清"听的是哪一份"了。 */}
      {AUDIBLE_RE.test(facts.path) && <PlayButton path={facts.path} />}
    </Item>
  )
}

/**
 * ① 的标签说的是**动作类别**（换 / 删 / 搬），不是判据。
 *
 * 用户一屏扫过去，第一位的问题是"这行要干什么"；"凭什么"是他停下来读某一行时才问的，而那个答案
 * 第 ④ 行的原因句里写得比任何标签都清楚（带具体数字）。把判据（`质量更优`/`时长择优`/…）放进标签
 * 等于把次要信息摆到最显眼处，还把最重要的动作类别挤掉了。
 */
function actionLabel(a: ReconcilePlanAction): string {
  if (a.kind === 'replace') return '换正主'
  if (a.kind === 'delete-loser') return '删除同集副本'
  return '删除重复'
}

/** 目的目录 → 人话:「下架」「付费」「付费/玄关笔记」。 */
export function dirLabel(dstDir?: string): string {
  if (!dstDir) return ''
  const parts = dstDir.split('/')
  const last = parts.pop() ?? ''
  const parent = parts.pop() ?? ''
  return parent === '付费' ? `${parent}/${last}` : last
}

/**
 * `move` 的④「凭什么」。判据同样只认机器可读的 `basis` 前缀（后端 `plan.ts`）：
 * `authority:` = 匹配器已经把它认成节目单里的这一集；`sole-candidate:` = 这一集还空着、
 * 它是唯一候选（时长或名字对得上）；`no-duration-hit:` = 两个信号都不指向任何一集 → 进下架货架。
 *
 * 这一句不是装饰：活体真发生过 5 条 move 全对、用户看着列表判断成"错误匹配"——没有它，
 * 一行搬运就只是"某个文件要挪走"，无从核对。
 */
function moveReason(a: ReconcilePlanAction): string {
  const b = a.basis ?? ''
  if (b.startsWith('authority:')) return '匹配器把它认成节目单里的这一集'
  if (b.startsWith('sole-candidate:')) return '这一集还空着，它是唯一候选（时长或名字对得上）——直接认领搬入'
  if (b.startsWith('no-duration-hit:')) return '时长和名字都对不上节目单任何一集 → 进下架货架（那儿本身是一条可播的来源，不是消失）'
  // 下架货架每轮回头看：源站把这一集重新上架了，而下架那份是唯一副本 → 接回付费货架。
  if (b.startsWith('relisted:')) return '源站重新上架了这一集，而下架货架那份是唯一副本——接回付费货架'
  return `搬进${dirLabel(a.dstDir)}`
}

/** 文件名里的清晰度标签。判据与后端 `compareQuality` 同一套（`4k` 就是 `2160p`）——两边说法不一致，
 *  用户看到的理由就会和机器真正做的事对不上。没标 = null，那半句整句不写。 */
const QUALITY_RE = /(2160p|1080p|720p|540p|480p|4k)/i
function qualityTag(path: string): string | null {
  const m = QUALITY_RE.exec(baseName(path))
  if (!m) return null
  const q = m[1].toLowerCase()
  return q === '4k' ? '2160p' : q
}

function kbpsOf(f: FileFacts): number | null {
  return f.size && f.durationS ? Math.round((f.size * 8) / f.durationS / 1000) : null
}

/** 「谁质量高」那半句证据。**判据顺序照抄后端**：先清晰度档、再码率。两样都算不出就返回 null——
 *  这一段整段不写，宁可短，绝不出现空括号 / `NaN` / `undefined`。 */
function qualityClause(hi: FileFacts, lo: FileFacts, op: '>' | '≥'): string | null {
  const [qh, ql] = [qualityTag(hi.path), qualityTag(lo.path)]
  if (qh && ql && qh !== ql) return `清晰度 ${qh} ${op} ${ql}`
  const [bh, bl] = [kbpsOf(hi), kbpsOf(lo)]
  if (bh != null && bl != null) return `码率 ${bh}k ${op} ${bl}k`
  return null
}

/**
 * ④ 原因：由**机器可读的 `basis` 前缀** + `compare` 里的数字现场组装，一律人话 + 具体数字。
 *
 * **绝不解析后端那句中文 `reason`**：那是给人看的散文，措辞随时会改，靠它做分支等于把 UI 挂在
 * 一个没有契约的字符串上。数字全部从这两份文件自己的 size/durationS 与节目单时长算——算不出的量
 * 就不写那一段（宁可短，绝不 `NaN` / 空括号）。
 *
 * `swap` 决定人称：`replace` 时留下的是 ③（"这份"），删除类留下的是 ② （"现任"）。
 */
function reasonOf(a: ReconcilePlanAction, incumbent: FileFacts, other: FileFacts, swap: boolean): string {
  const b = a.basis ?? ''
  const wrap = (head: string, clause: string | null, tail = '') => `${head}${clause ? `（${clause}）` : ''}${tail}`

  if (b.startsWith('size-dup-of:') || (!a.basis && a.kind === 'delete-dup')) {
    const size = other.size ?? incumbent.size
    return wrap('两份字节数完全相同 = 同一份文件', size != null ? fmtBytes(size) : null)
  }
  if (b.startsWith('quality-upgrade:')) return wrap('这份质量更高', qualityClause(other, incumbent, '>'), '，换上去')
  if (b.startsWith('authority-duration:')) {
    // 留下的那份离节目单更近；括号里报**落选那份**离节目单差多少——那才是它落选的理由。
    const [closer, farther] = swap ? [other, incumbent] : [incumbent, other]
    const [cn, fn] = swap ? ['这份', '现任'] : ['现任', '这份']
    const auth = a.compare?.authorityDurationS
    if (auth != null && closer.durationS != null && farther.durationS != null) {
      const off = Math.round(Math.abs(farther.durationS - auth))
      return `${cn}时长 ${fmtDur(closer.durationS)} 更贴近节目单 ${fmtDur(auth)}（${fn} ${fmtDur(farther.durationS)}，差 ${off} 秒）`
    }
    return `${cn}的时长更贴近节目单，留它`
  }
  if (b.startsWith('name-authority:')) {
    const [yes, no] = swap ? ['这份', '现任'] : ['现任', '这份']
    return `${yes}文件名和节目单这一集对得上，${no}对不上`
  }
  if (b.startsWith('quality-unknown:')) {
    const gap = incumbent.durationS != null && other.durationS != null
      ? Math.round(Math.abs(incumbent.durationS - other.durationS))
      : null
    const clause = gap ? `时长差 ${gap} 秒，不是同一份内容` : '清晰度与码率都比不出来'
    return `两份比不出高下（${clause}），保留新来的这份`
  }
  if (b.startsWith('shelf-copy-of:')) {
    // 复核**没有比过质量**——它落选的理由是"正主已经在付费货架上了"。套用默认那句
    // 「现任质量不低于这份」会是假话，而这一行是确认档、用户要照着它点删除。
    return '下架货架上这份是同一集的另一份，正主已经在付费货架上——留正主，删这份'
  }
  if (a.kind === 'replace') return a.newName ? `换上这份、移出现任，改名为 ${a.newName}` : '换上这份、移出现任'
  return wrap('现任质量不低于这份', qualityClause(incumbent, other, '≥'))
}

/** 留下的那份：`delete-loser` 记在 keptPath，`delete-dup` 记在 dupOf。 */
function keptOf(a: ReconcilePlanAction): string {
  return a.keptPath ?? a.dupOf ?? ''
}

export function baseName(p: string): string {
  return p ? p.slice(p.lastIndexOf('/') + 1) : ''
}
/** react key。同一路径在一张卡里只会出现一次，桥那行按序号——它没有身份可言。 */
function slotKey(slot: RowSlot, i: number): string {
  if (slot.kind === 'dest') return `dest:${slot.dir}`
  if (slot.kind === 'episode') return `ep:${slot.leftKey}`
  return slot.facts.path || String(i)
}
/** 网盘文件按 GiB/MiB 量级说（视频动辄几个 G，报成 MB 读不出量级）。 */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`
  return `${bytes} B`
}
