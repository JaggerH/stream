import { describe, it, expect } from 'vitest'
import { DEFAULT_MATCH_SPEC } from '../match-spec.ts'
import { matchByEvidence } from './resolve.ts'
import { explainFromTrail, explainsOf, MAX_EXPLAIN_EDGES, type ExplainEpisode } from './explain.ts'
import type { Trail, TrailEdge } from './types.ts'

const noEpisode = () => undefined
/** 默认带一条时长命中 —— 够得着展示门槛（见 `worthShowing`），不然它压根不进卡片。 */
const edge = (leftKey: string, e: Partial<TrailEdge> = {}): TrailEdge => ({
  leftKey,
  facts: [{ kind: 'duration', state: 'hit', deltaS: 0, toleranceS: 1 }],
  outcome: 'vetoed',
  vetoReason: 'below-threshold',
  ...e,
})
/** 记录密度产物：只有一条够不着裁决地板（0.3）的名字分。 */
const weakEdge = (leftKey: string, score = 0.06): TrailEdge => ({
  leftKey,
  facts: [{ kind: 'name', method: 'sim', score, cleanedLeft: '甲乙丙丁', cleanedRight: '戊己庚辛', stripId: 'S0' }],
  outcome: 'vetoed',
  vetoReason: 'below-threshold',
})

describe('file 那一段', () => {
  const trail: Trail = { path: '/a.mp3', disposition: 'residual', edges: [] }

  it('码率现算：size×8÷时长（88.7MiB / 5808s ≈ 128kbps）', () => {
    const x = explainFromTrail(trail, { path: '/a.mp3', size: 92_986_927, durationS: 5808 }, noEpisode)
    expect(x.file.kbps).toBe(128)
    expect(x.file.sizeBytes).toBe(92_986_927)
    expect(x.file.durationS).toBe(5808)
  })

  it('没时长 → 没有 kbps 这个字段（不塞 0 冒充）', () => {
    const x = explainFromTrail(trail, { path: '/a.mp3', size: 1000 }, noEpisode)
    expect(x.file).not.toHaveProperty('kbps')
    expect(x.file).not.toHaveProperty('durationS')
  })

  it('时长是 0 也不算数（除零算出来的不是码率）', () => {
    expect(explainFromTrail(trail, { path: '/a.mp3', size: 1000, durationS: 0 }, noEpisode).file).not.toHaveProperty('kbps')
  })
})

describe('edges 排序与截断', () => {
  it('胜出的那条永远排头（卡片第一眼要回答"凭什么是它"）', () => {
    const trail: Trail = {
      path: '/a.mp3', disposition: 'claimed', claimedBy: 'B', rule: 'R8',
      edges: [
        edge('A', { facts: [{ kind: 'duration', state: 'hit', deltaS: 0, toleranceS: 1 }] }),
        edge('B', { outcome: 'won', rule: 'R8', vetoReason: undefined, facts: [] }),
      ],
    }
    const x = explainFromTrail(trail, { path: '/a.mp3', size: 1 }, noEpisode)
    expect(x.edges.map((e) => e.episode.leftKey)).toEqual(['B', 'A'])
  })

  it('同为否决时按证据分量排：时长命中 > 结构键 > 名字分', () => {
    const trail: Trail = {
      path: '/a.mp3', disposition: 'residual',
      edges: [
        edge('name', { facts: [{ kind: 'name', method: 'sim', score: 0.9, cleanedLeft: 'x', cleanedRight: 'y', stripId: 'S0' }] }),
        edge('struct', { facts: [{ kind: 'struct-key', key: 'epnum', value: '7' }] }),
        edge('hit', { facts: [{ kind: 'duration', state: 'hit', deltaS: 0, toleranceS: 1 }] }),
      ],
    }
    const x = explainFromTrail(trail, { path: '/a.mp3', size: 1 }, noEpisode)
    expect(x.edges.map((e) => e.episode.leftKey)).toEqual(['hit', 'struct', 'name'])
  })

  it(`超过 ${MAX_EXPLAIN_EDGES} 条截断并记 truncatedCount（账本每轮一条，不设上限会撑爆库）`, () => {
    const trail: Trail = {
      path: '/a.mp3', disposition: 'residual',
      edges: Array.from({ length: 12 }, (_, i) => edge(`L${String(i).padStart(2, '0')}`)),
    }
    const x = explainFromTrail(trail, { path: '/a.mp3', size: 1 }, noEpisode)
    expect(x.edges).toHaveLength(MAX_EXPLAIN_EDGES)
    expect(x.truncatedCount).toBe(4)
  })

  it('没截断时 truncatedCount 字段缺席', () => {
    expect(explainFromTrail({ path: '/a.mp3', disposition: 'residual', edges: [edge('A')] }, { path: '/a.mp3', size: 1 }, noEpisode))
      .not.toHaveProperty('truncatedCount')
  })
})

/**
 * 展示门槛。名字器的记录地板 0.05 远低于裁决地板 0.3，于是一份文件会与几十集各连一条 0.06 分的
 * 边——**它们把真证据挤出 8 条的上限**（活体：2096 条边里 823 条是这种，373 行里 162 行被截断）。
 * 轨迹里照旧全留（I1），卡片只列规则真会拿来比的那几条。
 */
describe('展示门槛：记录密度的产物不进卡片', () => {
  it('只带弱名字分（<0.3）的边不列，但由 truncatedCount 如实交代', () => {
    const trail: Trail = {
      path: '/a.mp3', disposition: 'residual',
      edges: [edge('strong'), weakEdge('w1'), weakEdge('w2'), weakEdge('w3')],
    }
    const x = explainFromTrail(trail, { path: '/a.mp3', size: 1 }, noEpisode)
    expect(x.edges.map((e) => e.episode.leftKey)).toEqual(['strong'])
    expect(x.truncatedCount).toBe(3) // 没列进来的边数 —— 不假装没有过
  })

  it('名字分刚过裁决地板（0.3）就进卡片：门槛与裁决层同一把尺', () => {
    const trail: Trail = { path: '/a.mp3', disposition: 'residual', edges: [weakEdge('just-over', 0.3)] }
    expect(explainFromTrail(trail, { path: '/a.mp3', size: 1 }, noEpisode).edges).toHaveLength(1)
  })

  it('胜出的那条不看门槛（结构键认下的可以一点名字分都没有）', () => {
    const trail: Trail = {
      path: '/a.mp3', disposition: 'claimed', claimedBy: 'W', rule: 'R6',
      edges: [{ leftKey: 'W', outcome: 'won', rule: 'R6', facts: [] }],
    }
    expect(explainFromTrail(trail, { path: '/a.mp3', size: 1 }, noEpisode).edges.map((e) => e.episode.leftKey)).toEqual(['W'])
  })

  it('只带字节孪生的边不列——那条孪生信息每条边上都挂了一份，留下的边里现成就有', () => {
    const trail: Trail = {
      path: '/a.mp3', disposition: 'residual',
      edges: [
        { leftKey: 'twin', outcome: 'informational', facts: [{ kind: 'byte-identity', peerPath: '/b.mp3' }] },
        edge('real', { facts: [
          { kind: 'duration', state: 'hit', deltaS: 0, toleranceS: 1 },
          { kind: 'byte-identity', peerPath: '/b.mp3' },
        ] }),
      ],
    }
    const x = explainFromTrail(trail, { path: '/a.mp3', size: 1 }, noEpisode)
    expect(x.edges.map((e) => e.episode.leftKey)).toEqual(['real'])
    expect(x.edges[0].facts).toContainEqual({ kind: 'byte-identity', peerPath: '/b.mp3' })
  })
})

describe('verdict 那一段', () => {
  it('残差**没有规则号**——没有任何一条规则认领它，硬编一个就是编话', () => {
    const x = explainFromTrail({ path: '/a.mp3', disposition: 'residual', edges: [] }, { path: '/a.mp3', size: 1 }, noEpisode)
    expect(x.verdict).toEqual({ disposition: 'residual' })
  })

  it('认领带规则号与门槛对照', () => {
    const trail: Trail = {
      path: '/a.mp3', disposition: 'claimed', claimedBy: 'L1', rule: 'R5',
      thresholds: { sim: { got: 0.71, need: 0.6 } }, edges: [],
    }
    const x = explainFromTrail(trail, { path: '/a.mp3', size: 1 }, noEpisode)
    expect(x.verdict).toEqual({ rule: 'R5', disposition: 'claimed', thresholds: { sim: { got: 0.71, need: 0.6 } } })
  })
})

describe('被否决的边必带理由（I1）', () => {
  it('vetoReason 原样带出，不做人话映射——映射是前端的事，缺映射要露码不许编话', () => {
    const trail: Trail = { path: '/a.mp3', disposition: 'residual', edges: [edge('A', { vetoReason: 'name-floor' as const, rule: 'R3' })] }
    const x = explainFromTrail(trail, { path: '/a.mp3', size: 1 }, noEpisode)
    expect(x.edges[0]).toMatchObject({ outcome: 'vetoed', vetoReason: 'name-floor', rule: 'R3' })
  })
})

describe('explainsOf：真跑一轮引擎', () => {
  // 05 案：名字指 05、时长指 005。
  const left = [
    { leftKey: 'L005', title: '005.身边那些灵异事', durationS: 5808, paid: false },
    { leftKey: 'L05', title: '05.太极两仪生四象', durationS: 2163, paid: true },
  ]
  const files = [
    { path: '/玄关笔记/05.太极两仪生四象.mp3', size: 92_986_927, durationS: 5808 },
    { path: '/来源/05.太极两仪生四象【耗时整理】.mp3', size: 34_000_000, durationS: 2164 },
  ]
  const res = matchByEvidence(DEFAULT_MATCH_SPEC, left, files.map((f) => ({ name: f.path, size: f.size, durationS: f.durationS })))
  const byPath = new Map(files.map((f) => [f.path, f]))
  const episodeOf = (k: string): ExplainEpisode | undefined => {
    const l = left.find((x) => x.leftKey === k)
    return l ? { title: l.title, durationS: l.durationS, paid: l.paid } : undefined
  }
  const explains = explainsOf(res, (p) => byPath.get(p), episodeOf)

  it('每个进过证据图的文件都有一行（I1：轨迹不许缺）', () => {
    expect([...explains.keys()].sort()).toEqual(files.map((f) => f.path).sort())
  })

  it('05 案那份：两条边都在，各带自己那侧的事实与集标题', () => {
    const x = explains.get('/玄关笔记/05.太极两仪生四象.mp3')!
    expect(x.verdict.disposition).toBe('asked')
    const titles = x.edges.map((e) => e.episode.title).sort()
    expect(titles).toEqual(['005.身边那些灵异事', '05.太极两仪生四象'])
    // 时长那条边真的写着 hit，不是一句"对得上"
    const hit = x.edges.find((e) => e.episode.leftKey === 'L005')!
    expect(hit.facts).toContainEqual({ kind: 'duration', state: 'hit', deltaS: 0, toleranceS: 1 })
    // paid 三态原样带上（展示要用，裁决层没读过它）
    expect(hit.episode.paid).toBe(false)
    expect(x.edges.find((e) => e.episode.leftKey === 'L05')!.episode.paid).toBe(true)
  })

  it('取不到文件事实的路径直接不出行（豁免/字节全等那两档没进过图）', () => {
    expect(explainsOf(res, () => undefined, episodeOf).size).toBe(0)
  })

  it('取不到集标题时露 leftKey，不编一个名字出来', () => {
    const x = explainsOf(res, (p) => byPath.get(p), noEpisode).get('/玄关笔记/05.太极两仪生四象.mp3')!
    expect(x.edges.map((e) => e.episode.title).sort()).toEqual(['L005', 'L05'])
  })
})
