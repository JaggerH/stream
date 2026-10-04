import { describe, it, expect, vi, afterEach } from 'vitest'
import { activate } from './activate.ts'
import type { PluginContext } from '../../src/packages/activate.ts'

const ctx = (over: Partial<PluginContext> = {}): PluginContext => ({
  backendUrl: () => 'http://douyin-tiktok-download-api',
  withAwake: (_s, fn) => fn(),
  cookieFor: async () => undefined,
  // 这个包不碰登录态。桩子抛而不是 no-op：静默的空实现会让"其实调到了"这件事看不见。
  login: async () => { throw new Error('这个包不该调 login') },
  readSource: async () => { throw new Error('这个包不该调 readSource') },
  readArticle: async () => { throw new Error('这个包不该调 readArticle') },
  log: () => {},
  config: {},
  ...over,
})

describe('Douyin_TikTok_Download_API activate', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.DOUYIN_API_URL
  })

  it('registers the adapter under the exact name source manifests reference', () => {
    const out = activate(ctx())
    expect(Object.keys(out.adapters ?? {})).toEqual(['Douyin_TikTok_Download_API'])
  })

  it('registers the douyin, tiktok and bilibili-web normalizers', () => {
    const out = activate(ctx())
    expect(Object.keys(out.normalizers ?? {})).toEqual(['douyin', 'tiktok', 'bilibili-web'])
  })

  // 容器地址不经 `ctx.config`——adapter 拿的是 `ctx.backendUrl` / `ctx.withAwake` 两个 thunk，
  // 请求时才求值。断的是真实副作用（fetch 打到哪、唤醒键是什么），不是私有字段。
  it('adapter 的请求经 ctx.withAwake（以本包 service 为键）、打到 ctx.backendUrl() 现取的地址', async () => {
    const awoke: string[] = []
    let origin: string | undefined // 构造时还没有（host 档容器睡着），请求时才有
    const out = activate(ctx({
      backendUrl: () => origin,
      withAwake: async (s, fn) => { awoke.push(s); return fn() },
    }))
    origin = 'http://127.0.0.1:45123'
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, status: 200 }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await out.adapters!.Douyin_TikTok_Download_API!.follow!('u1')
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:45123/douyin/follow')
    expect(awoke).toEqual(['douyin-tiktok-download-api'])
  })
})
