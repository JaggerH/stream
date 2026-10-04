import { describe, expect, it } from 'vitest'
import { tmdbWorkRef, jellyfinDirName, opaqueWorkDirName } from './work-binding.ts'
import type { VideoDetail } from './types.ts'

const detail = (over: Partial<VideoDetail> = {}): VideoDetail => ({
  cacheKey: 'k',
  identity: { title: '权力的游戏', kind: 'series', externalIds: {} },
  images: {}, imageCandidates: [], failures: [],
  fetchedAt: '2026-07-17T00:00:00Z', expiresAt: '2026-07-18T00:00:00Z',
  ...over,
})

describe('tmdbWorkRef', () => {
  it('剧集 → tv 命名空间', () => {
    expect(tmdbWorkRef(detail({
      canonical: { status: 'resolved', provider: 'p', member: 'm', source: 'tmdb', externalIds: { tmdb: '1399' }, kind: 'series', title: '权力的游戏' },
    }))).toEqual({ id: '1399', media: 'tv', title: '权力的游戏' })
  })

  it('电影 → movie 命名空间', () => {
    expect(tmdbWorkRef(detail({
      identity: { title: '蜘蛛侠', kind: 'movie', externalIds: {} },
      canonical: { status: 'resolved', provider: 'p', member: 'm', source: 'tmdb', externalIds: { tmdb: '969681' }, kind: 'movie', title: '蜘蛛侠' },
    }))).toEqual({ id: '969681', media: 'movie', title: '蜘蛛侠' })
  })

  it('season/episode 也住 tv 命名空间', () => {
    expect(tmdbWorkRef(detail({
      canonical: { status: 'resolved', provider: 'p', member: 'm', source: 'tmdb', externalIds: { tmdb: '1399' }, kind: 'season', title: 'X' },
    }))?.media).toBe('tv')
  })

  // canonical 的存在意义就是「不让模糊匹配把一部作品悄悄变成另一部」。拿没验过的候选去绑网盘,
  // 等于把那个模糊匹配写进用户的盘里 —— 宁可说「还不能绑」。
  it('canonical 未验证 → null,绝不拿模糊匹配去绑', () => {
    expect(tmdbWorkRef(detail({ canonical: { status: 'miss', provider: 'p' } }))).toBeNull()
    expect(tmdbWorkRef(detail())).toBeNull()
  })

  it('只有 imdb 没有 tmdb → null', () => {
    expect(tmdbWorkRef(detail({
      canonical: { status: 'resolved', provider: 'p', member: 'm', source: 'tmdb', externalIds: { imdb: 'tt0944947' }, kind: 'series' },
    }))).toBeNull()
  })

  // kind 说不清就不猜:猜错媒体类型 = 绑到另一部同 id 的作品上（TMDb 的 id 按类型分命名空间）。
  it('kind 是 unknown → null,不猜媒体类型', () => {
    expect(tmdbWorkRef(detail({
      identity: { title: 'X', kind: 'unknown', externalIds: {} },
      canonical: { status: 'resolved', provider: 'p', member: 'm', source: 'tmdb', externalIds: { tmdb: '1' }, kind: 'unknown', title: 'X' },
    }))).toBeNull()
  })

  it('带 year（canonical → metadata → identity 依次回落）', () => {
    expect(tmdbWorkRef(detail({
      canonical: { status: 'resolved', provider: 'p', member: 'm', source: 'tmdb', externalIds: { tmdb: '1399' }, kind: 'series', title: '权力的游戏', year: 2011 },
    }))).toEqual({ id: '1399', media: 'tv', title: '权力的游戏', year: 2011 })
  })

  it('取不到 year → 不带该字段', () => {
    expect(tmdbWorkRef(detail({
      canonical: { status: 'resolved', provider: 'p', member: 'm', source: 'tmdb', externalIds: { tmdb: '1399' }, kind: 'series', title: '权力的游戏' },
    }))).not.toHaveProperty('year')
  })

  // ref.title 会被 jellyfinDirName 刻进用户的网盘目录。canonical.title 曾是调用方回显（tmdb:<id>
  // 详情路径没带提示时就是 id 本身），目录因此叫过「55157 (1993) [tmdbid-55157]」——id 冒充的
  // title 在每一级都要被跳过，全链没有真名就宁可 null（「还不能绑」）。
  it('canonical.title 是 id 回显 → 跳过，用 metadata 的真名', () => {
    expect(tmdbWorkRef(detail({
      identity: { title: '55157', kind: 'movie', externalIds: { tmdb: '55157' } },
      metadata: { source: 'tmdb-metadata', title: 'Kika', externalIds: { tmdb: '55157' } },
      canonical: { status: 'resolved', provider: 'p', member: 'm', source: 'tmdb', externalIds: { tmdb: '55157' }, kind: 'movie', title: '55157' },
    }))).toMatchObject({ id: '55157', media: 'movie', title: 'Kika' })
  })

  it('全链都只有 id 冒充的 title → null，绝不拿 id 当名字去绑', () => {
    expect(tmdbWorkRef(detail({
      identity: { title: '55157', kind: 'movie', externalIds: { tmdb: '55157' } },
      canonical: { status: 'resolved', provider: 'p', member: 'm', source: 'tmdb', externalIds: { tmdb: '55157' }, kind: 'movie', title: '55157' },
    }))).toBeNull()
  })
})

describe('jellyfinDirName', () => {
  it('电影带年份 → <标题> (年份) [tmdbid-x]', () => {
    expect(jellyfinDirName({ id: '843527', media: 'movie', title: '流浪地球2', year: 2023 })).toBe('流浪地球2 (2023) [tmdbid-843527]')
  })
  it('电影缺年份 → 省略年份段', () => {
    expect(jellyfinDirName({ id: '843527', media: 'movie', title: '流浪地球2' })).toBe('流浪地球2 [tmdbid-843527]')
  })
  // 真实 bug：剧集哪怕有 year 也不带——year 只是「第一季」的首播年份,单个标量扛不起一部可能
  // 跨好几年的多季剧;tmdbid 本身已经唯一定位这部作品,年份反而暗示"这个目录只代表某一年",
  // 误导用户(真实案例：`喜剧之王单口季 (2024) [tmdbid-261391]`——这部剧其实播到了 2026)。
  it('剧集永不带年份,即便 ref.year 有值', () => {
    expect(jellyfinDirName({ id: '1399', media: 'tv', title: '权力的游戏', year: 2011 })).toBe('权力的游戏 [tmdbid-1399]')
  })
  it('清洗文件系统非法字符', () => {
    expect(jellyfinDirName({ id: '1', media: 'movie', title: '这!就是: 街舞/S3', year: 2020 })).toBe('这!就是 街舞 S3 (2020) [tmdbid-1]')
  })
})

describe('opaqueWorkDirName', () => {
  it('不含作品名的任何字符——网盘上不出现明文', () => {
    expect(opaqueWorkDirName({ id: '261391', media: 'tv' })).toBe('tv-261391')
    expect(opaqueWorkDirName({ id: '1084244', media: 'movie' })).toBe('movie-1084244')
  })
  // TMDb 的 id 按媒体类型分命名空间。省掉前缀,同号的一剧一片会落进同一个目录、绑定互相踩。
  it('media 前缀把同号的 movie 与 tv 分开', () => {
    expect(opaqueWorkDirName({ id: '1084244', media: 'tv' })).not.toBe(opaqueWorkDirName({ id: '1084244', media: 'movie' }))
  })
  // planBinding 靠 `existing.right.path === dirPath` 区分 sync(同作品补集) 与 rebind(换目录)。
  // 掺进随机数/时间戳就会让同一作品每次转存都建出新目录、散掉绑定。
  it('同一作品恒定可复现', () => {
    const ref = { id: '261391', media: 'tv' } as const
    expect(opaqueWorkDirName(ref)).toBe(opaqueWorkDirName(ref))
  })
  // 标题/年份即便传进来也不该泄漏进目录名——多余字段一律忽略。
  it('无视 title 与 year', () => {
    expect(opaqueWorkDirName({ id: '55157', media: 'movie', title: '射雕英雄传之东成西就', year: 1993 } as never)).toBe('movie-55157')
  })
})
