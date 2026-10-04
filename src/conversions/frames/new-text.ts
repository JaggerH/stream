/**
 * 帧上的字 vs 同一时刻的转写，只留新的 —— spec §5.1。
 *
 * 一帧 OCR 出来的字里，很大一部分是烧进画面的字幕（标题条、水印、弹幕同理），
 * 跟同一时刻的语音一模一样，留着就是重复污染。这里判的就是这个：逐行看这帧上
 * 的字跟「此刻前后」的转写重不重，重的丢、不重的留。
 *
 * 为什么按时刻不按全片：全片比对会把「他后面才念到的那页要点」也当成字幕丢掉——
 * 那页在出现的当下确实是新信息，只是语音晚到。
 *
 * 为什么逐行不整段：一帧上常常一半是字幕、一半是幻灯片正文，整段比会一起留或
 * 一起丢，必须拆开判。
 *
 * 重合度算法：两边都归一化（去空白、去标点、转小写）后按字符 bigram 求
 * Jaccard——中文没有空格，按词切要引分词器，bigram 是不引依赖的最简可用形状。
 */

export interface Segment {
  start: number
  end: number
  text: string
}

/**
 * 时间窗口半径（秒）：判定某一帧的重合度时，往前往后各看这么多秒的转写。
 *
 * 未量过，只是起点。量法同 gate.ts 的两个阈值：拿库里已有转写+抽帧的真实
 * 视频跑一遍，看语速正常时一句话大致跨度多少秒、幻灯片停留时长大致多少秒，
 * 找一个既不会把邻近两页内容都框进来、又不会窄到把稍有语音提前/滞后的正常
 * 字幕漏判为「新」的数字。当前 15 只是「一页幻灯片/一段话大致的停留量级」
 * 的直觉数字。
 */
export const DEFAULT_WINDOW_S = 15

/**
 * 重合度门槛：某行与窗内转写的重合度达到它才判「重复」→ 丢；否则留。
 *
 * 未量过，只是起点。量法同上，跑一遍真实样本，看已知字幕行与转写的重合度
 * 落在哪个范围、真正的新内容（代码/图表/未读到的要点）落在哪个范围，找能
 * 分开两簇的数字。
 *
 * 门槛必须偏向「宁可留」：判成重合就永久丢掉那行，没有任何一处会喊；判成
 * 新只是正文里多留几个字，代价小得多。阈值只应该在有真实样本支持时往下调
 * （更容易判重复），不该轻易往上调。
 */
export const DEFAULT_OVERLAP = 0.6

export interface NewTextResult {
  /** 帧上「转写拿不到」的那部分，按行留。全被判重合就是空串。 */
  newText: string
  /** 逐行判定，进账用。 */
  lines: Array<{ text: string; overlap: number; kept: boolean }>
}

/** 去空白、去标点（含中英文标点符号）、转小写——两边比之前都要过这一步。
 *  `dedupe-track.ts` 的「这两行是不是同一行」也用它：两处必须同一把尺子，
 *  否则会出现「重合判据认得出、跨帧去重认不出」的静默错位。 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 归一化文本的字符 bigram 集合。长度 < 2 时退化成单字符集合，避免空集导致的边界问题。 */
function bigrams(normalized: string): Set<string> {
  const set = new Set<string>()
  if (normalized.length === 0) return set
  if (normalized.length === 1) {
    set.add(normalized)
    return set
  }
  for (let i = 0; i < normalized.length - 1; i++) {
    set.add(normalized.slice(i, i + 2))
  }
  return set
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  for (const x of a) {
    if (b.has(x)) intersection += 1
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * 某一帧文字与窗内转写比，逐行判「新 vs 重复」。
 *
 * 重合度按行与窗内**每条 segment 分别比、取最大值**，不是把窗内所有 segment
 * 拼成一大段再比——拼接会让一条精确匹配的 segment 被窗口里其它不相关的转写
 * 稀释，把本该判重的行误判成新（bigram 的分母被无关内容撑大，Jaccard 假性
 * 走低）。逐条取最大值才对得上「这一行到底像不像窗内某一句话」这个问题。
 */
export function newTextAt(
  frameText: string,
  at: number,
  segments: readonly Segment[],
  opts?: { windowS?: number; overlap?: number },
): NewTextResult {
  const windowS = opts?.windowS ?? DEFAULT_WINDOW_S
  const overlapThreshold = opts?.overlap ?? DEFAULT_OVERLAP

  const windowSegments = segments.filter(
    (s) => s.end >= at - windowS && s.start <= at + windowS,
  )
  const windowBigramSets = windowSegments.map((s) => bigrams(normalize(s.text)))

  const rawLines = (frameText ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  const lines = rawLines.map((text) => {
    const lineBigrams = bigrams(normalize(text))
    const overlap =
      windowBigramSets.length === 0
        ? 0
        : Math.max(...windowBigramSets.map((segBigrams) => jaccard(lineBigrams, segBigrams)))
    const kept = overlap < overlapThreshold
    return { text, overlap, kept }
  })

  const newText = lines
    .filter((l) => l.kept)
    .map((l) => l.text)
    .join('\n')

  return { newText, lines }
}
