/**
 * 帧文字轨的**文本级去重** —— spec §5.3 末尾那条：「哈希层宁可多留，OCR 之后再做文本级去重」。
 *
 * 哈希层判的是「画面变了没有」，它必须偏向多留（少留一帧 = 那页的字永远进不来）。
 * 代价就落在这里：同一页幻灯片跨好几个关键帧、水印/角标出现在每一帧，逐帧 OCR 出来
 * 之后轨里全是重复。
 *
 * **为什么这一步不能省，活体已经打过脸**：`newTextAt` 的重合判据是拿帧上的字跟同一时刻的
 * 转写比——**没有转写就没有比较对象，于是每一行都算「新的」**。而闸门恰恰把「没有转写」
 * 判为最该抽的一类（`gate.reason === 'no_transcript'`）。两件事对上的结果，是那一类视频
 * 抽出来的轨里水印占了一半（2026-08-14 B 站实测：40 条里反复出现「AI生成」角标与
 * markdown 围栏）。这一层是那条路径上**唯一**的把关。
 *
 * 四条规则，各自答一个不同的问题：
 *  1. **没有内容** → 丢。纯标点行、markdown 代码围栏，OCR 那个模型的格式噪声。
 *  2. **在够多的帧里反复出现** → 判水印/角标，**整条剔除**（连第一次也不留）。
 *  3. **前面某一帧已经出现过** → 只留第一次。同一页幻灯片跨帧、以及规则 2 拦不住的低频重复。
 *  4. **剩下的字太少** → 判烧录字幕，整帧丢掉（见 `DEFAULT_MIN_LINES`）。
 *
 * 规则 2 的危险在于**它会丢掉真内容**：一张停留很久的幻灯片，在每一帧里都出现。所以它有
 * 一道帧数下限（`watermarkMinFrames`）——帧数太少时「出现在每一帧」根本区分不出水印和
 * 「只有一页」，那时只走规则 3（留第一次），把判断权交给更保守的那条。
 */
import { normalize } from './new-text.ts'

/** 一帧 OCR 的产物。`kept: false` 是 `[未识别：…]` 那类标记——见下面为什么它必须原样穿过去。 */
export interface TrackCandidate {
  at: number
  text: string
  kept: boolean
}

export interface DedupeResult {
  track: Array<{ at: number; text: string }>
  /** 因为前面某一帧已经出现过而丢掉的行数（规则 3）。 */
  repeatedLines: number
  /** 判为水印/角标、整条剔除的**不同文字行**数（规则 2）。 */
  watermarkLines: number
  /** 归一化后没有内容而丢掉的行数（规则 1）。 */
  emptyLines: number
  /** 因为剩下的字太少、判为烧录字幕而整帧丢掉的**帧数**（规则 4）。 */
  thinFrames: number
}

/**
 * 一帧去重后至少要剩几行才算「屏幕上的内容」。少于它就判烧录字幕，整帧丢掉。
 *
 * **这个数是量出来的，不是拍的。** 2026-08-15 拿三条真实视频（各 27 帧）看行数分布，
 * 是**双峰的，中间几乎没有东西**：
 *
 * ```
 * 抖音财经    1×12, 2×7, 3, 10,10,14,20,21,22,26
 * B站键盘评测  1×5,  2×2, 3,5,6,6,7,7,7,7,7,8,8,8,9,9,9,10,10,11,15,15
 * B站影视飓风  1×20, 2×3, 3,6,8,33
 * ```
 *
 * 1–2 行那一峰全是烧录字幕（「爬坡」「那这次」「NVIDIA」）；≥3 行那一峰全是真内容——
 * 抖音那 8 条正好是 7 张图表 + 1 张卡片，不多不少。
 *
 * **为什么字幕必须丢**：这一层的定义是「转写拿不到的那部分」。烧录字幕转写里本来就有，
 * 留着它就是把同一句话记两遍，而且它还会把真正的图表挤出帧预算。
 *
 * 另外两条路已经被数据否掉，别重摸：**按画面静止段选帧**（键盘评测给出 145–213 段，
 * 收敛不到那 28 屏卡）、**哈希前遮住字幕带**（同一条视频反而从 145 段变成 168 段）。
 */
export const DEFAULT_MIN_LINES = 3

/**
 * 一行出现在多大比例的帧里就判水印。**没量过，是拍的。**
 *
 * 量法：跑一批真实视频，把每条轨里各行的出现比例打出来，看已知水印/角标（台标、
 * 「AI生成」这类）落在哪个区间、真内容里停留最久的幻灯片行落在哪个区间。
 *
 * 方向：这个数**只应该往上调**（更难判成水印）。判错一次就是一行真内容永久消失且
 * 没有任何一处会喊；判漏只是轨里多一行水印，读的人一眼认得出来。
 */
export const DEFAULT_WATERMARK_RATIO = 0.6

/**
 * 帧数低于它就完全不判水印。**没量过，是拍的。**
 *
 * 为什么必须有：3 帧里出现 3 次，既可能是水印，也可能是「这段就只有一页幻灯片」——
 * 样本量根本分不开这两件事。而两种猜错的代价差着量级（丢掉唯一那页 vs 多留一行水印），
 * 所以样本不够时不猜。
 */
export const DEFAULT_WATERMARK_MIN_FRAMES = 5

export interface DedupeOptions {
  watermarkRatio?: number
  watermarkMinFrames?: number
  /** 见 `DEFAULT_MIN_LINES`。给 1 等于关掉规则 4。 */
  minLines?: number
}

/**
 * markdown 代码围栏行（``` / ```markdown / ~~~ts）。
 *
 * 它躲得过「归一化后为空」那一条——语言名是字母，归一化留得下来（活体产出里就有
 * 一条孤零零的 ```markdown）。围栏是 OCR 那个模型的输出格式，不是画面上的字。
 */
const FENCE_LINE = /^(?:`{3,}|~{3,})[a-z0-9+#-]*$/i

/** 一帧文字切成行，附上归一化键。空键 = 这行没有内容（纯标点、围栏）。 */
function linesOf(text: string): Array<{ text: string; key: string }> {
  return (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => ({ text: l, key: FENCE_LINE.test(l) ? '' : normalize(l) }))
}

export function dedupeTrack(
  candidates: readonly TrackCandidate[],
  opts: DedupeOptions = {},
): DedupeResult {
  const ratio = opts.watermarkRatio ?? DEFAULT_WATERMARK_RATIO
  const minFrames = opts.watermarkMinFrames ?? DEFAULT_WATERMARK_MIN_FRAMES
  const minLines = opts.minLines ?? DEFAULT_MIN_LINES

  // 只有真出了字的帧参与统计。`[未识别：…]` 那类帧没有内容，把它们算进分母会
  // 稀释比例、让水印判不出来。
  //
  // 用**下标**认帧，不用 `at`：同一时刻理论上可以有两条候选，按 `at` 归并会把它们
  // 悄悄合成一条。
  const perFrame = candidates
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.kept)
    .map(({ c, index }) => {
      const all = linesOf(c.text)
      const lines = all.filter((l) => l.key.length > 0)
      // —— 规则 1：没内容的行在这里就摘掉，不参与后面任何一条统计 ——
      return { index, lines, dropped: all.length - lines.length }
    })
  const emptyLines = perFrame.reduce((n, f) => n + f.dropped, 0)

  // —— 规则 2：跨帧出现频率 ——
  // 一行在同一帧里重复出现只算一次：问的是「多少帧上有它」，不是「一共出现多少次」。
  const frameCount = new Map<string, number>()
  for (const f of perFrame) {
    for (const key of new Set(f.lines.map((l) => l.key))) {
      frameCount.set(key, (frameCount.get(key) ?? 0) + 1)
    }
  }
  const watermark = new Set<string>()
  if (perFrame.length >= minFrames) {
    for (const [key, n] of frameCount) {
      if (n / perFrame.length >= ratio) watermark.add(key)
    }
  }

  // —— 规则 3：按时间序走一遍，同一行只留第一次 ——
  const seen = new Set<string>()
  let repeatedLines = 0
  let thinFrames = 0
  const newTextByIndex = new Map<number, string>()
  for (const f of perFrame) {
    const kept: string[] = []
    for (const l of f.lines) {
      if (watermark.has(l.key)) continue
      if (seen.has(l.key)) {
        repeatedLines += 1
        continue
      }
      seen.add(l.key)
      kept.push(l.text)
    }
    // —— 规则 4：剩下的字太少 = 烧录字幕，整帧丢掉 ——
    // 只对**有内容但太薄**的帧计数：`kept.length === 0` 是被规则 2/3 清空的（同一页跨帧、
    // 水印帧），那是去重的正常产物，算进 thinFrames 会把两件事混成一个数。
    if (kept.length > 0 && kept.length < minLines) {
      thinFrames += 1
      // 已经吃进 `seen` 的那几行不回滚：这一帧的字确实出现过，后面同样的字仍算重复。
      // 回滚会让下一帧的同一行"复活"，把丢掉的字幕又放回轨里。
      continue
    }
    if (kept.length > 0) newTextByIndex.set(f.index, kept.join('\n'))
  }

  // 按原顺序拼回去。`kept: false` 的标记**原样穿过**：它们是「这一帧没跑成」的可见记录，
  // 两帧同样的报错也各留一条——去重掉就等于把「塌了两帧」记成了「塌了一帧」。
  const track: Array<{ at: number; text: string }> = []
  candidates.forEach((c, index) => {
    if (!c.kept) {
      track.push({ at: c.at, text: c.text })
      return
    }
    const text = newTextByIndex.get(index)
    if (text !== undefined) track.push({ at: c.at, text })
  })

  return { track, repeatedLines, watermarkLines: watermark.size, emptyLines, thinFrames }
}
