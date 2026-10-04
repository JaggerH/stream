/**
 * 「非人声碎片」的结构判据——找出那些其实是掌声/笑声、却被分段模型判成独立说话人的簇。
 *
 * 为什么这一步在 TS 侧、在跨窗合并**之后**：判据里最要紧的一条是「它在整条录音的别处
 * 从不露面」，而容器一次只看一个 120s 的窗，看不到"别处"。实测代价很具体：同一份 E02，
 * 判据放在窗内只摘到 41s，放在合并后的完整时间线上能看见 19 个碎片簇（36s…3s）。
 *
 * 这里只做**结构**判断（纯时间戳，不看内容、与题材无关：播客里主持人压着片头音乐、
 * 电影里对白压着配乐，都是同一个形状）。第二个信号——「这段音频里人声帧占多少」——
 * 由容器回答（`/speech-frac`），因为帧模型和它的判据都在那边，阈值不该在两处各写一份。
 *
 * ⚠ 只有**两个信号都命中**才允许摘段。同类改动 2026-07-27 试过一次并被证伪整体撤回
 * （拿帧标签切整条时间线，切掉的 47–69% 是压着音乐讲话的真人，spec
 * `2026-07-27-voiceprint-frame-cut-design.md`）。教训是「门控误判 = 少点干净音频（可恢复）；
 * 切分误判 = 一个人说过话这个事实消失（不可恢复）」。所以这里的每一条都是为了**少抓**：
 * 宁可留一个错簇，不删一句真话。
 */
import type { DiarizedSegment } from './resolve.ts'

export interface ShardParams {
  /** 碎片自己最多多长——再长就不像是被垫底噪声切出来的 */
  maxS: number
  /** 宿主至少比它长几倍（对谈里两人时长相当，不该命中） */
  hostRatio: number
  /** 至少与宿主交替几次（插一句嘴不算） */
  minFlips: number
  /** 交替间隔的**中位数**上限：换人换得慢 = 真的在轮流说话 */
  gapS: number
  /** 宿主必须在碎片的活动区间里确实一直在说（不是只在两头露脸） */
  hostInsideFrac: number
}

export const DEFAULT_SHARD_PARAMS: ShardParams = {
  maxS: 45,
  hostRatio: 3,
  minFlips: 4,
  gapS: 1.0,
  hostInsideFrac: 0.3,
}

/**
 * 返回 `碎片簇 → 宿主簇`。只是**嫌疑**：还要过容器的帧证据才允许摘。
 *
 * E02 全集实测：抓出 19–22 个（全部 ≤36s），而 12 个大簇（4 个演员 + 主持 + 6 个评委）
 * 一个都没被抓——那是这条判据的安全性质，改参数后要重新确认它还成立。
 */
export function shardSuspects(
  segments: readonly DiarizedSegment[],
  p: ShardParams = DEFAULT_SHARD_PARAMS
): Map<string, string> {
  const spans = new Map<string, [number, number][]>()
  for (const s of segments) {
    const list = spans.get(s.speaker)
    if (list) list.push([s.start, s.end])
    else spans.set(s.speaker, [[s.start, s.end]])
  }
  const total = new Map<string, number>()
  const range = new Map<string, [number, number]>()
  for (const [k, v] of spans) {
    total.set(k, v.reduce((n, [a, b]) => n + (b - a), 0))
    range.set(k, [Math.min(...v.map((x) => x[0])), Math.max(...v.map((x) => x[1]))])
  }
  const byLongest = [...total.entries()].sort((a, b) => b[1] - a[1])

  const out = new Map<string, string>()
  for (const [sp, t] of total) {
    if (t > p.maxS) continue
    const [a0, a1] = range.get(sp)!
    for (const [host, ht] of byLongest) {
      if (host === sp || ht < p.hostRatio * t) continue
      const [h0, h1] = range.get(host)!
      // 它跑到宿主范围之外去了 → 是个会在别处说话的真人（评委插话又长篇点评就走这条）
      if (!(h0 <= a0 && a1 <= h1)) continue
      const inside = spans
        .get(host)!
        .reduce((n, [a, b]) => n + Math.max(0, Math.min(b, a1) - Math.max(a, a0)), 0)
      if (inside < p.hostInsideFrac * (a1 - a0)) continue

      const merged = [
        ...spans.get(sp)!.map(([a, b]) => [a, b, sp] as const),
        ...spans.get(host)!.filter(([a]) => a >= a0 && a <= a1).map(([a, b]) => [a, b, host] as const),
      ].sort((x, y) => x[0] - y[0])
      const gaps: number[] = []
      for (let i = 1; i < merged.length; i++) {
        if (merged[i][2] !== merged[i - 1][2]) gaps.push(Math.max(0, merged[i][0] - merged[i - 1][1]))
      }
      if (gaps.length < p.minFlips) continue
      const sorted = [...gaps].sort((x, y) => x - y)
      if (sorted[Math.floor(sorted.length / 2)] > p.gapS) continue
      out.set(sp, host)
      break
    }
  }
  return out
}
