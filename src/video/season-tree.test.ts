import { describe, it, expect } from 'vitest'
import { parseEpisodeLeftKey, buildSeasons, type EpisodeRow } from './season-tree.ts'

describe('parseEpisodeLeftKey', () => {
  it('反解 tmdb 剧集键 → 季/集', () => {
    expect(parseEpisodeLeftKey('tmdb:1399:S01E05')).toEqual({ season: 1, episode: 5 })
    expect(parseEpisodeLeftKey('tmdb:456:S38E802')).toEqual({ season: 38, episode: 802 })
  })
  it('电影键 / 异常键 → null', () => {
    expect(parseEpisodeLeftKey('tmdb:969681')).toBeNull()
    expect(parseEpisodeLeftKey('iqiyi:第2期纯享上集')).toBeNull()
    expect(parseEpisodeLeftKey('tmdb:1:S01')).toBeNull()
  })
})

const row = (leftKey: string, title: string, playable = false): EpisodeRow => ({ leftKey, title, playable })

describe('buildSeasons', () => {
  it('非 tv（电影/未 canonical）→ undefined', () => {
    expect(buildSeasons('movie', [row('tmdb:1:S01E01', 'x')])).toBeUndefined()
    expect(buildSeasons(null, [row('tmdb:1:S01E01', 'x')])).toBeUndefined()
  })

  it('按季分组、季内按集号升序', () => {
    const seasons = buildSeasons('tv', [
      row('tmdb:1:S02E02', 'S2E2'),
      row('tmdb:1:S01E02', 'S1E2'),
      row('tmdb:1:S01E01', 'S1E1'),
      row('tmdb:1:S02E01', 'S2E1'),
    ])
    expect(seasons?.map((s) => s.season)).toEqual([1, 2])
    expect(seasons?.[0].episodes.map((e) => e.episode)).toEqual([1, 2])
    expect(seasons?.[1].episodes.map((e) => e.episode)).toEqual([1, 2])
  })

  it('携带标题与 playable', () => {
    const seasons = buildSeasons('tv', [row('tmdb:1:S01E01', '第一集', true)])
    expect(seasons?.[0].episodes[0]).toEqual({ season: 1, episode: 1, title: '第一集', leftKey: 'tmdb:1:S01E01', playable: true })
  })

  it('携带 airDate（未播出集判定要用它）；没有则不带该字段', () => {
    const seasons = buildSeasons('tv', [
      { leftKey: 'tmdb:1:S01E01', title: '第一集', playable: false, airDate: '2099-01-01' },
      row('tmdb:1:S01E02', '第二集'),
    ])
    expect(seasons?.[0].episodes[0].airDate).toBe('2099-01-01')
    expect(seasons?.[0].episodes[1]).not.toHaveProperty('airDate')
  })

  it('反解失败的行跳过，不硬塞', () => {
    const seasons = buildSeasons('tv', [row('tmdb:1:S01E01', 'ok'), row('tmdb:1', '电影键'), row('junk', 'junk')])
    expect(seasons?.length).toBe(1)
    expect(seasons?.[0].episodes.length).toBe(1)
  })

  it('全反解失败 / 无行 → undefined（不显示空树）', () => {
    expect(buildSeasons('tv', [])).toBeUndefined()
    expect(buildSeasons('tv', [row('tmdb:1', 'movie-key')])).toBeUndefined()
  })
})
