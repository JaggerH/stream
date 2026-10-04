import { describe, it, expect } from 'vitest'
import { planVideo } from './videoPlan.ts'
import type { Media } from './types.ts'

const vid = (m: Partial<Extract<Media, { kind: 'video' }>>): Extract<Media, { kind: 'video' }> => ({
  kind: 'video',
  ...m,
})

// 源站原图（qpic 一类图床按 Referer 防盗链）。海报**必须**从后端图片出口取，否则浏览器直连
// 拿到的是一张空白图——播放器一片黑而没有任何报错。下面每条断言里的 poster 都钉着这一点。
const P = 'https://p.qpic.cn/p.jpg'
const C = 'https://p.qpic.cn/c.jpg'
const proxied = (base: string, u: string) => `${base}/api/media/image?url=${encodeURIComponent(u)}`

describe('planVideo', () => {
  // A netdisk-bound followed-stream episode resolves by item id (…/resolve?id=<item.id>) rather than
  // by leftKey. The item id is stable + globally unique (the netdisk mapping already keys on it), so
  // it doubles as the watch-progress resume key too — namespaced `item:` to stay clear of tmdb keys.
  it('plans a directly resolved video URL as a file and resumes off its item id', () => {
    expect(planVideo({ kind: 'video', url: '/api/media/videos/resolve?id=e1', poster: P }, 'http://api'))
      .toEqual({
        kind: 'file',
        src: 'http://api/api/media/videos/resolve?id=e1',
        poster: proxied('http://api', P),
        progressKey: 'item:e1',
        subtitleListUrl: 'http://api/api/media/netdisk-subtitle-list?id=e1',
        subtitleUrlBase: 'http://api/api/media/netdisk-subtitle?id=e1',
      })
  })

  // Movies/episodes play through /api/media/videos/resolve?key=<leftKey>. The leftKey is a stable,
  // globally-unique id (embeds the tmdb work id), so it doubles as the watch-progress resume key —
  // decoded back from the url the call site percent-encoded it into.
  it('reuses the resolve leftKey as the progress key for an episode', () => {
    const url = '/api/media/videos/resolve?key=' + encodeURIComponent('tmdb:1399:S01E01')
    const key = encodeURIComponent('tmdb:1399:S01E01')
    expect(planVideo({ kind: 'video', url, poster: P }, 'http://api')).toEqual({
      kind: 'file',
      src: `http://api${url}`,
      poster: proxied('http://api', P),
      progressKey: 'tmdb:1399:S01E01',
      subtitleListUrl: `http://api/api/media/netdisk-subtitle-list?key=${key}`,
      subtitleUrlBase: `http://api/api/media/netdisk-subtitle?key=${key}`,
    })
  })

  it('reuses the resolve leftKey as the progress key for a movie', () => {
    const url = '/api/media/videos/resolve?key=' + encodeURIComponent('tmdb:969681')
    expect(planVideo({ kind: 'video', url }, 'http://api')).toMatchObject({
      kind: 'file',
      progressKey: 'tmdb:969681',
    })
  })

  it('does not set a progress key for a direct absolute url with no key/id (remote backend / AList)', () => {
    const plan = planVideo({ kind: 'video', url: 'http://alist.example/d/movie.mkv' }, 'http://api')
    expect(plan).not.toHaveProperty('progressKey')
  })

  it('带 provider+vid 的视频 → dash + progressive 两个地址走通用路由，progressKey 是 provider:vid', () => {
    const plan = planVideo({ kind: 'video', provider: 'bilibili', vid: 'BV1x' }, 'http://h')
    expect(plan).toEqual({
      kind: 'dash',
      dashUrl: 'http://h/api/media/dash?platform=bilibili&vid=BV1x',
      progressiveUrl: 'http://h/api/media/play?platform=bilibili&vid=BV1x',
      progressKey: 'bilibili:BV1x',
      poster: undefined,
    })
  })

  it('带海报时海报仍走后端图片出口（与通用路由无关）', () => {
    expect(planVideo(vid({ provider: 'bilibili', vid: 'BV1M2Jj6yE5g', poster: P }), 'http://h')).toEqual({
      kind: 'dash',
      dashUrl: 'http://h/api/media/dash?platform=bilibili&vid=BV1M2Jj6yE5g',
      progressiveUrl: 'http://h/api/media/play?platform=bilibili&vid=BV1M2Jj6yE5g',
      progressKey: 'bilibili:BV1M2Jj6yE5g',
      poster: proxied('http://h', P),
    })
  })

  it('任何别的平台同样走这条（前端不认识平台名）', () => {
    const plan = planVideo({ kind: 'video', provider: 'somesite', vid: 'ID/1' }, 'http://h')
    expect(plan.kind).toBe('dash')
    expect((plan as { dashUrl: string }).dashUrl).toBe('http://h/api/media/dash?platform=somesite&vid=ID%2F1')
  })

  it('抖音和别的平台一样走 (provider, vid)：page_url 只是回原站的链接，不参与选播放路', () => {
    const plan = planVideo({ kind: 'video', provider: 'douyin', vid: '7659053070483203953', page_url: 'https://www.douyin.com/video/7659053070483203953' }, 'http://h')
    expect(plan.kind).toBe('dash')
    expect((plan as { progressiveUrl: string }).progressiveUrl).toBe('http://h/api/media/play?platform=douyin&vid=7659053070483203953')
    expect((plan as { dashUrl: string }).dashUrl).toBe('http://h/api/media/dash?platform=douyin&vid=7659053070483203953')
    expect((plan as { progressKey: string }).progressKey).toBe('douyin:7659053070483203953')
  })

  it('TikTok 同理：作品 id 就是 vid', () => {
    const plan = planVideo({ kind: 'video', provider: 'tiktok', vid: '7301234567890123456', page_url: 'https://www.tiktok.com/@x/video/7301234567890123456' }, 'http://h')
    expect(plan.kind).toBe('dash')
    expect((plan as { progressiveUrl: string }).progressiveUrl).toBe('http://h/api/media/play?platform=tiktok&vid=7301234567890123456')
  })

  // 存量条目（Task 2 之前 normalize 的）身上还挂着 embed；它不是任何后端路由，别当 file 播——
  // 那会让 <video> 去打一个 404。前端不认识平台名，所以也没有"抖音就用 embed"的特判：
  // 有 vid 走 (provider, vid)，没 vid 的 embed 落到 iframe 那一档（一个点开即走的外链）。
  it('抖音存量条目带 embed：有 vid 仍走 (provider, vid)，embed 被忽略', () => {
    const plan = planVideo({ kind: 'video', provider: 'douyin', vid: '1', embed: '/api/media/douyin/video?u=STALE' }, 'http://h')
    expect(plan.kind).toBe('dash')
  })

  it('plans an iframe for a non-bilibili embeddable video', () => {
    expect(planVideo(vid({ provider: 'youtube', embed: 'https://e/p' }), 'http://h')).toEqual({
      kind: 'iframe',
      src: 'https://e/p',
    })
  })

  it('falls back to a poster when nothing is playable', () => {
    expect(planVideo(vid({ provider: 'rss', poster: C }), 'http://h')).toEqual({
      kind: 'poster',
      src: proxied('http://h', C),
    })
  })

  it('returns none when there is neither stream nor poster', () => {
    expect(planVideo(vid({ provider: 'rss' }), 'http://h')).toEqual({ kind: 'none' })
  })

  it('video-service-backed item (vid + duration, no code change needed) plans as dash', () => {
    expect(planVideo(vid({ provider: 'bilibili', vid: 'BV1x', poster: P, duration_s: 30 }), 'http://h')).toEqual({
      kind: 'dash',
      dashUrl: 'http://h/api/media/dash?platform=bilibili&vid=BV1x',
      progressiveUrl: 'http://h/api/media/play?platform=bilibili&vid=BV1x',
      progressKey: 'bilibili:BV1x',
      poster: proxied('http://h', P),
    })
  })

  // 海报和正片是**两种**地址：正片的字节归后端发（backendUrl 只补个源），海报是浏览器自己去
  // 取的图（必须走图片代理，否则防盗链图床返回空白图、播放器一片黑且不报错）。这两条钉住的
  // 就是"别把 poster 也当成正片那样只补源"。
  describe('poster 走图片代理，不是只补个源', () => {
    it('每一档可播计划的海报都是代理地址', () => {
      const plans = [
        planVideo({ kind: 'video', url: '/api/media/videos/resolve?id=e1', poster: P }, 'http://h'),
        planVideo(vid({ provider: 'bilibili', vid: 'BV1x', poster: P }), 'http://h'),
        planVideo(vid({ provider: 'douyin', vid: '1', page_url: 'https://d/1', poster: P }), 'http://h'),
        planVideo(vid({ provider: 'somesite', vid: 'n1', poster: P }), 'http://h'),
      ]
      for (const plan of plans) {
        expect(plan).toHaveProperty('poster', proxied('http://h', P))
      }
      expect(planVideo(vid({ provider: 'rss', poster: P }), 'http://h')).toEqual({
        kind: 'poster',
        src: proxied('http://h', P),
      })
    })

    // 海报本身已经是后端的根相对路由时**不能**再包一层（那是让后端去取自己）——只补源。
    it('海报是后端根相对路由 → 只补源，不代理', () => {
      expect(planVideo(vid({ provider: 'rss', poster: '/api/media/netdisk-thumb?p=a' }), 'http://h')).toEqual({
        kind: 'poster',
        src: 'http://h/api/media/netdisk-thumb?p=a',
      })
    })
  })
})
