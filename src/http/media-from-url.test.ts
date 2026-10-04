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
})
