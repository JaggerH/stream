import type { MatchSpec } from '../types.ts'
import type { SpecLeft, SpecRight } from '../match-spec.ts'
import { matchByEvidence } from './resolve.ts'
import { checkCase, fmtDrift, buildBaseline, type GoldenBaseline, type GoldenCase, type GoldenReport } from './golden.ts'
import type { Fact } from './types.ts'

/**
 * **活体金样**（spec §4.2 第二类输入）：拿真实绑定此刻的左右两侧重放一遍匹配。
 *
 * 单测夹具是人写的，人只会写自己想得到的形状；活体输入带着真实的错名副本、撞时长、水印重复、
 * 探不到时长的那些——**改动上活体之前的最后一道闸就是它**。
 *
 * 与 `golden.ts` 同一套账：抓一次活体就顺手录一份**基线**（`live-baseline.json`），此后重放
 * 同一份 fixture 逐行比对基线，漂了就红。抓取那一刻的基线是从当时的引擎录的，所以它钉的同样是
 * "行为不许无意变化"。没有基线时只出报告、不判对错（第一次抓、还没得可比）。
 *
 * 本文件**不出网、不读盘**：抓取与落盘是 `scripts/match-golden-live.ts` 的事，这里只负责重放与
 * 出报告。分开是为了让这份逻辑能被单测（CI 里没有活体后端，也不该有）。
 */

/** 一组活体输入。`left`/`right`/`spec` 三样凑齐就能重放一次匹配。 */
export interface LiveGroup {
  name: string
  /** 这组的取数口（端点 + 投影方式）。报告里原样带出——数字来自哪把尺必须写在数字旁边。 */
  source: string
  spec: MatchSpec
  left: SpecLeft[]
  right: SpecRight[]
}

export interface LiveFixture {
  capturedAt: string
  groups: LiveGroup[]
}

export function casesFromFixture(fx: LiveFixture): GoldenCase[] {
  return fx.groups.map((g) => ({ name: g.name, spec: g.spec, left: g.left, right: g.right }))
}

// ─────────────────────────────────────────────────────────────────────────────
// I3 翻案卡：逐张列名
// ─────────────────────────────────────────────────────────────────────────────

/** 一条边上的事实，渲染成人话 + 数字。**结论句一律由证据渲染**（spec §5.3），不写死。 */
export function describeFact(f: Fact): string {
  switch (f.kind) {
    case 'name':
      return f.method === 'identity-exact'
        ? `名字 清洗后全等（「${f.cleanedLeft}」）`
        : `名字 sim ${f.score.toFixed(3)}（「${f.cleanedLeft}」↔「${f.cleanedRight}」）`
    case 'struct-key':
      return `结构键 ${f.key}=${f.value}`
    case 'duration':
      return f.state === 'hit'
        ? `时长命中（差 ${f.deltaS}s，容差 ${f.toleranceS}s）`
        : `时长矛盾（差 ${f.deltaS}s）`
    case 'byte-identity':
      return `与 ${f.peerPath} 字节全等`
  }
}

/** 一张 I3 翻案卡：这份文件 + 它牵扯的每一集 + 各自的证据数字。 */
export interface ConflictCard {
  path: string
  sizeBytes?: number
  durationS?: number
  episodes: {
    leftKey: string
    title: string
    durationS?: number
    paid?: boolean
    facts: string[]
    /** 该集本轮的正主（若有）——05 案卡片里"该集正主：…"那一行。 */
    claimedBy?: string
  }[]
}

/**
 * 本组里 I3 把哪几份文件从"残差（→ 静默搬下架）"翻成了"出卡"。**逐张列名**：
 * 只报个数等于把用户的检查点变成一句"相信我"。
 */
export function conflictCards(group: LiveGroup): ConflictCard[] {
  const res = matchByEvidence(group.spec, group.left, group.right)
  const leftByKey = new Map(group.left.map((l) => [l.leftKey, l]))
  const rightByName = new Map(group.right.map((r) => [r.name, r]))
  const primaryOf = new Map<string, string>()
  for (const [leftKey, a] of res.assignments) primaryOf.set(leftKey, a.path)

  const out: ConflictCard[] = []
  for (const ask of res.asks) {
    if (ask.reason !== 'dual-episode-conflict' || !ask.path) continue
    const file = rightByName.get(ask.path)
    const trail = res.trails.get(ask.path)
    out.push({
      path: ask.path,
      sizeBytes: file?.size,
      durationS: file?.durationS,
      episodes: (trail?.edges ?? [])
        .filter((e) => e.outcome !== 'informational')
        .map((e) => {
          const l = leftByKey.get(e.leftKey)
          const claimed = primaryOf.get(e.leftKey)
          return {
            leftKey: e.leftKey,
            title: l?.title ?? e.leftKey,
            durationS: l?.durationS,
            paid: l?.paid,
            facts: e.facts.map(describeFact),
            ...(claimed && claimed !== ask.path ? { claimedBy: claimed } : {}),
          }
        }),
    })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 性能
// ─────────────────────────────────────────────────────────────────────────────

export interface EngineTiming {
  name: string
  medianMs: number
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/**
 * 同一份输入上跑 `runs` 次取中位。
 *
 * **这台机器的单调钟偏快 7.6%**（WSL2 选了裸 tsc，见 memory）：绝对毫秒数偏大。报告里的数字
 * 只能用来跟**同一台机器上另一次跑**比，别拿它跟别处的绝对值对。
 */
export function benchmark(c: GoldenCase, runs = 5, clock: () => number = () => performance.now()): EngineTiming {
  const ms: number[] = []
  for (let i = 0; i < runs; i++) {
    const t = clock()
    matchByEvidence(c.spec, c.left, c.right)
    ms.push(clock() - t)
  }
  return { name: c.name, medianMs: median(ms) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────────────────────

export interface LiveGoldenResult {
  /** 有基线时逐组的对照结果；没基线时为空数组（第一次抓，没得可比）。 */
  reports: GoldenReport[]
  cards: { group: string; cards: ConflictCard[] }[]
  timings: EngineTiming[]
  /** 与基线对不上的组数。没基线时恒 0，看 `hasBaseline` 分辨"没漂"与"没比"。 */
  driftTotal: number
  hasBaseline: boolean
}

/** 把这份 fixture 此刻的判决录成基线，供下次重放对照。 */
export const buildLiveBaseline = (fx: LiveFixture, note: string): GoldenBaseline =>
  buildBaseline(casesFromFixture(fx), note)

export function runLiveGolden(fx: LiveFixture, baseline?: GoldenBaseline, runs = 5): LiveGoldenResult {
  const cases = casesFromFixture(fx)
  const reports = baseline ? cases.map((c) => checkCase(c, baseline)) : []
  return {
    reports,
    cards: fx.groups.map((g) => ({ group: g.name, cards: conflictCards(g) })),
    timings: cases.map((c) => benchmark(c, runs)),
    driftTotal: reports.filter((r) => !r.identical).length,
    hasBaseline: baseline != null,
  }
}

export function renderLiveReport(fx: LiveFixture, result: LiveGoldenResult): string {
  const out: string[] = [`# 活体金样报告（抓取于 ${fx.capturedAt}）`, '']
  for (const [i, g] of fx.groups.entries()) {
    const r = result.reports[i]
    const t = result.timings[i]
    const cards = result.cards[i].cards
    out.push(`## ${g.name}`)
    out.push(`取数：${g.source}`)
    out.push(`规模：左 ${g.left.length} 集 × 右 ${g.right.length} 文件`)
    out.push(r ? `对照基线：${r.identical ? '逐字相同' : `**漂了 ${r.diffs.length} 条**`}` : '对照基线：无基线（本次即录）')
    out.push(`耗时中位（5 次）：${t.medianMs.toFixed(1)}ms`)
    if (r && !r.identical) {
      out.push('', '漂移逐条：')
      out.push(fmtDrift(r))
    }
    out.push('', `I3 翻案卡 ${cards.length} 张：`)
    for (const c of cards) {
      out.push(`  ▸ ${c.path}`)
      out.push(`      文件：${c.durationS != null ? `${c.durationS}s` : '时长未知'} · ${c.sizeBytes != null ? `${(c.sizeBytes / 1048576).toFixed(1)} MiB` : '体量未知'}`)
      for (const ep of c.episodes) {
        out.push(`      ↔《${ep.title}》${ep.paid === true ? '(付费)' : ep.paid === false ? '(免费)' : ''}${ep.durationS != null ? ` ${ep.durationS}s` : ''}`)
        for (const f of ep.facts) out.push(`          ${f}`)
        if (ep.claimedBy) out.push(`          该集正主：${ep.claimedBy}`)
      }
    }
    out.push('')
  }
  out.push(result.hasBaseline ? `总计漂移组数：${result.driftTotal}` : '总计漂移组数：—（本次没有基线可比，判决已录成新基线）')
  return out.join('\n')
}
