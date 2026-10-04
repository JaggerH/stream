import { describe, it, expect } from 'vitest'
import { matchByEvidence } from './resolve.ts'
import { RULES } from './rules.ts'
import { DEFAULT_MATCH_SPEC } from '../match-spec.ts'
import type { SpecLeft, SpecRight } from '../match-spec.ts'
import type { Resolution } from './types.ts'

/**
 * **裁决表逐格钉死**（spec §8 定稿表）。
 *
 * 表只有两轴 + 一个放大器：**名字**（结构键命中 ＞ 清洗后全等 ＞ 相似度最佳 ＞ 无信号）、
 * **时长**（吻合 ±容差 / 矛盾（相对差 >10%）/ 未知）；**唯一性是放大器不是证据**。
 * 字节全等是文件↔文件的证据，只用于副本判定，不参与认集。
 *
 * 本文件每个 `describe` = 表里的一格，用**判别性**输入（能把该格与相邻格分开）断言判决。
 * `resolve.test.ts` 钉的是"每条规则自己怎么跑"，这里钉的是"证据这样组合时该出什么结论"——
 * 规则重排、门槛调参、增删一档都不许改变这些结论，改了就是动了表，要先回 spec 拍板。
 *
 * 各格的实现出处见 `rules.ts` 的规则表；本次唯一新增的规则是 **R14（第 3 格的标题档缺口）**，
 * 其余七格量出来本已满足。
 */

const L = (leftKey: string, title: string, durationS?: number): SpecLeft =>
  ({ leftKey, title, ...(durationS != null ? { durationS } : {}) })
const R = (name: string, durationS?: number, size?: number): SpecRight =>
  ({ name, ...(durationS != null ? { durationS } : {}), ...(size != null ? { size } : {}) })
const run = (left: SpecLeft[], right: SpecRight[]): Resolution => matchByEvidence(DEFAULT_MATCH_SPEC, left, right)
const askFor = (r: Resolution, leftKey: string) => r.asks.find((a) => a.leftKey === leftKey)

describe('第 1 格：名字唯一命中 + 时长吻合 → 认领', () => {
  it('号与标题都对上、时长也撞进容差 → 认领（本已满足）', () => {
    const r = run([L('a', '020.再谈身边灵异事', 3600)], [R('020.再谈身边灵异事.mp3', 3600)])
    expect(r.assignments.get('a')).toMatchObject({ path: '020.再谈身边灵异事.mp3', status: 'auto', rule: RULES.DURATION_UNIQUE.id })
    expect(r.residual).toEqual([])
  })
})

describe('第 2 格：名字唯一命中 + 时长未知 → 认领（名字独证成立，不必撞时长）', () => {
  // 用户拍板：「只依赖名称匹配已经可以得到唯一的解，就没必要再撞时长线」。
  // 四种"名字唯一命中"的形态 × 三种"时长未知"的来路，全部必须认领。
  it('号+标题全等，两侧都没有时长', () => {
    expect(run([L('a', '020.再谈身边灵异事')], [R('020.再谈身边灵异事.mp3')]).assignments.get('a'))
      .toMatchObject({ path: '020.再谈身边灵异事.mp3', rule: RULES.EPNUM.id })
  })
  it('号+标题全等，只有左侧有时长', () => {
    expect(run([L('a', '020.再谈身边灵异事', 3600)], [R('020.再谈身边灵异事.mp3')]).assignments.size).toBe(1)
  })
  it('号+标题全等，只有右侧有时长', () => {
    expect(run([L('a', '020.再谈身边灵异事')], [R('020.再谈身边灵异事.mp3', 3600)]).assignments.size).toBe(1)
  })
  it('无号、纯标题清洗后全等', () => {
    expect(run([L('a', '灵异故事-2021年9月特别篇')], [R('灵异故事-2021年9月特别篇.mp3')]).assignments.get('a'))
      .toMatchObject({ rule: RULES.TITLE.id })
  })
  it('季集结构键唯一命中（中文标题 vs 英文文件名，名字相似度 0 也照认）', () => {
    expect(run([L('tmdb:9:S01E01', '首集')], [R('Show.S01E01.1080p.mkv')]).assignments.get('tmdb:9:S01E01'))
      .toMatchObject({ rule: RULES.SEASON_EPISODE.id })
  })

  /**
   * **边界：号撞上不等于名字命中**。集号是分桶键，桶内还得靠标题消歧（R8 `trustUnique:false`）——
   * 「014.六月新闻大盘点」与「14.辛金」号一样、讲的是两件事。这一格不是第 2 格，出卡不认领。
   * 把它当第 2 格放行，等于让所有撞号的文件互配。
   */
  it('边界：号对上但标题不沾 → 不算"名字命中"，出卡不认领', () => {
    const r = run([L('a', '014.六月新闻大盘点')], [R('14.辛金.mp3')])
    expect(r.assignments.size).toBe(0)
    expect(askFor(r, 'a')).toMatchObject({ reason: 'below-threshold', rule: RULES.EPNUM.id })
  })
})

describe('第 3 格：名字唯一命中 + 时长矛盾 → 出卡', () => {
  // 名字唯一给了它"不许静默"的豁免，时长矛盾剥夺了"免检认领"的资格：两个证据打架就该人裁。
  // 一律不认领、一律出卡——四档都要出，缺一档就是一条静默下架的通路。
  it('epnum 档（本已满足）', () => {
    const r = run([L('a', '005.身边那些灵异事', 2000)], [R('005.身边那些灵异事.mp3', 5808)])
    expect(r.assignments.size).toBe(0)
    expect(askFor(r, 'a')).toMatchObject({ reason: 'duration-contradiction', rule: RULES.CONTENT_MISMATCH.id })
  })
  it('season-episode 档（本已满足）', () => {
    const r = run([L('tmdb:9:S01E01', '首集', 2000)], [R('Show.S01E01.1080p.mkv', 5808)])
    expect(askFor(r, 'tmdb:9:S01E01')).toMatchObject({ reason: 'duration-contradiction' })
  })
  it('episode-part 档（本已满足）', () => {
    const r = run([L('a', '第2期纯享下集：谁在裸辞', 2000)], [R('2026-07-18 第2期纯享下集.mkv', 5808)])
    expect(askFor(r, 'a')).toMatchObject({ reason: 'duration-contradiction' })
  })

  /**
   * **标题档是本次补上的那一格（R14）**。它 `markAsk:false`（"仅高阈相似，没到就当没信号"），
   * 于是"清洗后全等 + 时长差出量级"这种最该问人的形状过去连一张卡都不出，文件直接算残差。
   */
  it('title 档：清洗后全等 + 时长差出量级 → 出卡（R14，本次实现）', () => {
    const r = run([L('a', '灵异故事-2021年9月特别篇', 2000)], [R('灵异故事-2021年9月特别篇.mp3', 5808)])
    expect(r.assignments.size).toBe(0)
    expect(askFor(r, 'a')).toMatchObject({
      stage: 'title', reason: 'duration-contradiction', rule: RULES.NAME_HIT_DURATION_CONTRADICT.id,
      candidates: [{ name: '灵异故事-2021年9月特别篇.mp3', sim: 1 }],
    })
  })

  /**
   * **边界：R14 的闸只对"本可认领的赢家"开**。标题器的记录地板是 0.05、远低于任何裁决门槛，
   * 一份文件会与几十集各连一条 0.06 分的边；时长一矛盾就全变成卡的话，问句面板会被噪声淹掉。
   * 名字够不到本档门槛的那些属于第 8 格（无信号），照常进残差。
   */
  it('边界：名字够不到门槛 + 时长矛盾 → 不出卡，走第 8 格', () => {
    const r = run([L('a', '灵异故事-2021年9月特别篇', 2000)], [R('甲乙丙丁戊己庚辛.mp3', 5808)])
    expect(r.asks).toEqual([])
    expect(r.residual).toEqual(['甲乙丙丁戊己庚辛.mp3'])
  })
})

describe('第 4 格：时长吻合唯一 + 名字最佳但没过阈 → 认领取最佳（须过 0.3 地板）', () => {
  it('名字 0.3~门槛之间 → 时长唯一命中免检，照认（本已满足）', () => {
    const r = run([L('a', '454.现代版枪下留人', 2605)], [R('455.现代版木仓下留银.mp3', 2605)])
    const a = r.assignments.get('a')!
    expect(a).toMatchObject({ path: '455.现代版木仓下留银.mp3', rule: RULES.DURATION_UNIQUE.id })
    expect(a.confidence).toBeLessThan(0.6) // 过不了 epnum/title 的门槛，是时长把它抬进来的
    expect(a.confidence).toBeGreaterThanOrEqual(0.3)
  })
  it('名字连 0.3 地板都不沾 → 不认领，记 name-floor 卡（848/209 活体，本已满足）', () => {
    const r = run([L('yile:848', '848.三十探悬疑案件', 8162)], [R('怡乐播客 - 209.十五谈身边灵异事.mp3', 8163)])
    expect(r.assignments.size).toBe(0)
    expect(askFor(r, 'yile:848')).toMatchObject({ reason: 'name-floor', rule: RULES.DURATION_NAME_FLOOR.id })
  })
})

describe('第 5 格：时长吻合多份 + 名字分得出最佳 → 最佳认领，落选份必须留痕', () => {
  it('两份都沾名字 → 最佳认领，另一份进副本链（本已满足）', () => {
    const r = run([L('a', '530.十七探悬疑案件', 7707)],
      [R('530.十七探悬疑案件.mp3', 7707), R('530.十七探悬疑案件的另一版本别名.mp3', 7707)])
    expect(r.assignments.get('a')).toMatchObject({ path: '530.十七探悬疑案件.mp3' })
    expect(r.trails.get('530.十七探悬疑案件的另一版本别名.mp3')).toMatchObject({ disposition: 'copy' })
    expect(r.residual).toEqual([])
  })
  it('另一份一个字不沾 → 零竞争出口认领，落选份带 zero-competition-loser 留痕（本已满足）', () => {
    const r = run([L('yl:005', '005.身边那些灵异事', 5808)],
      [R('怡乐播客 - 005.身边那些灵异事.mp3', 5808), R('别的节目/999.完全无关.mp3', 5808)])
    expect(r.assignments.get('yl:005')).toMatchObject({ path: '怡乐播客 - 005.身边那些灵异事.mp3' })
    // 落选的那份是**别的集**的文件、不是这一集的副本——留痕，但绝不进 losers（会被按副本处置）。
    expect(r.assignments.get('yl:005')!.losers).toEqual([])
    expect(r.trails.get('别的节目/999.完全无关.mp3')!.edges)
      .toContainEqual(expect.objectContaining({ vetoReason: 'zero-competition-loser', rule: RULES.ZERO_COMPETITION.id }))
  })
  it('名字也分不出最佳 → 出卡，谁都不认（本已满足）', () => {
    const r = run([L('a', '完全看不出是哪集', 3600)], [R('甲.mp3', 3600), R('乙.mp3', 3600)])
    expect(r.assignments.size).toBe(0)
    expect(askFor(r, 'a')).toMatchObject({ reason: 'below-threshold' })
  })
})

describe('第 6 格：名字指 A 集、时长指 B 集 → 出卡', () => {
  it('事故 05 的形状：文件侧冲突卡，且不许静默变残差（本已满足，I3）', () => {
    const r = run(
      [L('yl:005', '005.身边那些灵异事', 5808), L('yl:05', '05.太极两仪生四象', 2163)],
      [R('怡乐播客 - 005.身边那些灵异事.mp3', 5808, 92986927),
        R('玄关笔记/05.太极两仪生四象.mp3', 5808, 92986927),
        R('来源/05.太极两仪生四象【耗时整理‖cunlove.cn】.mp3', 2164, 34600000)],
    )
    const conflict = r.asks.find((a) => a.path === '玄关笔记/05.太极两仪生四象.mp3')
    expect(conflict).toMatchObject({ reason: 'dual-episode-conflict', rule: RULES.DUAL_EPISODE_CONFLICT.id })
    expect(r.trails.get('玄关笔记/05.太极两仪生四象.mp3')).toMatchObject({ disposition: 'asked' })
    expect(r.residual).toEqual([])
  })

  /**
   * **本轮明确不做**：第 6 格的"与 B 正主字节全等 → 自动判成副本"。用户没拍这一条，
   * 且它会新增一种自动删除行为。字节全等的事实照常收集、照常上卡（`byte-identity`），
   * 但**不参与认集**——它只是卡片上给人看的那句"它和 B 的正主一个字节不差"。
   */
  it('字节全等只上卡不认集：孪生事实在轨迹里，判决仍是出卡', () => {
    const r = run(
      [L('yl:005', '005.身边那些灵异事', 5808), L('yl:05', '05.太极两仪生四象', 2163)],
      [R('怡乐播客 - 005.身边那些灵异事.mp3', 5808, 92986927),
        R('玄关笔记/05.太极两仪生四象.mp3', 5808, 92986927),
        R('来源/05.太极两仪生四象【耗时整理‖cunlove.cn】.mp3', 2164, 34600000)],
    )
    const t = r.trails.get('玄关笔记/05.太极两仪生四象.mp3')!
    expect(t.edges.some((e) => e.facts.some((f) => f.kind === 'byte-identity'))).toBe(true)
    expect(t.disposition).toBe('asked')
  })
})

describe('第 7 格：名字多份命中同一集 → 时长能分就分；分不出走质量择优/出卡', () => {
  it('时长能分：撞上容差的那份认领，错身那份被横向闸否掉（本已满足）', () => {
    const r = run([L('a', '01.首集', 3600)], [R('01.首集.A.mp4', 3600), R('01.首集.B.mp4', 1200)])
    expect(r.assignments.get('a')).toMatchObject({ path: '01.首集.A.mp4' })
    expect(r.trails.get('01.首集.B.mp4')!.edges)
      .toContainEqual(expect.objectContaining({ vetoReason: 'duration-contradict' }))
  })
  it('时长分不出、体量能分：质量择优取正片，另一份进副本链（本已满足）', () => {
    const r = run([L('tmdb:9:S01E01', '首集')], [R('Show.S01E01.2160p.mkv', undefined, 500), R('Show.S01E01.1080p.mkv', undefined, 900)])
    expect(r.assignments.get('tmdb:9:S01E01')).toMatchObject({ path: 'Show.S01E01.1080p.mkv', losers: ['Show.S01E01.2160p.mkv'] })
  })
  it('时长与体量都分不出 → 出卡，不猜（本已满足）', () => {
    const r = run([L('tmdb:9:S01E01', '首集')], [R('Show.S01E01.2160p.mkv'), R('Show.S01E01.1080p.mkv')])
    expect(r.assignments.size).toBe(0)
    expect(askFor(r, 'tmdb:9:S01E01')).toMatchObject({ reason: 'no-margin' })
  })
})

describe('第 8 格：名字无信号 + 时长无命中 → 残差（唯一允许进下架的形状）', () => {
  it('与谁都不沾的媒体文件 → 零边残差（本已满足）', () => {
    const r = run([L('a', '001.身边那些灵异事', 3600)], [R('001.身边那些灵异事.mp3', 3600), R('无关的另一个节目.mp3', 999)])
    expect(r.residual).toEqual(['无关的另一个节目.mp3'])
    expect(r.trails.get('无关的另一个节目.mp3')!.edges).toEqual([])
  })
  it('非媒体文件（封面）同理', () => {
    const r = run([L('a', '020.再谈身边灵异事')], [R('020.再谈身边灵异事.mp3'), R('cover.jpg')])
    expect(r.residual).toEqual(['cover.jpg'])
  })
})

/**
 * **贯穿铁律：任何一格都不许无痕**。I1/I2 由 `assertInvariants` 每轮强制（跑不过就抛），
 * 这里额外把它钉在表的每一格上：把上面各格的输入全跑一遍，逐个文件要么有归宿、
 * 要么每条可裁决的边都带着显式否决理由。
 */
describe('贯穿铁律：不许无痕', () => {
  const ALL: { left: SpecLeft[]; right: SpecRight[] }[] = [
    { left: [L('a', '020.再谈身边灵异事', 3600)], right: [R('020.再谈身边灵异事.mp3', 3600)] },
    { left: [L('a', '014.六月新闻大盘点')], right: [R('14.辛金.mp3')] },
    { left: [L('a', '灵异故事-2021年9月特别篇', 2000)], right: [R('灵异故事-2021年9月特别篇.mp3', 5808)] },
    { left: [L('yile:848', '848.三十探悬疑案件', 8162)], right: [R('怡乐播客 - 209.十五谈身边灵异事.mp3', 8163)] },
    { left: [L('yl:005', '005.身边那些灵异事', 5808)], right: [R('怡乐播客 - 005.身边那些灵异事.mp3', 5808), R('别的节目/999.完全无关.mp3', 5808)] },
    { left: [L('a', '01.首集', 3600)], right: [R('01.首集.A.mp4', 3600), R('01.首集.B.mp4', 1200)] },
    { left: [L('a', '001.身边那些灵异事', 3600)], right: [R('001.身边那些灵异事.mp3', 3600), R('无关的另一个节目.mp3', 999)] },
  ]
  it('每个文件都有轨迹，被否决的边都带理由', () => {
    for (const c of ALL) {
      const r = run(c.left, c.right)
      for (const f of c.right) {
        const t = r.trails.get(f.name)
        expect(t, `${f.name} 没有轨迹`).toBeTruthy()
        for (const e of t!.edges) if (e.outcome === 'vetoed') expect(e.vetoReason, `${f.name} ↔ ${e.leftKey}`).toBeTruthy()
      }
    }
  })
})
