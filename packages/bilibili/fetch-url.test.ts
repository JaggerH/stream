import { describe, it, expect } from 'vitest'
import { fetchUrlFor } from './fetch-url.ts'

const client = {
  view: async () => ({ title: '标题', owner: { mid: '1', name: 'UP', face: 'https://x/f.jpg' } }),
} as never

describe('bilibili-fetch-url', () => {
  it('从链接里抠出 BV 号，媒体地址走宿主的通用播放路由', async () => {
    const r = await fetchUrlFor(client, 'https://www.bilibili.com/video/BV1xx411c7mD?p=1')
    expect(r.platform).toBe('bilibili')
    expect(r.title).toBe('标题')
    expect(r.author).toBe('UP')
    expect(r.author_avatar).toBe('https://x/f.jpg')
    expect(r.media[0].url).toBe('/api/media/play?platform=bilibili&vid=BV1xx411c7mD')
    expect(r.media[0].download_url).toBe('/api/media/play?platform=bilibili&vid=BV1xx411c7mD&dl=1')
  })
  it('av 号链接：id 保留 av 前缀，view 用 aid 查', async () => {
    let asked: unknown
    const c = { view: async (ref: unknown) => { asked = ref; return { title: 't', owner: null } } } as never
    const r = await fetchUrlFor(c, 'https://www.bilibili.com/video/av170001/')
    expect(asked).toEqual({ aid: '170001' })
    expect(r.media[0].url).toBe('/api/media/play?platform=bilibili&vid=av170001')
    expect(r.author).toBe('')
  })
  it('抠不出视频 id → 带原因的失败，不是空成功', async () => {
    const r = await fetchUrlFor(client, 'https://www.bilibili.com/')
    expect(r.media).toEqual([])
    expect(r.error).toBeTruthy()
  })
  it('view 接口打嗝 → 仍然给得出可播地址（标题作者缺就缺）', async () => {
    const broken = { view: async () => { throw new Error('boom') } } as never
    const r = await fetchUrlFor(broken, 'https://b23.tv/BV1xx411c7mD')
    expect(r.media).toHaveLength(1)
    expect(r.title).toBe('')
  })

  describe('b23.tv 短码：只跟一跳 302', () => {
    /** 一个假 fetch：记下每次调用的 method，按脚本回 status + Location。 */
    const redirecting = (loc: string | null, opts: { headStatus?: number } = {}) => {
      const calls: string[] = []
      const f = (async (_u: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        calls.push(method)
        if (method === 'HEAD' && opts.headStatus && opts.headStatus !== 302) {
          return new Response(null, { status: opts.headStatus })
        }
        return new Response(null, { status: 302, headers: loc ? { location: loc } : {} })
      }) as unknown as typeof fetch
      return { f, calls }
    }

    it('短码 → Location 落在主站 → 用它上面的 BV 号', async () => {
      const { f, calls } = redirecting('https://www.bilibili.com/video/BV1xx411c7mD?share_source=copy')
      const r = await fetchUrlFor(client, 'https://b23.tv/abc123', { fetch: f })
      expect(calls).toEqual(['HEAD'])
      expect(r.error).toBeUndefined()
      expect(r.media[0].url).toBe('/api/media/play?platform=bilibili&vid=BV1xx411c7mD')
      expect(r.title).toBe('标题')
    })
    it('HEAD 被拒 → 换 GET 再拿一次 Location', async () => {
      const { f, calls } = redirecting('https://www.bilibili.com/video/av170001', { headStatus: 405 })
      const r = await fetchUrlFor(client, 'https://b23.tv/abc123', { fetch: f })
      expect(calls).toEqual(['HEAD', 'GET'])
      expect(r.media[0].url).toBe('/api/media/play?platform=bilibili&vid=av170001')
    })
    it('跳去别处 → 不当视频链接看，仍是带原因的失败', async () => {
      const { f } = redirecting('https://evil.example/video/BV1xx411c7mD')
      const r = await fetchUrlFor(client, 'https://b23.tv/abc123', { fetch: f })
      expect(r.media).toEqual([])
      expect(r.error).toBeTruthy()
    })
    it('没有 Location / fetch 抛 → 失败，不抛', async () => {
      const { f } = redirecting(null)
      expect((await fetchUrlFor(client, 'https://b23.tv/abc123', { fetch: f })).media).toEqual([])
      const boom = (async () => { throw new Error('offline') }) as unknown as typeof fetch
      expect((await fetchUrlFor(client, 'https://b23.tv/abc123', { fetch: boom })).error).toBeTruthy()
    })
    it('不是 b23.tv 的链接抠不到 id 就不发任何请求', async () => {
      const { f, calls } = redirecting('https://www.bilibili.com/video/BV1xx411c7mD')
      await fetchUrlFor(client, 'https://www.bilibili.com/', { fetch: f })
      expect(calls).toEqual([])
    })
  })
})
