import { describe, it, expect } from 'vitest'
import { DEFAULT_MATCH_SPEC } from '../match-spec.ts'
import type { SpecLeft, SpecRight } from '../match-spec.ts'
import { matchByEvidence } from './resolve.ts'
import {
  ctxFromResolution, emptyResolution, fileAsksOf, leftAsksOf, matchByEvidenceResult, mergeResolutions,
} from './adapt.ts'

const L = (leftKey: string, title: string, durationS?: number): SpecLeft =>
  ({ leftKey, title, ...(durationS != null ? { durationS } : {}) })
const R = (name: string, durationS?: number, size?: number): SpecRight =>
  ({ name, ...(durationS != null ? { durationS } : {}), ...(size != null ? { size } : {}) })

describe('ctxFromResolution', () => {
  it('usedRight = 认领路径 ∪ 同集其余份（不是近似，是并集本身）', () => {
    const res = matchByEvidence(DEFAULT_MATCH_SPEC, [L('a', '01.首集')], [
      R('01.首集.mp4', undefined, 900), R('01.首集【公众号：CunWorkNotes】.mp4', undefined, 500),
    ])
    const ctx = ctxFromResolution(res)
    const a = ctx.assignments.get('a')!
    expect([...ctx.usedRight].sort()).toEqual([a.rightFile, ...(a.losers ?? [])].sort())
    expect(a.losers).toHaveLength(1)
  })

  it('没有同集其余份时 losers **整个字段缺席**（下游普遍写 losers ?? []，但深比较的测试看得见空数组与缺席的区别）', () => {
    const res = matchByEvidence(DEFAULT_MATCH_SPEC, [L('a', '01.首集')], [R('01.首集.mp4')])
    expect(ctxFromResolution(res).assignments.get('a')).not.toHaveProperty('losers')
  })

  it('缺档原样带过（覆盖率的 missingEpisodes 靠它）', () => {
    const res = matchByEvidence(DEFAULT_MATCH_SPEC, [L('a', '066.凑活聊道德绑架'), L('b', '020.再谈身边灵异事')], [R('020.再谈身边灵异事.mp3')])
    expect(ctxFromResolution(res).missingByKey.get('a')).toBe(66)
  })
})

/**
 * I3 的文件侧问句在绑定侧的落点。绑定 ctx 没有"文件侧问句"这个概念——
 * **不许硬塞进 `ambiguous`**：那张表是 `computeCoverage` 用来分"有候选没敢配"与"压根没信号"的，
 * 塞进去就等于凭空把某一集算成 ambiguous（覆盖率数字当场失真）。
 */
describe('文件侧问句（I3）：不进 ambiguous，也不许丢', () => {
  // 05 案：一份 5808s 的文件名字叫 05，时长却是 005 的。
  const left = [L('ep005', '005.身边那些灵异事', 5808), L('ep05', '05.太极两仪生四象', 2163)]
  const right = [R('玄关笔记/05.太极两仪生四象.mp3', 5808, 93_000_000), R('来源/05.太极两仪生四象【耗时整理】.mp3', 2164, 34_000_000)]
  const res = matchByEvidence(DEFAULT_MATCH_SPEC, left, right)

  it('确实产出了一条文件侧问句', () => {
    expect(fileAsksOf(res).map((a) => a.path)).toEqual(['玄关笔记/05.太极两仪生四象.mp3'])
    expect(fileAsksOf(res)[0].reason).toBe('dual-episode-conflict')
  })

  it('它不进 ambiguous —— 那张表一条都不许因它变多', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC, left, right)
    // 这一集自己确实有一条**集侧**问句（时长唯一命中 5808s、名字却不沾 → name-floor），
    // 与文件侧那张冲突卡是两回事。判据是"ambiguous 恰好等于集侧问句"，不是"这个 leftKey 不该出现"。
    expect(r.ambiguous.length).toBe(leftAsksOf(res).length)
    expect(r.ambiguous.map((a) => a.leftKey)).toEqual(leftAsksOf(res).map((a) => a.leftKey))
    expect(r.ambiguous.map((a) => a.reason)).not.toContain('dual-episode-conflict')
  })

  it('但它在 resolution 里还在（归档器就是从这儿取它出卡的）', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC, left, right)
    expect(fileAsksOf(r.resolution)).toHaveLength(1)
    // 残差判定也只有这一份能答：这个文件既没被认领、也不是残差，它是个问句。
    expect(r.resolution.residual).not.toContain('玄关笔记/05.太极两仪生四象.mp3')
    expect(r.resolution.trails.get('玄关笔记/05.太极两仪生四象.mp3')!.disposition).toBe('asked')
  })
})

/**
 * `SpecMatchResult` 的三个字段是**绑定同步（`sync.ts`）与前端的对外形状**——字段名长在
 * `MappingSet`、覆盖率面板、账本上。这里逐字钉死它们的值，不是抽象地比"两个引擎一样"：
 * 参照物换了就得重写的断言，等参照物没了也就没人守着了。
 */
describe('matchByEvidenceResult：交出去的三个字段', () => {
  it('干净的号+标题：配上、无问句、两向覆盖率满格', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC, [L('a', '020.再谈身边灵异事')], [R('020.再谈身边灵异事.mp3')])
    expect([...r.assignments]).toEqual([['a', { rightFile: '020.再谈身边灵异事.mp3', confidence: 1, status: 'auto' }]])
    expect(r.ambiguous).toEqual([])
    expect(r.coverage).toEqual({
      left: { total: 1, matched: 1, ambiguous: 0, missing: 0 },
      right: { total: 1, matched: 1, orphan: 0 },
      missingEpisodes: [], orphanFiles: [],
    })
  })

  it('水印重复折叠：正主进 rightFile、其余份进 losers，且都算 matched 不报孤儿', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC, [L('a', '707.风水鱼要在棺材里？')], [
      R('707.风水鱼要在棺材里？【公众号：CunWorkNotes】.mp3'), R('707.风水鱼要在棺材里？【耗时整理‖cunlove.cn】.mp3'),
    ])
    const a = r.assignments.get('a')!
    expect(a.rightFile).toBe('707.风水鱼要在棺材里？【公众号：CunWorkNotes】.mp3')
    expect(a.losers).toEqual(['707.风水鱼要在棺材里？【耗时整理‖cunlove.cn】.mp3'])
    // 两份剥完水印同名 → 覆盖率按 canonName 去重，右侧只算一个。
    expect(r.coverage.right).toEqual({ total: 1, matched: 1, orphan: 0 })
  })

  it('缺档 + 孤儿：missingEpisodes 报号、orphanFiles 报名', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('a', '066.凑活聊道德绑架'), L('b', '020.再谈身边灵异事')],
      [R('020.再谈身边灵异事.mp3'), R('无关的封面曲.mp3')])
    expect(r.coverage.missingEpisodes).toEqual([66])
    expect(r.coverage.orphanFiles).toEqual(['无关的封面曲.mp3'])
    expect(r.coverage.left).toEqual({ total: 2, matched: 1, ambiguous: 0, missing: 1 })
  })

  it('时长唯一命中但名字不沾：不配、出一条带候选与门槛的集侧问句（848/209 活体）', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC, [L('a', '848.三十探悬疑案件', 8162)], [R('怡乐播客 - 209.十五谈身边灵异事.mp3', 8163)])
    expect(r.assignments.size).toBe(0)
    expect(r.ambiguous).toHaveLength(1)
    expect(r.ambiguous[0]).toMatchObject({ leftKey: 'a', stage: 'duration', reason: 'name-floor' })
    expect(r.ambiguous[0].candidates.map((c) => c.name)).toEqual(['怡乐播客 - 209.十五谈身边灵异事.mp3'])
    // 没敢配的那一集算 ambiguous 不算 missing——覆盖率靠这个分岔路由它。
    expect(r.coverage.left).toEqual({ total: 1, matched: 0, ambiguous: 1, missing: 0 })
  })
})

describe('mergeResolutions（季分区）', () => {
  const a = matchByEvidence(DEFAULT_MATCH_SPEC, [L('s1', '01.甲')], [R('S01/01.甲.mkv')])
  const b = matchByEvidence(DEFAULT_MATCH_SPEC, [L('s2', '01.乙')], [R('S02/01.乙.mkv')])

  it('emptyResolution 是合并的幺元', () => {
    expect(mergeResolutions(emptyResolution(), a)).toEqual(a)
    expect(mergeResolutions(a, emptyResolution())).toEqual(a)
  })

  it('左键互不相交的两份判决并起来，两侧的认领与轨迹都在', () => {
    const m = mergeResolutions(a, b)
    expect([...m.assignments.keys()].sort()).toEqual(['s1', 's2'])
    expect([...m.trails.keys()].sort()).toEqual(['S01/01.甲.mkv', 'S02/01.乙.mkv'])
  })
})
