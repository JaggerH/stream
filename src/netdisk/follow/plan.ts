import type { ShareTreeFile } from './types.ts'

export const FRESH_WINDOW_DAYS = 3
export const FRESH_INTERVAL_H = 6
export const BASE_INTERVAL_H = 24
export const MAX_BACKOFF_POW = 3
export const IDLE_DAYS = 30
export const AIR_CHECK_HOUR = 20

type EntryLike = { leftKey: string; rightFile: string | null; status: string; airDate?: string }
const has = (e: EntryLike) => !!e.rightFile && (e.status === 'auto' || e.status === 'confirmed')
const H = 3600_000

/** 还没播的占位：盘上没有任何候选文件，且 airDate 在 today 之后或压根没定档。分母口径的另一半。 */
export const isUnaired = (e: EntryLike, today: string): boolean => !e.rightFile && (!e.airDate || e.airDate > today)

/** 已播出（airDate ≤ today）且没拿到的集。**airDate 缺席不算已播出**——宁可漏追，不可乱搜。 */
export function missingAired(entries: EntryLike[], today: string): string[] {
  return entries.filter((e) => !has(e) && !!e.airDate && e.airDate <= today).map((e) => e.leftKey)
}

/**
 * 「配上 M / 总 N 集」的分子分母——**分母只数已播出的集**。TMDb 把整季的占位先列出来（未定档的没
 * airDate，定了档的 airDate 在未来），它们不是缺货，是还没播；混进分母，「97/101」读起来像缺 4 集，
 * 而其实一集都不缺。判「已播」与 `missingAired` 同一把尺：airDate ≤ today；没 airDate 的没拿到也算
 * 未播（宁可少报进度，不可把未定档占位报成缺货）。已经配上的集不管 airDate 怎样都在分子分母里——
 * 分子不能大过分母；盘上已有候选文件（pending / rejected 仍挂着 rightFile）的也在分母里——
 * 文件都到了，它不是占位。`unaired` 单独给出，UI/工具面要说「还有 N 集未播」用它。
 */
export function progressOf(entries: EntryLike[], today: string): { matched: number; total: number; unaired: number } {
  let matched = 0, unaired = 0
  for (const e of entries) {
    if (has(e)) matched++
    else if (isUnaired(e, today)) unaired++
  }
  return { matched, total: entries.length - unaired, unaired }
}

/**
 * 下次该查的时刻。`now` 是**锚**（间隔从它起算）；`today` 是判「已播/未播」的日子，缺省取 `now`
 * 的日期。两者分开是给 `FollowService.dueAt` 用的：它拿上一轮的时刻当锚、拿真正的今天判播出——
 * 上一轮之后新播的集要按「新鲜缺集」起 6 小时节奏，而不是被锚那天的日历当成「还没播」。
 */
export function nextCheckAt(input: { entries: EntryLike[]; dryRuns: number; now: Date; today?: string }): Date {
  const { entries, dryRuns, now } = input
  const today = input.today ?? now.toISOString().slice(0, 10)
  const missing = entries.filter((e) => !has(e) && !!e.airDate && e.airDate <= today)
  if (missing.length) {
    const latest = missing.map((e) => e.airDate!).sort().at(-1)!
    const ageDays = (now.getTime() - Date.parse(latest)) / (24 * H)
    if (ageDays <= FRESH_WINDOW_DAYS) return new Date(now.getTime() + FRESH_INTERVAL_H * H)
    // 2^min(dryRuns,3) 到 3 次退避已经是 8 天——封顶 7 天，别让长期没结果的追更线拖到一周开外都不看一眼。
    const hours = Math.min(BASE_INTERVAL_H * 2 ** Math.min(dryRuns, MAX_BACKOFF_POW), 7 * 24)
    return new Date(now.getTime() + hours * H)
  }
  const upcoming = entries.filter((e) => !has(e) && !!e.airDate && e.airDate > today).map((e) => e.airDate!).sort()[0]
  if (upcoming) {
    const [y, m, d] = upcoming.split('-').map(Number)
    return new Date(y, m - 1, d, AIR_CHECK_HOUR, 0, 0, 0) // 本地时区
  }
  return new Date(now.getTime() + IDLE_DAYS * 24 * H)
}

export interface Candidate { key: string; files: ShareTreeFile[]; assigned: Map<string, string> }

const coverOf = (c: Candidate, missing: Set<string>) => [...c.assigned.keys()].filter((k) => missing.has(k))
/** 同分按「被选文件大小之和」——这里的「被选」是候选分享里被 assigned 选中的全部文件，不只是落在缺集上的那几个。 */
/** 只数**盖住缺集的那几个文件**的字节——质量代理要比的是"同一集谁的版本更大"；把整份分享的
 *  体积算进来，一条塞满已有季的分享就能靠无关文件赢下平局。 */
const coverBytesOf = (c: Candidate, keys: string[]) => keys.reduce((n, k) => n + (c.files.find((f) => f.path === c.assigned.get(k))?.size ?? 0), 0)

export function rankCandidates(cands: Candidate[], missing: string[]): Candidate[] {
  const m = new Set(missing)
  return [...cands].sort((a, b) => {
    const ca = coverOf(a, m), cb = coverOf(b, m)
    // 覆盖数 → 覆盖文件字节 → 这条分享总共认出多少集（认得多 = 更像一条持续维护的整剧分享）
    return cb.length - ca.length || coverBytesOf(b, cb) - coverBytesOf(a, ca) || b.assigned.size - a.assigned.size
  })
}

export function pickFiles(ranked: Candidate[], missing: string[], maxShares = 3): Array<{ key: string; files: ShareTreeFile[]; covers: string[] }> {
  const left = new Set(missing)
  const out: Array<{ key: string; files: ShareTreeFile[]; covers: string[] }> = []
  for (const c of ranked) {
    if (!left.size || out.length >= maxShares) break
    const covers = coverOf(c, left)
    if (!covers.length) continue
    const files = covers.map((k) => c.files.find((f) => f.path === c.assigned.get(k))!).filter(Boolean)
    out.push({ key: c.key, files, covers })
    covers.forEach((k) => left.delete(k))
  }
  return out
}
