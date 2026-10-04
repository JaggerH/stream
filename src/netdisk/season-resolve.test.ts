import { describe, it, expect, vi } from 'vitest'
import {
  fingerprintsFromLeft, groupByLeafFolder, structuralSeasonMatch, nestedCleanNameSeason, resolveFolderSeasons,
  matchBySeason, matchBySeasonResolved, airDateSeason,
} from './season-resolve.ts'
import type { LeftEntry } from './sync.ts'
import type { InvokeLlm } from './match-generate.ts'
import type { MatchSpec } from './types.ts'
import { DEFAULT_MATCH_SPEC } from './match-spec.ts'

describe('fingerprintsFromLeft', () => {
  it('groups a flat multi-season LeftEntry list into per-season episode counts', () => {
    const left: LeftEntry[] = [
      { leftKey: 'tmdb:261391:S01E01', title: 'a' }, { leftKey: 'tmdb:261391:S01E02', title: 'b' },
      { leftKey: 'tmdb:261391:S02E01', title: 'c' }, { leftKey: 'tmdb:261391:S02E02', title: 'd' }, { leftKey: 'tmdb:261391:S02E03', title: 'e' },
    ]
    expect(fingerprintsFromLeft(left)).toEqual([{ season: 1, episodeCount: 2 }, { season: 2, episodeCount: 3 }])
  })

  it('ignores non-episode leftKeys (movies, podcasts)', () => {
    expect(fingerprintsFromLeft([{ leftKey: 'tmdb:1', title: 'movie' }, { leftKey: 'lizhi:1', title: 'podcast ep' }])).toEqual([])
  })

  it('carries each season\'s air-date span (min/max of airDate) when the entries have one', () => {
    const left: LeftEntry[] = [
      { leftKey: 'tmdb:261391:S02E01', title: 'a', airDate: '2025-07-11' }, { leftKey: 'tmdb:261391:S02E02', title: 'b', airDate: '2025-09-13' },
      { leftKey: 'tmdb:261391:S03E01', title: 'c', airDate: '2026-07-03' }, { leftKey: 'tmdb:261391:S03E02', title: 'd' }, { leftKey: 'tmdb:261391:S03E03', title: 'e', airDate: '2026-09-05' },
    ]
    expect(fingerprintsFromLeft(left)).toEqual([
      { season: 2, episodeCount: 2, airFrom: '2025-07-11', airTo: '2025-09-13' },
      { season: 3, episodeCount: 3, airFrom: '2026-07-03', airTo: '2026-09-05' },
    ])
  })
})

// 活体（喜剧之王单口季，2026-09-03 fr_3f4d6a81）：追更转存进来的目录叫「X喜剧之DKJ」，无季号、13 个文件对不上
// 任何一季的集数、目录里没有子目录也没有杂项文件——LLM 兜底拿到的上下文是空的，答 null 并被永久缓存，
// 第 7–9 期整批卡成 season-unresolved。而每个文件名都带着 2026.08.xx 的日期，TMDb 第 3 季播出区间
// 2026-07-03..2026-09-05 就在手里。日期是比目录名硬得多的季证据。
describe('airDateSeason', () => {
  const fp = [
    { season: 1, episodeCount: 20, airFrom: '2024-08-16', airTo: '2024-10-20' },
    { season: 2, episodeCount: 40, airFrom: '2025-07-11', airTo: '2025-09-13' },
    { season: 3, episodeCount: 41, airFrom: '2026-07-03', airTo: '2026-09-05' },
  ]
  const dkj = ['2026.08.07-第6期(一) .mp4', '20260814.第7期(一).mp4', '2026.08.15-第7期(三).mp4', '20260821.第8期(二).mp4', '2026.08.28-第9期(一).mp4', '20260829.第9期(四).mp4']
    .map((n) => ({ name: `X喜剧之DKJ/${n}` }))

  it('reads YYYY.MM.DD / YYYYMMDD / YYYY-MM-DD dates out of the file names and picks the season whose air span holds them', () => {
    expect(airDateSeason(dkj, fp)).toBe(3)
  })

  it('tolerates netdisk uploads a few days after the finale (dates trail airTo by up to 14 days)', () => {
    expect(airDateSeason([{ name: 'x/2025.09.20-第10期（四）.mp4' }, { name: 'x/2025.09.14-第10期（三）.mp4' }], fp)).toBe(2)
  })

  it('declines when the dated files straddle two seasons', () => {
    expect(airDateSeason([{ name: 'x/2025.08.01-a.mp4' }, { name: 'x/2026.08.01-b.mp4' }], fp)).toBeNull()
  })

  it('declines when fewer than half of the episode-like files carry a date, or no fingerprint has an air span', () => {
    expect(airDateSeason([{ name: 'x/2026.08.01-a.mp4' }, { name: 'x/ep2.mp4' }, { name: 'x/ep3.mp4' }], fp)).toBeNull()
    expect(airDateSeason(dkj, [{ season: 3, episodeCount: 41 }])).toBeNull()
  })

  it('ignores 8-digit numbers that are not calendar dates (e.g. 1080p60 resolutions, 20260000)', () => {
    expect(airDateSeason([{ name: 'x/20261399.mp4' }, { name: 'x/ep.1080p.60fps.mp4' }], fp)).toBeNull()
  })
})

describe('groupByLeafFolder', () => {
  it('groups right files by their immediate parent directory; loose root files group under \'\'', () => {
    const groups = groupByLeafFolder([
      { name: '第一季/ep1.mp4' }, { name: '第一季/ep2.mp4' }, { name: '第二季/ep1.mp4' }, { name: 'loose.mp4' },
    ])
    expect(groups.map((g) => g.folder).sort()).toEqual(['', '第一季', '第二季'])
    expect(groups.find((g) => g.folder === '第一季')?.files).toHaveLength(2)
  })

  // 真实案例(脱口秀和Ta的朋友们,2026-07-20)：顶层文件夹底下混了两个互不相干的转存来源——
  // "S02.2025.../" 和 "Stand-up.Comedy.S01.2024...-BestWEB/"，各自的季号完全不同。按顶层文件夹
  // 分组会把两拨内容焊死成一个组、只能认一个季号(先扫到哪个文件就用哪个的季号信号),这是真实
  // 发生过的 bug 根因；必须分到各自独立的组，才能各自正确判季。
  it('keeps sibling subfolders under the same top-level folder as SEPARATE groups (each their own source)', () => {
    const groups = groupByLeafFolder([
      { name: '顶层/S02.2025.WEB-DL/ep1.mkv' }, { name: '顶层/S02.2025.WEB-DL/ep2.mkv' },
      { name: '顶层/Stand-up.Comedy.S01.2024-BestWEB/ep1.mkv' },
    ])
    expect(groups.map((g) => g.folder).sort()).toEqual([
      '顶层/S02.2025.WEB-DL', '顶层/Stand-up.Comedy.S01.2024-BestWEB',
    ])
    expect(groups.find((g) => g.folder === '顶层/S02.2025.WEB-DL')?.files).toHaveLength(2)
  })

  it('loose files directly in a top-level folder (no subfolder) group under that folder itself', () => {
    const groups = groupByLeafFolder([{ name: '顶层/ep1.mkv' }, { name: '顶层/子目录/ep2.mkv' }])
    expect(groups.map((g) => g.folder).sort()).toEqual(['顶层', '顶层/子目录'])
  })
})

describe('structuralSeasonMatch', () => {
  const fingerprints = [{ season: 1, episodeCount: 8 }, { season: 2, episodeCount: 12 }]

  it('resolves a folder to the season whose episode-like file count uniquely matches', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ name: `餙涺徔迋蕇☉季/ep${i + 1}.mp4` }))
    expect(structuralSeasonMatch(files, fingerprints)).toBe(2)
  })

  it('declines when the count matches no season', () => {
    expect(structuralSeasonMatch(Array.from({ length: 5 }, (_, i) => ({ name: `ep${i + 1}.mp4` })), fingerprints)).toBeNull()
  })

  it('declines when the count ties across seasons (ambiguous)', () => {
    const tied = [{ season: 1, episodeCount: 8 }, { season: 2, episodeCount: 8 }]
    expect(structuralSeasonMatch(Array.from({ length: 8 }, (_, i) => ({ name: `ep${i + 1}.mp4` })), tied)).toBeNull()
  })
})

describe('nestedCleanNameSeason', () => {
  const fingerprints = [{ season: 1, episodeCount: 8 }, { season: 2, episodeCount: 12 }, { season: 3, episodeCount: 10 }]

  it('finds a clean 第N季 pattern nested under an obfuscated top folder', () => {
    expect(nestedCleanNameSeason([{ name: 'S1+S2/脱口秀和Ta的朋友们 第二季.zip' }], fingerprints)).toBe(2)
  })

  it('finds a clean SxxExx pattern nested under an obfuscated top folder', () => {
    expect(nestedCleanNameSeason([{ name: '王.中.王/S03 纯享/ep1.mp4' }], fingerprints)).toBe(3)
  })

  it('ignores a season number not present in the candidate fingerprints', () => {
    expect(nestedCleanNameSeason([{ name: '花絮/第9季特别篇.mp4' }], fingerprints)).toBeNull()
  })

  it('declines when nothing clean is found', () => {
    expect(nestedCleanNameSeason([{ name: '餙涺徔迋蕇☉季/ep1.mp4' }], fingerprints)).toBeNull()
  })

  it('trusts a nested Sxx over an outer 第N季 when they disagree — the nested dir is a deliberate exception', () => {
    // 真实回归（喜剧之王单口季,2026-07-21):顶层文件夹写着"第二季",但底下嵌套了一个"S1"子目录,
    // 是这个来源特意"反向收录"进来的第一季内容——这不是顶层被混淆,是内层在明确标注一个例外
    // 子集。上一版按"顶层→文件名"顺序扫、撞见外层"第二季"就抢答返回,把这 32 个文件全错判成
    // 第二季;真实同步验证过这个误判(S01 从该有的应配数掉到 11/20)。改成"文件名→顶层"由近及远
    // 扫,内层更具体的标注应该赢。
    expect(nestedCleanNameSeason([{ name: '某某单口季 第二季(2025)/S1/ep1.mp4' }], fingerprints)).toBe(1)
  })

  it('still falls back to an outer 第N季 when nothing clean sits deeper in the path', () => {
    expect(nestedCleanNameSeason([{ name: '某某单口季 第二季(2025)/20250802 第4期.mp4' }], fingerprints)).toBe(2)
  })

  it('does not trust a bare Sxx match when the same segment mentions multiple seasons (e.g. "S1+S2")', () => {
    // "S1+S2" 本身就是"反向收录了前一季"的信号，不是单一季度指向——不该抢答成第1季，
    // 该跳过继续找,最终在压缩包文件名里找到干净的"第二季"。
    expect(nestedCleanNameSeason([{ name: 'S1+S2/脱口秀和Ta的朋友们 第二季.zip' }], fingerprints)).toBe(2)
  })

  it('declines a segment whose only signal is an internally-ambiguous multi-season mention, with nothing clean elsewhere', () => {
    expect(nestedCleanNameSeason([{ name: 'S1+S2/纯乱码没有干净信号.mp4' }], fingerprints)).toBeNull()
  })
})

describe('resolveFolderSeasons', () => {
  const fingerprints = [{ season: 1, episodeCount: 8 }, { season: 2, episodeCount: 12 }]

  it('resolves via structural fingerprint without calling the LLM', async () => {
    const invokeLlm = vi.fn<InvokeLlm>()
    const groups = [{ folder: '乱码季二', files: Array.from({ length: 12 }, (_, i) => ({ name: `乱码季二/ep${i + 1}.mp4` })) }]
    const out = await resolveFolderSeasons(groups, fingerprints, { invokeLlm })
    expect(out.get('乱码季二')).toBe(2)
    expect(invokeLlm).not.toHaveBeenCalled()
  })

  // 真实回归（进击的巨人，2026-07-25）：一季被拆成 part1/part2 两个子目录，part1 的文件数
  // 恰好等于另一季的真实集数——结构指纹会把它误判去那一季；folder 名里字面写着的 Sxx 更硬，
  // 该赢。
  it('prefers a literal Sxx in the folder name over a structural file-count collision with another season', async () => {
    const invokeLlm = vi.fn<InvokeLlm>()
    const fp = [{ season: 2, episodeCount: 12 }, { season: 3, episodeCount: 22 }]
    const groups = [{ folder: '剧集 S03/剧集 S03 part1', files: Array.from({ length: 12 }, (_, i) => ({ name: `剧集 S03/剧集 S03 part1/ep${i + 1}.mp4` })) }]
    const out = await resolveFolderSeasons(groups, fp, { invokeLlm })
    expect(out.get('剧集 S03/剧集 S03 part1')).toBe(3) // not 2, despite the 12-file count matching season 2
    expect(invokeLlm).not.toHaveBeenCalled()
  })

  /**
   * 活体（喜剧之王单口季，2026-09-03）：追更往「X丨戏剧指望 单口季 低二剂」（第 2 季的分享目录）转存两集后，
   * 目录里恰好 20 个视频，而第 1 季正好 20 集——结构指纹把整个目录判成第 1 季，新到的第 10 期两集
   * 一条边都没有。文件名全写着 2025 年的日期，第 1 季在 2024 年。日期必须压过"文件数凑巧相等"。
   */
  it('file dates beat a coincidental file-count match with another season', async () => {
    const invokeLlm = vi.fn<InvokeLlm>()
    const fp = [
      { season: 1, episodeCount: 20, airFrom: '2024-08-16', airTo: '2024-10-20' },
      { season: 2, episodeCount: 40, airFrom: '2025-07-11', airTo: '2025-09-13' },
    ]
    const files = Array.from({ length: 20 }, (_, i) => ({ name: `低二剂/2025.0${i < 9 ? 7 : 8}.${String((i % 9) + 10)}-第${i + 1}期（一）.mp4` }))
    const out = await resolveFolderSeasons([{ folder: '低二剂', files }], fp, { invokeLlm, llmSeasonCache: new Map([['低二剂', 2]]) })
    expect(out.get('低二剂')).toBe(2)
    expect(invokeLlm).not.toHaveBeenCalled()
  })

  it('resolves an obfuscated, count-mismatched folder from the file dates — before the LLM and over a stale cached null', async () => {
    const invokeLlm = vi.fn<InvokeLlm>()
    const fp = [{ season: 2, episodeCount: 40, airFrom: '2025-07-11', airTo: '2025-09-13' }, { season: 3, episodeCount: 41, airFrom: '2026-07-03', airTo: '2026-09-05' }]
    const files = ['2026.08.07-第6期(一) .mp4', '20260814.第7期(一).mp4', '2026.08.15-第7期(三).mp4'].map((n) => ({ name: `X喜剧之DKJ/${n}` }))
    const llmSeasonCache = new Map<string, number | null>([['X喜剧之DKJ', null]]) // 上一轮 LLM 空手而归留下的坑
    const out = await resolveFolderSeasons([{ folder: 'X喜剧之DKJ', files }], fp, { invokeLlm, llmSeasonCache })
    expect(out.get('X喜剧之DKJ')).toBe(3)
    expect(invokeLlm).not.toHaveBeenCalled()
  })

  it('falls back to the LLM when structural and nested-name signals are inconclusive', async () => {
    const invokeLlm: InvokeLlm = vi.fn(async () => JSON.stringify({ 低二剂: 1 }))
    const groups = [{ folder: '低二剂', files: [{ name: '低二剂/ep1.mp4' }, { name: '低二剂/ep2.mp4' }] }] // 2 集，两季都不是 2
    const out = await resolveFolderSeasons(groups, fingerprints, { invokeLlm })
    expect(invokeLlm).toHaveBeenCalled()
    expect(out.get('低二剂')).toBe(1)
  })

  it('gives the LLM the folder tree + non-episode files, not the episode video filenames', async () => {
    const invokeLlm: InvokeLlm = vi.fn(async () => JSON.stringify({ 乱码顶层名字: 2 }))
    // 顶层名、嵌套子目录名、压缩包名全是纯乱码——结构指纹/嵌套干净名都判不出,真落到 LLM 兜底,
    // 才用得上"给 LLM 目录树+杂项文件名"这个新载荷(这份 fixture 特意不含任何干净信号,免得像
    // 上一版那样被 nestedCleanNameSeason 自己先解出来,根本没走到 LLM 这层)。
    const groups = [{
      folder: '乱码顶层名字',
      files: [
        { name: '乱码顶层名字/乱码子目录/备注文件.txt' },
        { name: '乱码顶层名字/乱码子目录/ep1.mp4' },
        { name: '乱码顶层名字/乱码子目录/ep2.mp4' },
      ],
    }]
    const fp = [{ season: 1, episodeCount: 8 }, { season: 2, episodeCount: 12 }] // 2 集不唯一命中任何一季
    await resolveFolderSeasons(groups, fp, { invokeLlm })
    expect(invokeLlm).toHaveBeenCalled() // 先确认真落到了 LLM 这层,不是巧合通过
    const sent = JSON.parse((invokeLlm as ReturnType<typeof vi.fn>).mock.calls[0][0].messages[1].content)
    expect(sent.folders).toEqual([{ folderName: '乱码顶层名字', tree: ['乱码子目录'], extraFiles: ['乱码子目录/备注文件.txt'] }])
    // 两个 .mp4 一集视频文件名一个都不该出现在喂给模型的载荷里——季度判断用不上，纯粹是浪费 token。
    expect(JSON.stringify(sent.folders)).not.toContain('.mp4')
  })

  it('resolves to null when even the LLM cannot tell', async () => {
    const invokeLlm: InvokeLlm = vi.fn(async () => JSON.stringify({ 完全乱码: 'unknown' }))
    const out = await resolveFolderSeasons([{ folder: '完全乱码', files: [{ name: '完全乱码/ep1.mp4' }] }], fingerprints, { invokeLlm })
    expect(out.get('完全乱码')).toBeNull()
  })

  it('skips the LLM call for the root (\'\') group — nothing meaningful to guess from an empty name', async () => {
    const invokeLlm = vi.fn<InvokeLlm>()
    const out = await resolveFolderSeasons([{ folder: '', files: [{ name: 'loose.mp4' }] }], fingerprints, { invokeLlm })
    expect(out.get('')).toBeNull()
    expect(invokeLlm).not.toHaveBeenCalled()
  })

  it('batches every LLM-dependent folder into ONE call, not one call per folder', async () => {
    const invokeLlm: InvokeLlm = vi.fn(async () => JSON.stringify({ 乱码甲: 1, 乱码乙: 2 }))
    const groups = [
      { folder: '乱码甲', files: [{ name: '乱码甲/ep1.mp4' }, { name: '乱码甲/ep2.mp4' }] }, // 2 集,两季都不是 2
      { folder: '乱码乙', files: [{ name: '乱码乙/ep1.mp4' }, { name: '乱码乙/ep2.mp4' }, { name: '乱码乙/ep3.mp4' }] }, // 3 集,也不是
    ]
    const out = await resolveFolderSeasons(groups, fingerprints, { invokeLlm })
    expect(invokeLlm).toHaveBeenCalledTimes(1)
    expect(out.get('乱码甲')).toBe(1)
    expect(out.get('乱码乙')).toBe(2)
  })

  it('passes seasons already resolved by structural/nested-name as takenSeasons for the LLM batch to use as an elimination hint', async () => {
    const invokeLlm: InvokeLlm = vi.fn(async () => JSON.stringify({ 乱码文件夹: 1 }))
    const fp = [{ season: 1, episodeCount: 5 }, { season: 2, episodeCount: 12 }, { season: 3, episodeCount: 9 }]
    const groups = [
      { folder: '干净季二', files: Array.from({ length: 12 }, (_, i) => ({ name: `干净季二/ep${i + 1}.mp4` })) }, // 结构指纹判 2
      { folder: '第三季清楚', files: [{ name: '第三季清楚/ep1.mp4' }] }, // 嵌套干净名判 3
      { folder: '乱码文件夹', files: [{ name: '乱码文件夹/ep1.mp4' }, { name: '乱码文件夹/ep2.mp4' }] }, // 落到 LLM
    ]
    const out = await resolveFolderSeasons(groups, fp, { invokeLlm })
    expect(out.get('干净季二')).toBe(2)
    expect(out.get('第三季清楚')).toBe(3)
    expect(out.get('乱码文件夹')).toBe(1)
    const sent = JSON.parse((invokeLlm as ReturnType<typeof vi.fn>).mock.calls[0][0].messages[1].content)
    expect(sent.takenSeasons.sort()).toEqual([2, 3]) // 已经被结构指纹/嵌套干净名占用的季号,不含还没判的那个
    expect(sent.folders.map((f: { folderName: string }) => f.folderName)).toEqual(['乱码文件夹']) // 已判定的两个不进批量请求
  })

  it('reuses a cached LLM answer for a folder instead of asking the model again', async () => {
    const invokeLlm = vi.fn<InvokeLlm>()
    const cache = new Map<string, number | null>([['低二剂', 1]])
    const groups = [{ folder: '低二剂', files: [{ name: '低二剂/ep1.mp4' }, { name: '低二剂/ep2.mp4' }] }]
    const out = await resolveFolderSeasons(groups, fingerprints, { invokeLlm, llmSeasonCache: cache })
    expect(out.get('低二剂')).toBe(1)
    expect(invokeLlm).not.toHaveBeenCalled()
  })

  it('reuses a cached "could not resolve" answer (null) without re-asking', async () => {
    const invokeLlm = vi.fn<InvokeLlm>()
    const cache = new Map<string, number | null>([['低二剂', null]])
    const groups = [{ folder: '低二剂', files: [{ name: '低二剂/ep1.mp4' }, { name: '低二剂/ep2.mp4' }] }]
    const out = await resolveFolderSeasons(groups, fingerprints, { invokeLlm, llmSeasonCache: cache })
    expect(out.get('低二剂')).toBeNull()
    expect(invokeLlm).not.toHaveBeenCalled()
  })

  it('writes a fresh LLM answer into the cache for next time', async () => {
    const invokeLlm: InvokeLlm = vi.fn(async () => JSON.stringify({ 低二剂: 1 }))
    const cache = new Map<string, number | null>()
    const groups = [{ folder: '低二剂', files: [{ name: '低二剂/ep1.mp4' }, { name: '低二剂/ep2.mp4' }] }]
    await resolveFolderSeasons(groups, fingerprints, { invokeLlm, llmSeasonCache: cache })
    expect(cache.get('低二剂')).toBe(1)
  })

  it('a folder still resolved by structural fingerprint does not touch the cache at all', async () => {
    const invokeLlm = vi.fn<InvokeLlm>()
    const cache = new Map<string, number | null>()
    const groups = [{ folder: '乱码季二', files: Array.from({ length: 12 }, (_, i) => ({ name: `乱码季二/ep${i + 1}.mp4` })) }]
    await resolveFolderSeasons(groups, fingerprints, { invokeLlm, llmSeasonCache: cache })
    expect(cache.size).toBe(0) // 结构指纹/嵌套干净名廉价,每次都重新算,不进缓存
  })
})

describe('matchBySeason', () => {
  it('partitions by resolved season so two seasons sharing the same 期号 pattern do not collide', async () => {
    const left = [
      { leftKey: 'tmdb:1:S01E01', title: '第1期上' }, { leftKey: 'tmdb:1:S01E02', title: '第1期下' },
      { leftKey: 'tmdb:1:S02E01', title: '第1期上' }, { leftKey: 'tmdb:1:S02E02', title: '第1期下' },
    ]
    // 集数并列(两季都是 2)——结构指纹判不出,靠嵌套干净名区分。
    const right = [
      { name: '乱码季一/第1季/第1期上.mp4' }, { name: '乱码季一/第1季/第1期下.mp4' },
      { name: '乱码季二/第2季/第1期上.mp4' }, { name: '乱码季二/第2季/第1期下.mp4' },
    ]
    const fingerprints = fingerprintsFromLeft(left)
    const spec: MatchSpec = { version: 2, stages: [
      { by: 'episode-part', keyRegex: '第0*(\\d{1,3})期.*?(上|下)', titleStrip: [], threshold: 0, margin: 0.15 },
    ] }
    const invokeLlm = vi.fn<InvokeLlm>()
    const r = await matchBySeason(spec, left, right, fingerprints, { invokeLlm })
    expect(r.assignments.get('tmdb:1:S01E01')?.rightFile).toBe('乱码季一/第1季/第1期上.mp4')
    expect(r.assignments.get('tmdb:1:S02E01')?.rightFile).toBe('乱码季二/第2季/第1期上.mp4')
    expect(r.coverage.left).toMatchObject({ matched: 4, ambiguous: 0, missing: 0 })
    expect(invokeLlm).not.toHaveBeenCalled() // 嵌套干净名够用，不该白问模型
  })

  it('groups two top-level folders that resolve to the SAME season into one match run, so a weak isolated match cannot steal an episode that belongs to the other folder', async () => {
    const left = [
      { leftKey: 'tmdb:9:S01E01', title: '第一集彩蛋片段' },
      { leftKey: 'tmdb:9:S01E02', title: '第二集彩蛋片段' },
    ]
    // 两个顶层文件夹都靠嵌套 'S01' 解到同一季，各自只装一集不同的集数——旧的按文件夹跑
    // 会把完整 seasonLeft 喂给每个文件夹各自孤立地跑一遍，folder 之间互相看不见对方的候选。
    // title stage 只差"一"/"二"一字（Dice 系数 ≈0.667）在候选池只有 1 个文件时会绕开
    // margin 门槛（候选唯一时门槛判定直接短路），把 E01 错配给本属于 E02 的文件——手推见 task-8 报告。
    const right = [
      { name: '4K/S01/第一集彩蛋片段.mp4' },
      { name: '1080p/S01/第二集彩蛋片段.mp4' },
    ]
    const fingerprints = fingerprintsFromLeft(left)
    const spec: MatchSpec = { version: 2, stages: [{ by: 'title', titleStrip: [], threshold: 0.3, margin: 0.15 }] }
    const invokeLlm = vi.fn<InvokeLlm>()
    const r = await matchBySeason(spec, left, right, fingerprints, { invokeLlm })
    expect(r.assignments.get('tmdb:9:S01E01')?.rightFile).toBe('4K/S01/第一集彩蛋片段.mp4')
    expect(r.assignments.get('tmdb:9:S01E02')?.rightFile).toBe('1080p/S01/第二集彩蛋片段.mp4')
    expect(r.coverage.left).toMatchObject({ matched: 2, ambiguous: 0, missing: 0 })
    expect(invokeLlm).not.toHaveBeenCalled() // 嵌套干净名够用，不该白问模型
  })

  /**
   * 活体（星卡梦少女 S04，2026-09-02）：网盘按季分了文件夹，文件自己**只剩一个裸集号**
   * （`S04（花神的试炼）/23 4K.mkv`）。季分区已经把季号定死了，所以那个裸号就是完整的键——
   * 但默认谱的 `season-episode` 只认场景命名 `SxxExx`，`epnum` 又是 `trustUnique:false`
   * （桶键"集号"在没分季的池子里不算消歧证据），于是唯一候选、零竞争，还是配不上。
   *
   * 补的这一档只活在季分区里：`types.ts` 的 `MatchStage` 头注写明单捕获组 `fileRegex`
   * 「只在季已经被上游分区隔离干净时才安全」，而这里正是那个上游。
   */
  it('季分区内，文件只剩裸集号也认得出（季号已由文件夹定死，裸号就是完整的键）', async () => {
    const left = [
      { leftKey: 'tmdb:241453:S04E22', title: '林落的秘密' },
      { leftKey: 'tmdb:241453:S04E23', title: '“弱”者的逆袭' },
      { leftKey: 'tmdb:241453:S05E23', title: '别的季同号集' },
    ]
    const right = [{ name: 'S04（花神的试炼）/23 4K.mkv' }]
    const fingerprints = fingerprintsFromLeft(left)
    const invokeLlm = vi.fn<InvokeLlm>()
    const r = await matchBySeason(DEFAULT_MATCH_SPEC, left, right, fingerprints, { invokeLlm })
    expect(r.assignments.get('tmdb:241453:S04E23')?.rightFile).toBe('S04（花神的试炼）/23 4K.mkv')
    expect(r.assignments.has('tmdb:241453:S05E23')).toBe(false) // 同号但不同季，绝不能被它领走
    expect(r.coverage.right.orphan).toBe(0)
  })

  it('归不了季的文件夹里，裸集号照旧不认（那一档只在分区内成立）', async () => {
    const left = [
      { leftKey: 'tmdb:7:S01E01', title: 'a' }, { leftKey: 'tmdb:7:S01E23', title: 'b' },
      { leftKey: 'tmdb:7:S02E01', title: 'c' },
    ]
    const right = [{ name: '完全乱码不可读/23' }]
    const fingerprints = fingerprintsFromLeft(left)
    const invokeLlm: InvokeLlm = vi.fn(async () => 'unknown')
    const r = await matchBySeason(DEFAULT_MATCH_SPEC, left, right, fingerprints, { invokeLlm })
    expect(r.assignments.size).toBe(0)
    expect(r.coverage.right.orphan).toBe(1)
  })

  it('a folder whose season cannot be resolved contributes its files as orphans, not a crash', async () => {
    const left = [{ leftKey: 'tmdb:1:S01E01', title: '第1集' }]
    // 无扩展名 → episodeLikeCount=0,structuralSeasonMatch 不会因为"仅一季一集"这个退化指纹
    // 巧合命中(见 task-8 报告:原 .mp4 版本会被结构指纹意外判season1、违背本用例的本意)。
    const right = [{ name: '完全乱码不可读/第1集' }]
    const fingerprints = fingerprintsFromLeft(left)
    const spec: MatchSpec = { version: 2, stages: [{ by: 'title', titleStrip: [], threshold: 0.5, margin: 0.15 }] }
    const invokeLlm: InvokeLlm = vi.fn(async () => 'unknown')
    const r = await matchBySeason(spec, left, right, fingerprints, { invokeLlm })
    expect(r.assignments.size).toBe(0)
    expect(r.coverage.right.orphan).toBe(1)
    expect(r.coverage.left.missing).toBe(1)
  })
})

/**
 * 季归属（异步、要问 LLM）与分区匹配（同步、纯计算）被拆成两段，是为了让**归档器**也能走
 * 同一条分区路：它的季归属由服务层去要（与同步共用一份缓存），拿到答案后调的就是这一段。
 * 这里只考同步那一段——给定「文件夹 → 季」的答案，同期号的两个文件夹必须各归各季。
 */
describe('matchBySeasonResolved（季归属已知时的同步分区匹配）', () => {
  it('两个文件夹的同一个期号各自归各季，不互相抢', () => {
    const left = [
      { leftKey: 'tmdb:261471:S02E03', title: '第2期上：邱瑞谈冒犯的边界' },
      { leftKey: 'tmdb:261471:S02E04', title: '第2期下' },
      { leftKey: 'tmdb:261471:S03E04', title: '第2期上：邱瑞谈冒犯的边界' },
      { leftKey: 'tmdb:261471:S03E05', title: '第2期下' },
    ]
    const right = [
      { name: 'S02.2025/2025-06-28 第2期上：邱瑞谈冒犯的边界.mkv' },
      { name: '第三季（4K）/2026-07-03 第2期上：邱瑞谈冒犯的边界.mp4' },
    ]
    const seasonOfFolder = new Map<string, number | null>([['S02.2025', 2], ['第三季（4K）', 3]])
    const r = matchBySeasonResolved(DEFAULT_MATCH_SPEC, left, right, seasonOfFolder)
    expect(r.assignments.get('tmdb:261471:S02E03')?.rightFile).toBe('S02.2025/2025-06-28 第2期上：邱瑞谈冒犯的边界.mkv')
    expect(r.assignments.get('tmdb:261471:S03E04')?.rightFile).toBe('第三季（4K）/2026-07-03 第2期上：邱瑞谈冒犯的边界.mp4')
  })

  it('归不了季的文件夹（值为 null）整段不参与匹配，报成孤儿', () => {
    const left = [{ leftKey: 'tmdb:7:S01E01', title: '第1期' }, { leftKey: 'tmdb:7:S02E01', title: '第1期' }]
    const right = [{ name: '不知道哪一季/第1期.mkv' }]
    const r = matchBySeasonResolved(DEFAULT_MATCH_SPEC, left, right, new Map([['不知道哪一季', null]]))
    expect(r.assignments.size).toBe(0)
    expect(r.coverage.right.orphan).toBe(1)
  })

  /**
   * 活体（脱口秀 tmdb:261471 S02，2026-09-03）：这一季 TMDb 按"一期两集"编号
   * （E01=第1期上、E02=第1期下……），网盘按"期"命名（`第3期上：….mkv`、`第4期纯享版：….mkv`）。
   * `withBareEpisodeTail` 的默认正则只要求数字后不紧跟另一个数字，"第2期纯享版"照样被读成
   * 裸集号 2、唯一命中直接 `auto`，把本该配 E03（第2期上）的位置抢走。判据从这一季自己的
   * 权威标题找："第N期上/中/下"这个形状出现过，就说明期≠集，裸数字后面不能再跟"期"。
   */
  const QI_EPISODE_PART_SPEC: MatchSpec = {
    ...DEFAULT_MATCH_SPEC,
    stages: (DEFAULT_MATCH_SPEC.stages ?? []).map((s) => (
      s.by === 'episode-part' ? { ...s, keyRegex: '^第0*(\\d{1,3})期\\s*(上|中|下)' } : s
    )),
  }

  it('期≠集的季：裸期号不冒充集号——「第2期上」按 episode-part 配对，「第2期纯享版」配不上、留孤儿', () => {
    const left = [
      { leftKey: 'tmdb:261471:S02E01', title: '第1期上' },
      { leftKey: 'tmdb:261471:S02E02', title: '第1期下' },
      { leftKey: 'tmdb:261471:S02E03', title: '第2期上' },
      { leftKey: 'tmdb:261471:S02E04', title: '第2期下' },
    ]
    const right = [
      { name: 'S02/2025-06-28 第2期上：邱瑞谈冒犯的边界.mkv' },
      { name: 'S02/2025-07-05 第2期纯享版：邱瑞谈冒犯的边界.mkv' },
    ]
    const seasonOfFolder = new Map<string, number | null>([['S02', 2]])
    const r = matchBySeasonResolved(QI_EPISODE_PART_SPEC, left, right, seasonOfFolder)
    expect(r.assignments.get('tmdb:261471:S02E03')?.rightFile).toBe('S02/2025-06-28 第2期上：邱瑞谈冒犯的边界.mkv')
    // 纯享版不该被裸期号档偷走 E02（第1期下）——它压根不该配上任何一集。
    expect(r.assignments.get('tmdb:261471:S02E02')).toBeUndefined()
    expect([...r.assignments.values()].some((a) => a.rightFile.includes('纯享版'))).toBe(false)
  })

  /**
   * 活体（喜剧之王单口季 tmdb:261391 S02/S03，2026-09-03）：这两季的权威标题是「第1期（三）：…」——括号段号，
   * 不是上/中/下。守卫只认上/中/下，于是「2025-07-18 第2期（一）边疆少年…」被裸期号档读成 E02（第1期（二）），
   * 归档器把 `S02E02 - ` 刻进文件名；S02E02–E08、S03E01–E06 共 13 条同一形状。
   */
  it('期≠集的季（括号段号「第N期（一）」）：裸期号同样不冒充集号', () => {
    const left = [
      { leftKey: 'tmdb:261391:S02E01', title: '第1期（一）：48组演员车轮战突围' },
      { leftKey: 'tmdb:261391:S02E02', title: '第1期（二）：脱口秀版出走的决心看哭杨天真' },
      { leftKey: 'tmdb:261391:S02E05', title: '第2期（一）：边疆少年魔音洗脑郭麒麟' },
    ]
    const right = [{ name: 'S02/2025-07-18 第2期（一）东北双子星抢金PK.mkv' }]
    const seasonOfFolder = new Map<string, number | null>([['S02', 2]])
    const r = matchBySeasonResolved(DEFAULT_MATCH_SPEC, left, right, seasonOfFolder)
    expect(r.assignments.get('tmdb:261391:S02E02')).toBeUndefined()
  })

  it('括号段号的季：追更转存的「2025.09.13-第10期（三）.mp4」按段号键直接配上 E39', () => {
    const left = [
      { leftKey: 'tmdb:261391:S02E38', title: '第10期（二）：付航爆笑演绎' },
      { leftKey: 'tmdb:261391:S02E39', title: '第10期（三）：郭麒麟评价于祥宇摇滚明星' },
      { leftKey: 'tmdb:261391:S02E40', title: '第10期（四）：翟佳宁嘻哈冠亚之争' },
    ]
    const right = [{ name: 'S02/2025.09.13-第10期（三）.mp4' }, { name: 'S02/2025.09.13-第10期（四）.mp4' }]
    const r = matchBySeasonResolved(DEFAULT_MATCH_SPEC, left, right, new Map([['S02', 2]]))
    expect(r.assignments.get('tmdb:261391:S02E39')?.rightFile).toBe('S02/2025.09.13-第10期（三）.mp4')
    expect(r.assignments.get('tmdb:261391:S02E40')?.rightFile).toBe('S02/2025.09.13-第10期（四）.mp4')
  })

  it('期==集的季：没有「第N期上/下」这种权威标题，裸期号照旧当集号用（老行为不变）', () => {
    const left = [{ leftKey: 'tmdb:9:S01E05', title: '第5期' }]
    const right = [{ name: 'S01/第5期.mkv' }]
    const seasonOfFolder = new Map<string, number | null>([['S01', 1]])
    const r = matchBySeasonResolved(DEFAULT_MATCH_SPEC, left, right, seasonOfFolder)
    expect(r.assignments.get('tmdb:9:S01E05')?.rightFile).toBe('S01/第5期.mkv')
  })
})
