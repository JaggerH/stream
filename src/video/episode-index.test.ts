import { describe, expect, it, vi } from 'vitest'
import { tmdbEpisodeIndex } from './episode-index.ts'

const season = (n: number, eps: number) => ({
  episodes: Array.from({ length: eps }, (_, i) => ({
    season_number: n,
    episode_number: i + 1,
    name: `S${n}E${i + 1} 标题`,
    // TMDb 每集真实带的重货 —— 投影必须把它们丢掉
    overview: 'x'.repeat(400),
    still_path: '/abc.jpg',
    crew: [{ name: 'someone' }],
    guest_stars: [{ name: 'guest' }],
  })),
})

/** seasonCount 季、每季 epsPer 集的假 TMDb */
const fakeTmdb = (seasonCount: number, epsPer: number, calls: string[] = []) =>
  (async (url: URL | string) => {
    const u = String(url)
    calls.push(u.replace(/[?&]api_key=[^&]*/, ''))
    if (/\/tv\/\d+\?/.test(u) && u.includes('append_to_response')) {
      const body: Record<string, unknown> = { name: '剧', number_of_episodes: seasonCount * epsPer }
      for (const m of u.matchAll(/season%2F(\d+)|season\/(\d+)/g)) {
        const n = Number(m[1] ?? m[2])
        body[`season/${n}`] = season(n, epsPer)
      }
      return new Response(JSON.stringify(body))
    }
    if (/\/tv\/\d+/.test(u)) {
      return new Response(JSON.stringify({
        name: '剧',
        number_of_episodes: seasonCount * epsPer,
        seasons: [
          { season_number: 0, episode_count: 3 }, // 特别篇：不算集
          ...Array.from({ length: seasonCount }, (_, i) => ({ season_number: i + 1, episode_count: epsPer })),
        ],
      }))
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof globalThis.fetch

const deps = (fetch: typeof globalThis.fetch) => ({ fetch, apiKey: 'k', language: 'zh-CN' })

describe('tmdbEpisodeIndex', () => {
  it('剧集：左侧行数等于权威集数，键带季/集', async () => {
    const rows = await tmdbEpisodeIndex(deps(fakeTmdb(2, 8)), { id: '1399', media: 'tv', title: '权游' })
    expect(rows).toHaveLength(16)
    expect(rows[0]).toEqual({ leftKey: 'tmdb:1399:S01E01', title: 'S1E1 标题', still: 'https://image.tmdb.org/t/p/w300/abc.jpg' })
    expect(rows[15].leftKey).toBe('tmdb:1399:S02E08')
  })

  // 落盘的是投影，不是原始载荷：TMDb 每集带 overview/crew/guest_stars（那才是 0.8-1.8MB 的重货）。
  // 投影只留 季/集号/标题 + 一个剧照 URL（详情页 16:9 缩略图用）——重货一律丢。
  it('投影带剧照 URL，但丢掉 overview/crew/guest_stars 那 1MB 重货', async () => {
    const rows = await tmdbEpisodeIndex(deps(fakeTmdb(1, 2)), { id: '1', media: 'tv', title: 'x' })
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['leftKey', 'still', 'title'])
    expect(rows[0].still).toBe('https://image.tmdb.org/t/p/w300/abc.jpg')
    expect(JSON.stringify(rows)).not.toContain('xxxx') // overview 没进
    expect(JSON.stringify(rows)).not.toContain('someone') // crew 没进
    expect(JSON.stringify(rows)).not.toContain('guest') // guest_stars 没进
  })

  it('某集没有 still_path → 该集不带 still 字段（前端回落占位图）', async () => {
    const noStill = (async (url: URL | string) => {
      const u = String(url)
      if (u.includes('append_to_response')) return new Response(JSON.stringify({ name: '剧', 'season/1': { episodes: [{ season_number: 1, episode_number: 1, name: '无图集' }] } }))
      return new Response(JSON.stringify({ name: '剧', seasons: [{ season_number: 1, episode_count: 1 }] }))
    }) as unknown as typeof globalThis.fetch
    const rows = await tmdbEpisodeIndex(deps(noStill), { id: '1', media: 'tv', title: 'x' })
    expect(rows[0]).toEqual({ leftKey: 'tmdb:1:S01E01', title: '无图集' })
  })

  // TMDb 把「已公布但未播出」的集也列进 episodes[]（air_date 是未来日期）——投影必须带上
  // air_date，不然下游（分集树/详情页）没法区分「未播出」和「已播出未匹配」。
  it('带 air_date 的集 → 投影保留 airDate；没有 air_date → 不带该字段', async () => {
    const mixed = (async (url: URL | string) => {
      const u = String(url)
      if (u.includes('append_to_response')) {
        return new Response(JSON.stringify({
          name: '剧',
          'season/1': {
            episodes: [
              { season_number: 1, episode_number: 1, name: '已播', air_date: '2026-01-01' },
              { season_number: 1, episode_number: 2, name: '未播', air_date: '2099-01-01' },
              { season_number: 1, episode_number: 3, name: '没日期' },
            ],
          },
        }))
      }
      return new Response(JSON.stringify({ name: '剧', seasons: [{ season_number: 1, episode_count: 3 }] }))
    }) as unknown as typeof globalThis.fetch
    const rows = await tmdbEpisodeIndex(deps(mixed), { id: '1', media: 'tv', title: 'x' })
    expect(rows[0]).toEqual({ leftKey: 'tmdb:1:S01E01', title: '已播', airDate: '2026-01-01' })
    expect(rows[1]).toEqual({ leftKey: 'tmdb:1:S01E02', title: '未播', airDate: '2099-01-01' })
    expect(rows[2]).toEqual({ leftKey: 'tmdb:1:S01E03', title: '没日期' })
  })

  // append_to_response 官方上限 20 个。辛普森 38 季 —— 一发只能拿回前 20 季，静默截断会让
  // 后 18 季的集永远配不上文件，而 coverage 看着还是"全配上了"。
  it('超过 20 季分批取全，不静默截断', async () => {
    const calls: string[] = []
    const rows = await tmdbEpisodeIndex(deps(fakeTmdb(38, 10, calls)), { id: '456', media: 'tv', title: '辛普森' })
    expect(rows).toHaveLength(380)
    expect(rows.at(-1)!.leftKey).toBe('tmdb:456:S38E10')
    const appends = calls.filter((c) => c.includes('append_to_response'))
    expect(appends).toHaveLength(2) // 38 季 → 20 + 18
  })

  it('季 0（特别篇）不进左侧', async () => {
    const rows = await tmdbEpisodeIndex(deps(fakeTmdb(1, 4)), { id: '1', media: 'tv', title: 'x' })
    expect(rows.every((r) => !r.leftKey.includes('S00'))).toBe(true)
    expect(rows).toHaveLength(4)
  })

  it('电影：一行左侧，且不发任何 /tv 请求', async () => {
    const calls: string[] = []
    const f = fakeTmdb(1, 1, calls)
    const rows = await tmdbEpisodeIndex(deps(f), { id: '969681', media: 'movie', title: '蜘蛛侠' })
    expect(rows).toEqual([{ leftKey: 'tmdb:969681', title: '蜘蛛侠' }])
    expect(calls).toHaveLength(0)
  })

  it('上游报错不当成空剧集 —— 抛错,别让绑定看起来"没有集"', async () => {
    const boom = (async () => new Response('{}', { status: 500 })) as unknown as typeof globalThis.fetch
    await expect(tmdbEpisodeIndex(deps(boom), { id: '1', media: 'tv', title: 'x' })).rejects.toThrow()
  })
})
