import { describe, it, expect } from 'vitest'
import { collectEvidence } from './collect.ts'
import { resolve, matchByEvidence, assertInvariants } from './resolve.ts'
import { rulesFromSpec, RULES } from './rules.ts'
import { DEFAULT_MATCH_SPEC, DEFAULT_TITLE_STRIP } from '../match-spec.ts'
import type { SpecLeft, SpecRight } from '../match-spec.ts'
import type { MatchSpec } from '../types.ts'

const L = (leftKey: string, title: string, durationS?: number, paid?: boolean): SpecLeft =>
  ({ leftKey, title, ...(durationS != null ? { durationS } : {}), ...(paid != null ? { paid } : {}) })
const R = (name: string, durationS?: number, size?: number): SpecRight =>
  ({ name, ...(durationS != null ? { durationS } : {}), ...(size != null ? { size } : {}) })

describe('resolve 基本行为', () => {
  it('干净的号+标题 → 认领 auto', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC, [L('a', '020.再谈身边灵异事')], [R('020.再谈身边灵异事.mp3')])
    expect(r.assignments.get('a')).toMatchObject({ path: '020.再谈身边灵异事.mp3', status: 'auto' })
    expect(r.residual).toHaveLength(0)
  })

  it('号撞车、标题不同 → 不配，文件进残差，问句带证据', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC, [L('a', '014.六月新闻大盘点')], [R('14.辛金.mp3')])
    expect(r.assignments.size).toBe(0)
    expect(r.residual).toEqual(['14.辛金.mp3'])
    expect(r.asks[0]).toMatchObject({ leftKey: 'a', reason: 'below-threshold', rule: RULES.EPNUM.id })
  })

  it('号在左侧、右侧无此号文件 → 缺档（口径归 epnum）', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC, [L('a', '066.凑活聊道德绑架'), L('b', '020.再谈身边灵异事')], [R('020.再谈身边灵异事.mp3')])
    expect(r.missingByLeft.get('a')).toBe(66)
  })

  it('人工订正预置：pin 直接成为结论，规则不许翻案', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC,
      [{ leftKey: 'a', title: '020.再谈身边灵异事', pinnedRight: '别的文件.mp3' }],
      [R('020.再谈身边灵异事.mp3'), R('别的文件.mp3')])
    expect(r.assignments.get('a')).toMatchObject({ path: '别的文件.mp3', rule: RULES.PIN.id, confidence: 1 })
  })

  it('时长唯一命中免检阈值（455/454 那条 0.615 照过），且是 auto', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC, [L('a', '454.现代版枪下留人', 3000)], [R('455.现代版木仓下留人.mp3', 3000)])
    expect(r.assignments.get('a')).toMatchObject({ status: 'auto', rule: RULES.DURATION_UNIQUE.id })
  })

  it('时长唯一命中但名字一个字不沾 → 不配，且记 name-floor 问句（848/209 活体）', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC, [L('a', '848.太极两仪生四象', 8162)], [R('209.身边那些灵异事.mp3', 8163)])
    expect(r.assignments.size).toBe(0)
    expect(r.asks[0]).toMatchObject({ leftKey: 'a', reason: 'name-floor', rule: RULES.DURATION_NAME_FLOOR.id })
  })

  /**
   * 活体（脱口秀 map_c038e1，2026-09-03）：`S03E11 - 2026.07.25-第5期下纯享.mp4` 名字上刻着 E11、期段也对得上
   * 「第5期下」，引擎每一档都把它认成 E11；而纯享是另一条播放线（用户拍板）。同步和归档器各看各的
   * 决定账本，只有引擎自己不建这条边两侧才一致。
   */
  it('纯享剪辑对期-段体系的正片：名字/号/期段全对上也不配，记 pure-cut-mismatch、不出问句', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC, [L('tmdb:1:S03E11', '第5期下：周深丹妮合唱天籁', 3300)], [R('S03E11 - 2026.07.25-第5期下纯享.mp4', 3212)])
    expect(r.assignments.size).toBe(0)
    expect(r.trails.get('S03E11 - 2026.07.25-第5期下纯享.mp4')!.edges.some((e) => e.vetoReason === 'pure-cut-mismatch')).toBe(true)
    expect(r.asks).toHaveLength(0)
  })

  it('清单自己把纯享列成一集（标题带纯享）→ 照常认领', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC, [L('tmdb:1:S02E29', '第8期纯享：刘仁铖模仿付航心算热量')], [R('第8期纯享：刘仁铖模仿付航心算热量.mp4')])
    expect(r.assignments.get('tmdb:1:S02E29')).toBeDefined()
  })

  it('横向时长矛盾闸：名字一模一样、号也对，时长差出量级 → 不配', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC, [L('a', '005.身边那些灵异事', 2000)], [R('005.身边那些灵异事.mp3', 5808)])
    expect(r.assignments.size).toBe(0)
    expect(r.trails.get('005.身边那些灵异事.mp3')!.edges.some((e) => e.vetoReason === 'duration-contradict')).toBe(true)
  })

  it('paid 是透传字段：裁决层不读它，带不带结果一模一样', () => {
    const files = [R('020.再谈身边灵异事.mp3')]
    const a = matchByEvidence(DEFAULT_MATCH_SPEC, [L('a', '020.再谈身边灵异事')], files)
    const b = matchByEvidence(DEFAULT_MATCH_SPEC, [L('a', '020.再谈身边灵异事', undefined, true)], files)
    expect(a.assignments.get('a')).toEqual(b.assignments.get('a'))
  })
})

/**
 * **不需供货的集不发问句**（`LeftNode.needsSupply === false`）。理由不是"这一集不重要"，
 * 而是问了也白问：源站自己放得出，网盘那份文件是不是它都一样处置。
 *
 * 这一节钉三件事：闸真的关得住（各档问句一个都不出）、**认领判定一个字不变**（它不是第二个
 * 判定脑，只挡问句），以及 `undefined` 与 `false` 差得最远——缺席一律当"要供货"，
 * 影视绑定（压根没有供货这回事）绝不许被这道闸吞掉。
 */
describe('needsSupply 闸：不需供货的集，一个问句都不发', () => {
  const S = (leftKey: string, title: string, durationS: number, needsSupply?: boolean): SpecLeft =>
    ({ leftKey, title, durationS, ...(needsSupply != null ? { needsSupply } : {}) })

  it('name-floor 档：needsSupply:false → 问句没了（848/209 那个形状）', () => {
    const right = [R('209.身边那些灵异事.mp3', 8163)]
    expect(matchByEvidence(DEFAULT_MATCH_SPEC, [S('a', '848.太极两仪生四象', 8162)], right).asks)
      .toHaveLength(1)
    expect(matchByEvidence(DEFAULT_MATCH_SPEC, [S('a', '848.太极两仪生四象', 8162, false)], right).asks)
      .toEqual([])
  })

  it('below-threshold 档（号撞车、标题不同）同样关得住', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC, [{ leftKey: 'a', title: '014.六月新闻大盘点', needsSupply: false }], [R('14.辛金.mp3')])
    expect(r.asks).toEqual([])
    expect(r.residual).toEqual(['14.辛金.mp3']) // 处置照旧由残差说了算，闸只挡问句
  })

  /**
   * **时长矛盾那一档不在闸后面**（裁决表第 3 格，spec §8）。闸的论证是"问了也白问：不论是不是
   * 它，处置都一样（删）"，而这一句在这一档里是**假的**：处置层删那一步（`plan.ts` 的
   * `redundant-free-candidates`）只认**活候选**，而 `liveCandidateKeys` 把 `duration-contradict`
   * 这种**事实级**否决的边整条剔掉——时长矛盾的候选压根走不到自动删。答案真会改变动作
   * （是这一集 → 换正主；不是 → 挪去下架），问句就不许被吞。
   *
   * 两档都要钉：带 `markAsk` 的那几档（epnum/season-episode/episode-part/时长档，R11 记的）
   * 和标题档那条 `force` 记的（R14）。只放行其中一条就会留下另一条静默下架的通路——
   * 活体 2026-08-02 怡楽的 112/116 走的正是标题档那条。
   */
  it('duration-contradiction 档（epnum，R11 记的）：needsSupply:false 照发问句', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC, [S('a', '005.身边那些灵异事', 2000, false)], [R('005.身边那些灵异事.mp3', 5808)])
    expect(r.asks).toMatchObject([{ leftKey: 'a', reason: 'duration-contradiction', rule: RULES.CONTENT_MISMATCH.id }])
  })

  it('duration-contradiction 档（标题档，R14 force 记的）：needsSupply:false 照发问句', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC, [S('a', '灵异故事-2021年9月特别篇', 2000, false)], [R('灵异故事-2021年9月特别篇.mp3', 5808)])
    expect(r.asks).toMatchObject([{
      leftKey: 'a', reason: 'duration-contradiction', rule: RULES.NAME_HIT_DURATION_CONTRADICT.id,
    }])
  })

  /**
   * **闸只收窄这一档，别顺手掀开整道闸**：名字够不到门槛 + 时长矛盾属于第 8 格（无信号），
   * R14 的 `force` 判据本来就不对它开，闸开不开都不该有卡。
   */
  it('名字够不到门槛 + 时长矛盾 → 照旧没有卡（第 8 格，不是第 3 格）', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC, [S('a', '灵异故事-2021年9月特别篇', 2000, false)], [R('甲乙丙丁戊己庚辛.mp3', 5808)])
    expect(r.asks).toEqual([])
  })

  it('认领判定一个字不变：闸只挡问句，不是第二个判定脑', () => {
    const right = [R('020.再谈身边灵异事.mp3', 3000)]
    const on = matchByEvidence(DEFAULT_MATCH_SPEC, [S('a', '020.再谈身边灵异事', 3000, false)], right)
    const off = matchByEvidence(DEFAULT_MATCH_SPEC, [S('a', '020.再谈身边灵异事', 3000, true)], right)
    expect(on.assignments.get('a')).toEqual(off.assignments.get('a'))
    expect(on.residual).toEqual(off.residual)
  })

  it('needsSupply 缺席 = 要供货：问句照发（影视绑定的护栏）', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC, [S('a', '848.太极两仪生四象', 8162)], [R('209.身边那些灵异事.mp3', 8163)])
    expect(r.asks[0]).toMatchObject({ leftKey: 'a', reason: 'name-floor' })
  })

  it('一集关闸不影响别的集：另一集的问句照出', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC,
      [S('free', '848.太极两仪生四象', 8162, false), S('paid', '849.另一集完全不同的名字', 7000, true)],
      [R('209.身边那些灵异事.mp3', 8163), R('210.又一个不沾边的.mp3', 7000)])
    expect(r.asks.map((a) => a.leftKey)).toEqual(['paid'])
  })

  /** 文件侧的 I3 冲突卡**不经过这道闸**（它问的是文件不是集）——处置层据此另有出口，见 `plan.ts`。 */
  it('文件侧冲突卡不受影响：闸管的是集侧问句', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC,
      [S('a', '101.甲集', 3000, false), S('b', '102.乙集', 3000, false)],
      [R('完全不沾边的文件.mp3', 3000)])
    expect(r.asks.map((a) => a.path)).toEqual(['完全不沾边的文件.mp3'])
    expect(r.asks[0]).toMatchObject({ reason: 'dual-episode-conflict' })
  })
})

describe('I1 无痕：见过的边不许消失', () => {
  it('每个入池文件都有轨迹 —— 含一条边都没有的', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC, [L('a', '020.再谈身边灵异事')], [R('020.再谈身边灵异事.mp3'), R('封面.jpg'), R('说明.nfo')])
    expect([...r.trails.keys()].sort()).toEqual(['020.再谈身边灵异事.mp3', '封面.jpg', '说明.nfo'])
    expect(r.trails.get('封面.jpg')!.edges).toHaveLength(0)
  })

  it('被否决的每条边都带理由（闭集里的一个值），一条都不许空着', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC,
      [L('a', '005.身边那些灵异事', 5808), L('b', '05.太极两仪生四象', 2163)],
      [R('怡乐播客 - 005.身边那些灵异事.mp3', 5808, 92986927), R('玄关笔记/05.太极两仪生四象.mp3', 5808, 92986927), R('来源/05.太极两仪生四象【耗时整理】.mp3', 2164, 34600000)])
    for (const t of r.trails.values()) {
      for (const e of t.edges) if (e.outcome === 'vetoed') expect(e.vetoReason).toBeTruthy()
    }
  })

  it('「该集已被别的文件认领」这条断路必须留痕（05 案的第二条断路）', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC,
      [L('a', '05.太极两仪生四象', 2163)],
      [R('来源/05.太极两仪生四象【耗时整理】.mp3', 2164, 34600000), R('玄关笔记/05.太极两仪生四象.mp3', 5808, 92986927)])
    const t = r.trails.get('玄关笔记/05.太极两仪生四象.mp3')!
    const edge = t.edges.find((e) => e.leftKey === 'a')!
    expect(edge.outcome).toBe('vetoed')
    expect(edge.vetoReason).toBe('duration-contradict') // 名字全等的那条边被时长闸显式否掉，不是消失
  })

  it('走完全部规则都没人碰过的边 = 规则覆盖的漏洞 → 不许出现在真实夹具里', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC,
      [L('a', '005.身边那些灵异事', 5808), L('b', '05.太极两仪生四象', 2163)],
      [R('怡乐播客 - 005.身边那些灵异事.mp3', 5808, 92986927), R('玄关笔记/05.太极两仪生四象.mp3', 5808, 92986927)])
    const unevaluated = [...r.trails.values()].flatMap((t) => t.edges).filter((e) => e.vetoReason === 'unevaluated')
    expect(unevaluated).toEqual([])
  })

  it('构造「见过又丢弃」的形状：断言必然留痕，assertInvariants 不许放过手工抹掉的轨迹', () => {
    const spec = DEFAULT_MATCH_SPEC
    const left = [L('a', '005.身边那些灵异事', 5808)]
    const right = [R('怡乐播客 - 005.身边那些灵异事.mp3', 5808), R('玄关笔记/05.太极两仪生四象.mp3', 5808)]
    const graph = collectEvidence(spec, left, right)
    const r = resolve(graph, rulesFromSpec(spec, graph))
    // 零竞争落选的那份：05 案的第一条断路就在这里——它曾被原地丢掉，账上一个字都没留。
    const t = r.trails.get('玄关笔记/05.太极两仪生四象.mp3')!
    expect(t.edges.find((e) => e.leftKey === 'a')).toMatchObject({ outcome: 'vetoed', vetoReason: 'zero-competition-loser' })
    // 把理由抹掉 = 无痕丢弃 → 断言必须炸。
    t.edges[0].vetoReason = undefined
    expect(() => assertInvariants(graph, r)).toThrow(/I1/)
  })
})

describe('I2 残差最窄：只接受零边或全边显式否决', () => {
  it('零边的文件才是干净的残差（封面/nfo）', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC, [L('a', '020.再谈身边灵异事')], [R('020.再谈身边灵异事.mp3'), R('封面.jpg')])
    expect(r.residual).toEqual(['封面.jpg'])
  })

  it('残差里每条可裁决的边都必须是 vetoed —— 手工翻成 informational 就炸', () => {
    const spec = DEFAULT_MATCH_SPEC
    const left = [L('a', '014.六月新闻大盘点')]
    const right = [R('14.辛金.mp3')]
    const graph = collectEvidence(spec, left, right)
    const r = resolve(graph, rulesFromSpec(spec, graph))
    expect(r.residual).toEqual(['14.辛金.mp3'])
    r.trails.get('14.辛金.mp3')!.edges[0].outcome = 'won'
    expect(() => assertInvariants(graph, r)).toThrow(/I1|I2/)
  })

  it('被认领的文件（含同集副本）绝不同时算残差', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC,
      [L('a', '707.风水鱼要在棺材里？')],
      [R('707.风水鱼要在棺材里？【公众号】.mp3'), R('707.风水鱼要在棺材里？【耗时整理】.mp3')])
    const a = r.assignments.get('a')!
    expect(r.residual).not.toContain(a.path)
    for (const l of a.losers) expect(r.residual).not.toContain(l)
  })
})

/**
 * 触发这次重构的事故（2026-08-02 取证定案）：`玄关笔记/05.太极两仪生四象.mp3` 是免费集 005 的
 * 同字节副本、名字贴错。它一度被无痕丢弃 → 算进残差 → 计划静默搬下架，而卡片给的理由是假话。
 * I3 说这种证据指向多个集、没有规则显式裁定的形状**必须出卡**（裁决表第 6 格，spec §8）。
 */
describe('I3 冲突必浮出：05/20 必须出卡，不许落进残差', () => {
  const spec = DEFAULT_MATCH_SPEC
  const left = [
    L('yl:005', '005.身边那些灵异事', 5808, false),
    L('yl:05', '05.太极两仪生四象', 2163, true),
  ]
  const right = [
    R('怡乐播客 - 005.身边那些灵异事.mp3', 5808, 92986927),
    R('玄关笔记/05.太极两仪生四象.mp3', 5808, 92986927),
    R('来源/05.太极两仪生四象【耗时整理‖cunlove.cn】.mp3', 2164, 34600000),
  ]
  const mis = '玄关笔记/05.太极两仪生四象.mp3'

  it('出卡 dual-episode-conflict，不进残差', () => {
    const r = matchByEvidence(spec, left, right)
    expect(r.residual).not.toContain(mis)
    const ask = r.asks.find((a) => a.path === mis)!
    expect(ask).toMatchObject({ reason: 'dual-episode-conflict', rule: RULES.DUAL_EPISODE_CONFLICT.id })
    expect(ask.candidates.map((c) => c.name).sort()).toEqual(['yl:005', 'yl:05'])
  })

  it('卡片能把双集冲突原样摆出来：时长指 005、名字指 05、且与 005 正主字节全等', () => {
    const r = matchByEvidence(spec, left, right)
    const t = r.trails.get(mis)!
    expect(t.disposition).toBe('asked')
    const toFree = t.edges.find((e) => e.leftKey === 'yl:005')!
    const toPaid = t.edges.find((e) => e.leftKey === 'yl:05')!
    expect(toFree.facts.some((f) => f.kind === 'duration' && f.state === 'hit')).toBe(true)
    expect(toFree.facts.some((f) => f.kind === 'byte-identity' && f.peerPath === '怡乐播客 - 005.身边那些灵异事.mp3')).toBe(true)
    expect(toPaid.facts.some((f) => f.kind === 'name' && f.method === 'identity-exact')).toBe(true)
    expect(toPaid.facts.some((f) => f.kind === 'duration' && f.state === 'contradict')).toBe(true)
  })

  it('两集各自的正主照常配上 —— 冲突出卡不许连累正确的那两条', () => {
    const r = matchByEvidence(spec, left, right)
    expect(r.assignments.get('yl:005')!.path).toBe('怡乐播客 - 005.身边那些灵异事.mp3')
    expect(r.assignments.get('yl:05')!.path).toBe('来源/05.太极两仪生四象【耗时整理‖cunlove.cn】.mp3')
  })

  it('20 案同形状（另一期的错名副本）照样出卡', () => {
    const l20 = [L('yl:020', '020.再谈身边灵异事', 4210), L('yl:20', '20.坎水之象', 1900)]
    const r20 = [
      R('怡乐播客 - 020.再谈身边灵异事.mp3', 4210, 51200000),
      R('玄关笔记/20.坎水之象.mp3', 4210, 51200000),
      R('来源/20.坎水之象【耗时整理】.mp3', 1901, 22000000),
    ]
    const r = matchByEvidence(spec, l20, r20)
    expect(r.asks.some((a) => a.path === '玄关笔记/20.坎水之象.mp3' && a.reason === 'dual-episode-conflict')).toBe(true)
  })

  it('只有一条像样证据的文件不出卡（噪声不许把问句卡淹掉）', () => {
    const r = matchByEvidence(spec, [L('a', '014.六月新闻大盘点')], [R('14.辛金.mp3'), R('封面.jpg')])
    expect(r.asks.filter((a) => a.path)).toHaveLength(0)
  })
})

describe('规则表：优先序是显式的表，不是控制流的副产品', () => {
  it('隐式时长锚排在最前，收尾规则恒在最后', () => {
    const graph = collectEvidence(DEFAULT_MATCH_SPEC, [], [])
    const ids = rulesFromSpec(DEFAULT_MATCH_SPEC, graph).map((r) => r.id)
    expect(ids[0]).toBe(RULES.PIN.id)
    expect(ids[1]).toBe(RULES.DURATION_UNIQUE.id)
    expect(ids.at(-1)).toBe(RULES.SWEEP_COPIES.id)
  })

  it('免检口径逐档声明：结构键免检、集号/标题不免检', () => {
    const graph = collectEvidence(DEFAULT_MATCH_SPEC, [], [])
    const by = new Map(rulesFromSpec(DEFAULT_MATCH_SPEC, graph).map((r) => [r.id, r]))
    expect(by.get(RULES.SEASON_EPISODE.id)).toMatchObject({ trustUnique: true, autoOnMatch: true })
    expect(by.get(RULES.EPISODE_PART.id)).toMatchObject({ trustUnique: true, autoOnMatch: true })
    expect(by.get(RULES.EPNUM.id)).toMatchObject({ trustUnique: false, autoOnMatch: false, markAsk: true })
    expect(by.get(RULES.TITLE.id)).toMatchObject({ trustUnique: false, markAsk: false })
  })

  it('自定义谱：显式声明的时长档不再补，容差与门槛按声明走', () => {
    const spec: MatchSpec = {
      version: 2,
      stages: [{ by: 'duration', toleranceS: 3, titleStrip: DEFAULT_TITLE_STRIP, threshold: 0.6, margin: 0.15 }],
    }
    const graph = collectEvidence(spec, [], [])
    const rules = rulesFromSpec(spec, graph)
    expect(rules.filter((r) => r.kind === 'duration')).toHaveLength(1)
    expect(rules.find((r) => r.kind === 'duration')!.toleranceS).toBe(3)
  })
})

/**
 * 结构键桶里**名字全等压过体量**（活体 2026-09-03 脱口秀 S02E10，`tmdb:261471`）：
 * `第5期中` 这个键下正片 4.65GB、纯享版 5.87GB，体量择优把纯享版判成唯一候选并给了 auto，
 * 正片成了孤儿——而它的名字与节目单一字不差。体量只能在**同一内容**的不同发布之间选。
 *
 * 三条一起钉：翻案要真发生、**没有名字信号时行为一个字不变**（体量仍是唯一的尺）、
 * 真重复（都全等）照旧按体量。
 */
describe('结构键桶：名字全等压过体量', () => {
  const PART_SPEC: MatchSpec = {
    version: 2,
    stages: [{ by: 'episode-part', keyRegex: '^第0*(\\d{1,3})期([上中下])', titleStrip: DEFAULT_TITLE_STRIP, threshold: 0.25, margin: 0.1 }],
  }
  const GB = 1024 ** 3

  it('名字全等的小文件胜出，体量大的那份降为同键副本', () => {
    const r = matchByEvidence(PART_SPEC,
      [L('tmdb:261471:s2e10', '第5期中：狠人对决！邱瑞PK高寒')],
      [
        R('2025-07-12 第5期中：狠人对决！邱瑞PK高寒.mkv', undefined, Math.round(4.65 * GB)),
        R('2025-07-12 第5期中下纯享版：3500的良言 vs 1800的铁饭碗.mkv', undefined, Math.round(5.87 * GB)),
      ])
    const a = r.assignments.get('tmdb:261471:s2e10')!
    expect(a.path).toBe('2025-07-12 第5期中：狠人对决！邱瑞PK高寒.mkv')
    // 纯享版对期-段体系的正片是事实级否决（`pure-cut-mismatch`）：既不是正主也不是它的落选副本，
    // 留作残差（归档器把它搬去纯享货架）。
    expect(a.losers).not.toContain('2025-07-12 第5期中下纯享版：3500的良言 vs 1800的铁饭碗.mkv')
    expect(r.residual).toEqual(['2025-07-12 第5期中下纯享版：3500的良言 vs 1800的铁饭碗.mkv'])
    expect(r.trails.get('2025-07-12 第5期中下纯享版：3500的良言 vs 1800的铁饭碗.mkv')!.edges.some((e) => e.vetoReason === 'pure-cut-mismatch')).toBe(true)
  })

  it('两份都不沾名字（发布标签变体）→ 老行为：体量大者胜', () => {
    const r = matchByEvidence(PART_SPEC,
      [L('x', '第7期上：甲乙丙丁戊己庚辛')],
      [
        R('2025-08-01 第7期上纯享版：壬癸子丑寅卯辰巳.mkv', undefined, 3 * GB),
        R('2025-08-01 第7期上加更版：午未申酉戌亥青龙.mkv', undefined, 6 * GB),
      ])
    expect(r.assignments.get('x')!.path).toBe('2025-08-01 第7期上加更版：午未申酉戌亥青龙.mkv')
  })

  /**
   * 体量赢家自己是**别的集**的名字全等正主 → 这一档一个字都不动：桶里混了两集（号相同、内容
   * 不同），翻案会把别人的正片当成本集副本占掉。金样 `random#40` 是同一形状的活体样本。
   */
  it('体量赢家是别的集的正主 → 不翻案，两集各归各家', () => {
    const r = matchByEvidence(DEFAULT_MATCH_SPEC,
      [L('a', '太极两仪生四象'), L('b', '03.现代版枪下留人')],
      [
        R('03.太极两仪生四象【耗时整理】.720p.mp3', undefined, 6 * GB),
        R('03.现代版枪下留人【公众号】.2160p.mp3', undefined, 3 * GB),
      ])
    expect(r.assignments.get('a')!.path).toBe('03.太极两仪生四象【耗时整理】.720p.mp3')
    expect(r.assignments.get('b')!.path).toBe('03.现代版枪下留人【公众号】.2160p.mp3')
    expect(r.assignments.get('b')!.losers).toEqual([])
  })

  it('两份都名字全等（真重复，只差体量）→ 老行为：体量大者胜', () => {
    const r = matchByEvidence(PART_SPEC,
      [L('y', '第3期下：谁是喜剧之王')],
      [
        R('清晰版/第3期下：谁是喜剧之王.mkv', undefined, 6 * GB),
        R('压缩版/第3期下：谁是喜剧之王.mkv', undefined, 3 * GB),
      ])
    const a = r.assignments.get('y')!
    expect(a.path).toBe('清晰版/第3期下：谁是喜剧之王.mkv')
    expect(a.losers).toContain('压缩版/第3期下：谁是喜剧之王.mkv')
  })
})
