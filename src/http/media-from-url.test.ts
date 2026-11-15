// GET /api/media/from-url —— 「给我这个链接里的媒体」的 HTTP 门。
// 它曾经叫 /api/enrich?source=url，2026-07-31 以「消费方为零」被删（c14f71d5）——但那次只数了
// 前端和 MCP，仓库外还有个 systemd 里跑着的微信 bot 在打它，第二天就 400 了。所以这里守两件事：
// 路由在（别再被当成死代码删掉），以及 content.enrich 的派发真的接到了 fetchUrl（漏接线只在活体炸：
// 包认领的站统统落成 unknown，没有一处会喊）。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHttpApp } from './app.ts'

const stubs = {
  service: { streamsResource: () => [] },
  itemStore: { get: () => undefined },
  health: async () => ({ cookies: { domains: [], updatedAt: null }, manifests: 0, streams: 0 }),
} as never

afterEach(() => { vi.unstubAllGlobals() })

describe('GET /api/media/from-url', () => {
  it('缺 url → 400 validation_error', async () => {
    const app = createHttpApp(stubs)
    const res = await app.request('/api/media/from-url')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('validation_error')
  })

  it('直链图片 → media[] 带回该图片（不需要任何插件后端）', async () => {
    const app = createHttpApp(stubs)
    const url = 'https://example.com/a.jpg'
    const res = await app.request(`/api/media/from-url?url=${encodeURIComponent(url)}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ platform: 'image', media: [{ kind: 'image', url }] })
  })

  it('包认领的站 → 经 content.enrich 按主机键派发到那条行，整件事交给它', async () => {
    const dispatch = vi.fn((_c: string, key: string) => (key === 'site.test' ? 'row-site' : null))
    const invoke = vi.fn(async () => ({
      strategy: 'sequential', provider: 'row-site', via: 'm', misses: [], timings: [],
      value: [{ platform: 'somesite', title: 't', media: [{ kind: 'video', url: '/api/media/play?platform=somesite&vid=X' }] }],
    }))
    const app = createHttpApp({
      ...(stubs as object),
      providers: { executor: { invoke }, stats: {} },
      providerBindings: { dispatch },
    } as never)
    const res = await app.request(`/api/media/from-url?url=${encodeURIComponent('https://www.site.test/video/X')}`)
    expect(res.status).toBe(200)
    expect(dispatch.mock.calls.map((c) => [c[0], c[1]])).toEqual([['content.enrich', 'www.site.test'], ['content.enrich', 'site.test']])
    expect(invoke).toHaveBeenCalledWith('row-site', { url: 'https://www.site.test/video/X' })
    expect(await res.json()).toMatchObject({ platform: 'somesite', title: 't' })
  })

  it('没人认领、也不是直链 → 200 + unknown + 那句提示（宿主不认识任何站）', async () => {
    const app = createHttpApp(stubs)
    const res = await app.request(`/api/media/from-url?url=${encodeURIComponent('https://www.some-video-site.test/video/123')}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.platform).toBe('unknown')
    expect(body.error).toMatch(/read_url/)
  })

  // 失败必须留一行服务端日志（host + 认领到的包名）——原本失败只到前端，排查只能靠用户截图。
  // 日志是卫生边界：**不带 query**（分享链接的 query 里常有签名/凭据参数），错误原文里带的
  // URL 也照剥。
  it('认领了的站失败 → 200+error 照旧，服务端记一行（含 host 与包名，不含 query）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const dispatch = vi.fn((_c: string, key: string) => (key === 'somesite-link' ? 'row-somesite' : null))
      const invoke = vi.fn(async () => {
        throw new Error('上游拒了: https://www.somesite.test/video/X?sign=SECRET&msToken=TOK 失败')
      })
      const links = { sync: (u: string) => ({ url: u, package: '@streamapp/somesite', platform: 'somesite' }), normalize: async (u: string) => ({ url: u, package: '@streamapp/somesite', platform: 'somesite', claimed: true }) }
      const app = createHttpApp({
        ...(stubs as object),
        providers: { executor: { invoke }, stats: {} },
        providerBindings: { dispatch },
        links,
      } as never)
      const res = await app.request(
        `/api/media/from-url?url=${encodeURIComponent('https://www.somesite.test/video/X?sign=SECRET&msToken=TOK')}`)
      expect(res.status).toBe(200)
      expect((await res.json()).error).toMatch(/上游拒了/)
      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0]?.[0])
      expect(line).toContain('host=www.somesite.test')
      expect(line).toContain('package=@streamapp/somesite')
      expect(line).not.toContain('SECRET')
      expect(line).not.toContain('TOK')
    } finally {
      warn.mockRestore()
    }
  })

  it('抛错那一路（502）同样记一行', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const dispatch = vi.fn(() => 'row-x')
      const invoke = vi.fn(async () => {
        throw new (await import('../providers/bindings.ts')).SlotBrokenError('chan', 'site', ['row-x'])
      })
      const app = createHttpApp({
        ...(stubs as object),
        providers: { executor: { invoke }, stats: {} },
        providerBindings: { dispatch },
      } as never)
      const res = await app.request(`/api/media/from-url?url=${encodeURIComponent('https://www.site.test/v/1')}`)
      expect(res.status).toBe(422)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('host=www.site.test')
    } finally {
      warn.mockRestore()
    }
  })

  // 统一链接规范化（src/links/normalize.ts，由 deps.links.normalize 提供）在**取数前**做：
  // 弹窗地址 / 分享文案 / 短链 / 追踪参数都在这一步归一；认得平台却抽不出规范地址 → 输入错误原话
  // 出来（200+error，不是 502，更不是拿个错误形状去打采集端）。
  describe('统一链接规范化（links.normalize 接线）', () => {
    const linksStub = (result: { url?: string; platform?: string; claimed?: boolean; error?: string; extracted?: boolean }) => ({
      sync: (u: string) => ({ url: u, package: 'pkg', platform: result.platform ?? 'douyin' }),
      normalize: async () => ({
        url: result.url ?? '', platform: result.platform, package: 'pkg', claimed: result.claimed ?? true,
        ...(result.error ? { error: result.error } : {}),
        ...(result.extracted ? { extracted: true } : {}),
      }),
    })

    it('弹窗地址 → 规范地址递给认领的行（派发看到的是 /video/<id>）', async () => {
      const dispatch = vi.fn((_c: string, key: string) => (key === 'douyin-link' ? 'row-douyin' : null))
      const seen: string[] = []
      const invoke = vi.fn(async (id: string, args: { url: string }) => {
        seen.push(args.url)
        return {
          strategy: 'sequential', provider: 'row-douyin', via: 'm', misses: [], timings: [],
          value: [{ platform: 'douyin', title: 't', media: [{ kind: 'video', url: 'https://www.douyin.com/video/7684184358583930148' }] }],
        }
      })
      const app = createHttpApp({
        ...(stubs as object),
        providers: { executor: { invoke }, stats: {} },
        providerBindings: { dispatch },
        links: linksStub({ url: 'https://www.douyin.com/video/7684184358583930148', platform: 'douyin' }),
      } as never)
      const res = await app.request('/api/media/from-url?url=' +
        encodeURIComponent('https://www.douyin.com/user/self?modal_id=7684184358583930148'))
      expect(res.status).toBe(200)
      expect(seen).toEqual(['https://www.douyin.com/video/7684184358583930148'])
    })

    it('整段分享文案 → 抽出链接再走（派发看到的是链接，不是文案）', async () => {
      const dispatch = vi.fn(() => 'row-douyin')
      const seen: string[] = []
      const invoke = vi.fn(async (id: string, args: { url: string }) => {
        seen.push(args.url)
        throw new Error('上游没起来: https://www.douyin.com/video/1?sign=SECRET 失败')
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const app = createHttpApp({
          ...(stubs as object),
          providers: { executor: { invoke }, stats: {} },
          providerBindings: { dispatch },
          links: linksStub({ url: 'https://www.douyin.com/video/1', platform: 'douyin', extracted: true }),
        } as never)
        const res = await app.request('/api/media/from-url?url=' +
          encodeURIComponent('复制打开抖音，看看【某某的作品】 https://v.douyin.com/abc/'))
        expect(res.status).toBe(200)
        expect(seen).toEqual(['https://www.douyin.com/video/1'])
        // 失败日志里的 host 也要是链接自己的，不是整段文案
        expect(String(warn.mock.calls[0]?.[0])).toContain('host=www.douyin.com')
      } finally {
        warn.mockRestore()
      }
    })

    it('认得平台但抽不出规范地址 → 200 + 输入错误原话（不进取数）', async () => {
      const dispatch = vi.fn(() => { throw new Error('不该派发') })
      const invoke = vi.fn(async () => { throw new Error('不该执行') })
      const app = createHttpApp({
        ...(stubs as object),
        providers: { executor: { invoke }, stats: {} },
        providerBindings: { dispatch },
        links: linksStub({ platform: 'douyin', error: '这个地址形状还不认识：www.douyin.com/user/MS4w（认领平台 douyin，但抽不出规范的作品地址）' }),
      } as never)
      const res = await app.request('/api/media/from-url?url=' +
        encodeURIComponent('https://www.douyin.com/user/MS4w'))
      expect(res.status).toBe(200)
      expect((await res.json()).error).toMatch(/这个地址形状还不认识：www\.douyin\.com\/user/)
    })
  })
})
