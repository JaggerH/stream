/**
 * 档 B：**收件箱里的跨平台归堆**——同一个作者把同一条内容发到了抖音、B 站、小红书。
 *
 * 和档 A（搜索折叠，`./fold.ts`）共用判据的**零件**（`foldTitle` / `serialConflict` / `titleSim`），
 * 但配的是完全不同的证据组合：搜索那边只有标题，这边有**时长和作者**——时长是这条线上
 * 最硬也最便宜的证据（同一条视频搬到哪个平台，秒数几乎必然一致），而且它**不用联网、
 * 不用下封面**，直接躺在 normalize 好的 `content.media` 里。
 *
 * **为什么不做封面感知哈希**：算 dHash 要先把图下下来。这段代码跑在**采集入库的热路径**上
 * （`scheduler.ts` 写库之后那一跳），在那里发网络请求就是把每次采集拖慢一个数量级，
 * 还给一条本该纯本地的判据引入了失败模式。时长 + 标题已经够，封面留给以后真需要时的
 * 离线补算（那时它是个后台 job，不是这一跳）。
 */

import type { SourceType } from '../manifest/types.ts'
import type { StreamItem } from '../types.ts'
import { titleSim } from '../text/similarity.ts'
import { sketchSim } from '../text/shingle.ts'
import { foldTitle, serialConflict, urlKey, type Evidence } from './fold.ts'

/**
 * 归堆索引里的一行：**判据要用的字段，全部提前抠好**。
 *
 * 不直接拿 `StreamItem` 两两比，是因为找近邻要按时长查库——把 duration 抠成一列才索引得上。
 * 否则每来一条新 item 就得把窗口内几千条的 JSON 全解一遍。
 */
export interface IndexRow {
  itemId: string
  streamId: string
  author?: string
  /**
   * **内容身份**：正文/转写的文本草图（`src/text/shingle.ts`）。缺席 = 这条还没取到文本，
   * 于是**判不了**——不是"不像"。取文本要么白拿（文字类正文本来就在），要么走转写，
   * 后者十几秒，所以它在后台补，不在采集那一跳。
   */
  textSig?: number[]
  /** 这份文本哪来的：`inline` 正文 / `article` 网页 / `stt` 转写。排错和成本复盘要看它。 */
  textSource?: string
  /** 秒。抠自 `content.media` 里的 video/audio。没有 = 这条没时长可比。 */
  durationS?: number
  /** 归一化之后的标题（`foldTitle`）。存归一化后的，比对时不用反复算。 */
  titleFold: string
  /** 原标题——只用于产出人话理由和序号判据。 */
  title: string
  urlKey?: string
  /** 发布时间（缺则取 fetched_at）。窗口查询按它。 */
  ts: string
}

/** 从一条 item 抠出时长：video / audio 都带 `duration_s`。 */
function durationOf(item: StreamItem): number | undefined {
  for (const m of item.content?.media ?? []) {
    if ((m.kind === 'video' || m.kind === 'audio') && typeof m.duration_s === 'number' && m.duration_s > 0) {
      return Math.round(m.duration_s)
    }
  }
  return undefined
}

/** 一条 item → 索引行。**在入库那一跳算一次**，之后所有比对都只读这张表。 */
export function indexRowOf(item: StreamItem, _type?: SourceType): IndexRow {
  return {
    itemId: item.id,
    streamId: item.stream_id,
    author: item.author,
    durationS: durationOf(item),
    titleFold: foldTitle(item.title ?? ''),
    title: item.title ?? '',
    urlKey: item.url ? urlKey(item.url) : undefined,
    ts: item.timestamp || item.fetched_at,
  }
}

export interface InboxProfile {
  /**
   * 文本草图过这条线 = 同一条内容。
   *
   * 0.55：同一段音频被两个 ASR 引擎转出来、或同一篇稿子被两个站清洗过，正文会有出入
   * （错字、片头问候、平台加的水印文案），实测这类改动把相似度压到 0.6 附近；而"讲同一个
   * 话题但不是同一段话"实测 <0.2。两者之间空得很开，取中间偏下。
   */
  textThreshold: number
  /** 候选生成用的时长容差（秒）。**只用来缩候选，不参与结论。** */
  durationToleranceS: number
  /** 候选生成用的标题相似度下限。同上：只决定"值不值得取文本比一比"。 */
  candidateTitleThreshold: number
}

/** 收件箱这一档。两道硬闸门先于一切：同 Stream 内永不归堆、序列身份冲突一票否决。 */
export const INBOX_PROFILE: InboxProfile = {
  textThreshold: 0.55,
  durationToleranceS: 1,
  candidateTitleThreshold: 0.35,
}

/**
 * 同一个 Stream 里的两条**永远不归堆**。
 *
 * 一个 Stream = 一个源 + 一个账号，它自己的两条内容按定义就是两条不同的内容；
 * 那里出现的"标题很像"只会是同一档节目的两集。**这条闸门比阈值可靠得多**——
 * 它不依赖任何相似度，也不会随阈值调整而失效。
 */
function crossStream(a: IndexRow, b: IndexRow): boolean {
  return a.streamId !== b.streamId
}

/**
 * **值不值得为这一对去取文本。** 这是候选闸门，不是判据——它宁可放过头也不该漏，
 * 因为漏掉的那一对永远不会被再看一眼；而放宽的代价只是多取一次文本（多半还是白拿的正文）。
 *
 * 时长和标题都在这里，也只在这里。它们的作用是把"要比的对"从全库缩到个位数。
 */
export function worthChecking(a: IndexRow, b: IndexRow, profile: InboxProfile): boolean {
  if (!crossStream(a, b)) return false
  if (serialConflict(a.title, b.title)) return false
  if (a.urlKey && a.urlKey === b.urlKey) return true
  const durClose =
    a.durationS !== undefined &&
    b.durationS !== undefined &&
    Math.abs(a.durationS - b.durationS) <= profile.durationToleranceS
  return durClose || titleSim(a.titleFold, b.titleFold) >= profile.candidateTitleThreshold
}

/** 判据的三种收场。**「不像」和「还判不了」必须分开**——前者是结论，后者要去取文本。 */
export type Verdict =
  | { kind: 'same'; evidence: Evidence }
  | { kind: 'different' }
  | { kind: 'need-text'; who: IndexRow[] }

/**
 * 这两条是不是同一件内容。**判据是文本，不是标题也不是时长。**
 *
 * 同一条内容被重新投放时，标题会被改写、封面会换、时长会因转码/剪片头差几秒、链接必然
 * 不同——**只有内容本身不变**。所以身份落在正文/转写的文本草图上；标题和时长退成
 * **候选生成器**（`store.neighbors` 用它们把候选缩到个位数），一个字都不参与结论。
 *
 * 这一条是被活体打出来的：时长当判据时，两个歌单共享几十首歌，四分钟左右的歌互相乱折，
 * 一个堆滚到 22 条。**时长从来不是身份。**
 *
 * **作者也不参与判断。** 搬运号发的和本人发的是同一条内容，本来就该收在一起。
 * 「谁发的」的价值在别处：看哪个源在同质内容上持续先发（`byPublishOrder` → `source_lead`）。
 */
export function sameStoryInbox(a: IndexRow, b: IndexRow, profile: InboxProfile): Verdict {
  if (!crossStream(a, b)) return { kind: 'different' }
  // 同一个链接是**事实**，不需要文本佐证。
  if (a.urlKey && a.urlKey === b.urlKey) {
    return { kind: 'same', evidence: { kind: 'url-identity', score: 1, detail: `同一个链接：${a.urlKey}` } }
  }
  // 集号/期号/上下集对不上 → 一票否决。这道闸门在取文本之前先走：省掉一次十几秒的转写，
  // 而且它比任何相似度都可靠（同一档节目的两集，正文也可能很像）。
  if (serialConflict(a.title, b.title)) return { kind: 'different' }

  const missing = [a, b].filter((r) => !r.textSig?.length)
  if (missing.length) return { kind: 'need-text', who: missing }

  const sim = sketchSim(a.textSig!, b.textSig!)
  if (sim < 0) return { kind: 'need-text', who: [a, b] } // 草图空 = 文本太短，等于没取到
  if (sim >= profile.textThreshold) {
    return {
      kind: 'same',
      evidence: { kind: 'text-identity', score: sim, detail: `正文/转写几乎一样（${sim.toFixed(2)}，来源 ${a.textSource ?? '?'}/${b.textSource ?? '?'}）` },
    }
  }
  return { kind: 'different' }
}

/**
 * 一堆里谁先发的。**这是「来源」在归堆之后唯一的作用**：不参与"是不是同一条"的判断，
 * 只回答"哪个源在同质内容上持续领先"。
 *
 * 返回按发布时间排好的成员；第一个就是首发。并列（同一秒）算并列第一，不硬分先后——
 * 两个平台同一秒发出来，判谁领先是编造精度。
 */
export function byPublishOrder<T extends { ts: string; streamId: string }>(rows: T[]): T[] {
  return [...rows].sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0))
}
