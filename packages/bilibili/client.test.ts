import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BilibiliClient, videoRefOf } from './client.ts'
import { allStreamUrls, isAllowedSegHost } from '../../src/video/dash.ts'

const json = (body: unknown) => ({ json: async () => body }) as unknown as Response

/** 一个按 URL 片段应答的假 fetch，顺带记下每次请求的 headers。 */
function fakeFetch(routes: Array<[RegExp, unknown]>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string> })
    const hit = routes.find(([re]) => re.test(u))
    if (!hit) throw new Error(`unexpected fetch ${u}`)
    return json(hit[1])
  })
  return { f, calls }
}

// 每条用例用**不同的** id：客户端里的缓存是模块级 Map（搬过来的行为，不是本次要改的），
// 复用同一个 id 会让第二条用例读到第一条的缓存、看起来像"没发请求"。
let n = 0
const freshBv = () => `BV1test${++n}`

beforeEach(() => { vi.useRealTimers() })
afterEach(() => { vi.unstubAllGlobals() })

describe('videoRefOf', () => {
  it('BV → bvid；av<数字> / 裸数字 → aid', () => {
    expect(videoRefOf('BV1xx')).toEqual({ bvid: 'BV1xx' })
    expect(videoRefOf('av12345')).toEqual({ aid: '12345' })
    expect(videoRefOf('12345')).toEqual({ aid: '12345' })
  })
})

describe('BilibiliClient — cookie 每次现取，不在构造时快照', () => {
  it('myUid 从 cookie 的 DedeUserID 读；cookie 换了下一次就读到新的', async () => {
    let cookie: string | undefined = 'SESSDATA=a; DedeUserID=111; bili_jct=x'
    const client = new BilibiliClient(async () => cookie)
    expect(await client.myUid()).toBe('111')
    cookie = 'DedeUserID=222'
    expect(await client.myUid()).toBe('222')
    cookie = undefined
    expect(await client.myUid()).toBeNull()
  })

  it('请求头带 UA + Referer，有 cookie 就带 Cookie；没有就不带这一格', async () => {
    const { f, calls } = fakeFetch([[/web-interface\/card/, { code: 0, data: { card: { name: 'UP', face: '//i0.hdslb.com/a.jpg' } } }]])
    vi.stubGlobal('fetch', f)
    const client = new BilibiliClient(async () => undefined)
    const u = await client.user(String(9000 + n++))
    expect(u.face).toBe('https://i0.hdslb.com/a.jpg')
    expect(calls[0].headers).toMatchObject({ Referer: 'https://www.bilibili.com' })
    expect(calls[0].headers['User-Agent']).toMatch(/Mozilla/)
    expect(calls[0].headers).not.toHaveProperty('Cookie')
  })

  it('progressive：view → cid → playurl durl，回 url + 带 cookie 的请求头', async () => {
    const bv = freshBv()
    const { f, calls } = fakeFetch([
      [/web-interface\/view/, { code: 0, data: { cid: 77 } }],
      [/player\/playurl/, { code: 0, data: { durl: [{ url: 'https://upos-sz.bilivideo.com/v.mp4' }] } }],
    ])
    vi.stubGlobal('fetch', f)
    const client = new BilibiliClient(async () => 'SESSDATA=s')
    const r = await client.progressive({ bvid: bv })
    expect(r.url).toBe('https://upos-sz.bilivideo.com/v.mp4')
    expect(r.headers).toMatchObject({ Cookie: 'SESSDATA=s', Referer: 'https://www.bilibili.com' })
    expect(calls.map((c) => c.url)).toEqual([
      expect.stringContaining(`view?bvid=${bv}`),
      expect.stringContaining(`playurl?bvid=${bv}&cid=77`),
    ])
    expect(calls[1].headers.Cookie).toBe('SESSDATA=s')
  })

  it('dash：映射主备 URL，请求头随结果申报（headers）——不碰宿主的分片信任表', async () => {
    const bv = freshBv()
    const { f } = fakeFetch([
      [/web-interface\/view/, { code: 0, data: { cid: 5 } }],
      [/player\/playurl/, {
        code: 0,
        data: {
          dash: {
            duration: 12,
            video: [{ id: 80, codecs: 'avc1', mimeType: 'video/mp4', width: 1920, height: 1080, frameRate: '30', bandwidth: 1000,
              baseUrl: 'https://cn-primary.bilivideo.com/v.m4s', backupUrl: ['https://cn-backup.mirrorks.com/v.m4s'],
              SegmentBase: { Initialization: '0-9', indexRange: '10-20' } }],
            audio: [{ id: 30280, codecs: 'mp4a', mime_type: 'audio/mp4', bandwidth: 200, base_url: 'https://cn-audio.bilivideo.com/a.m4s',
              segment_base: { initialization: '0-5', index_range: '6-9' } }],
          },
        },
      }],
    ])
    vi.stubGlobal('fetch', f)
    const client = new BilibiliClient(async () => 'SESSDATA=t')
    const d = await client.dash({ bvid: bv })
    expect(d.durationS).toBe(12)
    expect(d.video[0]).toMatchObject({ url: 'https://cn-primary.bilivideo.com/v.m4s', backupUrls: ['https://cn-backup.mirrorks.com/v.m4s'], init: '0-9', indexRange: '10-20' })
    expect(d.audio[0]).toMatchObject({ url: 'https://cn-audio.bilivideo.com/a.m4s', init: '0-5', indexRange: '6-9', mimeType: 'audio/mp4' })
    // 登记归 /api/media/dash 路由（src/http/app.video-resolve.test.ts）；包这边只负责把头申报出来，
    // 且申报的正是它自己打 API 用的那套（Cookie + Referer + UA）。
    expect(d.headers).toMatchObject({ Cookie: 'SESSDATA=t', Referer: 'https://www.bilibili.com' })
    expect(d.headers?.['User-Agent']).toMatch(/Mozilla/)
    expect(allStreamUrls(d)).toEqual(['https://cn-primary.bilivideo.com/v.m4s', 'https://cn-backup.mirrorks.com/v.m4s', 'https://cn-audio.bilivideo.com/a.m4s'])
    for (const u of allStreamUrls(d)) expect(isAllowedSegHost(u), `${u} 不该由包登记`).toBe(false)
  })

  it('dash：命中缓存时 headers 仍按此刻的 cookie 现取，不是缓存那份', async () => {
    const bv = freshBv()
    const { f } = fakeFetch([
      [/web-interface\/view/, { code: 0, data: { cid: 5 } }],
      [/player\/playurl/, { code: 0, data: { dash: { duration: 1, video: [], audio: [
        { id: 30216, codecs: 'mp4a', mimeType: 'audio/mp4', bandwidth: 100, baseUrl: 'https://cn-a.bilivideo.com/a.m4s', SegmentBase: { Initialization: '0-1', indexRange: '2-3' } },
      ] } } }],
    ])
    vi.stubGlobal('fetch', f)
    let cookie = 'SESSDATA=first'
    const client = new BilibiliClient(async () => cookie)
    expect((await client.dash({ bvid: bv })).headers?.Cookie).toBe('SESSDATA=first')
    cookie = 'SESSDATA=rotated'
    const again = await client.dash({ bvid: bv })
    expect(again.headers?.Cookie).toBe('SESSDATA=rotated')
    expect(again).not.toHaveProperty('exp')
    expect(f).toHaveBeenCalledTimes(2) // view + playurl 一次；第二次 dash() 走缓存
  })

  it('audio：dash 里最小码率那条音轨 + 请求头', async () => {
    const bv = freshBv()
    const { f } = fakeFetch([
      [/web-interface\/view/, { code: 0, data: { cid: 6 } }],
      [/player\/playurl/, {
        code: 0,
        data: { dash: { duration: 1, video: [], audio: [
          { id: 1, bandwidth: 300, baseUrl: 'https://a.bilivideo.com/hi.m4s' },
          { id: 2, bandwidth: 100, baseUrl: 'https://a.bilivideo.com/lo.m4s' },
        ] } },
      }],
    ])
    vi.stubGlobal('fetch', f)
    const client = new BilibiliClient(async () => 'SESSDATA=u')
    const a = await client.audio({ bvid: bv })
    expect(a.url).toBe('https://a.bilivideo.com/lo.m4s')
    expect(a.headers.Cookie).toBe('SESSDATA=u')
  })

  it('view：一次拿标题与 UP 主；没有 owner 就回 null', async () => {
    const bv = freshBv()
    const { f } = fakeFetch([[/web-interface\/view/, { code: 0, data: { title: '标题', owner: { mid: 42, name: 'UP', face: '//i.hdslb.com/f.jpg' } } }]])
    vi.stubGlobal('fetch', f)
    const client = new BilibiliClient(async () => undefined)
    expect(await client.view({ bvid: bv })).toEqual({ title: '标题', owner: { mid: '42', name: 'UP', face: 'https://i.hdslb.com/f.jpg' } })
    const { f: f2 } = fakeFetch([[/web-interface\/view/, { code: 0, data: { title: 'T' } }]])
    vi.stubGlobal('fetch', f2)
    expect(await client.view({ bvid: freshBv() })).toEqual({ title: 'T', owner: null })
  })

  it('comments：bvid 先经 view 换 aid，再取 reply；UP 主自己的评论标 isUp，首页带置顶', async () => {
    const bv = freshBv()
    const { f } = fakeFetch([
      [/web-interface\/view/, { code: 0, data: { aid: 1234 } }],
      [/v2\/reply/, {
        code: 0,
        data: {
          upper: { mid: 7, top: { rpid: 1, mid: 7, member: { uname: 'UP', avatar: '//i/a.jpg' }, content: { message: '置顶' }, like: 3 } },
          page: { count: 2, size: 20, num: 1 },
          replies: [{ rpid: 2, mid: 8, member: { uname: '路人' }, content: { message: '嗨' } }],
        },
      }],
    ])
    vi.stubGlobal('fetch', f)
    const client = new BilibiliClient(async () => undefined)
    const c = await client.comments({ bvid: bv })
    expect(c.total).toBe(2)
    expect(c.pinned).toMatchObject({ rpid: '1', author: 'UP', isUp: true, text: '置顶', avatar: 'https://i/a.jpg' })
    expect(c.comments).toEqual([expect.objectContaining({ rpid: '2', author: '路人', isUp: false })])
  })

  it('userByName：优先同名精确命中，否则取榜首；空名回 null', async () => {
    const { f } = fakeFetch([[/search\/type\?search_type=bili_user/, { code: 0, data: { result: [
      { mid: 1, uname: '某某 official', upic: '//i/1.jpg' }, { mid: 2, uname: `某某${n}`, upic: '//i/2.jpg' },
    ] } }]])
    vi.stubGlobal('fetch', f)
    const client = new BilibiliClient(async () => undefined)
    expect(await client.userByName(`某某${n}`)).toEqual({ uid: '2', name: `某某${n}`, face: 'https://i/2.jpg' })
    expect(await client.userByName('   ')).toBeNull()
  })
})
