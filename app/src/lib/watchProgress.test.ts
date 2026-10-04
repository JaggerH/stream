import { describe, expect, it } from 'vitest'
import { continueWatchingCards, continueWatchingRoute, findResumeRow, fmtVideoClock, resumeUrlFor, workKeyParts } from './watchProgress.ts'

describe('workKeyParts', () => {
  it('splits a series episode key into workKey + epLabel', () => {
    expect(workKeyParts('tmdb:261391:S03E02')).toEqual({ workKey: 'tmdb:261391', epLabel: 'S03E02' })
  })

  it('treats a movie key (no third segment) as the workKey itself, with no epLabel', () => {
    expect(workKeyParts('tmdb:756999')).toEqual({ workKey: 'tmdb:756999' })
  })

  it('a key with no colon at all is also its own workKey (e.g. a raw inbox item id)', () => {
    expect(workKeyParts('abc123')).toEqual({ workKey: 'abc123' })
  })

  it('ignores segments past the third — an id containing extra colons cannot widen workKey', () => {
    expect(workKeyParts('tmdb:261391:S03E02:extra:colons')).toEqual({ workKey: 'tmdb:261391', epLabel: 'S03E02' })
  })
})

describe('fmtVideoClock', () => {
  it('formats under an hour as m:ss', () => {
    expect(fmtVideoClock(65)).toBe('1:05')
  })

  it('formats an hour or more as h:mm:ss (minutes zero-padded)', () => {
    expect(fmtVideoClock(3905)).toBe('1:05:05')
  })

  it('clamps negative/non-finite input to 0', () => {
    expect(fmtVideoClock(-5)).toBe('0:00')
    expect(fmtVideoClock(NaN)).toBe('0:00')
  })
})

describe('resumeUrlFor', () => {
  it('a stream:-prefixed workKey (item-id row, e.g. WorkDetail local season/flat grid) resumes via ?id=', () => {
    expect(resumeUrlFor({ key: 'e1', workKey: 'stream:abc' })).toBe('/api/media/videos/resolve?id=e1')
  })

  it('a leftKey row (e.g. tmdb:… netdisk-bound episode/movie) resumes via ?key=', () => {
    expect(resumeUrlFor({ key: 'tmdb:1:S03E02', workKey: 'tmdb:1' })).toBe('/api/media/videos/resolve?key=tmdb%3A1%3AS03E02')
  })
})

// minimal fake t, same shape as sourceLabel.test.ts's — {{ep}}/{{time}} interpolation only.
const fakeT = ((key: string, opts?: Record<string, unknown>) => {
  const dict: Record<string, string> = {
    'movie.continueWatchingSubtitleEp': `看到 ${opts?.ep} · ${opts?.time}`,
    'movie.continueWatchingSubtitleMovie': `看到 ${opts?.time}`,
  }
  return dict[key] ?? key
}) as unknown as Parameters<typeof continueWatchingCards>[1]

describe('continueWatchingCards', () => {
  it('剧集副标带「看到」+ 集号 + 时间;电影只带「看到」+ 时间;进度条百分比正确', () => {
    const out = continueWatchingCards([
      { key: 'tmdb:1:S03E02', workKey: 'tmdb:1', workTitle: '某剧', epLabel: 'S03E02', position: 754, duration: 3000, updatedAt: 2 },
      { key: 'tmdb:2', workKey: 'tmdb:2', workTitle: '某电影', position: 65, duration: 6000, updatedAt: 1 },
    ] as never, fakeT)
    expect(out[0]).toMatchObject({ title: '某剧', subtitle: '看到 S03E02 · 12:34', percent: 25 })
    expect(out[1]).toMatchObject({ title: '某电影', subtitle: '看到 1:05' })
  })

  it('超过一小时用 时:分:秒(影视必须,别用歌曲那套)', () => {
    const out = continueWatchingCards([
      { key: 'k', workKey: 'w', workTitle: '长片', position: 3905, duration: 7200, updatedAt: 1 },
    ] as never, fakeT)
    expect(out[0].subtitle).toBe('看到 1:05:05')
  })

  it('duration 为 0 时百分比取 0,不产生 NaN', () => {
    expect(continueWatchingCards([{ key: 'k', workKey: 'w', workTitle: 't', position: 10, duration: 0, updatedAt: 1 } as never], fakeT)[0].percent).toBe(0)
  })
})

describe('continueWatchingRoute', () => {
  it('stream: 打头 → 关注剧的作品详情路由', () => {
    expect(continueWatchingRoute({ workKey: 'stream:work-1' })).toEqual({ kind: 'item', id: 'work-1' })
  })
  it('tmdb: 带集号 → 剧;不带 → 电影(leftKey 第三段就是集号)', () => {
    expect(continueWatchingRoute({ workKey: 'tmdb:261391', epLabel: 'S03E02' })).toEqual({ kind: 'tmdb', id: '261391', media: 'tv' })
    expect(continueWatchingRoute({ workKey: 'tmdb:550' })).toEqual({ kind: 'tmdb', id: '550', media: 'movie' })
  })
  it('认不出的命名空间 / 残缺 workKey → null(调用方回落到原地续播)', () => {
    expect(continueWatchingRoute({ workKey: 'lizhi:1' })).toBeNull()
    expect(continueWatchingRoute({ workKey: 'tmdb:' })).toBeNull()
    expect(continueWatchingRoute({ workKey: 'nocolon' })).toBeNull()
    expect(continueWatchingRoute({ workKey: ':x' })).toBeNull()
  })
})

describe('findResumeRow', () => {
  const rows = [
    { workKey: 'tmdb:1', key: 'a' },
    { workKey: 'stream:work-1', key: 'b' },
  ]
  it('一页可能以不止一种身份写进度——任一命中即认领', () => {
    expect(findResumeRow(rows, ['stream:work-1', 'tmdb:9'])?.key).toBe('b')
    expect(findResumeRow(rows, [undefined, 'tmdb:1'])?.key).toBe('a')
  })
  it('都不命中 / 没有可认领的身份 → undefined', () => {
    expect(findResumeRow(rows, ['tmdb:9'])).toBeUndefined()
    expect(findResumeRow(rows, [undefined])).toBeUndefined()
  })
  it('行已按 updatedAt 新→旧排好,取第一条命中的', () => {
    expect(findResumeRow(rows, ['tmdb:1', 'stream:work-1'])?.key).toBe('a')
  })
})
