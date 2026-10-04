import { describe, expect, it, vi } from 'vitest'
import { makeTmdbCanonicalFn } from './video-canonical.ts'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const DOUBAN = 'https://img9.doubanio.com/view/photo/m_ratio_poster/public/p2934049524.webp'

describe('TMDb canonical video resolver', () => {
  // 无 key 时没法核实，调用方的 title 可用（≠ id 回显）就照旧发布——这是唯一还允许 echo 的情形。
  it('uses an existing TMDb ID without candidate lookup (keyless, usable title)', async () => {
    const fetch = vi.fn()
    const source = makeTmdbCanonicalFn({ fetch })

    await expect(source({ title: 'Already known', year: 2024, kind: 'movie', externalIds: { tmdb: '42', imdb: 'tt42' } }, {})).resolves.toEqual([{
      source: 'tmdb-canonical', externalIds: { tmdb: '42', imdb: 'tt42' }, kind: 'movie', title: 'Already known', year: 2024, matchedBy: 'id',
    }])
    expect(fetch).not.toHaveBeenCalled()
  })

  // canonical.title 是下游命名（网盘目录/绑定左侧）的权威。id 快速路径曾直接回显 identity.title，
  // tmdb:<id> 详情路径没带 title 时它就是 id 本身——网盘目录因此叫过「55157 (1993) [tmdbid-55157]」。
  describe('id fast path verifies the official title', () => {
    it('fetches detail even when the id is already known — never republishes the caller title', async () => {
      const fetch = vi.fn(async (input: string) => {
        if (input.includes('/movie/42?')) return json({ id: 42, title: 'Kika', release_date: '1993-10-29', external_ids: { imdb_id: 'tt0107315' } })
        throw new Error(`unexpected request ${input}`)
      })
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch })

      await expect(source({ title: '42', kind: 'movie', externalIds: { tmdb: '42' } }, {})).resolves.toEqual([{
        source: 'tmdb-canonical', externalIds: { tmdb: '42', imdb: 'tt0107315' }, kind: 'movie', title: 'Kika', year: 1993, matchedBy: 'id',
      }])
    })

    it('falls back to the caller title when TMDb is unreachable and the title is not an id echo', async () => {
      const fetch = vi.fn(async () => { throw new Error('down') })
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch })

      await expect(source({ title: 'Already known', year: 2024, kind: 'movie', externalIds: { tmdb: '42' } }, {})).resolves.toEqual([{
        source: 'tmdb-canonical', externalIds: { tmdb: '42' }, kind: 'movie', title: 'Already known', year: 2024, matchedBy: 'id',
      }])
    })

    it('declines rather than resolve with the id as title when TMDb is unreachable', async () => {
      const fetch = vi.fn(async () => { throw new Error('down') })
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch })

      await expect(source({ title: '42', kind: 'movie', externalIds: { tmdb: '42' } }, {})).resolves.toEqual([])
    })

    it('declines an id-echo title when no api key can verify it', async () => {
      const source = makeTmdbCanonicalFn({ fetch: vi.fn() })

      await expect(source({ title: '42', kind: 'movie', externalIds: { tmdb: '42' } }, {})).resolves.toEqual([])
    })
  })

  describe('textual rungs', () => {
    // "女子当参政" shape: one exact-title work, year agrees. No cover should ever be fetched.
    function loneMatch() {
      return vi.fn(async (input: string) => {
        if (input.includes('/search/movie')) return json({ results: [{ id: 1638171, title: '女子当参政', release_date: '2026-05-08' }] })
        if (input.includes('/movie/1638171?')) return json({ id: 1638171, title: 'Suffs', release_date: '2026-05-08', external_ids: { imdb_id: 'tt99' } })
        throw new Error(`unexpected request ${input}`)
      })
    }

    it('accepts a lone exact-title match whose year agrees, without comparing any cover', async () => {
      const comparePosters = vi.fn()
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch: loneMatch(), comparePosters })

      await expect(source({ title: '女子当参政', year: 2026, kind: 'movie', externalIds: {}, poster: DOUBAN }, {})).resolves.toEqual([{
        source: 'tmdb-canonical', externalIds: { tmdb: '1638171', imdb: 'tt99' }, kind: 'movie', title: 'Suffs', year: 2026, matchedBy: 'title-unique',
      }])
      // the whole point of the ladder: text already singled the work out
      expect(comparePosters).not.toHaveBeenCalled()
    })

    it('tolerates the year Douban and TMDb routinely disagree on', async () => {
      const comparePosters = vi.fn()
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch: loneMatch(), comparePosters })

      // Douban dates it 2025, TMDb releases it 2026-05-08
      await expect(source({ title: '女子当参政', year: 2025, kind: 'movie', externalIds: {}, poster: DOUBAN }, {})).resolves.toMatchObject([
        { externalIds: { tmdb: '1638171' }, matchedBy: 'title-unique' },
      ])
      expect(comparePosters).not.toHaveBeenCalled()
    })

    it('never filters the search by year, which would return nothing at all', async () => {
      const fetch = loneMatch()
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch, comparePosters: vi.fn() })

      await source({ title: '女子当参政', year: 2026, kind: 'movie', externalIds: {} }, {})
      expect(String(fetch.mock.calls.find(([url]) => String(url).includes('/search/movie'))![0])).not.toContain('primary_release_year')
    })

    it('picks between same-titled works by year', async () => {
      // "痴迷" shape: three works share the exact title; only one is near the discovery year.
      const comparePosters = vi.fn()
      const fetch = vi.fn(async (input: string) => {
        if (input.includes('/search/movie')) return json({ results: [
          { id: 1339713, title: '痴迷', release_date: '2026-05-13' },
          { id: 1658209, title: '女仆的痴迷', release_date: '2026-03-27' },
          { id: 937895, title: '痴迷', release_date: '2022-07-14' },
          { id: 641706, title: '痴迷', release_date: '2019-10-26' },
        ] })
        if (input.includes('/movie/1339713?')) return json({ id: 1339713, title: 'Obsession', release_date: '2026-05-13', external_ids: { imdb_id: 'tt37287335' } })
        throw new Error(`unexpected request ${input}`)
      })
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch, comparePosters })

      await expect(source({ title: '痴迷', year: 2025, kind: 'movie', externalIds: {}, poster: DOUBAN }, {})).resolves.toMatchObject([
        { externalIds: { tmdb: '1339713', imdb: 'tt37287335' }, title: 'Obsession', matchedBy: 'title-year' },
      ])
      // 女仆的痴迷 is a fuzzy row, not an exact title — it never competes
      expect(comparePosters).not.toHaveBeenCalled()
    })

    it('rejects a fuzzy-unique row whose title is not the work being resolved', async () => {
      // Searching 痴迷 can return exactly one row that is a different film entirely.
      const fetch = vi.fn(async (input: string) => {
        if (input.includes('/search/movie')) return json({ results: [{ id: 1246037, title: '她痴迷于我的丈夫', release_date: '2024-02-15' }] })
        if (input.includes('/movie/1246037?')) return json({ id: 1246037, title: '她痴迷于我的丈夫', release_date: '2024-02-15', alternative_titles: { titles: [] } })
        if (input.includes('/movie/1246037/images')) return json({ posters: [{ file_path: '/other.jpg', iso_639_1: 'zh' }] })
        throw new Error(`unexpected request ${input}`)
      })
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch, comparePosters: async () => 0.2 })

      await expect(source({ title: '痴迷', year: 2024, kind: 'movie', externalIds: {}, poster: DOUBAN }, {})).resolves.toEqual([])
    })

    it('matches a localized name carried only in alternative titles', async () => {
      const fetch = vi.fn(async (input: string) => {
        if (input.includes('/search/movie')) return json({ results: [{ id: 1339713, title: 'Obsession', release_date: '2026-05-13' }] })
        if (input.includes('/movie/1339713?')) return json({
          id: 1339713, title: 'Obsession', release_date: '2026-05-13', external_ids: { imdb_id: 'tt37287335' },
          alternative_titles: { titles: [{ title: '痴迷' }] },
        })
        throw new Error(`unexpected request ${input}`)
      })
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch, comparePosters: vi.fn() })

      await expect(source({ title: '痴迷', year: 2026, kind: 'movie', externalIds: {} }, {})).resolves.toMatchObject([
        { externalIds: { tmdb: '1339713' }, matchedBy: 'title-unique' },
      ])
    })
  })

  describe('cover tie-break', () => {
    // Two works share the exact title AND the discovery year — text cannot separate them.
    function tied() {
      return vi.fn(async (input: string) => {
        if (input.includes('/search/movie')) return json({ results: [
          { id: 1339713, title: '痴迷', release_date: '2026-05-13' },
          { id: 937895, title: '痴迷', release_date: '2026-01-04' },
        ] })
        if (input.includes('/movie/1339713/images')) return json({ posters: [{ file_path: '/right-a.jpg', iso_639_1: 'en' }, { file_path: '/right-b.jpg', iso_639_1: 'zh' }] })
        if (input.includes('/movie/937895/images')) return json({ posters: [{ file_path: '/wrong.jpg', iso_639_1: 'zh' }] })
        if (input.includes('/movie/1339713?')) return json({ id: 1339713, title: 'Obsession', release_date: '2026-05-13', external_ids: { imdb_id: 'tt37287335' } })
        throw new Error(`unexpected request ${input}`)
      })
    }
    const tiedIdentity = { title: '痴迷', year: 2026, kind: 'movie' as const, externalIds: {}, poster: DOUBAN }

    it('admits the highest-scoring work and reports the scores behind it', async () => {
      const comparePosters = vi.fn(async (_s: string, candidate: string) => (candidate.includes('right-a') ? 0.85 : candidate.includes('right-b') ? 0.61 : 0.53))
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch: tied(), comparePosters })

      const [canonical] = await source(tiedIdentity, {}) as any[]
      expect(canonical).toMatchObject({ externalIds: { tmdb: '1339713' }, matchedBy: 'poster' })
      expect(canonical.posterMatch).toEqual({
        threshold: 0.6, minMargin: 0.05, score: 0.85, runnerUp: 0.53,
        candidates: [
          { tmdbId: '1339713', title: '痴迷', compared: 2, score: 0.85 },
          { tmdbId: '937895', title: '痴迷', compared: 1, score: 0.53 },
        ],
      })
      expect(comparePosters.mock.calls.every(([, candidate]) => candidate.includes('/t/p/w185'))).toBe(true)
    })

    it('compares covers of every language, ordered so the localized ones come first', async () => {
      const fetch = tied()
      const comparePosters = vi.fn(async (_source: string, _candidate: string) => 0.9)
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret', language: 'zh-CN' }), fetch, comparePosters })

      await source(tiedIdentity, {})
      const images = String(fetch.mock.calls.find(([url]) => String(url).includes('/images'))![0])
      // filtering /images to zh,null discarded the only matching cover of real works and rejected them
      expect(images).not.toContain('include_image_language')
      expect(images).not.toContain('language=zh-CN')
      // the zh cover is compared before the en one it was listed after
      expect(comparePosters.mock.calls.map(([, url]) => url)).toEqual([
        expect.stringContaining('right-b'), expect.stringContaining('right-a'), expect.stringContaining('wrong'),
      ])
    })

    it('declines when the best cover is below the admission threshold', async () => {
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch: tied(), comparePosters: async () => 0.55 })

      await expect(source(tiedIdentity, {})).resolves.toEqual([])
    })

    it('declines when the winner does not clear the runner-up by the margin', async () => {
      const comparePosters = async (_s: string, candidate: string) => (candidate.includes('right') ? 0.8 : 0.79)
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch: tied(), comparePosters })

      await expect(source(tiedIdentity, {})).resolves.toEqual([])
    })

    it('declines without guessing from the title when no cover can be fetched or decoded', async () => {
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch: tied(), comparePosters: async () => null })

      await expect(source(tiedIdentity, {})).resolves.toEqual([])
    })

    it('sends a row with no year to the covers rather than trusting a lone title', async () => {
      const comparePosters = vi.fn(async (_s: string, candidate: string) => (candidate.includes('right-a') ? 0.85 : 0.2))
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch: tied(), comparePosters })

      await expect(source({ title: '痴迷', kind: 'movie', externalIds: {}, poster: DOUBAN }, {})).resolves.toMatchObject([
        { externalIds: { tmdb: '1339713' }, matchedBy: 'poster' },
      ])
      expect(comparePosters).toHaveBeenCalled()
    })

    it('sends a lone exact title whose year is far off to the covers', async () => {
      const comparePosters = vi.fn(async (_s: string, candidate: string) => (candidate.includes('right-a') ? 0.85 : 0.2))
      const fetch = vi.fn(async (input: string) => {
        if (input.includes('/search/movie')) return json({ results: [{ id: 1339713, title: '痴迷', release_date: '2026-05-13' }] })
        if (input.includes('/movie/1339713/images')) return json({ posters: [{ file_path: '/right-a.jpg', iso_639_1: 'zh' }] })
        if (input.includes('/movie/1339713?')) return json({ id: 1339713, title: 'Obsession', release_date: '2026-05-13' })
        throw new Error(`unexpected request ${input}`)
      })
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch, comparePosters })

      // 2019 vs 2026 is not a dating disagreement — it is a different work until a cover says otherwise
      await expect(source({ title: '痴迷', year: 2019, kind: 'movie', externalIds: {}, poster: DOUBAN }, {})).resolves.toMatchObject([
        { externalIds: { tmdb: '1339713' }, matchedBy: 'poster' },
      ])
      expect(comparePosters).toHaveBeenCalled()
    })

    it('falls back to fuzzy rows when nothing matches the title exactly', async () => {
      const fetch = vi.fn(async (input: string) => {
        if (input.includes('/search/movie')) return json({ results: [{ id: 555, title: '完全不同的名字', release_date: '2026-01-01' }] })
        if (input.includes('/movie/555?')) return json({ id: 555, title: '完全不同的名字', release_date: '2026-01-01', alternative_titles: { titles: [] } })
        if (input.includes('/movie/555/images')) return json({ posters: [{ file_path: '/f.jpg', iso_639_1: 'zh' }] })
        throw new Error(`unexpected request ${input}`)
      })
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch, comparePosters: async () => 0.9 })

      await expect(source({ title: '痴迷', year: 2026, kind: 'movie', externalIds: {}, poster: DOUBAN }, {})).resolves.toMatchObject([
        { externalIds: { tmdb: '555' }, matchedBy: 'poster' },
      ])
    })

    it('declines a row with no cover that text could not single out', async () => {
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch: tied(), comparePosters: vi.fn() })

      await expect(source({ title: '痴迷', year: 2026, kind: 'movie', externalIds: {} }, {})).resolves.toEqual([])
    })
  })

  // `/search/<type>` 逼调用方先知道答案，而发现行常常并不知道（只有 themoviedb.org/tv/… 链接
  // 才是证据）。kind 缺席 = "不知道"，此时必须两个索引都问——否则一份学前动画名单会被整个
  // 当成电影去 /search/movie 找，一条都匹配不上而且不报错。
  describe('kind 未知时两个索引都问', () => {
    // 只有 tv 索引有这部；movie 索引空。
    function tvOnly() {
      return vi.fn(async (input: string) => {
        if (input.includes('/search/movie')) return json({ results: [] })
        if (input.includes('/search/tv')) return json({ results: [{ id: 129604, name: 'Ada Twist, Scientist', first_air_date: '2021-09-28' }] })
        if (input.includes('/tv/129604?')) return json({ id: 129604, name: 'Ada Twist, Scientist', first_air_date: '2021-09-28' })
        throw new Error(`unexpected request ${input}`)
      })
    }

    it('kind 缺席 → 剧集也能被认出来（旧行为：只搜 movie，永远空手而归）', async () => {
      const fetch = tvOnly()
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch, comparePosters: vi.fn() })

      await expect(source({ title: 'Ada Twist, Scientist', year: 2021, externalIds: {} }, {})).resolves.toEqual([{
        source: 'tmdb-canonical', externalIds: { tmdb: '129604' }, kind: 'series', title: 'Ada Twist, Scientist', year: 2021, matchedBy: 'title-unique',
      }])
      expect(fetch.mock.calls.some(([url]) => String(url).includes('/search/tv'))).toBe(true)
    })

    it('kind 明说是电影时不多问一次 tv——有证据就不该再猜', async () => {
      const fetch = tvOnly()
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch, comparePosters: vi.fn() })

      await expect(source({ title: 'Ada Twist, Scientist', year: 2021, kind: 'movie', externalIds: {} }, {})).resolves.toEqual([])
      expect(fetch.mock.calls.some(([url]) => String(url).includes('/search/tv'))).toBe(false)
    })

    it('已知 id + kind 未知：一个索引 404 就试另一个', async () => {
      const fetch = vi.fn(async (input: string) => {
        if (input.includes('/movie/129604?')) return json({ status_code: 34 }, 404)
        if (input.includes('/tv/129604?')) return json({ id: 129604, name: 'Ada Twist, Scientist', first_air_date: '2021-09-28' })
        throw new Error(`unexpected request ${input}`)
      })
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch })

      await expect(source({ title: 'Ada Twist, Scientist', externalIds: { tmdb: '129604' } }, {})).resolves.toMatchObject([
        { externalIds: { tmdb: '129604' }, kind: 'series', title: 'Ada Twist, Scientist', matchedBy: 'id' },
      ])
    })
  })

  // 多一份证据永远不该让结果更差。TMDb 有些记录的 imdb_id 是 null（或记着另一个号），/find
  // 因此空手而归——那只说明这条捷径不通，不说明这部作品不存在。
  describe('IMDb 号 TMDb 不认时，回落到片名那条梯子', () => {
    // Monster Café：/find 空（TMDb 那条记录的 imdb_id 是 null），但片名搜得到 tv 15417。
    const monsterCafe = () => vi.fn(async (input: string) => {
      if (input.includes('/find/tt0470654')) return json({ movie_results: [], tv_results: [] })
      if (input.includes('/search/movie')) return json({ results: [] })
      if (input.includes('/search/tv')) return json({ results: [{ id: 15417, name: 'Monster Café', first_air_date: '1994-01-01' }] })
      if (input.includes('/tv/15417?')) return json({ id: 15417, name: 'Monster Café', first_air_date: '1994-01-01' })
      throw new Error(`unexpected request ${input}`)
    })

    it('/find 空 → 继续按片名找（旧行为：直接 miss，梯子一格都不走）', async () => {
      const fetch = monsterCafe()
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch, comparePosters: vi.fn() })

      await expect(source({ title: 'Monster Café', year: 1994, externalIds: { imdb: 'tt0470654' } }, {})).resolves.toMatchObject([
        { externalIds: { tmdb: '15417' }, kind: 'series', matchedBy: 'title-unique' },
      ])
      expect(fetch.mock.calls.some(([url]) => String(url).includes('/search/tv'))).toBe(true)
    })

    it('带一个 TMDb 不认的 id，结果不比只有片名更差——这是这次修的那条', async () => {
      const opts = { getSettings: () => ({ tmdbApiKey: 'secret' }), comparePosters: vi.fn() }
      const withId = makeTmdbCanonicalFn({ ...opts, fetch: monsterCafe() })
      const titleOnly = makeTmdbCanonicalFn({ ...opts, fetch: monsterCafe() })

      const a = await withId({ title: 'Monster Café', year: 1994, externalIds: { imdb: 'tt0470654' } }, {})
      const b = await titleOnly({ title: 'Monster Café', year: 1994, externalIds: {} }, {})
      expect(a).toEqual(b)
      expect(a).toHaveLength(1)
    })

    it('回落之后仍然守着「光有片名不够」那条线：没年份没封面 → 照样 miss', async () => {
      // 梯子的保守是有意的（见 resolveIn 里的注释）。这次改的只是"要不要走梯子"，不是梯子本身。
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch: monsterCafe(), comparePosters: vi.fn(async () => null) })
      await expect(source({ title: 'Monster Café', externalIds: { imdb: 'tt0470654' } }, {})).resolves.toEqual([])
    })

    it('/find 命中时不走梯子——捷径通就别多查', async () => {
      const fetch = vi.fn(async (input: string) => {
        if (input.includes('/find/tt1817311')) return json({ movie_results: [], tv_results: [{ id: 13910, name: '64 Zoo Lane' }] })
        if (input.includes('/tv/13910?')) return json({ id: 13910, name: '64 Zoo Lane' })
        throw new Error(`unexpected request ${input}`)
      })
      const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch })

      await expect(source({ title: '64 Zoo Lane', externalIds: { imdb: 'tt1817311' } }, {}))
        .resolves.toMatchObject([{ matchedBy: 'id' }])
      expect(fetch.mock.calls.some(([url]) => String(url).includes('/search/'))).toBe(false)
    })
  })

  // Wikidata 的编号兑换已前移到采集期（wikipedia 包的 hops），这一层不再对 wikidata.org 发任何
  // 请求：Q 号换来的 tmdb/imdb 编号在 item 上就位，走上面那两条 id fast-path。
  it('externalIds.wikidata 只是身份证据——这一层一个 wikidata.org 请求都不发', async () => {
    const fetch = vi.fn(async (input: string) => {
      if (input.includes('/search/movie')) return json({ results: [] })
      if (input.includes('/search/tv')) return json({ results: [{ id: 13910, name: '64 Zoo Lane', first_air_date: '1999-01-01' }] })
      if (input.includes('/tv/13910?')) return json({ id: 13910, name: '64 Zoo Lane', first_air_date: '1999-01-01' })
      throw new Error(`unexpected request ${input}`)
    })
    const source = makeTmdbCanonicalFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch, comparePosters: vi.fn() })

    await expect(source({ title: '64 Zoo Lane', year: 1999, externalIds: { wikidata: 'Q2817988' } }, {}))
      .resolves.toMatchObject([{ externalIds: { tmdb: '13910' }, matchedBy: 'title-unique' }])
    expect(fetch.mock.calls.some(([url]) => String(url).includes('wikidata.org'))).toBe(false)
  })
})
