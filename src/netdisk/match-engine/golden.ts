import type { MatchSpec } from '../types.ts'
import type { SpecLeft, SpecRight } from '../match-spec.ts'
import { matchByEvidence } from './resolve.ts'
import type { Ask, Resolution } from './types.ts'

/**
 * 金样回归网：同一批输入喂给引擎，判决逐行比对**冻结基线**（`golden-baseline.json`）。
 * 基线外的任何 diff 一律测试红。
 *
 * **它钉的是"行为不许无意变化"**——不是"结果一定对"。对不对由 `decision-table.test.ts`
 * （裁决表 R1–R14 逐格）与各层单测说了算；这里管的是那些没人单独写用例、却真实存在的
 * 组合形状：104 组输入（单测夹具 51 + 事故复刻 3 + 固定种子随机语料 50）里任何一格
 * 悄悄换了结论，都得在改的那一刻红。
 *
 * **基线怎么来**：`scripts/match-golden-baseline.ts` 现跑现录。头一版录于 `ce22d298`——
 * 那个提交上，判决刚跟被它取代的那套匹配实现逐行对过（104 组 + 活体 5 组，未预期差异 0）。
 * 基线**就是**那份被验证过的行为，不是随手一录。
 *
 * **要改基线时**：确认这是有意的行为变更（多半同时会有一条裁决表格子在动），重跑脚本、
 * 在 commit 信息里写清哪几组为什么变。别为了绿灯改，也别把 diff 加进什么白名单——
 * 这张网只有"一字不差"一个档位。
 */

export interface GoldenCase {
  name: string
  spec: MatchSpec
  left: SpecLeft[]
  right: SpecRight[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 快照：只录**结论**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一组输入的判决快照。只装结论——认领、问句、残差、缺档，外加每个文件的裁决轨迹投影。
 * 引擎的内部形状（证据图、候选包、中间态）一概不进：录了它就等于把当前实现钉成契约，
 * 下次重构连改都不敢改。
 *
 * **轨迹为什么要录**：I1/I2（无痕丢弃不可能、残差最窄）是这次重构的正身，而它只在
 * "有事实的边最后去哪了"这个层面看得见。轨迹里不录 `facts`（那是证据层的形状、量级也大），
 * 只录「哪一集 · 结局 · 否决理由 · 定这个结局的规则」——四样都是结论。
 */
export interface CaseSnapshot {
  assignments: Record<string, SnapAssignment>
  /** 集侧问句，按 leftKey 索引。 */
  leftAsks: Record<string, SnapAsk>
  /** 文件侧问句（I3 双集冲突卡），按 path 索引。 */
  fileAsks: Record<string, SnapAsk>
  residual: string[]
  missing: Record<string, number>
  /** path → `<disposition>[ by <正主规则>]` + 每条边一行 `<leftKey> <outcome>[/<veto>][ <rule>]`。 */
  trails: Record<string, string[]>
}

export interface SnapAssignment { file: string; confidence: number; status: string; losers: string[]; rule: string }
export interface SnapAsk { stage: string; rule: string; reason: string; candidates: { name: string; sim: number }[]; threshold: number; margin: number }

/** 基线文件的形状：组名 → 快照。组名是键，**顺序无关**——挪动夹具顺序不该让整张网红。 */
export interface GoldenBaseline {
  /** 录基线那一刻的说明，人读的。 */
  note: string
  cases: Record<string, CaseSnapshot>
}

const round = (n: number) => Math.round(n * 1e6) / 1e6
const sorted = (xs: string[]) => [...xs].sort()
/** 键排序后重建，保证 JSON 逐字稳定（不然夹具里换个遍历顺序就 diff）。 */
const byKey = <T,>(entries: [string, T][]): Record<string, T> =>
  Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)))

const snapAsk = (a: Ask): SnapAsk => ({
  stage: a.stage, rule: a.rule, reason: a.reason, threshold: a.threshold, margin: a.margin,
  candidates: [...a.candidates].map((c) => ({ name: c.name, sim: round(c.sim) })).sort((x, y) => x.name.localeCompare(y.name)),
})

const snapTrail = (t: { disposition: string; rule?: string; edges: { leftKey: string; outcome: string; vetoReason?: string; rule?: string }[] }): string[] => [
  `${t.disposition}${t.rule ? ` by ${t.rule}` : ''}`,
  ...t.edges
    .map((e) => `${e.leftKey} ${e.outcome}${e.vetoReason ? `/${e.vetoReason}` : ''}${e.rule ? ` ${e.rule}` : ''}`)
    .sort(),
]

/** 判决 → 快照。纯投影，不做取舍。 */
export function snapshotOf(res: Resolution): CaseSnapshot {
  return {
    assignments: byKey([...res.assignments].map(([k, a]) => [k, {
      file: a.path, confidence: round(a.confidence), status: a.status, losers: sorted(a.losers), rule: a.rule,
    }])),
    leftAsks: byKey(res.asks.filter((a) => a.leftKey != null).map((a) => [a.leftKey!, snapAsk(a)])),
    fileAsks: byKey(res.asks.filter((a) => a.path != null).map((a) => [a.path!, snapAsk(a)])),
    residual: sorted(res.residual),
    missing: byKey([...res.missingByLeft]),
    trails: byKey([...res.trails].map(([p, t]) => [p, snapTrail(t)])),
  }
}

/** 跑一组输入，出快照。 */
export const runCase = (c: GoldenCase): CaseSnapshot => snapshotOf(matchByEvidence(c.spec, c.left, c.right))

// ─────────────────────────────────────────────────────────────────────────────
// 对照
// ─────────────────────────────────────────────────────────────────────────────

export type DiffSection = 'assignments' | 'leftAsks' | 'fileAsks' | 'residual' | 'missing' | 'trails'
export type DiffKind = 'changed' | 'only-baseline' | 'only-actual'

export interface DiffEntry {
  section: DiffSection
  kind: DiffKind
  /** 集侧用 leftKey、文件侧用 path。 */
  key: string
  baseline?: unknown
  actual?: unknown
}

export interface GoldenReport {
  name: string
  /** 基线里压根没有这一组（新加了夹具却没重录基线）。 */
  missingBaseline: boolean
  diffs: DiffEntry[]
  identical: boolean
  counts: { lefts: number; files: number; assigned: number }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** 两个 Record 的逐键 diff。 */
function diffRecords(section: DiffSection, base: Record<string, unknown>, actual: Record<string, unknown>): DiffEntry[] {
  const out: DiffEntry[] = []
  for (const key of sorted([...new Set([...Object.keys(base), ...Object.keys(actual)])])) {
    const b = base[key], a = actual[key]
    if (b !== undefined && a === undefined) out.push({ section, kind: 'only-baseline', key, baseline: b })
    else if (b === undefined && a !== undefined) out.push({ section, kind: 'only-actual', key, actual: a })
    else if (!same(b, a)) out.push({ section, kind: 'changed', key, baseline: b, actual: a })
  }
  return out
}

export function diffSnapshots(base: CaseSnapshot, actual: CaseSnapshot): DiffEntry[] {
  const out: DiffEntry[] = [
    ...diffRecords('assignments', base.assignments, actual.assignments),
    ...diffRecords('leftAsks', base.leftAsks, actual.leftAsks),
    ...diffRecords('fileAsks', base.fileAsks, actual.fileAsks),
    ...diffRecords('missing', base.missing, actual.missing),
    ...diffRecords('trails', base.trails, actual.trails),
  ]
  const wasResidual = new Set(base.residual)
  const isResidual = new Set(actual.residual)
  for (const p of base.residual) if (!isResidual.has(p)) out.push({ section: 'residual', kind: 'only-baseline', key: p })
  for (const p of actual.residual) if (!wasResidual.has(p)) out.push({ section: 'residual', kind: 'only-actual', key: p })
  return out
}

export function checkCase(c: GoldenCase, baseline: GoldenBaseline): GoldenReport {
  const actual = runCase(c)
  const base = baseline.cases[c.name]
  const counts = { lefts: c.left.length, files: c.right.length, assigned: Object.keys(actual.assignments).length }
  if (!base) return { name: c.name, missingBaseline: true, diffs: [], identical: false, counts }
  const diffs = diffSnapshots(base, actual)
  return { name: c.name, missingBaseline: false, diffs, identical: diffs.length === 0, counts }
}

export interface GoldenSummary {
  total: number
  identical: number
  /** 与基线对不上的组（含基线里没有的）。**必须为 0**。 */
  drifted: number
  /** 基线里有、但这一批输入里没有的组名——夹具被删了却没重录基线。 */
  orphanBaselines: string[]
  reports: GoldenReport[]
}

export function runGolden(cases: GoldenCase[], baseline: GoldenBaseline): GoldenSummary {
  const reports = cases.map((c) => checkCase(c, baseline))
  const names = new Set(cases.map((c) => c.name))
  return {
    total: reports.length,
    identical: reports.filter((r) => r.identical).length,
    drifted: reports.filter((r) => !r.identical).length,
    orphanBaselines: sorted(Object.keys(baseline.cases).filter((n) => !names.has(n))),
    reports,
  }
}

/** 现跑现录，供 `scripts/match-golden-baseline.ts` 落盘。 */
export function buildBaseline(cases: GoldenCase[], note: string): GoldenBaseline {
  return { note, cases: byKey(cases.map((c) => [c.name, runCase(c)])) }
}

/** 漂了的组，渲染成人读的一段（报告与测试失败信息共用）。 */
export const fmtDrift = (r: GoldenReport): string =>
  r.missingBaseline
    ? `  ▸ ${r.name}：基线里没有这一组（新加了夹具就重录基线）`
    : [`  ▸ ${r.name}：${r.diffs.length} 条`, ...r.diffs.map((d) =>
        `      · ${d.section} ${d.kind} ${d.key}` +
        `${d.baseline !== undefined ? `\n          基线 ${JSON.stringify(d.baseline)}` : ''}` +
        `${d.actual !== undefined ? `\n          现在 ${JSON.stringify(d.actual)}` : ''}`)].join('\n')

// ─────────────────────────────────────────────────────────────────────────────
// 随机扰动组：种子写死，保证可复现
// ─────────────────────────────────────────────────────────────────────────────

/** mulberry32：32 位种子的确定性 PRNG。种子写死 ⇒ 每次跑的 50 组输入逐字相同。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = ['身边那些灵异事', '太极两仪生四象', '现代版枪下留人', '十神的生克关系', '清华大学朱令案', '骗局', '财克印印克食伤', '凑活聊道德绑架', '三十探悬疑案件', '风水鱼要在棺材里']
const WATERMARKS = ['', '【公众号：CunWorkNotes】', '【耗时整理‖cunlove.cn】']
const QUALITY = ['', '.1080p', '.2160p', '.720p']

/**
 * 一组随机输入。覆盖压在真实事故上的那几种形状：**时长缺失**（左/右各自可能没有）、
 * **名字乱码**（错号、改字避审、贴错名）、**多副本**（水印/画质/转存重复）、
 * **时长撞车**（两集恰好等长）、**错身文件**（时长差出量级）。
 */
export function randomCase(spec: MatchSpec, rnd: () => number, i: number): GoldenCase {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
  const n = 2 + Math.floor(rnd() * 5)
  const sharedDuration = 1800 + Math.floor(rnd() * 6000)
  const left: SpecLeft[] = []
  const right: SpecRight[] = []
  /**
   * **文件名去重**：`right` 的取数口是网盘目录列表（AList `fs/list`，递归时带相对子路径），
   * 同一目录里两个文件叫同一个名字**在真实输入里不可能出现**。别把这行"修"回去——
   * 它界定的是合法输入空间（见 `golden.test.ts` 那条「输入契约」用例）。
   */
  const seen = new Set<string>()
  const push = (f: SpecRight) => { if (!seen.has(f.name)) { seen.add(f.name); right.push(f) } }

  for (let k = 0; k < n; k++) {
    const num = k + 1
    const word = WORDS[(i + k) % WORDS.length]
    // 时长：1/4 概率整集没有时长；1/3 概率与别的集撞车（同一批文件里 530/820 那种）。
    const collide = rnd() < 0.34
    const durationS = rnd() < 0.25 ? undefined : collide ? sharedDuration : 1200 + Math.floor(rnd() * 7000)
    left.push({ leftKey: `s:${i}:${num}`, title: `${String(num).padStart(3, '0')}.${word}`, ...(durationS != null ? { durationS } : {}) })

    if (rnd() < 0.15) continue // 这一集干脆没文件 → 缺档
    // 文件名扰动：正常 / 错号 1 / 贴错别的集的名字 / 改一个字
    const roll = rnd()
    const fileWord = roll < 0.15 ? WORDS[(i + k + 3) % WORDS.length] : roll < 0.3 ? word.replace(/.$/, '象') : word
    const fileNum = roll >= 0.3 && roll < 0.45 ? num + 1 : num
    const base = `${String(fileNum).padStart(2, '0')}.${fileWord}${pick(WATERMARKS)}${pick(QUALITY)}`
    // 文件时长：跟集走 / 差编码零头 / 差出量级（错身文件）/ 干脆没有
    const dRoll = rnd()
    const fileDuration = durationS == null ? (rnd() < 0.5 ? undefined : 1200 + Math.floor(rnd() * 7000))
      : dRoll < 0.55 ? durationS : dRoll < 0.7 ? durationS + 1 : dRoll < 0.85 ? Math.floor(durationS / 3) : undefined
    push({ name: `${base}.mp3`, size: 10_000_000 + Math.floor(rnd() * 90_000_000), ...(fileDuration != null ? { durationS: fileDuration } : {}) })
    // 1/4 概率再来一份副本（转存重复 / 另一画质），体量与时长各自小幅浮动
    if (rnd() < 0.25) {
      push({
        name: `${String(fileNum).padStart(2, '0')}.${fileWord}${pick(WATERMARKS)}${pick(QUALITY)}.mp3`,
        size: 10_000_000 + Math.floor(rnd() * 90_000_000),
        ...(fileDuration != null ? { durationS: fileDuration } : {}),
      })
    }
  }
  // 混入一个与谁都不沾的文件（封面/无关媒体），压残差判定
  if (rnd() < 0.5) push({ name: rnd() < 0.5 ? 'cover.jpg' : `zz.${pick(WORDS)}.mp3`, size: 1024 })
  return { name: `random#${i}`, spec, left, right }
}
