// src/conversions/derive.ts
//
// 「这条落定的转换，该自动排出下一条什么」——转成文字那条梯子的**唯一**一张规则表。
//
// 设计见 docs/superpowers/specs/2026-08-14-extract-progressive-ladder-design.md §3：
// extract 只做底座，更深的层作为**独立的 conversion** 派生上去——最贵的那份（转写）必须
// 落地即安全，上层塌了不能把它带走。
//
// 纯函数：不碰 store、不认识 runner、不知道后端配没配。真去排队是 runner 的事。
//
// `derivationsFor` 是单循环：某条规则的 `when` 谓词抛出会让**整张规则表**一起中止
// （外层 runner 接住这个异常，当作「这条记录没有要派生的东西」，见 runner.ts 的 deriveFrom）。
// 表里现在有两条规则（转写→补说话人、转写→抽帧），这条风险已经是真的：任何一条 `when`
// 抛出，都会把同一轮里另一条本该派生的规则一起静默吃掉。`when` 必须是纯判断（不碰 store、
// 不打 I/O），只看传进来的这条记录，不许抛。
import { segmentsIn } from '../../shared/extract/transcript.ts'
import { transcribableMedia } from '../transcribe/media.ts'
import type { Media } from '../content/types.ts'
import type { ConversionKind, ConversionRecord } from './store.ts'

export interface DerivationRule {
  /** 上游 kind。 */
  from: ConversionKind
  /** 上游成功后要排的 kind。 */
  to: ConversionKind
  /** 看着上游那条**已落定**的记录决定派不派。返回 false = 这条 item 不需要这一层。 */
  when: (rec: ConversionRecord) => boolean
}

/**
 * 转写 → 抽帧取画面文字。
 *
 * 同样以「带不带时间轴」为「这条走没走转写分支」的判据（复用 `segmentsIn`，别第二次实现）。
 * 另一半判据是「这条 item 是不是视频」——**只能看上游 result 里现成的东西**（`detail.media`），
 * 因为 `when` 是纯判据：它拿不到 store，也不许打任何 I/O（谓词抛出会被 runner 的外层 try
 * 当成「没有要派生的」，静默吃掉**整张表**）。
 *
 * 判据方向刻意偏放行：`media` 缺席 = 判不出来 → 放行。真不是视频的那些，由 converter 自己
 * 的第 3 步兜底（`resolveVideoSource` 回 null → `probe.stop = 'no_source'`，零字节、ok:true）。
 * **宁可多派生一条便宜的转换，不可漏掉一条真有画面文字的视频**——多派的那条代价是一次
 * 查表，漏掉的那条代价是那页幻灯片的字永远不进正文，且没有任何一处会喊。
 * 只有「media 明确在、且里头一个 video 都没有」（纯音频播客）才拦下来。
 */
const TRANSCRIPT_TO_FRAMES: DerivationRule = {
  from: 'extract',
  to: 'frames',
  when: (rec) => {
    if (segmentsIn(rec) === undefined) return false
    const media = (rec.result as { detail?: { media?: { kind?: string }[] } } | undefined)?.detail?.media
    if (!media || media.length === 0) return true // 判不出来 → 放行
    return media.some((m) => m?.kind === 'video')
  },
}

/** 今天全部的**接力**规则（上游落定之后才排）。**加一层就在这里加一行**。 */
export const CONVERSION_DERIVATIONS: readonly DerivationRule[] = [TRANSCRIPT_TO_FRAMES]

// —— 并肩起跑 ——

/**
 * 「起这条转换的同时，还要起哪些」——和上面那张表是**两件事**，别合并。
 *
 * 上面那张表是**接力**：上游的产物就是下游的判据（抽帧要读转写才知道值不值得抽），所以必须
 * 等。这张表是**并肩**：两件事只是碰巧要同一份字节，谁也不是谁的输入，等就是白等。
 *
 * 判据只看得到起跑那一刻手里的东西（itemId + options），**没有上游记录可读**——这正是它和
 * `DerivationRule` 用不同签名的原因。
 */
export interface CostartRule {
  /** 起这个 kind 的时候。 */
  from: ConversionKind
  /** 同时也起这个。 */
  to: ConversionKind
  when: (options: Record<string, unknown>) => boolean
}

/**
 * 取白文 ‖ 补说话人。
 *
 * 这两件事只共用一样东西：那段音频。转写答「说了什么」，声纹答「谁说的」，**互不为输入**。
 * 以前是接力（转写落定才排声纹），代价是把 20–140s 的取白文串在 200–900s 的分人前面白等。
 *
 * 投影（把说话人标签贴到文字段上）确实要文字——但它发生在分人**之后**，那时取白文早跑完了，
 * identify converter 到那一步才去读上游（见该文件里那条注释）。真赶上上游还没好，就少一次
 * 投影，时间线照样落库、照样成功。
 *
 * 判据：这条 item 有没有能转写的音视频。用后端真身那个具名判断（`transcribableMedia`），
 * **不另写一份** ——两份判据漂移了是「一边说行、另一边说不行」的静默错位。
 * 拿不到 media（判不出来）→ 不起：这一层贵，宁可漏掉一次自动起跑（用户点一下就有），
 * 也不要对着一堆网页/图片白起一批必然 no_media 的记录。
 */
const EXTRACT_ALONGSIDE_IDENTIFY: CostartRule = {
  from: 'extract',
  to: 'identify',
  // `options` 是从 HTTP body 一路递进来的，形状是调用方说了算、不是类型说了算——**必须先验
  // 是不是数组**。`transcribableMedia` 对一个字符串会当场抛，而 `when` 抛出会被外层当成
  // 「没有要并肩的」静默吃掉整张表。
  when: (options) => Array.isArray(options.media) && transcribableMedia(options.media as Media[]) !== undefined,
}

/** 今天全部的并肩规则。 */
export const CONVERSION_COSTARTS: readonly CostartRule[] = [EXTRACT_ALONGSIDE_IDENTIFY]

/** 起这个 kind 时还要并肩起哪些。去重，顺序按规则表。 */
export function costartsFor(
  kind: ConversionKind,
  options: Record<string, unknown>,
  rules: readonly CostartRule[],
): ConversionKind[] {
  const out: ConversionKind[] = []
  for (const rule of rules) {
    if (rule.from !== kind) continue
    // 自并肩是无限递归（起 X 又起 X 又起 X…）。规则表是人手写的，这里挡住比指望写表的人不写错可靠。
    if (rule.to === rule.from) continue
    if (!rule.when(options)) continue
    if (!out.includes(rule.to)) out.push(rule.to)
  }
  return out
}

/**
 * 这条记录该派生出哪些 kind。去重，顺序按规则表。
 *
 * 只有 `done` 才派：失败的上游没有产物，判据无从下手；而「重试上游」是用户的意图，
 * 不该由一条自动派生替他做决定。
 */
export function derivationsFor(rec: ConversionRecord, rules: readonly DerivationRule[]): ConversionKind[] {
  if (rec.status !== 'done') return []
  const out: ConversionKind[] = []
  for (const rule of rules) {
    if (rule.from !== rec.kind) continue
    // 自派生是无限循环。规则表是人手写的，这里挡住比指望写表的人不写错更可靠。
    if (rule.to === rule.from) continue
    if (!rule.when(rec)) continue
    if (!out.includes(rule.to)) out.push(rule.to)
  }
  return out
}
