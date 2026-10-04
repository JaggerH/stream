import { describe, it, expect } from 'vitest'
import {
  buildBaseline, checkCase, diffSnapshots, fmtDrift, runCase, runGolden, snapshotOf,
  type CaseSnapshot, type GoldenBaseline, type GoldenCase,
} from './golden.ts'
import { FIXTURES, INCIDENTS, allCases, randomCases } from './golden-cases.ts'
import { matchByEvidence } from './resolve.ts'
import { RULES } from './rules.ts'
import { DEFAULT_MATCH_SPEC } from '../match-spec.ts'
import type { SpecLeft, SpecRight } from '../match-spec.ts'
import baselineJson from './golden-baseline.json' with { type: 'json' }

const BASELINE = baselineJson as GoldenBaseline
const D = DEFAULT_MATCH_SPEC
const L = (leftKey: string, title: string): SpecLeft => ({ leftKey, title })

describe('金样：104 组输入的判决必须与冻结基线逐字相同', () => {
  it('全部 104 组零漂移，且基线里没有多余的组', () => {
    const cases = allCases()
    expect(cases).toHaveLength(104)
    const s = runGolden(cases, BASELINE)
    // 失败时把漂了的那几组连 diff 一起打出来——只报个数等于让人自己再跑一遍。
    expect(s.reports.filter((r) => !r.identical).map(fmtDrift).join('\n')).toBe('')
    expect({ total: s.total, identical: s.identical, drifted: s.drifted }).toEqual({ total: 104, identical: 104, drifted: 0 })
    // 基线里有、这批输入里没有 = 删了夹具没重录基线。同样是账对不上，同样红。
    expect(s.orphanBaselines).toEqual([])
  })

  it('三类语料一组不少（别哪天被顺手删剩夹具）', () => {
    expect(FIXTURES).toHaveLength(51)
    expect(INCIDENTS).toHaveLength(3)
    expect(randomCases()).toHaveLength(50)
  })

  it('随机组确实压到了该压的形状（不是 50 组空输入白跑）', () => {
    const cases = randomCases()
    expect(cases.some((c) => c.left.some((l) => l.durationS == null))).toBe(true)
    expect(cases.some((c) => c.right.some((r) => r.durationS == null))).toBe(true)
    expect(cases.some((c) => c.right.length > c.left.length)).toBe(true)
    expect(cases.some((c) => Object.keys(runCase(c).assignments).length > 0)).toBe(true)
    // 随机语料固定种子 ⇒ 逐字可复现。不成立的话基线本身就没有意义。
    expect(randomCases()).toEqual(cases)
  })

  /**
   * 基线**记住了**这次重构真正翻掉的那两格——它们是当初新旧对照里仅有的两类预期差异，
   * 现在成了基线的一部分。这条用例守住"翻案没被后来的改动悄悄翻回去"。
   */
  it('基线里记着 I3 与 R14 这两格翻案（05/20 出卡、标题档名字全等×时长矛盾出卡）', () => {
    const c05 = BASELINE.cases['事故 05：错名副本（92986927 字节 / 5808s）']
    // 第 6 格 / I3：这份文件曾被无痕丢成残差，现在是一张文件侧冲突卡。
    expect(c05.fileAsks['玄关笔记/05.太极两仪生四象.mp3']?.reason).toBe('dual-episode-conflict')
    expect(c05.residual).not.toContain('玄关笔记/05.太极两仪生四象.mp3')
    const c20 = BASELINE.cases['事故 20：同形状的另一期']
    expect(c20.fileAsks['玄关笔记/20.坎水之象.mp3']?.reason).toBe('dual-episode-conflict')
    // 第 3 格 / R14：标题档名字全等但时长差出量级 → 集侧卡，规则编号写在卡上。
    const r14 = BASELINE.cases['第 3 格：标题档清洗后全等 + 时长差出量级 → 出卡（R14）']
    expect(r14.leftAsks['a']?.rule).toBe(RULES.NAME_HIT_DURATION_CONTRADICT.id)
    // 37 是**没**翻的那一组：名字地板本来就挡住了它，不该凭空多出认领。
    expect(BASELINE.cases['事故 37：归档器曾自判成 756 副本（6044s vs 6043s，名字一个字不沾）'].assignments)
      .toEqual({ 'yl:756': { file: '756.那一期节目.mp3', confidence: 1, status: 'auto', losers: [], rule: RULES.DURATION_UNIQUE.id } })
  })

  /**
   * I1「无痕丢弃不可能」在**全部 104 组**上成立：每个入池文件都有轨迹。
   * 这条不看基线、直接看判决——基线是"别变"，它是"本来就得成立"。
   */
  it('每一组里每个文件都有裁决轨迹（I1）', () => {
    const missing: string[] = []
    for (const c of allCases()) {
      const res = matchByEvidence(c.spec, c.left, c.right)
      for (const r of c.right) if (!res.trails.has(r.name)) missing.push(`${c.name} → ${r.name}`)
    }
    expect(missing).toEqual([])
  })
})

describe('对照器本身', () => {
  const CASE: GoldenCase = { name: 'x', spec: D, left: [L('a', '020.再谈身边灵异事')], right: [{ name: '020.再谈身边灵异事.mp3' }] }

  it('纯函数：同一份输入两次跑出同一份快照', () => {
    expect(runCase(CASE)).toEqual(runCase(CASE))
  })

  it('快照相同 ⇒ 零 diff', () => {
    expect(diffSnapshots(runCase(CASE), runCase(CASE))).toEqual([])
  })

  it('认领变了要报出来，不许被别的段落吞掉', () => {
    const base = runCase(CASE)
    const changed: CaseSnapshot = { ...base, assignments: { a: { ...base.assignments['a'], file: '别的.mp3' } } }
    const diffs = diffSnapshots(base, changed)
    expect(diffs.map((d) => ({ section: d.section, kind: d.kind, key: d.key })))
      .toEqual([{ section: 'assignments', kind: 'changed', key: 'a' }])
  })

  it('多一条/少一条问句都是 diff（只增不减也不算"兼容"）', () => {
    const base = runCase(CASE)
    const ask = { stage: 'title', rule: 'R9', reason: 'below-threshold', candidates: [], threshold: 0.6, margin: 0.15 }
    expect(diffSnapshots(base, { ...base, leftAsks: { a: ask } }).map((d) => d.kind)).toEqual(['only-actual'])
    expect(diffSnapshots({ ...base, leftAsks: { a: ask } }, base).map((d) => d.kind)).toEqual(['only-baseline'])
  })

  it('残差进出都是 diff', () => {
    const base = runCase(CASE)
    expect(diffSnapshots(base, { ...base, residual: ['x.mp3'] })).toEqual([{ section: 'residual', kind: 'only-actual', key: 'x.mp3' }])
    expect(diffSnapshots({ ...base, residual: ['x.mp3'] }, base)).toEqual([{ section: 'residual', kind: 'only-baseline', key: 'x.mp3' }])
  })

  it('基线里没有这一组 → 报 missingBaseline，不算"通过"', () => {
    const r = checkCase({ ...CASE, name: '基线里没有的新夹具' }, BASELINE)
    expect({ missingBaseline: r.missingBaseline, identical: r.identical }).toEqual({ missingBaseline: true, identical: false })
    expect(fmtDrift(r)).toContain('基线里没有这一组')
  })

  it('快照只装结论：证据图/候选包这些内部形状一概不进', () => {
    const snap = snapshotOf(matchByEvidence(INCIDENTS[0].spec, INCIDENTS[0].left, INCIDENTS[0].right))
    expect(Object.keys(snap).sort()).toEqual(['assignments', 'fileAsks', 'leftAsks', 'missing', 'residual', 'trails'])
    // 轨迹只留「哪一集 · 结局 · 否决理由 · 规则」四样，不留事实原文（那是证据层的形状）。
    const trail = snap.trails['玄关笔记/05.太极两仪生四象.mp3']
    expect(trail[0]).toMatch(/^asked/)
    expect(trail.slice(1).every((line) => /^\S+ (won|vetoed|informational)/.test(line))).toBe(true)
    expect(JSON.stringify(snap)).not.toContain('cleanedLeft')
  })

  it('键顺序不影响快照（挪夹具顺序不该让整张网红）', () => {
    const a = buildBaseline([CASE, { ...CASE, name: 'y' }], 'n')
    const b = buildBaseline([{ ...CASE, name: 'y' }, CASE], 'n')
    expect(JSON.stringify(a.cases)).toBe(JSON.stringify(b.cases))
  })
})

/**
 * 输入契约：`right` 的文件名（相对子路径）**唯一**——它来自网盘目录列表，同一目录里不可能有
 * 两个同名文件。随机组一度撞出违反契约的输入（`randomCase` 里那个 `seen` 去重就是为它加的）。
 * 引擎对此结构上免疫：证据图按 (leftKey, path) 建边，同名即同一条边，重复自然合并。
 */
describe('输入契约：文件名唯一', () => {
  it('真撞了同名也不会把正主列进自己的落选副本', () => {
    const dup = '03.某一集.mp3'
    const snap = runCase({ name: 'dup-names', spec: D, left: [L('a', '003.某一集')], right: [{ name: dup, size: 100 }, { name: dup, size: 90 }] })
    expect(snap.assignments['a'].file).toBe(dup)
    expect(snap.assignments['a'].losers).toEqual([])
  })
})

describe('随机语料生成器', () => {
  it('mulberry32 同种子同序列（基线可复现的根）', () => {
    const cases = randomCases(3)
    expect(cases.map((c) => c.name)).toEqual(['random#0', 'random#1', 'random#2'])
    expect(randomCases(3)).toEqual(cases)
  })

  it('生成器不产同名文件（合法输入空间）', () => {
    for (const c of randomCases()) {
      expect(new Set(c.right.map((r) => r.name)).size, c.name).toBe(c.right.length)
    }
  })
})
