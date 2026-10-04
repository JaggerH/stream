import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { DEFAULT_MATCH_SPEC } from '../match-spec.ts'
import type { Fact } from './types.ts'
import {
  benchmark, buildLiveBaseline, casesFromFixture, conflictCards, describeFact, renderLiveReport, runLiveGolden,
  type LiveFixture, type LiveGroup,
} from './live-golden.ts'
import { fmtDrift, type GoldenBaseline } from './golden.ts'

/**
 * 活体金样的**重放侧**测试。抓取那半边（`scripts/match-golden-live.ts`）出网，进不了 CI；
 * 重放这半边是纯函数，必须能单测——否则报告本身就没人验过。
 *
 * 最后一条是**门控**的真活体重放：`MATCH_GOLDEN_FIXTURE` + `MATCH_GOLDEN_BASELINE` 都给了才跑。
 * 默认跳过，CI 不依赖活体。
 */

/**
 * 05 案的最小复刻（spec §6 触发事故）：一份 5808s 的文件名字叫 `05.太极两仪生四象`，
 * 时长恰恰是免费集 005 的。名字指 A、时长指 B —— I3 说这必须出卡。
 */
const CASE_05: LiveGroup = {
  name: '05-案',
  source: '合成（事故复刻）',
  spec: DEFAULT_MATCH_SPEC,
  left: [
    { leftKey: 'ep005', title: '005.身边那些灵异事', durationS: 5808, paid: false },
    { leftKey: 'ep05', title: '05.太极两仪生四象', durationS: 2163, paid: true },
  ],
  right: [
    { name: '玄关笔记/05.太极两仪生四象.mp3', size: 93_000_000, durationS: 5808 },
    { name: '来源/05.太极两仪生四象【耗时整理‖cunlove.cn】.mp3', size: 34_000_000, durationS: 2164 },
  ],
}

describe('casesFromFixture', () => {
  it('逐组 1:1 投影，谱与左右两侧原样带过', () => {
    const fx: LiveFixture = { capturedAt: '2026-08-02T00:00:00.000Z', groups: [CASE_05] }
    const cases = casesFromFixture(fx)
    expect(cases).toHaveLength(1)
    expect(cases[0]).toEqual({ name: '05-案', spec: CASE_05.spec, left: CASE_05.left, right: CASE_05.right })
  })
})

describe('describeFact', () => {
  /** 每种 `Fact` 都要渲染出**它自己的数字**。加一种 Fact 忘了加渲染 → 这里红。 */
  const samples: Record<Fact['kind'], Fact> = {
    name: { kind: 'name', method: 'sim', score: 0.571, cleanedLeft: '甲', cleanedRight: '乙', stripId: 'S0' },
    'struct-key': { kind: 'struct-key', key: 'epnum', value: '455' },
    duration: { kind: 'duration', state: 'hit', deltaS: 0, toleranceS: 1 },
    'byte-identity': { kind: 'byte-identity', peerPath: '/lib/x.mp3' },
  }

  it('每种事实都渲染出量到的数字，没有空壳', () => {
    for (const [kind, f] of Object.entries(samples)) {
      const s = describeFact(f)
      expect(s, kind).toBeTruthy()
      expect(s, kind).not.toContain('undefined')
    }
  })

  it('名字全等与相似度是两种说法（分数不许被抹平成同一句）', () => {
    expect(describeFact({ kind: 'name', method: 'identity-exact', score: 1, cleanedLeft: '甲', cleanedRight: '甲', stripId: 'S0' }))
      .toContain('全等')
    expect(describeFact(samples.name)).toContain('0.571')
  })

  it('时长两态各说各的，差值与容差都在句子里', () => {
    expect(describeFact({ kind: 'duration', state: 'hit', deltaS: 0, toleranceS: 1 })).toMatch(/命中.*差 0s.*容差 1s/)
    expect(describeFact({ kind: 'duration', state: 'contradict', deltaS: 3645, toleranceS: 1 })).toMatch(/矛盾.*3645s/)
  })
})

describe('conflictCards', () => {
  const cards = conflictCards(CASE_05)

  it('05 案那份文件出一张卡（旧引擎把它无痕丢成残差）', () => {
    expect(cards.map((c) => c.path)).toEqual(['玄关笔记/05.太极两仪生四象.mp3'])
  })

  it('卡上两集都在场，且各带自己那侧的证据数字', () => {
    const [card] = cards
    expect(card.durationS).toBe(5808)
    const byTitle = new Map(card.episodes.map((e) => [e.title, e]))
    expect([...byTitle.keys()].sort()).toEqual(['005.身边那些灵异事', '05.太极两仪生四象'])
    // 时长指向 005（差 0s）
    expect(byTitle.get('005.身边那些灵异事')!.facts.join('|')).toMatch(/时长命中（差 0s/)
    // 名字指向 05，而时长与它差出量级
    const ep05 = byTitle.get('05.太极两仪生四象')!
    expect(ep05.facts.join('|')).toMatch(/名字/)
    expect(ep05.facts.join('|')).toMatch(/时长矛盾（差 3645s）/)
    // 05 这一集的正主是另一份（2164s 那个）——卡片要说得出"该集正主"
    expect(ep05.claimedBy).toBe('来源/05.太极两仪生四象【耗时整理‖cunlove.cn】.mp3')
  })

  it('paid 三态原样带上（卡片要标"免费/付费"，但裁决层没读过它）', () => {
    const byTitle = new Map(cards[0].episodes.map((e) => [e.title, e]))
    expect(byTitle.get('005.身边那些灵异事')!.paid).toBe(false)
    expect(byTitle.get('05.太极两仪生四象')!.paid).toBe(true)
  })
})

describe('benchmark', () => {
  it('取中位不取均值（离群的那一次不许把数字带跑）', () => {
    // 注入的假钟：每次读数 +1，于是每段耗时恒为 1 —— 断言的是"中位怎么取"，不是真实速度。
    let t = 0
    const timing = benchmark(casesFromFixture({ capturedAt: '', groups: [CASE_05] })[0], 3, () => ++t)
    expect(timing.medianMs).toBe(1)
  })
})

describe('runLiveGolden', () => {
  const fx: LiveFixture = { capturedAt: '2026-08-02T00:00:00.000Z', groups: [CASE_05] }

  it('没基线时只出报告、不判对错（第一次抓，没得可比）', () => {
    const result = runLiveGolden(fx, undefined, 1)
    expect({ hasBaseline: result.hasBaseline, drift: result.driftTotal, reports: result.reports.length })
      .toEqual({ hasBaseline: false, drift: 0, reports: 0 })
    expect(renderLiveReport(fx, result)).toContain('本次没有基线可比')
  })

  it('拿自己刚录的基线重放 → 零漂移', () => {
    const result = runLiveGolden(fx, buildLiveBaseline(fx, 'x'), 1)
    expect({ hasBaseline: result.hasBaseline, drift: result.driftTotal }).toEqual({ hasBaseline: true, drift: 0 })
  })

  it('基线里的判决被改过 → 报漂移，且报告里写出漂在哪', () => {
    const baseline = buildLiveBaseline(fx, 'x')
    // 把 05 案那张 I3 冲突卡从基线里抹掉，模拟"有人把它悄悄改回残差"。
    delete baseline.cases['05-案'].fileAsks['玄关笔记/05.太极两仪生四象.mp3']
    const result = runLiveGolden(fx, baseline, 1)
    expect(result.driftTotal).toBe(1)
    const text = renderLiveReport(fx, result)
    expect(text).toContain('漂了 1 条')
    expect(text).toContain('fileAsks only-actual 玄关笔记/05.太极两仪生四象.mp3')
  })

  it('报告里逐张列出翻案卡，不是只报个数', () => {
    const text = renderLiveReport(fx, runLiveGolden(fx, buildLiveBaseline(fx, 'x'), 1))
    expect(text).toContain('玄关笔记/05.太极两仪生四象.mp3')
    expect(text).toContain('《005.身边那些灵异事》')
    expect(text).toContain('逐字相同')
  })
})

/**
 * 真活体重放。`MATCH_GOLDEN_FIXTURE` 指向 `scripts/match-golden-live.ts` 抓下来的那份 JSON、
 * `MATCH_GOLDEN_BASELINE` 指向同一次抓取录下的基线时才跑——**默认跳过**：CI 里没有活体后端，
 * 也不该有。改了引擎之后拿同一对 fixture+基线复跑即为回归网。
 */
const fixturePath = process.env.MATCH_GOLDEN_FIXTURE
const baselinePath = process.env.MATCH_GOLDEN_BASELINE
describe.skipIf(!fixturePath || !baselinePath)('活体重放（门控）', () => {
  it('活体两 show + 影视绑定：与抓取时录下的基线零漂移', () => {
    const fx = JSON.parse(readFileSync(fixturePath!, 'utf8')) as LiveFixture
    const baseline = JSON.parse(readFileSync(baselinePath!, 'utf8')) as GoldenBaseline
    const result = runLiveGolden(fx, baseline, 1)
    expect(result.reports.filter((r) => !r.identical).map(fmtDrift).join('\n')).toBe('')
  })
})
