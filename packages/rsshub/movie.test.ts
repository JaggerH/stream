import { describe, it, expect } from 'vitest'
import { movieNormalizer } from './movie.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'
import { videoDiscoveryFallback } from '../../src/video/discovery-fallback.ts'

const mf = (id: string) => ({ id, normalizer: 'movie' } as unknown as SourceManifest)

// —— description strings below mirror the EXACT html each RSSHub route emits
//    (douban/other/{playing,ustop,weekly-best}, themoviedb/utils, imdb/chart). ——

describe('movieNormalizer', () => {
  it('douban 正在热映: rating + cover, no year/genre', () => {
    const desc =
      '标题：周处除三害<br>评分：8.4<br>片长：134分钟<br>制片国家/地区：中国台湾<br>' +
      '导演：黄精甫<br>主演：阮经天 / 袁富华<br><img src="https://img1.doubanio.com/p2895.jpg">'
    const c = movieNormalizer({ title: '周处除三害', description: desc, link: 'x' }, mf('movie-douban-playing'))
    expect(c.archetype).toBe('gallery')
    expect(c.title).toBe('周处除三害')
    expect(c.media).toEqual([{ kind: 'image', url: 'https://img1.doubanio.com/p2895.jpg' }])
    expect(c.meta).toEqual({
      source: 'douban', sourceLabel: '豆瓣', rating: '8.4',
      discovery: { runtimeMinutes: 134, directors: ['黄精甫'], actors: ['阮经天', '袁富华'] },
    })
  })

  // 搬家等价：宿主 discovery-fallback 以前自己解析 description 的「片长 / 导演 / 主演」，现在只吃
  // normalizer 申报的 `meta.discovery`。同一条原始条目走「normalizer → fallback」必须得到与搬前
  // 逐字段相同的详情（下面的期望值是搬前 src/video/discovery-fallback.test.ts 的原样输出）。
  it('discovery fallback over the normalized item equals the pre-move host output', () => {
    const raw = { title: '功夫女足', description: '标题：功夫女足<br>评分：6.6<br>片长：106分钟<br>制片国家/地区：中国香港 中国大陆<br>导演：周星驰<br>主演：张小斐 / 迪丽热巴 / 张艺兴<br>' }
    const content = movieNormalizer(raw, mf('movie-douban-playing'))
    expect(videoDiscoveryFallback({
      id: 'douban-playing', stream_id: 'video-douban-playing', source_type: 'rsshub-bridge', source_route: '/douban/movie/playing', title: '功夫女足',
      raw, content, timestamp: 't', fetched_at: 't',
    })).toEqual({
      source: 'douban-discovery',
      title: '功夫女足',
      runtimeMinutes: 106,
      ratings: [{ source: 'douban', value: 6.6, scale: 10 }],
      people: [
        { name: '周星驰', role: 'director' },
        { name: '张小斐', role: 'actor' },
        { name: '迪丽热巴', role: 'actor' },
        { name: '张艺兴', role: 'actor' },
      ],
      externalIds: {},
    })
    // TMDB / IMDb 条目不申报 discovery → 不兜底（搬前同）
    const tmdb = movieNormalizer({ title: 'A', description: 'User Score: 7' }, mf('movie-tmdb-trend-movie'))
    expect(videoDiscoveryFallback({ id: 'a', stream_id: 's', source_type: 'rsshub-bridge', source_route: '/t', title: 'A', raw: {}, content: tmdb, timestamp: 't', fetched_at: 't' })).toBeNull()
  })

  it('douban 北美票房: rating + pipe-split genres', () => {
    const desc =
      '标题：头脑特工队2<br> 影片类型：喜剧 | 动画 | 冒险  <br>评分：8.1 <br/> ' +
      '<img src="https://img2.doubanio.com/x.jpg">'
    const c = movieNormalizer({ title: '头脑特工队2', description: desc }, mf('movie-douban-ustop'))
    expect(c.meta).toEqual({ source: 'douban', sourceLabel: '豆瓣', rating: '8.1', genres: ['喜剧', '动画', '冒险'], discovery: {} })
  })

  it('douban 一周口碑: rating + year + genres from card_subtitle', () => {
    const desc =
      '<p>标题：某种物质</p><p>评分：7.9分</p>' +
      '<p>标签：2024 / 美国 英国 / 剧情 科幻 惊悚 / 科拉莉·法尔雅 / 黛米·摩尔</p>' +
      '<p>影片信息：一个过气女星求助于黑市药物。</p><p><img src="https://img3.doubanio.com/y.jpg"/></p>'
    const c = movieNormalizer({ title: '某种物质', description: desc }, mf('movie-douban-weekly'))
    expect(c.meta).toEqual({ source: 'douban', sourceLabel: '豆瓣', rating: '7.9', year: '2024', genres: ['剧情', '科幻', '惊悚'], discovery: {} })
    expect(c.text).toBe('一个过气女星求助于黑市药物。')
    expect(c.media).toEqual([{ kind: 'image', url: 'https://img3.doubanio.com/y.jpg' }])
  })

  it('tmdb trending: rating from User Score, year from pubDate, no genre', () => {
    const desc =
      '<img src="https://image.tmdb.org/t/p/original/abc.jpg"/>' +
      '<p>User Score: 8.2<br/>Vote Count: 12000</p><p>保罗·厄崔迪联合契妮与弗雷曼人复仇。</p>'
    const c = movieNormalizer(
      { title: '沙丘3', description: desc, pubDate: new Date('2024-02-27T00:00:00Z') },
      mf('movie-tmdb-trend-movie'),
    )
    expect(c.meta).toEqual({ source: 'tmdb', sourceLabel: 'TMDB', rating: '8.2', year: '2024' })
    expect(c.text).toBe('保罗·厄崔迪联合契妮与弗雷曼人复仇。')
  })

  it('imdb chart: strip rank prefix, year from title, genres from category', () => {
    const desc =
      '<figure><img src="https://m.media-amazon.com/z.jpg" alt="The Shawshank Redemption"/>' +
      '<figcaption>x</figcaption></figure><br>Original title: The Shawshank Redemption<br>' +
      'R IMDb RATING: 9.3/10 (2900000)<br><br>Two imprisoned men bond over years.'
    const c = movieNormalizer(
      { title: '1. The Shawshank Redemption (1994)', description: desc, category: ['Drama'] },
      mf('movie-imdb-popular'),
    )
    expect(c.title).toBe('The Shawshank Redemption')
    expect(c.meta).toEqual({ source: 'imdb', sourceLabel: 'IMDb', rating: '9.3', year: '1994', genres: ['Drama'] })
    expect(c.text).toBe('Two imprisoned men bond over years.')
  })

  it('imdb tv with a year range in the title', () => {
    const c = movieNormalizer(
      { title: '2. Breaking Bad (2008-2013)', description: 'IMDb RATING: 9.5/10 (2100000)', category: ['Crime', 'Drama'] },
      mf('movie-imdb-popular'),
    )
    expect(c.title).toBe('Breaking Bad')
    expect(c.meta).toMatchObject({ year: '2008', rating: '9.5', genres: ['Crime', 'Drama'] })
  })

  it('drops a 0/unrated score and rounds a long float to one decimal', () => {
    const unrated = '标题：未上映片<br>评分：0<br><img src="https://img.doubanio.com/u.jpg">'
    expect(movieNormalizer({ title: '未上映片', description: unrated }, mf('movie-douban-playing')).meta)
      .toEqual({ source: 'douban', sourceLabel: '豆瓣', discovery: {} })
    const tmdb = '<img src="https://image.tmdb.org/t/p/original/o.jpg"/><p>User Score: 5.643<br/>Vote Count: 9</p>'
    expect(movieNormalizer({ title: '奥德赛', description: tmdb, pubDate: new Date('2026-07-01T00:00:00Z') }, mf('movie-tmdb-trend-movie')).meta)
      .toEqual({ source: 'tmdb', sourceLabel: 'TMDB', rating: '5.6', year: '2026' })
  })

  it('never throws and degrades to text on a garbage item', () => {
    expect(() => movieNormalizer({}, mf('movie-douban-playing'))).not.toThrow()
    const c = movieNormalizer({}, mf('movie-tmdb-trend-tv'))
    expect(c.archetype).toBe('text')
    expect(c.meta).toEqual({ source: 'tmdb', sourceLabel: 'TMDB' })
  })
})
