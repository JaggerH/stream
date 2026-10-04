import { describe, it, expect } from 'vitest'
import { DEFAULT_MATCH_SPEC, DEFAULT_EPNUM_REGEX, DEFAULT_SEASON_EPISODE_REGEX, DEFAULT_EPISODE_PART_REGEX, DEFAULT_TITLE_STRIP, DURATION_TOLERANCE_S, DURATION_MIN_SIM, validateSpec, canonName, computeCoverage, identityRulesFromSpec, specStages, compareQuality } from './match-spec.ts'
import { titleSim } from '../text/similarity.ts'
import { matchByEvidence } from './match-engine/resolve.ts'
import { ctxFromResolution, matchByEvidenceResult, mergeResolutions } from './match-engine/adapt.ts'
import type { MatchSpec, MatchStage } from './types.ts'

const L = (leftKey: string, title: string) => ({ leftKey, title })
const R = (name: string) => ({ name })

/**
 * 「给定这样一份谱，匹配出来该是什么」——本文件按 `MatchSpec` 的各档 stage 组织，
 * 断言走引擎的对外入口 `matchByEvidenceResult`（`match-engine/adapt.ts`）。
 * 规则表逐格（R1–R14）在 `match-engine/decision-table.test.ts`，两边不重复。
 */
describe('各档 stage 的配对行为', () => {
  it('matches clean num+title as auto', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('a', '020.再谈身边灵异事')],
      [R('020.再谈身边灵异事.mp3')])
    const m = r.assignments.get('a')!
    expect(m.rightFile).toBe('020.再谈身边灵异事.mp3')
    expect(m.status).toBe('auto')
    expect(r.coverage.left.matched).toBe(1)
    expect(r.coverage.right.orphan).toBe(0)
  })

  it('rejects a number-collision when titles disagree (14.六月 vs 14.辛金)', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('a', '014.六月新闻大盘点')],
      [R('14.辛金.mp3')])
    expect(r.assignments.has('a')).toBe(false)
    expect(r.coverage.left.missing + r.coverage.left.ambiguous).toBe(1) // not matched
    expect(r.coverage.right.orphan).toBe(1)
    expect(r.coverage.orphanFiles).toContain('14.辛金.mp3')
  })

  it('collapses watermark duplicates on the right', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('a', '707.风水鱼要在棺材里？')],
      [R('707.风水鱼要在棺材里？【公众号：CunWorkNotes】.mp3'), R('707.风水鱼要在棺材里？【耗时整理‖cunlove.cn】.mp3')])
    expect(r.coverage.right.total).toBe(1) // two copies → one
    expect(r.assignments.get('a')).toBeTruthy()
  })

  it('reports a left episode with no netdisk file as missing', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('a', '066.凑活聊道德绑架'), L('b', '020.再谈身边灵异事')],
      [R('020.再谈身边灵异事.mp3')])
    expect(r.coverage.left.missing).toBe(1)
    expect(r.coverage.missingEpisodes).toEqual([66])
  })

  it('channel-specific filename prefix is handled by per-binding stage titleStrip data, not code', () => {
    // The default (generic) spec can't read a number off a prefixed filename (number not at
    // start), and the title fallback is below its 0.85 bar → stays unmatched. By design: no
    // channel specifics live in DEFAULT_MATCH_SPEC.
    const prefixed = [R('怡乐播客 - 020.再谈身边灵异事.mp3')]
    const generic = matchByEvidenceResult(DEFAULT_MATCH_SPEC, [L('a', '020.再谈身边灵异事')], prefixed)
    expect(generic.assignments.has('a')).toBe(false)
    // A binding whose epnum stage strips the channel's own prefix recovers the number-match —
    // specificity is parameterized as data on the stage, not code.
    const tuned: MatchSpec = { version: 2, stages: [
      { by: 'epnum', epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: ['^怡[乐楽]播客\\s*[-—]\\s*', '【[^】]*】'], threshold: 0.6, margin: 0.15 },
    ] }
    const t = matchByEvidenceResult(tuned, [L('a', '020.再谈身边灵异事')], prefixed)
    expect(t.assignments.get('a')?.rightFile).toBe('怡乐播客 - 020.再谈身边灵异事.mp3')
    expect(t.assignments.get('a')?.status).toBe('auto')
  })

  // 分享者的文件名常常挂**两块**水印（节目自己的 `【神探李昌钰】` + 分享者的 `【耗时整理…】`）。
  // `titleStrip` 过去每条只替换第一处（`new RegExp(s)` 没有 `g`），第二块原样留在标题里，
  // 名字一模一样的文件相似度被生生压到门槛以下 → 整条配不上。活体 2026-08-01 春典 JARGON：
  // `【神探李昌钰】天使警察…杀妻案【耗时整理‖免费分享：cunlove.cn】.mp3` 与节目单同名，却配不上。
  // 同一份文件在 `canonName`（覆盖率/去重那条路）里是 `/g` 的——两条清洗路径口径本就该一致。
  it('titleStrip 每条都全局替换：一个文件名上的多块水印要全剥掉', () => {
    const spec: MatchSpec = { version: 2, stages: [{ by: 'title', titleStrip: ['【[^】]*】'], threshold: 0.85, margin: 0.15 }] }
    const r = matchByEvidenceResult(spec, [L('a', '【神探李昌钰】天使警察，魔鬼丈夫：西奥多麦克阿瑟杀妻案')], [
      { name: '/付费/【神探李昌钰】天使警察，魔鬼丈夫：西奥多麦克阿瑟杀妻案【耗时整理‖免费分享：cunlove.cn】.mp3', size: 100 },
    ])
    expect(r.assignments.get('a')).toMatchObject({ confidence: 1, status: 'auto' })
  })

  it('falls back to a title match for a no-episode-number special (year-titled)', () => {
    // The bug this whole design fixes: "2022壬寅流年运势解析" has no episode number (4-digit
    // year is excluded), so epnum skips it — but the title stage matches the near-identical file.
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('a', '2022壬寅流年运势解析')],
      [R('怡乐所有付费/2022壬寅流年运势解析.mp3'), R('怡乐所有付费/2023癸卯流年运势解析.mp3')])
    const m = r.assignments.get('a')!
    expect(m.rightFile).toBe('怡乐所有付费/2022壬寅流年运势解析.mp3')
    expect(m.status).toBe('auto')
    expect(r.coverage.left.matched).toBe(1)
  })

  // 真实案例（春典JARGON,2026-07-26）:"灵异故事-YYYY年MM月特别篇" 这类模板化标题,同系列
  // 相邻月份/年份彼此 bigram 相似度天然就高(共享"灵异故事-""年""月特别篇"这些字,只有数字不同)。
  // 左标题和唯一同名右文件字符串完全相等(sim=1),但同目录里"2022年9月"/"2023年9月"这些近似月份
  // 的次佳候选能把 sim 顶到 0.857——离 1.0 只差 0.143,卡在 margin=0.15 门槛下面一丝之差,精确匹配
  // 反而被拒。exact match 不该被"隔壁月份长得像"这种噪声绊倒——门槛判定对 sim===1 的唯一
  // 候选豁免 margin 检查(仍受 threshold 约束,且只在没有第二个同为 1.0 的候选时豁免)。
  it('an exact-string title match is not blocked by a near-duplicate sibling under the margin gate', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('a', '灵异故事-2021年9月特别篇')],
      [R('灵异故事-2021年9月特别篇.mp3'), R('灵异故事-2022年9月特别篇.mp3'), R('灵异故事-2023年9月特别篇【公众号：CunWorkNotes】.mp3')])
    const m = r.assignments.get('a')
    expect(m?.rightFile).toBe('灵异故事-2021年9月特别篇.mp3')
    expect(m?.status).toBe('auto')
  })

  it('two right files that both reduce to the exact same normalized title still stay a genuine, undisambiguated tie', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('a', '灵异故事-2021年9月特别篇')],
      [R('灵异故事-2021年9月特别篇.mp3'), R('灵异故事-2021年9月特别篇【公众号：CunWorkNotes】.mp3')])
    expect(r.assignments.has('a')).toBe(false)
  })

  // 真实 bug（幸运女神,2026-07-18）:tmdb-tv 绑定,左侧 leftKey 带 SxxExx + 中文标题,右侧是
  // 英文场景命名(Lucky.S01E02...)。epnum 读不到(号不在开头)、title 中英相似度 0 → 0/N 全灭。
  // SxxExx 这个结构键在左键和文件名里都躺着,却没有 stage 用它。season-episode stage 补上。
  it('matches tmdb-tv leftKeys (SxxExx) to scene-named files by season+episode', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('tmdb:278624:S01E01', '脚踏实地'), L('tmdb:278624:S01E02', '股掌之间'), L('tmdb:278624:S01E03', '察言观色')],
      [R(' 幸运女神 Lucky（2026）/Lucky.S01E01.No.Shortcuts.2160p.Apple.TV+.WEB-DL.DV.HDR.H.265-Ham.mkv'),
       R(' 幸运女神 Lucky（2026）/Lucky.S01E02.Make.em.Dance.2160p.Apple.TV+.WEB-DL.DV.HDR.H.265-Ham.mkv')])
    expect(r.assignments.get('tmdb:278624:S01E01')?.rightFile).toContain('S01E01')
    expect(r.assignments.get('tmdb:278624:S01E02')?.rightFile).toContain('S01E02')
    expect(r.assignments.get('tmdb:278624:S01E01')?.status).toBe('auto')
    expect(r.coverage.left.matched).toBe(2) // E03 无文件 → missing
    expect(r.coverage.left.missing).toBe(1)
    expect(r.coverage.right.orphan).toBe(0)
  })

  it('season-episode keys on season too — S01E01 file never claims an S02E01 left', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('tmdb:9:S02E01', '第二季首集')],
      [R('Show.S01E01.1080p.mkv')]) // 只有第一季的文件
    expect(r.assignments.has('tmdb:9:S02E01')).toBe(false)
    expect(r.coverage.right.orphan).toBe(1)
  })

  // 真实案例（进击的巨人,2026-07-25）:网盘按季分文件夹、文件本身裸到只剩集号
  // （`进击的巨人 S01/进击的巨人24.mp4`）。stripper() 递归列目录时把 name 砍到只剩 basename,
  // 双捕获组 fileRegex 读不到季号 → DEFAULT 全灭(0/N)。单捕获组 fileRegex(只取集号)让 stage
  // 退化成纯按集号分桶——这在调用方已经保证 right 是单季纯净集合时安全（此处用单季 left/right
  // 直接模拟 matchBySeason 分区后的一季）。
  it('DEFAULT (two-capture fileRegex) declines folder-per-season, plain-episode-number naming — season is invisible to it', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('tmdb:1429:S01E01', '致两千年后的你')],
      [R('进击的巨人 S01/进击的巨人01.mp4')])
    expect(r.assignments.has('tmdb:1429:S01E01')).toBe(false)
  })

  it('season-episode with a single-capture fileRegex recovers folder-per-season, plain-episode-number naming', () => {
    const r = matchByEvidenceResult(
      { version: 2, stages: [{ by: 'season-episode', fileRegex: '(\\d{1,3})$', titleStrip: [], threshold: 0, margin: 0.15 }] },
      [L('tmdb:1429:S01E01', '致两千年后的你'), L('tmdb:1429:S01E02', '那一天')],
      [R('进击的巨人 S01/进击的巨人01.mp4'), R('进击的巨人 S01/进击的巨人02.mp4')],
    )
    expect(r.assignments.get('tmdb:1429:S01E01')?.rightFile).toBe('进击的巨人 S01/进击的巨人01.mp4')
    expect(r.assignments.get('tmdb:1429:S01E02')?.rightFile).toBe('进击的巨人 S01/进击的巨人02.mp4')
    expect(r.coverage.left.matched).toBe(2)
    expect(r.coverage.right.orphan).toBe(0)
  })

  it('season-episode leaves same-episode multi-quality ambiguous rather than mis-picking', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('tmdb:9:S01E01', '首集')],
      [R('Show.S01E01.2160p.mkv'), R('Show.S01E01.1080p.mkv')]) // 同一集两个画质
    expect(r.assignments.has('tmdb:9:S01E01')).toBe(false) // 中英标题消歧无效 → 不乱配
    expect(r.coverage.left.ambiguous).toBe(1)
  })

  it('season-episode picks the decisively larger file when size disambiguates a multi-quality bucket', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('tmdb:9:S01E01', '首集')],
      [{ name: 'Show.S01E01.2160p.mkv', size: 500 }, { name: 'Show.S01E01.1080p.mkv', size: 900 }])
    expect(r.assignments.get('tmdb:9:S01E01')?.rightFile).toBe('Show.S01E01.1080p.mkv')
    expect(r.coverage.left.ambiguous).toBe(0)
  })

  // 一集只认一个正主：落选那档**不进配对结果**（它是整理的删除候选，不是可切换的播放候选）。
  // 但它已经被认出是这一集的另一份 → 照样占住右文件，不该在覆盖率里报成孤儿。
  it('season-episode 落选画质不进配对结果,但仍算 matched 不是 orphan', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('tmdb:9:S01E01', '首集')],
      [{ name: 'Show.S01E01.2160p.mkv', size: 500 }, { name: 'Show.S01E01.1080p.mkv', size: 900 }])
    // 正主只有一个（`rightFile`）；落选那份走 `losers` 交出来给归档器判删——它不是第二个可播候选。
    expect(r.assignments.get('tmdb:9:S01E01')).toEqual({
      rightFile: 'Show.S01E01.1080p.mkv', confidence: expect.any(Number), status: 'auto',
      losers: ['Show.S01E01.2160p.mkv'],
    })
    expect(r.coverage.right).toMatchObject({ total: 2, matched: 2, orphan: 0 })
  })

  it('season-episode reduces two duplicates within each of two quality tiers to one winner per tier', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('tmdb:9:S01E01', '首集')],
      [
        { name: 'Show.S01E01.1080p.GroupA.mkv', size: 900 },
        { name: 'Show.S01E01.1080p.GroupB.mkv', size: 850 },
        { name: 'Show.S01E01.720p.GroupA.mkv', size: 500 },
        { name: 'Show.S01E01.720p.GroupB.mkv', size: 480 },
      ])
    expect(r.assignments.get('tmdb:9:S01E01')?.rightFile).toBe('Show.S01E01.1080p.GroupA.mkv')
    // 每档一个赢家：1080p 的进配对结果，720p 那个是落选副本（占住右文件、不进结果）。
    // GroupB 在两个档位里都是体量较小的**另一个标题**，不算"同一份的重复"，丢弃后是孤儿。
    expect(r.coverage.right).toMatchObject({ total: 4, matched: 2, orphan: 2 })
  })

  it('season-episode still declines when sizes tie or are absent (no size = no signal, stays ambiguous)', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('tmdb:9:S01E01', '首集')],
      [{ name: 'Show.S01E01.2160p.mkv', size: 500 }, { name: 'Show.S01E01.1080p.mkv', size: 500 }])
    expect(r.assignments.has('tmdb:9:S01E01')).toBe(false)
    expect(r.coverage.left.ambiguous).toBe(1)
  })

  // 真实案例（躲在超市后门抽烟的两人 (2026),tmdb:296286,2026-07-20):S01 全 12 集都在同一目录下
  // 并存两版压制(1080p H.264 WEB-DL / 4K HEVC WEBRip)——中文集标题(「第 2 集」)对英文场景命名
  // 相似度为 0,标题消歧从来没用。season-episode 加 size 判正片之前是 1/12(只有 S01E01 因为另一
  // 集左标题恰好等于剧名、title stage 兜底捞到),其余 11 集全 ambiguous。加了 size 判正片后 12/12——
  // 这份网盘里 1080p(H.264,压缩效率低)体积反而比 4K(HEVC,压缩效率高)大,「体量最大即正片」的
  // 判据（同 solo 阶段）在跨编码场景下不代表分辨率最高，是已知、跟 solo 一致的既定取舍。
  it('DEFAULT recovers a 12-episode season with dual-quality releases via season-episode size tiebreak', () => {
    const left = Array.from({ length: 12 }, (_, i) => L(`tmdb:296286:S01E${String(i + 1).padStart(2, '0')}`, i === 0 ? '躲在超市后门抽烟的两人' : `第 ${i + 1} 集`))
    const right = Array.from({ length: 12 }, (_, i) => {
      const n = String(i + 1).padStart(2, '0')
      return [
        { name: `Smoking.Behind.the.Supermarket.with.You.2026.S01E${n}.Mini-Episode.${i + 1}.1080p.CR.WEB-DL.AAC2.0.H.264-Pluto@HiveWeb.mkv`, size: 900_000_000 + i },
        { name: `躲在超市后门抽烟的两人.2026.S01E${n}.2160p.CR.WEBRip.HEVC.10bit.AAC.ASSx2.mkv`, size: 700_000_000 + i },
      ]
    }).flat()
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC, left, right)
    expect(r.coverage.left).toMatchObject({ matched: 12, ambiguous: 0, missing: 0 })
    expect([...r.assignments.values()].every((a) => a.rightFile.includes('1080p'))).toBe(true)
    // 每集的 4K 落选版本都占住了右文件（不报孤儿），但不进配对结果——它是整理的删除候选。
    expect(r.coverage.right).toMatchObject({ total: 24, matched: 24, orphan: 0 })
  })

  it('season-episode no-ops for non-tmdb leftKeys (podcast/stream) → epnum/title still run', () => {
    // 播客/订阅流 leftKey 是 平台:id,不含 SxxExx → season-episode 无信号跳过,老行为不变。
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('lizhi:12345', '020.再谈身边灵异事')],
      [R('020.再谈身边灵异事.mp3')])
    expect(r.assignments.get('lizhi:12345')?.rightFile).toBe('020.再谈身边灵异事.mp3')
  })

  it('lifts a legacy v1 flat spec into the standard [epnum, title] pipeline', () => {
    const v1: MatchSpec = { version: 1, epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: ['【[^】]*】'], threshold: 0.6, margin: 0.15 }
    const r = matchByEvidenceResult(v1,
      [L('a', '020.再谈身边灵异事'), L('b', '2022壬寅流年运势解析')],
      [R('020.再谈身边灵异事.mp3'), R('2022壬寅流年运势解析.mp3')])
    expect(r.assignments.get('a')?.rightFile).toBe('020.再谈身边灵异事.mp3') // epnum stage
    expect(r.assignments.get('b')?.rightFile).toBe('2022壬寅流年运势解析.mp3') // title fallback the lift adds
  })

  it('does not treat a 4-digit year as an episode number', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('a', '2025封箱直播回放')],
      [R('2025乙巳流年运势解析.mp3')])
    // both parse to no-epnum → not force-matched by number
    expect(r.assignments.has('a')).toBe(false)
    expect(r.coverage.orphanFiles).toContain('2025乙巳流年运势解析.mp3')
  })

  it('picks the best of colliding candidates only when it clearly leads', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('a', '064.不要轻易养小gui')],
      [R('064.不要轻易养小鬼.mp3'), R('64.第六次答疑.mp3')])
    const m = r.assignments.get('a')
    expect(m?.rightFile).toBe('064.不要轻易养小鬼.mp3')
  })

  it('matches composite episode-part keys after stripping filename date prefixes', () => {
    const spec: MatchSpec = { version: 2, stages: [
      {
        by: 'episode-part',
        keyRegex: '第\\s*(\\d+)期.*?(上集|下集)',
        titleStrip: ['^\\d{4}-\\d{2}-\\d{2}\\s*'],
        threshold: 0.25,
        margin: 0.15,
      },
    ] }
    const r = matchByEvidenceResult(spec,
      [
        L('one-up', '第1期纯享上集'), L('one-down', '第1期纯享下集'),
        L('two-up', '第2期纯享上集'), L('two-down', '第2期纯享下集'),
      ],
      [
        R('2026-07-01 第1期纯享上集.mkv'), R('2026-07-01 第1期纯享下集.mkv'),
        R('2026-07-08 第2期纯享上集.mkv'), R('2026-07-08 第2期纯享下集.mkv'),
      ])
    expect(r.assignments.get('one-up')?.rightFile).toBe('2026-07-01 第1期纯享上集.mkv')
    expect(r.assignments.get('one-down')?.rightFile).toBe('2026-07-01 第1期纯享下集.mkv')
    expect(r.assignments.get('two-up')?.rightFile).toBe('2026-07-08 第2期纯享上集.mkv')
    expect(r.assignments.get('two-down')?.rightFile).toBe('2026-07-08 第2期纯享下集.mkv')
    expect([...r.assignments.values()].every((assignment) => assignment.status === 'auto')).toBe(true)
    expect(r.coverage.left).toMatchObject({ matched: 4, ambiguous: 0, missing: 0 })
  })

  // 真实 bug（喜剧之王单口季第3季,2026-07-18):stream 绑定,左标题「第N期纯享上/下集」以「第」开头
  // (epnum 拿不到号)、右文件带 `YYYY-MM-DD ` 日期前缀、中文含噪标题够不到 title 阈值 → 老默认 0/6。
  // 默认管线补上 episode-part(第N期上/下)复合键 + 日期前缀 strip → 6/6,无需 per-binding 调谱、零 LLM。
  it('DEFAULT matches a 第N期上/下集 variety show with date-prefixed files (episode-part, zero AI)', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [
        L('item:a', '第2期纯享下集 刘骙带易立竞全国巡演'), L('item:b', '第2期纯享上集 大老王陪产升级成巨婴'),
        L('item:c', '第1期纯享下集 贤鱼高能量脱口秀狂打鸡血'), L('item:d', '第1期纯享上集 翟佳宁冠军热血回归'),
        L('item:e', '第3期纯享下集 徐不气写歌催房东还押金'), L('item:f', '第3期纯享上集 嘻哈玩转说唱智斗劫机犯'),
      ],
      [
        R('2026-07-11 第2期纯享下集.mkv'), R('2026-07-10 第2期纯享上集.mkv'),
        R('2026-07-04 第1期纯享下集.mkv'), R('2026-07-03 第1期纯享上集.mkv'),
        R('2026-07-18 第3期纯享下集.mkv'), R('2026-07-17 第3期纯享上集.mkv'),
      ])
    expect(r.assignments.get('item:a')?.rightFile).toBe('2026-07-11 第2期纯享下集.mkv')
    expect(r.assignments.get('item:d')?.rightFile).toBe('2026-07-03 第1期纯享上集.mkv')
    expect(r.assignments.get('item:e')?.rightFile).toBe('2026-07-18 第3期纯享下集.mkv')
    expect([...r.assignments.values()].every((a) => a.status === 'auto')).toBe(true)
    expect(r.coverage.left).toMatchObject({ matched: 6, ambiguous: 0, missing: 0 })
    expect(r.coverage.right.orphan).toBe(0)
  })

  // 「第10期上流社会」含「上」却非「上集」——episode-part 的 `(上|下)集` 兜底不误命中,落回 title/无配,
  // 不会把它错分进某个上/下集桶。守住通用 keyRegex 不误伤普通国综标题。
  it('DEFAULT episode-part does not misfire on 上/下 that is not 上集/下集', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('item:x', '第10期 上流社会大乱斗')],
      [R('2026-07-18 第10期 下集彩蛋.mkv')]) // 右是「下集」,左非「上/下集」→ 不该配上
    expect(r.assignments.has('item:x')).toBe(false)
    expect(r.coverage.right.orphan).toBe(1)
  })

  // 真实回归（喜剧之王单口季 第三季,2026-07-21):右侧文件名裸到只剩"第N期X"结构键,没有任何
  // 分集简介文字("第1期一.mkv"),左侧 TMDb 标题却带长描述("第1期（一）：郭麒麟黄渤马思纯斗舞")。
  // 键(期号+段落)已经唯一锁定是哪一集,但旧逻辑仍要求标题相似度过阈值——4 个字 vs 15+ 个字的
  // Dice 系数只有 ~0.21,够不到 0.25,白白拒掉一个本该确定无疑的匹配。episode-part/season-episode
  // 的复合键比标题相似度更可信（结构键档的 autoOnMatch 就凭这个）,候选桶只有唯一一个候选时,
  // 键本身就是消歧证据,不该再让标题相似度当绊脚石。
  it('episode-part trusts a unique key match even when the bare right filename has no descriptive title to compare', () => {
    const spec: MatchSpec = { version: 2, stages: [
      {
        by: 'episode-part',
        keyRegex: '第0*(\\d{1,3})期[^0-9一二三四五六七八九十]*([一二三四五六七八九十]|上|下)',
        titleStrip: ['^\\d{4}-\\d{2}-\\d{2}\\s*'],
        threshold: 0.25,
        margin: 0.1,
      },
    ] }
    const r = matchByEvidenceResult(spec,
      [L('item:s3e1', '第1期（一）：郭麒麟黄渤马思纯斗舞')],
      [R('2026-07-03 第1期一.mkv')])
    expect(r.assignments.get('item:s3e1')?.rightFile).toBe('2026-07-03 第1期一.mkv')
    expect(r.coverage.left.matched).toBe(1)
  })

  // 同一份数据但键桶里有两个候选（同集不同来源,都叫"第1期一"但内容不保证一致）——唯一候选
  // 才免检阈值,多候选仍要标题相似度消歧,不然真撞车时会瞎选一个。
  it('episode-part still requires title similarity to disambiguate when the same key has multiple candidates', () => {
    const spec: MatchSpec = { version: 2, stages: [
      {
        by: 'episode-part',
        keyRegex: '第0*(\\d{1,3})期[^0-9一二三四五六七八九十]*([一二三四五六七八九十]|上|下)',
        titleStrip: ['^\\d{4}-\\d{2}-\\d{2}\\s*'],
        threshold: 0.25,
        margin: 0.1,
      },
    ] }
    const r = matchByEvidenceResult(spec,
      [L('item:s3e1', '第1期（一）：郭麒麟黄渤马思纯斗舞')],
      [R('2026-07-03 第1期一.mkv'), R('来源乙/2026-07-03 第1期一花絮版.mp4')])
    expect(r.assignments.has('item:s3e1')).toBe(false)
    expect(r.coverage.left.ambiguous).toBe(1)
  })

  // 真实案例（脱口秀和Ta的朋友们 第三季,2026-07-19):左标题是裸「上/下」(无「集」字,episode-part
  // 按设计不认,同上一条)+ 行内「纯享」标记 + 冒号分隔的长描述("第2期上纯享：18岁女高音乐脱口秀")。
  // 右文件名往往连「纯享」都不带("第2期上.mp4")。DEFAULT_TITLE_STRIP 不剥冒号后缀/「纯享」,两侧
  // 相似度只有 0.75,够不到 0.85 默认阈值 → DEFAULT 0/N,这是设计使然、不是回归(episode-part 那条
  // 判断依旧成立)。诊断结论：新情况，不是"某次改动把它改坏了"。
  it('DEFAULT title stage declines bare 上/下 + inline 纯享 tag + colon description (new pattern, not a regression)', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('item:b', '第2期上纯享：18岁女高音乐脱口秀')],
      [R('2026-07-03 第2期上.mp4')])
    expect(r.assignments.has('item:b')).toBe(false)
  })

  // 真实回归（同一绑定,2026-07-20）：上一版把「纯享」列进 titleStrip 当噪音剥,这是错的——「纯享」
  // 标的是剪辑版本（同一期号存在纯享/非纯享两条不同内容），不是水印。这份网盘目录本身质量差，
  // 大多数期号只有非纯享版：剥掉「纯享」后"第2期上纯享"（左）和"第2期上.mp4"（非纯享正片）剥出
  // 同一个串，被错配成"这就是纯享版"——5/8 集播的其实是错的内容。见下方"WRONG"对照。
  it('stripping 纯享 as noise wrongly matches a 纯享-labeled episode to its non-纯享 cut', () => {
    const wrong: MatchSpec = { version: 2, stages: [
      { by: 'title', titleStrip: ['^\\d{4}-\\d{2}-\\d{2}\\s*', '【[^】]*】', '[：:].*$', '版$', '纯享'], threshold: 0.97, margin: 0.1 },
    ] }
    const r = matchByEvidenceResult(wrong,
      [L('item:b', '第2期上纯享：18岁女高音乐脱口秀')],
      [R('2026-07-03 第2期上.mp4')]) // 这是非纯享正片，不是纯享版
    expect(r.assignments.get('item:b')?.rightFile).toBe('2026-07-03 第2期上.mp4') // WRONG but reproduces the bug
  })

  // 修正：titleStrip 去掉「纯享」，只剥真噪音（日期前缀、【水印】、冒号后描述、结尾「版」）。
  // 有「纯享」字样的文件精确命中；没有的（这份网盘目录里的大多数）正确留 missing，不瞎配非纯享内容。
  // 冒号剥离仍不进 DEFAULT_TITLE_STRIP，理由同上一条测试。
  it('a corrected per-binding title stage (纯享 kept, not stripped) only recovers genuinely 纯享-labeled files', () => {
    const fixed: MatchSpec = { version: 2, stages: [
      { by: 'title', titleStrip: ['^\\d{4}-\\d{2}-\\d{2}\\s*', '【[^】]*】', '[：:].*$', '版$'], threshold: 0.97, margin: 0.1 },
    ] }
    const r = matchByEvidenceResult(fixed,
      [
        L('item:a', '第1期上中纯享：小奇爆笑进化新人强势突围'), // 有纯享标注的文件 → 精确匹配
        L('item:c', '第1期下纯享：继业表演型人格上演浮夸脱口秀'), // 同上
        L('item:b', '第2期上纯享：18岁女高音乐脱口秀'), // 网盘里只有非纯享正片 → 该留 missing
      ],
      [
        R('2026-06-26 第1期上中纯享版.mp4'),
        R('2026-06-27 第1期下.mp4'), R('2026-06-27 第1期下纯享.mp4'), // 正片 + 纯享 两版并存
        R('2026-07-03 第2期上.mp4'), // 只有非纯享正片
      ])
    expect(r.assignments.get('item:a')?.rightFile).toBe('2026-06-26 第1期上中纯享版.mp4')
    expect(r.assignments.get('item:c')?.rightFile).toBe('2026-06-27 第1期下纯享.mp4') // 不再跟正片打平
    expect(r.assignments.has('item:b')).toBe(false) // 没有纯享版可配，不该认领非纯享正片
    expect(r.coverage.left.missing).toBe(1)
  })

  it('episode-part 同一期的两个清晰度档不判 ambiguous:高档当正主,低档是落选副本', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('item:a', '第2期纯享下集 刘骙带易立竞全国巡演')],
      [
        { name: '2026-07-11 第2期纯享下集.1080p.mkv', size: 900 },
        { name: '2026-07-11 第2期纯享下集.720p.mkv', size: 500 },
      ])
    expect(r.assignments.get('item:a')?.rightFile).toBe('2026-07-11 第2期纯享下集.1080p.mkv')
    expect(r.assignments.get('item:a')?.status).toBe('auto')
    expect(r.coverage.right).toMatchObject({ total: 2, matched: 2, orphan: 0 })
  })

  it('epnum dedupes exact-duplicate reposts within an episode number (watermark/transfer copies)', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('a', '020.再谈身边灵异事')],
      [R('020.再谈身边灵异事【公众号A】.mp3'), R('020.再谈身边灵异事【公众号B】.mp3')])
    expect(r.assignments.get('a')?.rightFile).toBeTruthy()
    expect(r.assignments.get('a')?.status).toBe('auto')
  })

  it('epnum 同一集的两个清晰度档不判 ambiguous:高档当正主,低档是落选副本', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('a', '003.怡乐播客第三期')],
      [{ name: '003.怡乐播客第三期.1080p.mp4', size: 900 }, { name: '003.怡乐播客第三期.720p.mp4', size: 500 }])
    expect(r.assignments.get('a')?.rightFile).toBe('003.怡乐播客第三期.1080p.mp4')
    expect(r.assignments.get('a')?.status).toBe('auto')
    expect(r.coverage.right).toMatchObject({ total: 2, matched: 2, orphan: 0 })
  })

  it('epnum reduces duplicate copies within each quality tier before cross-tier picking', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('a', '003.怡乐播客第三期')],
      [
        { name: '003.怡乐播客第三期.1080p.GroupA.mp4', size: 900 },
        { name: '003.怡乐播客第三期.1080p.GroupB.mp4', size: 850 },
        { name: '003.怡乐播客第三期.720p.mp4', size: 500 },
      ])
    expect(r.assignments.get('a')?.rightFile).toBe('003.怡乐播客第三期.1080p.GroupA.mp4')
    // 720p 那份是落选副本(占住右文件不报孤儿);GroupB 是同档**另一个标题**、不是同一份的重复,
    // 被丢弃后才是孤儿(号相同不等于内容相同,见 reduceByQuality 头注的活体反例)。
    expect(r.coverage.right).toMatchObject({ total: 3, matched: 2, orphan: 1 })
  })
})

/**
 * 同集择优的判据（spec 2026-07-31 §3）。它是**脑**的一部分——整理只消费它的结论，自己不许比。
 * `incomparable` 与 `tie` 必须分开：平手可以删一份，比不出必须留着让人看。
 */
describe('compareQuality（同集两份谁更好）', () => {
  const F = (name: string, size: number, durationS?: number) => ({ name, size, durationS })

  it('两侧都标了清晰度档 → 档位说了算,与体量无关（4K 压得再小也赢 1080p）', () => {
    expect(compareQuality(F('X.S01E01.2160p.mkv', 1), F('X.S01E01.1080p.mkv', 999))).toBe('better')
    expect(compareQuality(F('X.S01E01.1080p.mkv', 999), F('X.S01E01.2160p.mkv', 1))).toBe('worse')
    expect(compareQuality(F('X.4k.mkv', 1), F('X.2160p.mkv', 1))).toBe('incomparable') // 同档,没时长比不出码率
  })

  it('档位探不出 → 码率（size×8÷时长）;差 ≤5% 算平手', () => {
    expect(compareQuality(F('a.mp3', 2000, 1000), F('b.mp3', 1000, 1000))).toBe('better')
    expect(compareQuality(F('a.mp3', 1000, 1000), F('b.mp3', 2000, 1000))).toBe('worse')
    expect(compareQuality(F('a.mp3', 1030, 1000), F('b.mp3', 1000, 1000))).toBe('tie')
  })

  it('长度差出容差 → 根本不是同一份内容（加长版/切割版）,不比', () => {
    expect(compareQuality(F('a.mp3', 9999, 8279), F('b.mp3', 100, 8274))).toBe('incomparable')
  })

  it('时长缺一侧且档位探不出 → 比不出（未知 ≠ 该删）', () => {
    expect(compareQuality(F('a.mp3', 999), F('b.mp3', 100, 1000))).toBe('incomparable')
    expect(compareQuality(F('a.mp3', 999), F('b.mp3', 100))).toBe('incomparable')
  })
})

describe('validateSpec (closed-set gate — both apply paths share it)', () => {
  const good = {
    version: 2,
    generatedBy: 'app-llm',
    generatedAt: '2026-07-09T00:00:00Z',
    stages: [
      { by: 'epnum', epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: ['【[^】]*】', '^怡乐播客\\s*[-—]\\s*'], threshold: 0.6, margin: 0.15 },
      { by: 'title', titleStrip: ['【[^】]*】'], threshold: 0.85, margin: 0.15 },
    ],
  }

  it('accepts a well-formed two-stage spec and keeps generatedBy/At', () => {
    const s = validateSpec(good)
    expect(s.version).toBe(2)
    expect(s.stages?.map((x) => x.by)).toEqual(['epnum', 'title'])
    expect(s.generatedBy).toBe('app-llm')
    expect(s.generatedAt).toBe('2026-07-09T00:00:00Z')
  })

  it('strips unknown top-level fields (only known shape survives)', () => {
    const s = validateSpec({ ...good, evil: 'rm -rf', epNumRegex: 'legacy' }) as unknown as Record<string, unknown>
    expect('evil' in s).toBe(false)
    expect('epNumRegex' in s).toBe(false) // v1 flat field not carried onto a v2 spec
  })

  /**
   * `needsSupply` 是**人工覆盖**那一位（整条绑定一刀切，缺省 = 自动算）。它必须过这道闸——
   * 上一条用例已经钉死"未知顶层字段一律剥掉"，不在这里显式认它就会被那条规则静默吃掉，
   * 表现是用户填了开关、下一轮照旧按算出来的走。
   */
  describe('needsSupply（人工覆盖，整绑定一刀切）', () => {
    it('两个方向都收', () => {
      expect(validateSpec({ ...good, needsSupply: true }).needsSupply).toBe(true)
      expect(validateSpec({ ...good, needsSupply: false }).needsSupply).toBe(false)
    })

    it('不填 → 字段缺席（缺席才是"自动算"，不是 false）', () => {
      expect('needsSupply' in validateSpec(good)).toBe(false)
    })

    // 非布尔一律当没填：这一位只有"人说了算"和"没说"两种状态，把 'true'/1 之类当真值等于
    // 让一个删除开关被字符串真值意外打开。
    it('非布尔 → 剥掉，不猜真值', () => {
      for (const v of ['true', 1, 0, null, {}]) {
        expect('needsSupply' in validateSpec({ ...good, needsSupply: v })).toBe(false)
      }
    })
  })

  it('accepts an episode-part stage with a compilable composite key regex', () => {
    const s = validateSpec({ version: 2, stages: [{
      by: 'episode-part', keyRegex: '第(\\d+)期(上集|下集)', titleStrip: [], threshold: 0.6, margin: 0.15,
    }] })
    expect(s.stages?.[0]).toMatchObject({ by: 'episode-part', keyRegex: '第(\\d+)期(上集|下集)' })
  })

  // 电影绑定:左侧一行、目录里唯一的视频文件就是它。epnum/title 对电影全无意义——片名是中文、
  // 文件名是英文发布组命名,相似度必然 0,而根本没有需要消歧的第二个文件。`solo` 阶段:唯一
  // 视频文件直接认领。
  describe('solo 阶段（电影 = 目录里唯一的视频文件）', () => {
    const soloSpec = { version: 2, stages: [{ by: 'solo' as const }] }
    it('唯一视频文件 → 认领给唯一左项', () => {
      const r = matchByEvidenceResult(soloSpec,
        [{ leftKey: 'tmdb:842675', title: '流浪地球2' }],
        [
          { name: 'The Wandering Earth II (2023) - 2160p UHD BluRay DoVi X265 10bit.mkv' },
          { name: 'poster.jpg' }, { name: 'movie.nfo' }, { name: 'backdrop.jpg' },
        ])
      expect(r.assignments.get('tmdb:842675')?.rightFile).toBe('The Wandering Earth II (2023) - 2160p UHD BluRay DoVi X265 10bit.mkv')
      expect(r.assignments.get('tmdb:842675')?.status).toBe('auto')
    })

    it('多个画质版本 → 取体量最大的正片（同一部电影 4K/1080p 多压制）', () => {
      // 真实回归案例：《绵羊侦探团 (2026)》网盘目录里 5 个同片不同画质版本，中文片名 vs 英文
      // 发布组文件名相似度 0，solo 按 size 取最大的 2160p 认领，其余是同片备选。
      const r = matchByEvidenceResult(soloSpec,
        [{ leftKey: 'tmdb:1301421', title: '绵羊侦探团' }],
        [
          { name: 'The.Sheep.Detectives.2026.2160p.AMZN.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv', size: 18_400_000_000 },
          { name: 'The.Sheep.Detectives.2026.2160p.AMZN.WEB-DL.H265.DDP5.1.Atmos-UBWEB.mkv', size: 12_100_000_000 },
          { name: 'The.Sheep.Detectives.2026.1080p.AMZN.MULTi.WEB-DL.H.264.mkv', size: 4_300_000_000 },
        ])
      expect(r.assignments.get('tmdb:1301421')?.rightFile).toBe('The.Sheep.Detectives.2026.2160p.AMZN.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv')
      expect(r.assignments.get('tmdb:1301421')?.status).toBe('auto')
    })

    it('正片 + 花絮 → 取正片（花絮体量小,不会被误认）', () => {
      const r = matchByEvidenceResult(soloSpec,
        [{ leftKey: 'tmdb:1', title: 'X' }],
        [{ name: 'main.mkv', size: 9_000_000_000 }, { name: 'behind-the-scenes.mkv', size: 300_000_000 }])
      expect(r.assignments.get('tmdb:1')?.rightFile).toBe('main.mkv')
    })

    it('多个视频文件但缺 size → 不猜（分不出正片,退回安全网）', () => {
      const r = matchByEvidenceResult(soloSpec,
        [{ leftKey: 'tmdb:1', title: 'X' }],
        [{ name: 'main.mkv' }, { name: 'behind-the-scenes.mkv' }])
      expect(r.assignments.has('tmdb:1')).toBe(false)
    })

    it('多个视频文件 size 并列 → 不猜（无法判定谁是正片）', () => {
      const r = matchByEvidenceResult(soloSpec,
        [{ leftKey: 'tmdb:1', title: 'X' }],
        [{ name: 'a.mkv', size: 5_000_000_000 }, { name: 'b.mkv', size: 5_000_000_000 }])
      expect(r.assignments.has('tmdb:1')).toBe(false)
    })

    it('零视频文件 → 不认领（只有封面/nfo,片源还没到）', () => {
      const r = matchByEvidenceResult(soloSpec,
        [{ leftKey: 'tmdb:1', title: 'X' }],
        [{ name: 'poster.jpg' }, { name: 'movie.nfo' }])
      expect(r.assignments.has('tmdb:1')).toBe(false)
    })

    it('多个左项 → solo 不认领（solo 是电影专用,不该在剧集上乱配）', () => {
      const r = matchByEvidenceResult(soloSpec,
        [{ leftKey: 'a', title: 'A' }, { leftKey: 'b', title: 'B' }],
        [{ name: 'only.mkv' }])
      expect(r.assignments.size).toBe(0)
    })
  })

  it('validateSpec 认 solo 阶段', () => {
    expect(validateSpec({ version: 2, stages: [{ by: 'solo' }] }).stages).toEqual([{ by: 'solo' }])
  })

  it('rejects an unknown stage kind (fingerprint deferred → not in the closed set)', () => {
    expect(() => validateSpec({ version: 2, stages: [{ by: 'fingerprint', toleranceS: 5 }] }))
      .toThrow(/by must be 'epnum', 'title', 'episode-part', 'season-episode', 'duration', or 'solo'/)
  })

  it('accepts a duration stage with an explicit toleranceS', () => {
    const s = validateSpec({ version: 2, stages: [{
      by: 'duration', toleranceS: 3, titleStrip: [], threshold: 0.6, margin: 0.15,
    }] })
    expect(s.stages?.[0]).toMatchObject({ by: 'duration', toleranceS: 3 })
  })

  it.each([
    ['duration missing toleranceS', { version: 2, stages: [{ by: 'duration', titleStrip: [], threshold: 0.6, margin: 0.15 }] }],
    // 秒不是比例——把 [0,1] 那个校验器套上去会把任何有意义的容差(1s/3s)全拒掉
    ['duration toleranceS out of range', { version: 2, stages: [{ by: 'duration', toleranceS: 99_999, titleStrip: [], threshold: 0.6, margin: 0.15 }] }],
    ['duration negative toleranceS', { version: 2, stages: [{ by: 'duration', toleranceS: -1, titleStrip: [], threshold: 0.6, margin: 0.15 }] }],
  ])('rejects %s', (_name, input) => {
    expect(() => validateSpec(input)).toThrow(/toleranceS must be a number of seconds in \[0,3600\]/)
  })

  it.each([
    ['non-2 version', { version: 1, stages: good.stages }, /version must be 2/],
    ['empty stages', { version: 2, stages: [] }, /non-empty array/],
    ['out-of-range threshold', { version: 2, stages: [{ by: 'title', titleStrip: [], threshold: 1.5, margin: 0.1 }] }, /threshold must be a number in \[0,1\]/],
    ['uncompilable titleStrip regex', { version: 2, stages: [{ by: 'title', titleStrip: ['('], threshold: 0.8, margin: 0.1 }] }, /uncompilable regex/],
    ['epnum missing epNumRegex', { version: 2, stages: [{ by: 'epnum', titleStrip: [], threshold: 0.6, margin: 0.15 }] }, /epNumRegex must be a string/],
    ['episode-part missing keyRegex', { version: 2, stages: [{ by: 'episode-part', titleStrip: [], threshold: 0.6, margin: 0.15 }] }, /keyRegex must be a string/],
    ['episode-part uncompilable keyRegex', { version: 2, stages: [{ by: 'episode-part', keyRegex: '(', titleStrip: [], threshold: 0.6, margin: 0.15 }] }, /keyRegex uncompilable/],
    ['not an object', null, /not an object/],
  ])('rejects %s', (_name, input, re) => {
    expect(() => validateSpec(input)).toThrow(re as RegExp)
  })
})

/**
 * 季分区匹配（`season-resolve.ts:matchBySeason`）把每季各跑一遍，再把判决折叠成一份。
 * `computeCoverage` 必须能对着折叠后的那份算出**全局**覆盖率——它是这条路的收尾，
 * 少算一季就等于把整季文件报成孤儿。
 */
describe('computeCoverage 吃季分区折叠后的判决', () => {
  it('两季各自的认领并起来，覆盖率两季都算上', () => {
    const leftA = [L('a', '020.再谈身边灵异事')]
    const rightA = [R('020.再谈身边灵异事.mp3')]
    const leftB = [L('b', '021.再谈身边灵异事二')]
    const rightB = [R('021.再谈身边灵异事二.mp3')]
    const merged = mergeResolutions(
      matchByEvidence(DEFAULT_MATCH_SPEC, leftA, rightA),
      matchByEvidence(DEFAULT_MATCH_SPEC, leftB, rightB),
    )
    const coverage = computeCoverage([...leftA, ...leftB], [...rightA, ...rightB], ctxFromResolution(merged))
    expect(coverage.left).toMatchObject({ total: 2, matched: 2, ambiguous: 0, missing: 0 })
    expect(coverage.right).toMatchObject({ total: 2, matched: 2, orphan: 0 })
  })

  it('没配上的照实报：ambiguous 与 orphan 各归各位', () => {
    const left = [L('a', '020.再谈身边灵异事'), L('b', '014.六月新闻大盘点')]
    const right = [R('020.再谈身边灵异事.mp3'), R('14.辛金.mp3')]
    const coverage = computeCoverage(left, right, ctxFromResolution(matchByEvidence(DEFAULT_MATCH_SPEC, left, right)))
    expect(coverage.left).toMatchObject({ total: 2, matched: 1, ambiguous: 1, missing: 0 })
    expect(coverage.orphanFiles).toEqual(['14.辛金.mp3'])
  })
})

describe('identityRulesFromSpec', () => {
  it('从 spec 各 stage 收敛 titleStrip（去重保序）+ epnum 正则；无 spec 用默认', () => {
    const rules = identityRulesFromSpec(undefined)
    expect(rules.epNumRegex).toBe(DEFAULT_EPNUM_REGEX)
    expect(rules.titleStrip).toEqual(DEFAULT_TITLE_STRIP)
  })
  it('per-binding 追加的 strip 与自定义 epnum 正则被收进来', () => {
    const spec: MatchSpec = { version: 2, stages: [
      { by: 'epnum', epNumRegex: '^(\\d{3})\\.', titleStrip: ['【[^】]*】', '^瓜瓜乐\\s*[-–—·]\\s*'], threshold: 0.6, margin: 0.15 },
      { by: 'title', titleStrip: ['【[^】]*】', '_\\d{10}'], threshold: 0.85, margin: 0.15 },
    ] }
    const rules = identityRulesFromSpec(spec)
    expect(rules.epNumRegex).toBe('^(\\d{3})\\.')
    expect(rules.titleStrip).toEqual(['【[^】]*】', '^瓜瓜乐\\s*[-–—·]\\s*', '_\\d{10}'])
  })

  // decisions.json 的豁免按归档器的分组 key 存,key 由 titleStrip/epNumRegex 决定。隐式补进来的
  // 时长档带着 titleStrip,若被并进这份规则,归档器的 key 会整体漂移、人工豁免全部失联。
  it('隐式补的时长档不进认集规则（decisions key 不许漂）', () => {
    const spec: MatchSpec = { version: 2, stages: [
      { by: 'epnum', epNumRegex: '^(\\d{3})\\.', titleStrip: ['^瓜瓜乐\\s*[-–—·]\\s*'], threshold: 0.6, margin: 0.15 },
    ] }
    expect(identityRulesFromSpec(spec).titleStrip).toEqual(['^瓜瓜乐\\s*[-–—·]\\s*'])
    // 显式声明的时长档同样不进（它的 titleStrip 只服务二次确认的相似度，不是认集规则）
    const explicit: MatchSpec = { version: 2, stages: [
      { by: 'duration', toleranceS: 1, titleStrip: ['^只给时长档用的\\s*'], threshold: 0.6, margin: 0.15 },
      ...spec.stages!,
    ] }
    expect(identityRulesFromSpec(explicit).titleStrip).toEqual(['^瓜瓜乐\\s*[-–—·]\\s*'])
  })
})

/**
 * 时长主锚（spec 2026-07-30-duration-primary-anchor-design）。
 * 两个真实失配案例是这一档存在的理由，各自一条回归。
 */
describe('duration stage（时长为主锚，文件名/编号降为二次确认）', () => {
  const LD = (leftKey: string, title: string, durationS?: number) => ({ leftKey, title, durationS })
  const RD = (name: string, durationS?: number) => ({ name, durationS })

  it('specStages 给任何没声明时长档的 spec 补一档，且排在最前（编号会骗人，时长不会）', () => {
    expect(specStages(DEFAULT_MATCH_SPEC).map((s) => s.by))
      .toEqual(['duration', 'season-episode', 'episode-part', 'epnum', 'title'])
    // 自定义谱（LLM 产的、被 resolveSpec 冻结尊重的那种）同样补——否则最需要时长锚的绑定拿不到
    const custom: MatchSpec = { version: 2, generatedBy: 'app-llm', stages: [
      { by: 'epnum', epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: ['^瓜瓜乐\\s*-\\s*'], threshold: 0.6, margin: 0.15 },
    ] }
    const lifted = specStages(custom)
    expect(lifted.map((s) => s.by)).toEqual(['duration', 'epnum'])
    // 补进来的那档借用本绑定已声明的清洗口径,不然二次确认的相似度虚低
    expect((lifted[0] as { titleStrip: string[] }).titleStrip).toEqual(['^瓜瓜乐\\s*-\\s*'])
  })

  it('显式声明了时长档就不再补（可调容差）', () => {
    const spec: MatchSpec = { version: 2, stages: [
      { by: 'duration', toleranceS: 30, titleStrip: [], threshold: 0.6, margin: 0.15 },
      { by: 'title', titleStrip: [], threshold: 0.85, margin: 0.15 },
    ] }
    expect(specStages(spec).filter((s) => s.by === 'duration')).toHaveLength(1)
    // 名字得过得了地板（见下方「名字完全不沾边」那条），否则量不到容差本身
    const r = matchByEvidenceResult(spec, [LD('a', '某一集', 1000)], [RD('某一集【水印】.mp3', 1020)])
    expect(r.assignments.get('a')?.rightFile).toBe('某一集【水印】.mp3') // 20s 在 30s 容差内
  })

  // 真实失配（怡乐播客，2026-07-25，docs/MATCHING.md「三个真实案例」第三行）：
  // 源站 53、网盘 52，标题一模一样。编号错位 1，任何 titleStrip 都救不了 —— 这一档存在的理由。
  it('回归·编号错位 1、标题相同：53 靠时长唯一命中认领文件 52', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [LD('yile:53', '53.财克印、印克食伤', 2011)],
      [RD('52.财克印、印克食伤.mp3', 2011)])
    const m = r.assignments.get('yile:53')!
    expect(m.rightFile).toBe('52.财克印、印克食伤.mp3')
    expect(m.status).toBe('auto') // 时长唯一命中 = 结构化键唯一命中的同级证据
    expect(r.coverage.left.matched).toBe(1)
    expect(r.coverage.right.orphan).toBe(0)
  })

  // 同一条错位,放回真实目录里就致命:相邻集标题天然相近(`…食伤` / `…食伤（上）`),
  // epnum 排在 title 前面,错号的文件会被**真正的**第 52 集按号抢走(相似度 0.82,够 auto),
  // 第 53 集则永远配不上 —— 一次错位赔两集。这就是"编号会骗人"的完整形状。
  it('回归·错位的文件不再被真正的 52 集按号抢走（编号会骗人，时长不会）', () => {
    const left = [LD('yile:52', '52.财克印、印克食伤（上）', 1800), LD('yile:53', '53.财克印、印克食伤', 2011)]
    const right = [RD('52.财克印、印克食伤.mp3', 2011)] // 号是 52,内容是 53

    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC, left, right)
    expect(r.assignments.get('yile:53')?.rightFile).toBe('52.财克印、印克食伤.mp3')
    expect(r.assignments.has('yile:52')).toBe(false) // 52 真的没有文件 → 老老实实报缺
    expect(r.coverage.missingEpisodes).toEqual([52])

    // 同一组数据抹掉时长 = 改动前的行为:epnum 把文件按号判给 52（错配），53 全无着落。
    const blind = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      left.map((l) => ({ leftKey: l.leftKey, title: l.title })),
      right.map((x) => ({ name: x.name })))
    expect(blind.assignments.get('yile:52')?.rightFile).toBe('52.财克印、印克食伤.mp3')
    expect(blind.assignments.has('yile:53')).toBe(false)
  })

  // 孤立一对时 `title` 档（阈值 0.85）其实救得了标题完全相同的错位——真实目录里救不了它的是
  // **转存重复**：同一集两份文件归一化后一模一样,门槛判定拒绝在平局里瞎选（既有用例
  // "two right files that both reduce to the exact same normalized title" 钉的就是这条）。
  // 时长档在分桶后先做 reduceByQuality 去重（同 tn 取体量大的），平局自然消解。
  it('回归·编号错位 + 转存重复：文件名链在这里彻底失效，时长档把它救回来', () => {
    const right = [
      RD('52.财克印、印克食伤.mp3', 2011),
      RD('52.财克印、印克食伤【公众号：CunWorkNotes】.mp3', 2011),
    ]
    const blind = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [{ leftKey: 'yile:53', title: '53.财克印、印克食伤' }],
      right.map((x) => ({ name: x.name })))
    expect(blind.assignments.has('yile:53')).toBe(false) // 改动前:平局,不敢配

    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [LD('yile:53', '53.财克印、印克食伤', 2011)],
      [{ ...right[0], size: 10 }, { ...right[1], size: 9 }])
    expect(r.assignments.get('yile:53')?.rightFile).toBe('52.财克印、印克食伤.mp3')
    expect(r.assignments.get('yile:53')?.status).toBe('auto')
  })

  // 真实失配（2026-07-24 活体）：网盘 455.现代版木仓下留人 就是源站的 454.现代版枪下留人。
  // 编号错位 + 改字避审同时失灵；标题相似度只有 0.615，够不到 AUTO_SIM=0.8。
  it('回归·编号错位 + 规避字（木仓=枪）：时长唯一命中照样认，且是 auto', () => {
    expect(titleSim('现代版枪下留人', '现代版木仓下留人')).toBeLessThan(0.8) // 光靠标题永远到不了 auto
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [LD('yile:454', '454.现代版枪下留人', 2605)],
      [RD('455.现代版木仓下留人.mp3', 2605)])
    const m = r.assignments.get('yile:454')!
    expect(m.rightFile).toBe('455.现代版木仓下留人.mp3')
    expect(m.status).toBe('auto')
  })

  // 真实误配（怡乐播客，2026-07-30 活体 sync）：848 期时长 8162s，网盘里恰好有个 8163s 的文件，
  // 容差内独一份 —— 但它是**另一集**（209 期），只是碰巧一样长。209 不在订阅流给的清单里
  // （feed 只给近 167 条），没有"正主"来把它认领回去，于是这个文件就一直挂在 848 名下、
  // 还标成 auto。「唯一」不等于「对」：一两个小时的节目，时长撞车比想象中常见。
  it('回归·唯一命中但名字完全不沾边 → 不配（配不上本身就是要报出来的信号）', () => {
    const left = [LD('yile:848', '848.三十探悬疑案件', 8162)]
    const right = [RD('怡乐播客 - 209.十五谈身边灵异事.mp3', 8163)]
    expect(titleSim('三十探悬疑案件', '怡乐播客-209.十五谈身边灵异事')).toBe(0)

    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC, left, right)
    expect(r.assignments.has('yile:848')).toBe(false)
    expect(r.coverage.orphanFiles).toContain('怡乐播客 - 209.十五谈身边灵异事.mp3')
  })

  it('地板不许高到吃掉这一档的立身之本：455/454 的 0.615 必须照过', () => {
    expect(DURATION_MIN_SIM).toBeLessThan(0.615) // 改字避审那组是真配的下限，实测 0.615
    expect(DURATION_MIN_SIM).toBeGreaterThan(0) // 0 分那些是纯巧合，必须挡住
  })

  // 用 455/454 那组（文件名链救不了它）来量容差边界：差 2s 就不再是"同一集的编码零头"。
  // 若换成标题完全相同的 53/52 组，退回文件名链后 `title` 档会以 sim=1 把它配上——那证明的是
  // fallback 通了，不是容差生效了。
  it('容差外（差 2s）不算命中 → 退回文件名规则链（这一组文件名链也救不了 → 不配）', () => {
    expect(DURATION_TOLERANCE_S).toBe(1)
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [LD('yile:454', '454.现代版枪下留人', 2605)],
      [RD('455.现代版木仓下留人.mp3', 2607)])
    expect(r.assignments.has('yile:454')).toBe(false)
  })

  it('时长档从不记缺档号（缺档口径仍归 epnum）—— 没撞上就是无信号，不是"这集没有文件"', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [LD('yile:66', '066.凑活聊道德绑架', 900)],
      [RD('020.再谈身边灵异事.mp3', 3000)])
    expect(r.coverage.missingEpisodes).toEqual([66]) // 66 来自 epnum，不是时长档
  })

  // 拍板边界 ②：整季等长的节目时长区分度低，多个候选都在容差内时按撞车处理，
  // 交给标题/编号细分，不许硬配。
  it('整季等长：三集时长全一样 → 时长档不硬配，season-episode 照常把它们配对', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [LD('tmdb:9:S01E01', '第一集', 3600), LD('tmdb:9:S01E02', '第二集', 3600), LD('tmdb:9:S01E03', '第三集', 3600)],
      [RD('Show.S01E01.1080p.mkv', 3600), RD('Show.S01E02.1080p.mkv', 3600), RD('Show.S01E03.1080p.mkv', 3600)])
    expect(r.assignments.get('tmdb:9:S01E01')?.rightFile).toBe('Show.S01E01.1080p.mkv')
    expect(r.assignments.get('tmdb:9:S01E02')?.rightFile).toBe('Show.S01E02.1080p.mkv')
    expect(r.assignments.get('tmdb:9:S01E03')?.rightFile).toBe('Show.S01E03.1080p.mkv')
    expect(r.coverage.left).toMatchObject({ matched: 3, ambiguous: 0, missing: 0 })
  })

  // 上面那条之所以过，是因为 RD 不带 size —— 一旦带上真实体量，reduceByQuality 的「体量大者胜」
  // 会把撞车的桶压成"唯一候选"，唯一性又被 trustUniqueKey 当成锚级证据，标题相似度根本不查。
  // 下面两条是 2026-07-30 首次活体 sync 抓到的真实错配，钉的就是这条：
  // **体量只配用来消同名重复，不许用来在不同标题之间选。**
  it('回归·两集时长完全相同（7707s）：不许按体量硬配，编号/标题必须能把它们分开', () => {
    // 怡乐播客活体：530 与 820 时长同为 7707s，两个文件体量只差 3.7KB。
    // 缺这道闸门时，时长档把两集**交叉**配错（530⟵820 的文件、820⟵530 的文件），且都是 conf=0 的 auto。
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [LD('yile:530', '530.十七探悬疑案件', 7707), LD('yile:820', '820.骗局', 7707)],
      [
        { ...RD('530.十七探悬疑案件【公众号：CunWorkNotes】.mp3', 7707), size: 123368124 },
        { ...RD('820.骗局【耗时整理‖免费分享：cunlove.cn】.mp3', 7707), size: 123371876 },
      ])
    expect(r.assignments.get('yile:530')?.rightFile).toBe('530.十七探悬疑案件【公众号：CunWorkNotes】.mp3')
    expect(r.assignments.get('yile:820')?.rightFile).toBe('820.骗局【耗时整理‖免费分享：cunlove.cn】.mp3')
  })

  it('回归·撞车时精确标题命中不许被体量更大的无关文件挤掉', () => {
    // 怡乐播客活体：子节目「玄关笔记/29.十神的生克关系」(1989s/31.9MB) 与正片
    // 「104.清华大学朱令案」(1989s/47.7MB) 时长相同。缺闸门时体量大的正片胜出，
    // sim=1 的精确同名文件反而落进 orphan。
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [LD('yile:29', '29.十神的生克关系', 1988)],
      [
        { ...RD('玄关笔记/29.十神的生克关系.mp3', 1989), size: 31876857 },
        { ...RD('104.清华大学朱令案.mp3', 1989), size: 47742674 },
      ])
    expect(r.assignments.get('yile:29')?.rightFile).toBe('玄关笔记/29.十神的生克关系.mp3')
  })

  it('撞车且标题也分不出 → 记 ambiguous，绝不硬配', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [LD('a', '完全看不出是哪集', 3600)],
      [RD('甲.mp3', 3600), RD('乙.mp3', 3600)])
    expect(r.assignments.size).toBe(0)
    expect(r.coverage.left.ambiguous).toBe(1)
  })

  it('右侧一个时长都没有 → 整档无信号，老行为逐字不变', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [LD('a', '020.再谈身边灵异事', 2011)],
      [RD('020.再谈身边灵异事.mp3')])
    expect(r.assignments.get('a')?.rightFile).toBe('020.再谈身边灵异事.mp3') // epnum 配上的
    expect(r.assignments.get('a')?.confidence).toBe(1)
  })

  it('paid 是透传字段：带不带它，配对结果一模一样', () => {
    const plain = matchByEvidenceResult(DEFAULT_MATCH_SPEC, [LD('a', '020.再谈身边灵异事', 2011)], [RD('020.再谈身边灵异事.mp3', 2011)])
    const paid = matchByEvidenceResult(DEFAULT_MATCH_SPEC, [{ ...LD('a', '020.再谈身边灵异事', 2011), paid: true }], [RD('020.再谈身边灵异事.mp3', 2011)])
    expect(paid.assignments).toEqual(plain.assignments)
  })
})

/**
 * 横向时长矛盾闸（`CONTENT_MISMATCH_RATIO`）。
 *
 * `epnum`/`title`/`season-episode` 三档完全不看时长——时长档在最前面没撞上就返回"无信号"，后面的
 * 档再也不问。活体（2026-07-31 怡乐）：96 分钟的 `玄关笔记/05.太极两仪生四象.mp3` 被 epnum 按名字
 * 配给节目单上 36 分钟的第 05 集，还给了 `auto`——用户点开第 05 集，播出来的是灵异事。
 * 「时长是认集主锚」必须横着管住所有档才成立。
 */
describe('横向时长矛盾闸：任何一档配出来的对，时长差出量级就不算配上', () => {
  const spec: MatchSpec = {
    version: 2,
    stages: [{ by: 'epnum', epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: [], threshold: 0.6, margin: 0.15 }],
  }
  const left = [{ leftKey: 'L05', title: '05.太极两仪生四象', durationS: 2164 }]

  it('时长差出量级 → 不配（哪怕名字一模一样、集号也对）', () => {
    const { assignments } = matchByEvidenceResult(spec, left, [{ name: '05.太极两仪生四象.mp3', durationS: 5808 }])
    expect(assignments.has('L05')).toBe(false)
  })

  it('闸门只剔掉矛盾的那个候选，同桶里时长对得上的照常配', () => {
    const { assignments } = matchByEvidenceResult(spec, left, [
      { name: '玄关笔记/05.太极两仪生四象.mp3', durationS: 5808 },
      { name: '来源/05.太极两仪生四象【耗时整理】.mp3', durationS: 2164 },
    ])
    expect(assignments.get('L05')?.rightFile).toBe('来源/05.太极两仪生四象【耗时整理】.mp3')
  })

  it('两侧任一没有时长 → 闸门不生效（TMDb 不给时长，影视线一字不变）', () => {
    const noLeftDur = [{ leftKey: 'L05', title: '05.太极两仪生四象' }]
    expect(matchByEvidenceResult(spec, noLeftDur, [{ name: '05.太极两仪生四象.mp3', durationS: 5808 }]).assignments.has('L05')).toBe(true)
    expect(matchByEvidenceResult(spec, left, [{ name: '05.太极两仪生四象.mp3' }]).assignments.has('L05')).toBe(true)
  })

  it('量级以内的差不受影响（几秒尾巴 / 片头重剪是同一集的另一版；活体 780 差 0.06%）', () => {
    const l = [{ leftKey: 'L780', title: '780.四十五谈身边灵异事', durationS: 8274 }]
    const { assignments } = matchByEvidenceResult(spec, l, [{ name: '780.四十五谈身边灵异事.mp3', durationS: 8279 }])
    expect(assignments.get('L780')?.rightFile).toBe('780.四十五谈身边灵异事.mp3')
  })

  // `title` 档（阈值 0.85、纯标题相似度）过去完全不参考时长——系列邻集是重灾区。
  // 活体反例（2026-07-30，归档器收敛到单匹配脑时撞出）：`069.四谈身边灵异事`（1777s）被
  // `200.十四谈身边灵异事.mp3`（3000s）以 sim 0.923 唯一候选配上、状态 `auto`。
  // 过去这只是覆盖率数字里的一个错；单脑落地后归档器照结论**真把文件搬进付费货架**。
  it('title 档同样过闸：系列邻集名字极像、时长差出量级 → 不配（活体 069/200）', () => {
    const titleOnly: MatchSpec = { version: 2, stages: [{ by: 'title', titleStrip: [], threshold: 0.85, margin: 0.15 }] }
    const l = [{ leftKey: 'L069', title: '069.四谈身边灵异事', durationS: 1777 }]
    const r = matchByEvidenceResult(titleOnly, l, [{ name: '200.十四谈身边灵异事.mp3', durationS: 3000 }])
    expect(r.assignments.has('L069')).toBe(false)
    expect(r.coverage.right.orphan).toBe(1)
    /**
     * **出一张卡**（裁决表第 3 格 / R14，spec §8）。别把它和 title 档那条老口径混——
     * 老口径说的是"相似度没够到高阈值就当没信号、不记 ambiguous"，那条仍然成立（下一条用例）。
     * 这里名字**够到了**（0.923 ≥ 0.85），是时长闸把它否掉的：证据在场、只是被否，
     * 属于"必须说出来"的那一类。悄悄咽下去正是 05 案的形状。
     */
    expect(r.ambiguous).toHaveLength(1)
    expect(r.ambiguous[0]).toMatchObject({ leftKey: 'L069', stage: 'title', reason: 'duration-contradiction' })
    expect(r.coverage.left.ambiguous).toBe(1)
  })

  it('title 档相似度压根没够到高阈 → 仍不记 ambiguous（"没信号"和"被否决"是两件事）', () => {
    const titleOnly: MatchSpec = { version: 2, stages: [{ by: 'title', titleStrip: [], threshold: 0.85, margin: 0.15 }] }
    const r = matchByEvidenceResult(titleOnly, [{ leftKey: 'L1', title: '完全不同的一集', durationS: 1777 }], [{ name: '毫不相干的文件.mp3', durationS: 3000 }])
    expect(r.assignments.size).toBe(0)
    expect(r.ambiguous).toEqual([])
    expect(r.coverage.left).toMatchObject({ ambiguous: 0, missing: 1 })
  })

  // 时长撞上、名字地板没过：过去只 `return null`（无信号），到最后这一集就是普通的"没配上"，
  // **"它的时长命中过某一集"这条证据在链条里蒸发了**。归档器因此看不到这一档，只好自己重算一遍
  // 时长命中 + 名字地板（`hitsOf`/`clearFloor`/`anchorOf`）——第二个判定脑的另一半就是这么长出来的。
  // 现在把它记成一等歧义：不配、不占文件、照常退回文件名链，但**说出来**。
  it('时长命中但名字地板没过 → 记 ambiguous(name-floor)，不是无声掉队', () => {
    const durSpec: MatchSpec = { version: 2, stages: [{ by: 'duration', toleranceS: 1, titleStrip: [], threshold: 0.6, margin: 0.15 }] }
    const r = matchByEvidenceResult(durSpec, [{ leftKey: 'L37', title: '37.申与酉', durationS: 6044 }], [
      { name: '756.谈风水那些事.mp3', durationS: 6043, size: 900 },
    ])
    expect(r.assignments.has('L37')).toBe(false)
    expect(r.ambiguous).toHaveLength(1)
    expect(r.ambiguous[0]).toMatchObject({ leftKey: 'L37', stage: 'duration', reason: 'name-floor' })
    expect(r.ambiguous[0].candidates.map((c) => c.name)).toEqual(['756.谈风水那些事.mp3'])
    // 不配 = 不占：那份文件照常报孤儿，后续 stage 也还抢得到它
    expect(r.coverage.right.orphan).toBe(1)
  })

  it('候选全被时长否掉 → 记 ambiguous（号命中但没敢配），不是缺档', () => {
    const r = matchByEvidenceResult(spec, left, [{ name: '05.太极两仪生四象.mp3', durationS: 5808 }])
    expect(r.coverage.left.ambiguous).toBe(1)
    expect(r.coverage.missingEpisodes).toEqual([])
    // 被否掉的那份没被占住 → 照常报 orphan，不许凭空消失
    expect(r.coverage.right.orphan).toBe(1)
  })
})

describe('assignments 交出 losers：同集的其余份是匹配器的结论，不该让归档器反推', () => {
  const spec: MatchSpec = {
    version: 2,
    stages: [{ by: 'epnum', epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: DEFAULT_TITLE_STRIP, threshold: 0.6, margin: 0.15 }],
  }

  it('同集多份 → 正主进 rightFile，其余份进 losers', () => {
    const { assignments } = matchByEvidenceResult(spec, [L('L01', '01.开场')], [
      { name: '01.开场 2160P.mkv', size: 900 },
      { name: '01.开场 1080P.mkv', size: 300 },
    ])
    const a = assignments.get('L01')!
    expect(a.rightFile).toBe('01.开场 2160P.mkv')
    expect(a.losers).toEqual(['01.开场 1080P.mkv'])
  })

  it('只有一份时不带 losers 字段（别塞空数组）', () => {
    const { assignments } = matchByEvidenceResult(spec, [L('L01', '01.开场')], [{ name: '01.开场.mkv' }])
    expect(assignments.get('L01')).not.toHaveProperty('losers')
  })

  // 下面三条守的是 `reduceByQuality` 的**层内**丢弃：同名重复、同档位体量择优的落选，
  // 两类都必须进 `losers`（也就是"这一集的其余份"）。它们一度只在匹配器肚子里被丢掉、谁都没告诉，
  // 于是归档器只能自己长一套判据反推"这是同一集的另一份"——第二个判定脑就是这么长出来的。
  it('层内同名重复（同档位、清洗后同名的转存副本）也进 losers', () => {
    const { assignments, coverage } = matchByEvidenceResult(spec, [L('L01', '01.开场')], [
      { name: '01.开场.mkv', size: 900 },
      { name: '01.开场.m4a', size: 300 },
    ])
    const a = assignments.get('L01')!
    expect(a.rightFile).toBe('01.开场.mkv')
    expect(a.losers).toEqual(['01.开场.m4a'])
    // 被认成"同集的另一份"就该占住，不能再报成没人认领的孤儿
    expect(coverage.right.orphan).toBe(0)
  })

  // 反过来的那半条同样要守死。集号相同 + 标题不同 = **可能是不同内容**，不许当落选份收编：
  // 活体（2026-08-01）喜剧之王 `第7期（一）(二)(三)(四)`、脱口秀 `第5期上/中/下纯享` 都落在
  // 同一个号桶里，按"整桶同一集"收编会把 78 份不同内容标成落选份，而落选份的归宿是按质量判删。
  it('集号相同但标题不同 → 不算落选份，照常报孤儿', () => {
    const { assignments, coverage } = matchByEvidenceResult(spec, [L('L01', '01.开场典礼')], [
      { name: '01.开场典礼.mkv', size: 900 },
      { name: '01.开场典礼 中.mkv', size: 300 },
    ])
    expect(assignments.get('L01')!.rightFile).toBe('01.开场典礼.mkv')
    expect(assignments.get('L01')).not.toHaveProperty('losers')
    expect(coverage.right.orphan).toBe(1)
  })

  // 字幕/海报/nfo 和正片剥掉扩展名后常常同名——照 tn 收编就会把字幕标成落选副本，
  // 而落选份的归宿是判删。活体：西区帮派两条 `.ass`（2026-08-01）。
  it('同名的非媒体文件（字幕等）不算落选份', () => {
    const { assignments, coverage } = matchByEvidenceResult(spec, [L('L01', '01.开场')], [
      { name: '01.开场.mkv', size: 900 },
      { name: '01.开场.ass', size: 30 },
    ])
    expect(assignments.get('L01')!.rightFile).toBe('01.开场.mkv')
    expect(assignments.get('L01')).not.toHaveProperty('losers')
    expect(coverage.right.orphan).toBe(1)
  })

  // 时长档的桶键**不保证同一集**，所以层内重复只能算在它自己那个候选头上——绝不能整桶
  // 一起当成赢家的 losers，否则错身文件会被"同集的另一份"这个名义占住、下游还会判它删。
  it('时长档：同名重复只跟着它自己的候选走，不许算到另一集头上', () => {
    const durSpec: MatchSpec = { version: 2, stages: [{ by: 'duration', toleranceS: 1, titleStrip: [], threshold: 0.6, margin: 0.15 }] }
    const r = matchByEvidenceResult(durSpec, [{ leftKey: 'L05', title: '005.身边灵异事', durationS: 5808 }], [
      { name: '005.身边灵异事.mp3', durationS: 5808, size: 900 },
      { name: '005.身边灵异事.m4a', durationS: 5808, size: 300 },
      { name: '05.太极两仪生四象.mp3', durationS: 5808, size: 800 },
    ])
    const a = r.assignments.get('L05')!
    expect(a.rightFile).toBe('005.身边灵异事.mp3')
    expect(a.losers).toEqual(['005.身边灵异事.m4a'])
    // 同长的错身文件既不是正主也不是"这一集的另一份"——照常报孤儿
    expect(r.coverage.right.orphan).toBe(1)
  })
})

/**
 * 时长桶的**零竞争出口**（裁决表 R4，`match-engine/rules.ts:soleTouching`）。活体 2026-08-01 怡乐的形状：节目单
 * 「005.身边那些灵异事」（5808s）的时长桶里撞进两份：`怡乐播客 - 005.身边那些灵异事.mp3`
 * （名字一字不差，只是被分享者前缀把相似度稀释到 0.571）和 `玄关笔记/05.太极两仪生四象.mp3`
 * （同样 5808s 的另一期节目，名字相似度 0）。
 *
 * 相似度 0 的那份**不是竞争者**——它和这一集的标题连一个公共 bigram 都没有，撞上纯属两集一样长。
 * 让它把唯一那份真候选挤下免检线，结果就是名字完全正确的文件也配不上、攒成问句。
 * 唯一沾边 = 时长与名字两侧同时成立 = 锚级证据，直接 auto。
 */
describe('时长桶零竞争：撞车的另一份名字一个字不沾 → 唯一沾边那份直接认', () => {
  const spec: MatchSpec = { version: 2, stages: [{ by: 'duration', toleranceS: 1, titleStrip: [], threshold: 0.6, margin: 0.15 }] }
  const left = [{ leftKey: 'L005', title: '005.身边那些灵异事', durationS: 5808 }]
  const right = [
    { name: '怡乐播客 - 005.身边那些灵异事.mp3', size: 92986927, durationS: 5808 },
    { name: '玄关笔记/05.太极两仪生四象.mp3', size: 92986927, durationS: 5808 },
  ]

  it('唯一沾边那份直接 auto（相似度 0.571 够不着 threshold 0.6 也照认）', () => {
    const r = matchByEvidenceResult(spec, left, right)
    expect(r.assignments.get('L005')).toMatchObject({ rightFile: right[0].name, status: 'auto' })
  })

  it('sim 0 的那份**不是**这一集的 loser——它留在池子里，被自己那一集认走', () => {
    const r = matchByEvidenceResult(spec, [...left, { leftKey: 'L05太极', title: '05.太极两仪生四象', durationS: 5808 }], right)
    expect(r.assignments.get('L005')?.losers).toBeUndefined()
    expect(r.assignments.get('L05太极')).toMatchObject({ rightFile: right[1].name, status: 'auto' })
    expect(r.coverage.right.orphan).toBe(0)
  })

  it('把错身那份拿掉（桶里只剩一份）→ 唯一命中免检，直接 auto', () => {
    const r = matchByEvidenceResult(spec, left, [right[0]])
    expect(r.assignments.get('L005')).toMatchObject({ rightFile: right[0].name, status: 'auto' })
  })

  it('唯一沾边、但过不了名字地板（0 < sim < 0.3）→ 不放行，维持撞车的现状', () => {
    const r = matchByEvidenceResult(spec, [{ leftKey: 'L1', title: '甲乙丙丁戊己庚辛壬癸', durationS: 3600 }], [
      { name: '甲乙子丑寅卯辰巳午未申酉戌亥.mp3', durationS: 3600 }, // 只共一个 bigram → sim 0.09
      { name: '青龙白虎朱雀玄武.mp3', durationS: 3600 }, // sim 0
    ])
    expect(r.assignments.has('L1')).toBe(false)
    expect(r.ambiguous).toHaveLength(1)
  })

  it('两个候选都沾边 = 真撞车 → 行为不变，仍由 threshold/margin 说了算', () => {
    const r = matchByEvidenceResult(spec, left, [
      right[0],
      { name: '怡乐播客 - 005.身边那些灵异事（补档）.mp3', size: 92986000, durationS: 5808 },
    ])
    expect(r.assignments.has('L005')).toBe(false)
    expect(r.ambiguous[0]?.candidates).toHaveLength(2)
  })
})

/**
 * 人工订正预置。`sync.ts` 那侧一直写着「corrected 优先，不重算」，但那是**写回时**的特判——
 * 匹配本身照跑，被钉死的那份文件照样参与别的左项的竞争。而归档器那侧连这个特判都没有
 * （`corrected` 这个词在整个 `reconcile/` 里一次都没出现）：你 PATCH 钉死 A→ep1，归档器按
 * 自己重算的结果认为 B→ep1，就把 A 当"清单里没有它"搬去下架。
 *
 * 把 pin 提到匹配层预置——跑任何 stage 之前先占位——两个消费者自动都尊重，不用各自记得。
 */
describe('人工订正预置：人裁过的先占位，规则不许翻案', () => {
  const spec: MatchSpec = { version: 2, stages: [{ by: 'title', titleStrip: [], threshold: 0.85, margin: 0.15 }] }

  it('pin 直接成为配对结果、状态 auto，规则给的答案不许盖掉它', () => {
    const { assignments } = matchByEvidenceResult(spec, [{ leftKey: 'L1', title: '甲', pinnedRight: '完全不像的名字.mp3' }], [
      { name: '完全不像的名字.mp3' }, { name: '甲.mp3' },
    ])
    expect(assignments.get('L1')).toMatchObject({ rightFile: '完全不像的名字.mp3', status: 'auto' })
  })

  it('被 pin 占住的文件不会再配给别的集', () => {
    const { assignments } = matchByEvidenceResult(spec, [
      { leftKey: 'L1', title: '甲', pinnedRight: '乙.mp3' },
      { leftKey: 'L2', title: '乙' },
    ], [{ name: '乙.mp3' }])
    expect(assignments.get('L1')?.rightFile).toBe('乙.mp3')
    expect(assignments.has('L2')).toBe(false)
  })

  it('pin 指向的文件这一轮不在右侧（被删/改名）→ 不占位，按规则照常跑', () => {
    const { assignments } = matchByEvidenceResult(spec, [{ leftKey: 'L1', title: '甲', pinnedRight: '已经没了.mp3' }], [{ name: '甲.mp3' }])
    expect(assignments.get('L1')?.rightFile).toBe('甲.mp3')
  })

  it('pin 过的左项不参与覆盖率的 ambiguous/missing 统计（它已经有答案了）', () => {
    const r = matchByEvidenceResult(spec, [{ leftKey: 'L1', title: '甲', pinnedRight: 'x.mp3' }], [{ name: 'x.mp3' }])
    expect(r.coverage.left).toMatchObject({ total: 1, matched: 1, ambiguous: 0, missing: 0 })
    expect(r.coverage.right.orphan).toBe(0)
  })
})

/**
 * `solo`（电影：目录里唯一的视频文件，裁决表 R10）与别的档共用同一套过滤：横向时长闸（R11）、
 * `pinnedRight` 预置（R1）、同一份"文件已被占用"账。它一度自己单开一条认领路，那两道闸绕不到它。
 * 免检要保留（电影中文片名 vs 发布组英文文件名相似度天然是 0，走相似度必然全灭）——共用的是
 * **过滤与认领**，不是判据。
 */
describe('solo：免检认领，但同一套过滤照样管它', () => {
  const spec: MatchSpec = { version: 2, stages: [{ by: 'solo' }] }

  it('唯一视频文件 → 认领（名字完全不像也照认，这是 solo 的意义）', () => {
    const r = matchByEvidenceResult(spec, [{ leftKey: 'M1', title: '某部中文电影' }], [{ name: 'Some.Movie.2160p.mkv', size: 9 }])
    expect(r.assignments.get('M1')).toMatchObject({ rightFile: 'Some.Movie.2160p.mkv', status: 'auto' })
  })

  it('过时长矛盾闸：5 分钟的花絮不是 2 小时的正片', () => {
    const r = matchByEvidenceResult(spec, [{ leftKey: 'M1', title: '某部中文电影', durationS: 7200 }],
      [{ name: 'Some.Movie.2160p.mkv', size: 9e9, durationS: 300 }])
    expect(r.assignments.has('M1')).toBe(false)
  })

  it('过 pin 预置：人钉死的那份不许被"体量最大"顶掉', () => {
    const r = matchByEvidenceResult(spec, [{ leftKey: 'M1', title: '某部中文电影', pinnedRight: '小的那份.mkv' }],
      [{ name: '大的那份.mkv', size: 9e9 }, { name: '小的那份.mkv', size: 1 }])
    expect(r.assignments.get('M1')?.rightFile).toBe('小的那份.mkv')
  })

  it('多个视频体量分不出正片 → 不猜（老安全网不变）', () => {
    const r = matchByEvidenceResult(spec, [{ leftKey: 'M1', title: '某部中文电影' }],
      [{ name: 'a.mkv', size: 500 }, { name: 'b.mkv', size: 500 }])
    expect(r.assignments.has('M1')).toBe(false)
  })
})

/**
 * 免检口径（characterization）。收口重构**必须一行不改地继续通过**——它钉的是各档现有行为，
 * 不是新判据：结构化键自带身份信息所以免检不设名字地板（`第1期一.mkv` 那类裸到只剩集号的文件
 * 标题相似度天然算不高，加地板会把确定无疑的匹配全拒掉）；`duration` 的"容差内唯一"不带任何
 * 身份信息，所以它的免检额外要过 `DURATION_MIN_SIM`。两者不该同尺。
 */
describe('免检口径：哪几档的唯一候选不检阈值、各自凭什么', () => {
  const one = (stage: MatchStage) => ({ version: 2 as const, stages: [stage] })

  it('season-episode：结构键唯一候选 → 免检阈值，且不设名字地板', () => {
    const r = matchByEvidenceResult(one({ by: 'season-episode', fileRegex: DEFAULT_SEASON_EPISODE_REGEX, titleStrip: [], threshold: 0.9, margin: 0.15 }),
      [{ leftKey: 'tmdb:1:S01E01', title: '完全不像的中文集名' }], [{ name: 'Show.S01E01.mkv' }])
    expect(r.assignments.get('tmdb:1:S01E01')).toMatchObject({ status: 'auto' })
  })

  it('episode-part：同上', () => {
    const r = matchByEvidenceResult(one({ by: 'episode-part', keyRegex: DEFAULT_EPISODE_PART_REGEX, titleStrip: [], threshold: 0.9, margin: 0.1 }),
      [{ leftKey: 'L1', title: '第2期纯享下集' }], [{ name: '第2期完全不同的描述下集.mkv' }])
    expect(r.assignments.get('L1')).toMatchObject({ status: 'auto' })
  })

  it('duration：唯一候选免检阈值，但要过名字地板 0.3', () => {
    const spec = one({ by: 'duration', toleranceS: 1, titleStrip: [], threshold: 0.9, margin: 0.15 })
    const over = matchByEvidenceResult(spec, [{ leftKey: 'L1', title: '现代版枪下留人', durationS: 100 }], [{ name: '现代版木仓下留人.mp3', durationS: 100 }])
    expect(over.assignments.get('L1')).toMatchObject({ status: 'auto' }) // 沾边 → 免检放行
    const under = matchByEvidenceResult(spec, [{ leftKey: 'L1', title: '甲乙丙丁戊己庚', durationS: 100 }], [{ name: '完全不沾的名字.mp3', durationS: 100 }])
    expect(under.assignments.has('L1')).toBe(false) // 地板不过 → 无信号
  })

  it('epnum / title：不免检，唯一候选照样要过阈值', () => {
    const ep = matchByEvidenceResult(one({ by: 'epnum', epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: [], threshold: 0.9, margin: 0.15 }),
      [{ leftKey: 'L1', title: '01.甲乙丙丁戊' }], [{ name: '01.完全不同的描述.mp3' }])
    expect(ep.assignments.has('L1')).toBe(false)
    const ti = matchByEvidenceResult(one({ by: 'title', titleStrip: [], threshold: 0.9, margin: 0.15 }),
      [{ leftKey: 'L1', title: '甲乙丙丁戊' }], [{ name: '完全不同的描述.mp3' }])
    expect(ti.assignments.has('L1')).toBe(false)
  })

  it('状态口径：免檢档给 auto；非免检档按相似度，够不到 AUTO_SIM 就是 pending', () => {
    const r = matchByEvidenceResult(one({ by: 'epnum', epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: [], threshold: 0.6, margin: 0.15 }),
      [{ leftKey: 'L1', title: '01.身边那些灵异事' }], [{ name: '01.怡乐播客-身边那些灵异事.mp3' }])
    expect(r.assignments.get('L1')).toMatchObject({ status: 'pending' })
  })
})

/**
 * 歧义是**一等输出**，不是一个计数。
 *
 * `ambiguous`（有像样候选但没敢配）过去只活到 `coverage.left.ambiguous` 那个数字为止：哪几集、
 * 当时在场的是哪些候选、差在阈值还是 margin——全丢了。下游拿不到证据，只能自己重算一遍，
 * **归档器那两个自建认领入口就是这么长出来的**（活体怡乐 3 条 `sole-candidate:`）。
 * 交出去之后，"判不出"从"拒绝理由"变成"路由信号"：谁来裁是另一回事，但证据必须跟着走。
 */
describe('歧义一等输出：把匹配器已经算出来的证据交出去', () => {
  it('阈值不过 → 一条 ambiguity，带候选与分数、差在哪一道门槛', () => {
    const spec: MatchSpec = { version: 2, stages: [{ by: 'epnum', epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: [], threshold: 0.9, margin: 0.15 }] }
    const r = matchByEvidenceResult(spec, [{ leftKey: 'L1', title: '01.甲乙丙丁戊' }], [{ name: '01.完全不同的描述.mp3' }])
    expect(r.ambiguous).toHaveLength(1)
    expect(r.ambiguous[0]).toMatchObject({ leftKey: 'L1', stage: 'epnum', reason: 'below-threshold', threshold: 0.9 })
    expect(r.ambiguous[0].candidates.map((c) => c.name)).toEqual(['01.完全不同的描述.mp3'])
    expect(r.ambiguous[0].candidates[0].sim).toBeLessThan(0.9)
  })

  it('两个都挺像、拉不开差距 → reason 是 no-margin，候选按分数降序全带上', () => {
    const spec: MatchSpec = { version: 2, stages: [{ by: 'epnum', epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: [], threshold: 0.3, margin: 0.5 }] }
    const r = matchByEvidenceResult(spec, [{ leftKey: 'L1', title: '01.甲乙丙丁' }], [{ name: '01.甲乙丙丁纯享.mp3' }, { name: '01.甲乙丙丁重制.mp3' }])
    expect(r.ambiguous[0]).toMatchObject({ leftKey: 'L1', reason: 'no-margin' })
    expect(r.ambiguous[0].candidates).toHaveLength(2)
    expect(r.ambiguous[0].candidates[0].sim).toBeGreaterThanOrEqual(r.ambiguous[0].candidates[1].sim)
  })

  it('候选全被时长闸否掉 → reason 是 duration-contradiction，被否的那几份照样列出来', () => {
    const spec: MatchSpec = { version: 2, stages: [{ by: 'epnum', epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: [], threshold: 0.6, margin: 0.15 }] }
    const r = matchByEvidenceResult(spec, [{ leftKey: 'L05', title: '05.太极两仪生四象', durationS: 2164 }],
      [{ name: '05.太极两仪生四象.mp3', durationS: 5808 }])
    expect(r.ambiguous[0]).toMatchObject({ leftKey: 'L05', reason: 'duration-contradiction' })
    expect(r.ambiguous[0].candidates.map((c) => c.name)).toEqual(['05.太极两仪生四象.mp3'])
  })

  it('后续 stage 把它配上了 → 那条 ambiguity 撤掉（不能既配上又挂着问句）', () => {
    const spec: MatchSpec = { version: 2, stages: [
      { by: 'epnum', epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: [], threshold: 0.99, margin: 0.15 },
      { by: 'title', titleStrip: [], threshold: 0.3, margin: 0.15 },
    ] }
    const r = matchByEvidenceResult(spec, [{ leftKey: 'L1', title: '01.甲乙丙丁戊己' }], [{ name: '01.甲乙丙丁戊.mp3' }])
    expect(r.assignments.has('L1')).toBe(true)
    expect(r.ambiguous).toEqual([])
  })

  it('覆盖率口径一字不变：ambiguous 的条数还是老那个数', () => {
    const spec: MatchSpec = { version: 2, stages: [{ by: 'epnum', epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: [], threshold: 0.9, margin: 0.15 }] }
    const r = matchByEvidenceResult(spec, [{ leftKey: 'L1', title: '01.甲乙丙丁戊' }], [{ name: '01.完全不同的描述.mp3' }])
    expect(r.coverage.left).toMatchObject({ total: 1, matched: 0, ambiguous: 1, missing: 0 })
  })
})

/**
 * 右侧是网盘的**绝对路径**（`plan.ts` 明确这么传：来源和库内常有同名文件），所以比较前要砍到
 * basename、去扩展名。左侧是**节目单里的集标题**，不是路径——同一套砍法套上去，标题里一个普通的
 * `/` 或一个像扩展名的结尾就会把它拦腰截断，而且**不报错、只是相似度变低**，一路表现为"名字一个
 * 字都不沾"的假歧义。
 */
describe('清洗口径分左右：集标题不是文件路径', () => {
  it('标题里的 "/" 不再把它砍成最后一段（活体：春典「男朋友/女朋友（6）」sim 0.244 → 0.959）', () => {
    const title = '我婚礼被迫取消，只因和前男友独处10分钟丨你有多讨厌你的男朋友/女朋友（6）'
    const file = '/quark/From Stream/春典JARGON/付费/我婚礼被迫取消，只因和前男友独处10分钟丨你有多讨厌你的男朋友女朋友（6）.mp3'
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC, [{ leftKey: 'L', title, durationS: 3806 }], [{ name: file, durationS: 3806 }])
    expect(r.ambiguous).toEqual([])
    expect(r.assignments.get('L')).toMatchObject({ rightFile: file, status: 'auto' })
  })

  it('标题结尾像扩展名（真实存量：`putt.day`）不再被当成扩展名剥掉', () => {
    // 剥掉 `.day` 只剩 `putt`，与文件名相似度掉到 0.6、够不着 title 档的 0.85 → 配不上。
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC, [{ leftKey: 'L', title: 'putt.day' }], [{ name: 'putt.day.mp3' }])
    expect(r.assignments.get('L')).toMatchObject({ rightFile: 'putt.day.mp3' })
  })

  it('键正则照旧在剥完路径/扩展名之后才跑（`^集号` 够得着、`集号$` 也够得着）', () => {
    const epnum = matchByEvidenceResult(
      { version: 2, stages: [{ by: 'epnum', epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: [], threshold: 0.6, margin: 0.15 }] },
      [L('a', '020.再谈身边灵异事')], [R('/quark/From Stream/怡楽播客/付费/020.再谈身边灵异事.mp3')])
    expect(epnum.assignments.get('a')?.rightFile).toBe('/quark/From Stream/怡楽播客/付费/020.再谈身边灵异事.mp3')

    const se = matchByEvidenceResult(
      { version: 2, stages: [{ by: 'season-episode', fileRegex: '(\\d{1,3})$', titleStrip: [], threshold: 0, margin: 0.15 }] },
      [L('tmdb:1429:S01E01', '致两千年后的你')], [R('进击的巨人 S01/进击的巨人01.mp4')])
    expect(se.assignments.get('tmdb:1429:S01E01')?.rightFile).toBe('进击的巨人 S01/进击的巨人01.mp4')
  })

  it('右侧照旧剥路径与扩展名——这一半不许跟着变', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC, [{ leftKey: 'L', title: '020.再谈身边灵异事' }],
      [{ name: '/quark/From Stream/怡楽播客/付费/020.再谈身边灵异事.mp3' }])
    expect(r.assignments.get('L')).toMatchObject({ status: 'auto' })
  })
})

/**
 * `canonName` 是覆盖率与孤儿清单的去重键。它剥前导集号，本意是让 `01.X` 和 `1.X`（同一集、
 * 补零不同）折成一份——但对**只剩集号**的文件名，集号就是全部的区分信息，剥掉它等于把
 * 一整个文件夹折成一份。
 *
 * 活体（星卡梦少女 S04，2026-09-02）：`01 4K.mp4` … `30 4K.mkv` 三十个文件全部折成 `4k`。
 * 后果有两层，第二层才是要命的：覆盖率把 122 个用上的文件报成 93；而 `orphanFiles` 每组
 * 只留一个代表，于是**残差视图里 S04 的 30 个孤儿只露出 1 个**——读它的人（当时是对话里的
 * 模型）据此断定"网盘上 S04 只有一个文件"，而 30 个都在盘上。改规则的整个循环都读这份残差，
 * 它少报一个文件夹，循环就是瞎的，且没有任何一处会喊。
 *
 * 修法不是不去重，是**归一化而不是删除**：集号折成数值留在键里，补零差异照旧折叠。
 */
describe('canonName：集号归一化，不是删掉', () => {
  it('只剩集号的文件名不再互相折叠（S04 那三十个）', () => {
    const names = Array.from({ length: 30 }, (_, i) => `S04（花神的试炼）/${String(i + 1).padStart(2, '0')} 4K.mkv`)
    expect(new Set(names.map(canonName)).size).toBe(30)
  })

  it('补零差异照旧折成一份（去重的本意）', () => {
    expect(canonName('01.再谈身边灵异事.mp3')).toBe(canonName('1.再谈身边灵异事.mp3'))
    expect(canonName('020.身边那些灵异事.mp3')).toBe(canonName('20.身边那些灵异事.mp3'))
  })

  it('同一集的两种写法（裸号 / 第N集）也折成一份', () => {
    expect(canonName('30.阴暗的另一面.mp4')).toBe(canonName('第30集 阴暗的另一面.mp4'))
  })

  it('水印副本照旧折成一份——这条是去重存在的理由，不许跟着变', () => {
    expect(canonName('02.风水鱼要在棺材里.mp3')).toBe(canonName('02.风水鱼要在棺材里【耗时整理‖cunlove.cn】.mp3'))
  })
})

/**
 * 「第N集 标题.mp4」—— 国内剧集网盘最常见的命名之一，默认谱曾经**整份 0 匹配**（活体
 * 星卡梦少女 2026-09-02：165 个文件配上 0 个）。两处够不着：集号档的默认正则要求数字打头，
 * 而「第」不是数字；标题档的比较形不剥这个前缀、也不归一化中文标点，0.85 的阈值够不到。
 *
 * 修在**比较形**（`tidy`）和默认集号正则里，**不动 `DEFAULT_TITLE_STRIP`** —— 归档器的豁免
 * key 由 titleStrip 决定（`identityRulesFromSpec`），往那里加一条会把存量豁免整片漂掉。
 */
describe('「第N集 标题」命名（默认谱开箱即用）', () => {
  it('第N集 前缀不再挡住集号档', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('tmdb:241453:S01E01', '花语笔记')],
      [R('第1集 花语笔记.mp4')])
    expect(r.assignments.get('tmdb:241453:S01E01')).toMatchObject({ rightFile: '第1集 花语笔记.mp4', status: 'auto' })
  })

  it('中文标点两侧一起归一化（「，！？（）」不再压低相似度）', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('tmdb:241453:S02E14', '桃子小芸，友情危机！（上）')],
      [R('第14集 桃子小芸 友情危机 上.mp4')])
    expect(r.assignments.get('tmdb:241453:S02E14')).toMatchObject({ rightFile: '第14集 桃子小芸 友情危机 上.mp4' })
  })

  it('集号一致但标题实打实不同，照旧不配（放宽的是清洗，不是判据）', () => {
    const r = matchByEvidenceResult(DEFAULT_MATCH_SPEC,
      [L('a', '六月新闻大盘点')],
      [R('第14集 辛金.mp4')])
    expect(r.assignments.has('a')).toBe(false)
  })
})
