import { describe, expect, it } from 'vitest'
import { videoWorkLookupIdentity, videoItemReference } from './item-identity.ts'

describe('video item identity', () => {
  it('treats a Douban ranking URL as discovery evidence rather than an external metadata id', () => {
    expect(videoWorkLookupIdentity({
      id: 'douban-1', stream_id: 'video-douban-weekly', source_type: 'rsshub-bridge', source_route: 'movie/douban/weekly',
      fetched_at: '2026-07-15T00:00:00.000Z', timestamp: '2026-07-14T00:00:00.000Z', title: '某种物质',
      url: 'https://movie.douban.com/subject/35575567/', raw: {}, content: { archetype: 'gallery', meta: { year: '2024', source: 'douban' } },
    })).toEqual({
      title: '某种物质', year: 2024, sourceUrl: 'https://movie.douban.com/subject/35575567/', externalIds: {},
    })
  })

  // 豆瓣的 subject 链接不区分电影和剧集（一周口碑榜里两者混着），所以这里**没有** kind ——
  // 而不是默认成电影。曾经默认成电影，下游 tmdb-canonical 就只去 /search/movie 找，剧集
  // 一条也匹配不上，且全程不报错。留空让它去问 TMDb 两个索引。
  it('没有 movie/tv 证据时不编造 kind；有 TMDb 链接才断言', () => {
    const base = {
      id: 'x', stream_id: 's', source_type: 'rsshub-bridge' as const, source_route: 'r',
      fetched_at: '2026-07-15T00:00:00.000Z', timestamp: '2026-07-15T00:00:00.000Z', title: 'Ada Twist, Scientist',
      raw: {}, content: { archetype: 'text' as const },
    }
    expect(videoItemReference({ ...base, url: 'https://en.wikipedia.org/wiki/Ada_Twist,_Scientist_(TV_series)' }))
      .not.toHaveProperty('kind')
    expect(videoWorkLookupIdentity({ ...base, url: 'https://en.wikipedia.org/wiki/Ada_Twist,_Scientist_(TV_series)' }))
      .not.toHaveProperty('kind')
    expect(videoItemReference({ ...base, url: 'https://www.themoviedb.org/tv/129604' })).toMatchObject({ kind: 'series' })
    expect(videoItemReference({ ...base, url: 'https://www.themoviedb.org/movie/1101383' })).toMatchObject({ kind: 'movie' })
  })

  it('does not mistake a Douban feed fetch timestamp for the work release year', () => {
    expect(videoWorkLookupIdentity({
      id: 'douban-playing', stream_id: 'video-douban-playing', source_type: 'rsshub-bridge', source_route: 'movie/douban/playing',
      fetched_at: '2026-07-15T00:00:00.000Z', timestamp: '2026-07-15T00:00:00.000Z', title: '功夫女足',
      url: 'https://movie.douban.com/subject/36452545', raw: {}, content: { archetype: 'gallery', meta: { source: 'douban' } },
    })).toEqual({
      title: '功夫女足', sourceUrl: 'https://movie.douban.com/subject/36452545', externalIds: {},
    })
  })

  it('retains director and cast evidence from a stored Douban weekly row', () => {
    const item = {
      id: 'douban-weekly-obsession', stream_id: 'video-douban-weekly', source_type: 'rsshub-bridge' as const, source_route: '/douban/movie/weekly',
      fetched_at: '2026-07-15T00:00:00.000Z', timestamp: '2026-07-14T00:00:00.000Z', title: '痴迷',
      url: 'https://movie.douban.com/subject/37380073/',
      raw: { description: '<p>标题：痴迷</p><p>标签：2025 / 美国 / 剧情 / 库里·巴克 / 迈克尔·约翰斯顿 印达·纳瓦雷特</p>' },
      content: { archetype: 'gallery' as const, meta: { year: '2025', source: 'douban' as const } },
    }

    expect(videoItemReference(item)).toMatchObject({
      title: '痴迷', year: 2025, externalIds: {},
      people: [
        { name: '库里·巴克', role: 'director' },
        { name: '迈克尔·约翰斯顿', role: 'actor' },
        { name: '印达·纳瓦雷特', role: 'actor' },
      ],
    })
    expect(videoWorkLookupIdentity(item)).toMatchObject({
      people: [
        { name: '库里·巴克', role: 'director' },
        { name: '迈克尔·约翰斯顿', role: 'actor' },
        { name: '印达·纳瓦雷特', role: 'actor' },
      ],
    })
  })

  // 一条源常常只能把 id 以**链接**的形式交出来（recipe 从 <a href> 上读，CSS 切不出裸 id）。
  // 抠 id 的规则只有一条，对 item 自己的 URL 和源声明的字段一视同仁——否则每加一个新源就会
  // 在调用点再写一个正则，同一个问题就有了第二个答案。
  it('声明字段里的 id 可以是链接形态，和 URL 走同一条抠取规则', () => {
    const base = {
      id: 'w', stream_id: 's', source_type: 'rsshub-bridge' as const, source_route: 'r',
      fetched_at: '2026-07-15T00:00:00.000Z', timestamp: '2026-07-15T00:00:00.000Z', title: 'Ada Twist, Scientist',
      url: 'https://en.wikipedia.org/wiki/Ada_Twist,_Scientist_(TV_series)', content: { archetype: 'text' as const },
    }
    expect(videoItemReference({ ...base, raw: { imdb_id: 'https://www.imdb.com/title/tt13241650/' } }).externalIds)
      .toEqual({ imdb: 'tt13241650' })
    expect(videoItemReference({ ...base, raw: { imdb_id: 'tt13241650' } }).externalIds)
      .toEqual({ imdb: 'tt13241650' })
    expect(videoItemReference({ ...base, raw: { tmdb_id: 'https://www.themoviedb.org/tv/129604' } }).externalIds)
      .toEqual({ tmdb: '129604' })
    // 垃圾值不该被当成裸 id 收下
    expect(videoItemReference({ ...base, raw: { imdb_id: 'see the article' } }).externalIds).toEqual({})
  })

  // Wikidata 的 hop 把 TMDb 编号分索引交出来（P4947 电影 / P4983 剧集）。同一个数字在两个索引
  // 下是两部不同的作品，所以哪格有值本身就是 kind 证据；两格都有（电影剧集双登记）而 kind 未知
  // 时取电影、不猜 kind——与 canonical 阶梯 kind 未知时先问 /movie 的既有顺序一致。
  it('分索引的 TMDb 编号：取值即证据，只有一格时顺带定 kind', () => {
    const base = {
      id: 'wd', stream_id: 's', source_type: 'rsshub-bridge' as const, source_route: 'r',
      fetched_at: '2026-07-15T00:00:00.000Z', timestamp: '2026-07-15T00:00:00.000Z', title: 'Monster Café',
      url: 'https://en.wikipedia.org/wiki/Monster_Café', content: { archetype: 'text' as const },
    }
    // 只有剧集编号 → tmdb 就是它，kind 一并确定
    expect(videoItemReference({ ...base, raw: { tmdb_tv_id: '15417' } }))
      .toMatchObject({ kind: 'series', externalIds: { tmdb: '15417' } })
    expect(videoItemReference({ ...base, raw: { tmdb_movie_id: '430162' } }))
      .toMatchObject({ kind: 'movie', externalIds: { tmdb: '430162' } })
    // 两格都有、kind 未知 → 取电影，但不断言 kind
    const both = videoItemReference({ ...base, raw: { tmdb_movie_id: '430162', tmdb_tv_id: '76718' } })
    expect(both.externalIds).toMatchObject({ tmdb: '430162' })
    expect(both).not.toHaveProperty('kind')
    // kind 已知就只认那个索引的编号，绝不拿另一格去撞
    expect(videoItemReference({ ...base, videoRef: { title: 'Revolting Rhymes', kind: 'series' as const, externalIds: {} }, raw: { tmdb_movie_id: '430162', tmdb_tv_id: '76718' } }))
      .toMatchObject({ kind: 'series', externalIds: { tmdb: '76718' } })
    // 显式 tmdb_id 永远赢过分索引字段
    expect(videoItemReference({ ...base, raw: { tmdb_id: '111', tmdb_tv_id: '222' } }).externalIds)
      .toMatchObject({ tmdb: '111' })
  })

  it('uses a canonical TMDb URL as the external metadata id', () => {
    expect(videoWorkLookupIdentity({
      id: 'tmdb-1', stream_id: 'video-tmdb-tv', source_type: 'rsshub-bridge', source_route: 'movie/tmdb/tv',
      fetched_at: '2026-07-15T00:00:00.000Z', timestamp: '2026-07-14T00:00:00.000Z', title: '航海王',
      url: 'https://www.themoviedb.org/tv/37854', raw: {}, content: { archetype: 'gallery', meta: { year: '1999', source: 'tmdb' } },
    })).toMatchObject({ title: '航海王', year: 1999, kind: 'series', externalIds: { tmdb: '37854' } })
  })
})
