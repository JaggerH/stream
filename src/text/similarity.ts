/**
 * 字面相似度：**全后端唯一一把尺**。
 *
 * 公式只有这一份，两条线共用：网盘认集（`src/netdisk/match-spec.ts` 的 title stage 与
 * `match-engine` 的倒排索引证据器）和同质内容归堆（`src/story-fold/`）。
 *
 * **为什么必须共用而不是各写各的**：两份 bigram-Dice 实现漂移了不会有任何测试报警——
 * 一边说 0.86 另一边说 0.83，卡在阈值两侧就变成「网盘认得出、搜索折不掉」的静默错位，
 * 而两边单看都正常。判据放一处，阈值各配各的（阈值是场景的事，公式不是）。
 *
 * 选 bigram-Dice 而不是编辑距离的理由在 `titleSim` 头注：对中文标题稳，且便宜。
 */

/** 一个串的字符 bigram 计数。 */
export type Grams = Map<string, number>

export function gramsOf(s: string): Grams {
  const m: Grams = new Map()
  for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1) }
  return m
}

/**
 * Dice 系数的**尾段**：交集计数已经算好时用它收口。
 *
 * 导出是给 `match-engine` 的名字证据器用的：它要给上千集 × 数百文件评分，逐对现建两张 bigram
 * 表是纯浪费（同一个串会被重建几百遍）。证据器改用倒排索引一次算出全部交集计数，
 * 再经这里收口——**公式只有这一份**，数值与 `titleSim` 逐位相同（金样对照压着这条）。
 */
export function diceFromIntersection(a: string, b: string, inter: number): number {
  if (a === b) return a.length ? 1 : 0
  if (a.length < 2 || b.length < 2) return 0
  return (2 * inter) / (a.length - 1 + (b.length - 1))
}

/** 字符 bigram 的 Dice 系数——对中文标题稳,比编辑距离便宜。相等=1,无公共 bigram=0。 */
export function titleSim(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0
  if (a.length < 2 || b.length < 2) return 0
  const A = gramsOf(a), B = gramsOf(b)
  let inter = 0
  for (const [g, ca] of A) { const cb = B.get(g); if (cb) inter += Math.min(ca, cb) }
  return diceFromIntersection(a, b, inter)
}
