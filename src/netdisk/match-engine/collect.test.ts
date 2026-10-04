import { describe, it, expect } from 'vitest'
import { collectEvidence, NAME_RECORD_FLOOR } from './collect.ts'
import { DEFAULT_MATCH_SPEC, DEFAULT_TITLE_STRIP, DEFAULT_EPNUM_REGEX, DEFAULT_SEASON_EPISODE_REGEX, DEFAULT_EPISODE_PART_REGEX } from '../match-spec.ts'
import type { SpecLeft, SpecRight } from '../match-spec.ts'
import type { EvidenceGraph, Fact } from './types.ts'
import type { MatchSpec } from '../types.ts'

const L = (leftKey: string, title: string, durationS?: number): SpecLeft => ({ leftKey, title, ...(durationS != null ? { durationS } : {}) })
const R = (name: string, durationS?: number, size?: number): SpecRight => ({ name, ...(durationS != null ? { durationS } : {}), ...(size != null ? { size } : {}) })

const factsOn = (g: EvidenceGraph, leftKey: string, path: string): Fact[] =>
  g.edges.find((e) => e.leftKey === leftKey && e.path === path)?.facts ?? []
const kinds = (g: EvidenceGraph, leftKey: string, path: string) => factsOn(g, leftKey, path).map((f) => f.kind)
const durationFact = (g: EvidenceGraph, leftKey: string, path: string) =>
  factsOn(g, leftKey, path).find((f): f is Extract<Fact, { kind: 'duration' }> => f.kind === 'duration')
const nameFact = (g: EvidenceGraph, leftKey: string, path: string) =>
  factsOn(g, leftKey, path).find((f): f is Extract<Fact, { kind: 'name' }> => f.kind === 'name')
const structFact = (g: EvidenceGraph, leftKey: string, path: string) =>
  factsOn(g, leftKey, path).find((f): f is Extract<Fact, { kind: 'struct-key' }> => f.kind === 'struct-key')

const durationOnly: MatchSpec = {
  version: 2,
  stages: [{ by: 'duration', toleranceS: 1, titleStrip: DEFAULT_TITLE_STRIP, threshold: 0.6, margin: 0.15 }],
}

describe('DurationCollector（时长命中）', () => {
  it('容差内 → 出 hit 事实，deltaS 是实测差', () => {
    const g = collectEvidence(durationOnly, [L('a', '52.财克印', 3600)], [R('52.财克印.mp3', 3599)])
    expect(durationFact(g, 'a', '52.财克印.mp3')).toMatchObject({ state: 'hit', deltaS: 1, toleranceS: 1 })
  })

  it('容差外（差 2s）→ 时长上不表态（无 duration 事实）', () => {
    const g = collectEvidence(durationOnly, [L('a', '52.财克印', 3600)], [R('52.财克印.mp3', 3598)])
    expect(durationFact(g, 'a', '52.财克印.mp3')).toBeUndefined()
  })

  it('边界：差恰好等于 toleranceS 仍算命中', () => {
    const g = collectEvidence(durationOnly, [L('a', 'x', 100)], [R('x.mp3', 101)])
    expect(durationFact(g, 'a', 'x.mp3')?.state).toBe('hit')
  })

  it('任一侧没有时长 → 不产事实（unknown 不是事实）', () => {
    const noLeft = collectEvidence(durationOnly, [L('a', 'x')], [R('x.mp3', 100)])
    const noRight = collectEvidence(durationOnly, [L('a', 'x', 100)], [R('x.mp3')])
    expect(durationFact(noLeft, 'a', 'x.mp3')).toBeUndefined()
    expect(durationFact(noRight, 'a', 'x.mp3')).toBeUndefined()
  })

  it('桶化省时间不省记录：同长的三个文件每一对都出边', () => {
    const g = collectEvidence(durationOnly, [L('a', 'x', 7707)], [R('530.mp3', 7707), R('820.mp3', 7707), R('999.mp3', 6000)])
    expect(g.edges.filter((e) => e.facts.some((f) => f.kind === 'duration' && f.state === 'hit')).map((e) => e.path))
      .toEqual(['530.mp3', '820.mp3'])
  })
})

describe('StructKeyCollector（三种结构键）', () => {
  const epnumOnly: MatchSpec = { version: 2, stages: [{ by: 'epnum', epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: DEFAULT_TITLE_STRIP, threshold: 0.6, margin: 0.15 }] }
  const seasonOnly: MatchSpec = { version: 2, stages: [{ by: 'season-episode', fileRegex: DEFAULT_SEASON_EPISODE_REGEX, titleStrip: DEFAULT_TITLE_STRIP, threshold: 0, margin: 0.15 }] }
  const partOnly: MatchSpec = { version: 2, stages: [{ by: 'episode-part', keyRegex: DEFAULT_EPISODE_PART_REGEX, titleStrip: DEFAULT_TITLE_STRIP, threshold: 0.25, margin: 0.1 }] }

  it('epnum：两侧同号 → 出 struct-key 事实（号归一化，005 与 05 同一个键）', () => {
    const g = collectEvidence(epnumOnly, [L('a', '005.身边那些灵异事')], [R('05.太极两仪生四象.mp3')])
    expect(structFact(g, 'a', '05.太极两仪生四象.mp3')).toMatchObject({ key: 'epnum', value: '5' })
  })

  it('epnum：号不同 → 不建边（键不同不是"弱证据"，是无证据）', () => {
    const g = collectEvidence(epnumOnly, [L('a', '005.身边那些灵异事')], [R('14.辛金.mp3')])
    expect(structFact(g, 'a', '14.辛金.mp3')).toBeUndefined()
  })

  it('epnum：左侧有号、右侧无此号文件 → 无边，但键记进 leftStructKeys（缺档的定义）', () => {
    const g = collectEvidence(epnumOnly, [L('a', '066.凑活聊道德绑架')], [R('020.再谈身边灵异事.mp3')])
    expect(g.edges.some((e) => e.leftKey === 'a' && e.facts.some((f) => f.kind === 'struct-key'))).toBe(false)
    expect(g.leftStructKeys).toContainEqual({ leftKey: 'a', key: 'epnum', value: '66' })
  })

  it('epnum：4 位年份不当集号（左侧读不出键 → 本档无信号）', () => {
    const g = collectEvidence(epnumOnly, [L('a', '2022壬寅流年运势解析')], [R('2022壬寅流年运势解析.mp3')])
    expect(g.leftStructKeys).toHaveLength(0)
  })

  it('season-episode：左键从 leftKey 取季集，S01E01 的文件绝不给 S02E01 的左项建边', () => {
    const g = collectEvidence(seasonOnly, [L('tmdb:1:S02E01', '第一集')], [R('Show.S01E01.mkv'), R('Show.S02E01.mkv')])
    expect(structFact(g, 'tmdb:1:S02E01', 'Show.S02E01.mkv')).toMatchObject({ key: 'season-episode', value: '2:1' })
    expect(structFact(g, 'tmdb:1:S02E01', 'Show.S01E01.mkv')).toBeUndefined()
  })

  it('season-episode：单捕获组 fileRegex → 整档退化成纯集号分桶（按季分文件夹的裸命名）', () => {
    const single: MatchSpec = { version: 2, stages: [{ by: 'season-episode', fileRegex: '(\\d{1,3})$', titleStrip: DEFAULT_TITLE_STRIP, threshold: 0, margin: 0.15 }] }
    const g = collectEvidence(single, [L('tmdb:1:S01E24', '第24集')], [R('进击的巨人24.mp4')])
    expect(structFact(g, 'tmdb:1:S01E24', '进击的巨人24.mp4')).toMatchObject({ value: 'E24' })
  })

  it('episode-part：期号+上/下复合键（含日期前缀的文件名先剥再读键）', () => {
    const g = collectEvidence(partOnly, [L('a', '第2期纯享下集：谁在裸辞')], [R('2026-07-18 第2期纯享下集.mkv')])
    expect(structFact(g, 'a', '2026-07-18 第2期纯享下集.mkv')).toMatchObject({ key: 'episode-part', value: '2:下' })
  })

  /** 活体（喜剧之王单口季，2026-09-03）：TMDb 标题「第10期（三）：郭麒麟…」、追更转存的文件
   *  「2025.09.13-第10期（三）.mp4」，两侧一条边都没有——只认「上/下集」的正则读不出括号段号，
   *  日期前缀又是点分的，默认剥离只剥短横线那种。 */
  it('episode-part：括号段号「第10期（三）」+ 点分日期前缀，两侧同键', () => {
    const g = collectEvidence(partOnly, [L('a', '第10期（三）：郭麒麟评价于祥宇摇滚明星')], [R('2025.09.13-第10期（三）.mp4')])
    expect(structFact(g, 'a', '2025.09.13-第10期（三）.mp4')).toMatchObject({ key: 'episode-part', value: '10:3' })
  })

  it('episode-part：裸段号「第1期四」、数字段号「第4期2」、中文期号「第一期上」都归一到同一种键', () => {
    const g = collectEvidence(partOnly,
      [L('a', '第1期（四）： 李雪琴王建国首搭漫才'), L('b', '第4期（二）：郭麒麟开嗑'), L('c', '第1期上：郭麒麟玩梗喊话郭德纲')],
      [R('2026-07-04 第1期四.mkv'), R('20250801第4期2.mp4'), R('第一期上.mkv')])
    expect(structFact(g, 'a', '2026-07-04 第1期四.mkv')).toMatchObject({ value: '1:4' })
    expect(structFact(g, 'b', '20250801第4期2.mp4')).toMatchObject({ value: '4:2' })
    expect(structFact(g, 'c', '第一期上.mkv')).toMatchObject({ value: '1:上' })
  })

  it('episode-part：含「上」但不是「上集」→ 两侧都读不出键，不建边', () => {
    const g = collectEvidence(partOnly, [L('a', '第10期上流社会')], [R('第10期上流社会.mkv')])
    expect(structFact(g, 'a', '第10期上流社会.mkv')).toBeUndefined()
  })
})

describe('NameCollector（identity-exact 与 sim 两种 method）', () => {
  it('清洗后逐字相同 → identity-exact，score 恒 1', () => {
    const g = collectEvidence(DEFAULT_MATCH_SPEC, [L('a', '020.再谈身边灵异事')], [R('020.再谈身边灵异事.mp3')])
    expect(nameFact(g, 'a', '020.再谈身边灵异事.mp3')).toMatchObject({ method: 'identity-exact', score: 1 })
  })

  it('沾边但不全等 → sim，带两侧清洗后的串（卡片要显示的就是它）', () => {
    const g = collectEvidence(DEFAULT_MATCH_SPEC, [L('a', '005.身边那些灵异事')], [R('怡乐播客 - 005.身边那些灵异事.mp3')])
    const f = nameFact(g, 'a', '怡乐播客 - 005.身边那些灵异事.mp3')!
    expect(f.method).toBe('sim')
    expect(f.score).toBeGreaterThan(0.5)
    expect(f.cleanedLeft).toBe('身边那些灵异事')
    // 比较形不含标点（`tidy` 与归档器 identity 共用同一把 PUNCT 尺）——卡片显示的就是这一串。
    expect(f.cleanedRight).toBe('怡乐播客005身边那些灵异事')
  })

  it('sim < 记录地板 0.05 且无别的事实 → 不建边（防 L×F 全连接）', () => {
    const g = collectEvidence(DEFAULT_MATCH_SPEC, [L('a', '太极两仪生四象')], [R('身边那些灵异事.mp3')])
    expect(g.edges).toHaveLength(0)
  })

  it('地板管建边、不管记分：已有别的事实的边照样补上 0 分的名字事实', () => {
    const g = collectEvidence(durationOnly, [L('a', '太极两仪生四象', 5808)], [R('身边那些灵异事.mp3', 5808)])
    const f = nameFact(g, 'a', '身边那些灵异事.mp3')!
    expect(f.score).toBe(0)
    expect(f.score).toBeLessThan(NAME_RECORD_FLOOR)
    expect(kinds(g, 'a', '身边那些灵异事.mp3')).toEqual(['duration', 'name'])
  })

  /**
   * 倒排索引的键是 bigram，而**长度 1 的串一个 bigram 都没有**——按"交集非空"筛的话，
   * 两边清洗后都是单字的那种标题永远建不起边，一个逐字相同的名字反而配不上。
   * 判据必须是"串相等"本身。
   */
  it('清洗后都只剩一个字、且逐字相同 → 照样 identity-exact 建边（bigram 交集恒空）', () => {
    const titleOnly: MatchSpec = { version: 2, stages: [{ by: 'title', titleStrip: [], threshold: 0.85, margin: 0.15 }] }
    const g = collectEvidence(titleOnly, [L('a', '甲')], [R('甲.mp3')])
    expect(nameFact(g, 'a', '甲.mp3')).toMatchObject({ method: 'identity-exact', score: 1, cleanedLeft: '甲', cleanedRight: '甲' })
  })

  it('单字但不相同 → 照旧不建边（放行的是"相等"，不是"短"）', () => {
    const titleOnly: MatchSpec = { version: 2, stages: [{ by: 'title', titleStrip: [], threshold: 0.85, margin: 0.15 }] }
    expect(collectEvidence(titleOnly, [L('a', '甲')], [R('乙.mp3')]).edges).toHaveLength(0)
  })

  it('一份 titleStrip 一个口径：各 stage 口径不同时事实按 stripId 分开记', () => {
    const twoStrips: MatchSpec = {
      version: 2,
      stages: [
        { by: 'epnum', epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: ['^怡乐播客 - '], threshold: 0.6, margin: 0.15 },
        { by: 'title', titleStrip: [], threshold: 0.85, margin: 0.15 },
      ],
    }
    const g = collectEvidence(twoStrips, [L('a', '005.身边那些灵异事')], [R('怡乐播客 - 005.身边那些灵异事.mp3')])
    const names = factsOn(g, 'a', '怡乐播客 - 005.身边那些灵异事.mp3').filter((f) => f.kind === 'name')
    expect(new Set(names.map((f) => (f as Extract<Fact, { kind: 'name' }>).stripId)).size).toBe(2)
    expect(Object.keys(g.strips)).toHaveLength(2)
  })
})

describe('ByteIdentityCollector（同字节数 + 时长相同或同缺）', () => {
  it('同字节 + 同时长 → 双向的 byte-identity 事实挂在各自的边上', () => {
    const g = collectEvidence(durationOnly,
      [L('a', '身边那些灵异事', 5808)],
      [R('怡乐播客 - 005.身边那些灵异事.mp3', 5808, 92986927), R('玄关笔记/05.太极两仪生四象.mp3', 5808, 92986927)])
    const peers = (p: string) => factsOn(g, 'a', p).filter((f) => f.kind === 'byte-identity').map((f) => (f as Extract<Fact, { kind: 'byte-identity' }>).peerPath)
    expect(peers('怡乐播客 - 005.身边那些灵异事.mp3')).toEqual(['玄关笔记/05.太极两仪生四象.mp3'])
    expect(peers('玄关笔记/05.太极两仪生四象.mp3')).toEqual(['怡乐播客 - 005.身边那些灵异事.mp3'])
  })

  it('同字节但时长不同 → 不是孪生（切割/加长版恰好同体量）', () => {
    const g = collectEvidence(durationOnly, [L('a', 'x', 5808)], [R('x.mp3', 5808, 1000), R('y.mp3', 5809, 1000)])
    expect(factsOn(g, 'a', 'x.mp3').some((f) => f.kind === 'byte-identity')).toBe(false)
  })

  it('体量缺席 → 无孪生事实（未知不是事实）', () => {
    const g = collectEvidence(durationOnly, [L('a', 'x', 100)], [R('x.mp3', 100), R('y.mp3', 100)])
    expect(g.edges.every((e) => e.facts.every((f) => f.kind !== 'byte-identity'))).toBe(true)
  })
})

describe('DurationContradictCollector（横向矛盾闸的事实面）', () => {
  it('名字全等但时长差出量级 → contradict 事实（05 案的那条边）', () => {
    const g = collectEvidence(DEFAULT_MATCH_SPEC, [L('a', '05.太极两仪生四象', 2163)], [R('玄关笔记/05.太极两仪生四象.mp3', 5808)])
    expect(durationFact(g, 'a', '玄关笔记/05.太极两仪生四象.mp3')).toMatchObject({ state: 'contradict', deltaS: 3645 })
  })

  it('差出容差、但没差出量级（活体 780 差 0.06%）→ 时长上不表态', () => {
    const g = collectEvidence(DEFAULT_MATCH_SPEC, [L('a', '780.putt', 8274)], [R('780.putt.mp3', 8279)])
    expect(durationFact(g, 'a', '780.putt.mp3')).toBeUndefined()
  })

  it('只往已有边上加：不沾边的两个东西不因"不是一集"而建边', () => {
    const g = collectEvidence(DEFAULT_MATCH_SPEC, [L('a', '太极两仪生四象', 2163)], [R('身边那些灵异事.mp3', 5808)])
    expect(g.edges).toHaveLength(0)
  })
})

/**
 * 05 案取证夹具（2026-08-02 定案）：`玄关笔记/05.太极两仪生四象.mp3` 实为免费集 005 的同字节副本、
 * 名字贴错。现行引擎把它零竞争无痕丢弃 → 残差 → 静默搬下架，卡片理由是假话。
 * 证据层这一关只要求**证据一条不少**——怎么判是裁决层的事。
 */
describe('05 案：证据图必须把三面证据全摆出来', () => {
  const spec = DEFAULT_MATCH_SPEC
  const left = [
    L('l005', '005.身边那些灵异事', 5808),
    L('l05', '05.太极两仪生四象', 2163),
  ]
  const right = [
    R('怡乐播客 - 005.身边那些灵异事.mp3', 5808, 92986927),
    R('玄关笔记/05.太极两仪生四象.mp3', 5808, 92986927),
    R('来源/05.太极两仪生四象【耗时整理‖cunlove.cn】.mp3', 2164, 34600000),
  ]
  const g = collectEvidence(spec, left, right)
  const mis = '玄关笔记/05.太极两仪生四象.mp3'

  it('时长指向 005：命中且差 0s', () => {
    expect(durationFact(g, 'l005', mis)).toMatchObject({ state: 'hit', deltaS: 0 })
  })

  it('名字指向 05：清洗后逐字相同', () => {
    expect(nameFact(g, 'l05', mis)).toMatchObject({ method: 'identity-exact', score: 1 })
  })

  it('时长同时否掉 05：5808 vs 2163 差出量级', () => {
    expect(durationFact(g, 'l05', mis)).toMatchObject({ state: 'contradict', deltaS: 3645 })
  })

  it('与 005 的正主字节全等 —— 现行引擎里压根不存在的那条证据', () => {
    const peers = factsOn(g, 'l005', mis).filter((f) => f.kind === 'byte-identity')
    expect(peers).toEqual([{ kind: 'byte-identity', peerPath: '怡乐播客 - 005.身边那些灵异事.mp3' }])
  })

  it('05 的正主自己也在图里（时长命中 2164 vs 2163）', () => {
    expect(durationFact(g, 'l05', '来源/05.太极两仪生四象【耗时整理‖cunlove.cn】.mp3')?.state).toBe('hit')
  })

  it('三个文件全部入池 —— 残差判定要能确认"它一条边都没有"', () => {
    expect(g.files).toHaveLength(3)
    expect(g.lefts).toEqual(['l005', 'l05'])
  })
})
