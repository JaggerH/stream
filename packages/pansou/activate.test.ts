import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { activate } from './activate.ts'
import type { PluginContext } from '../../src/packages/activate.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

const ctx = (config: Record<string, unknown> = {}, over: Partial<PluginContext> = {}): PluginContext => ({
  backendUrl: () => 'http://pansou:8888',
  withAwake: (_s, fn) => fn(),
  cookieFor: async () => undefined,
  // 这个包不碰登录态。桩子抛而不是 no-op：静默的空实现会让"其实调到了"这件事看不见。
  login: async () => { throw new Error('这个包不该调 login') },
  readSource: async () => { throw new Error('这个包不该调 readSource') },
  readArticle: async () => { throw new Error('这个包不该调 readArticle') },
  log: () => {},
  config,
  ...over,
})

const manifest = { id: 'pansou-search' } as unknown as SourceManifest

function okFetch() {
  const fetchMock = vi.fn(async (url: string) => {
    void url
    return { ok: true, status: 200, json: async () => ({ data: { results: [] } }) } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('pansou activate', () => {
  let prevPansouUrl: string | undefined
  beforeEach(() => {
    prevPansouUrl = process.env.PANSOU_URL
  })
  afterEach(() => {
    if (prevPansouUrl === undefined) delete process.env.PANSOU_URL
    else process.env.PANSOU_URL = prevPansouUrl
    vi.unstubAllGlobals()
  })

  it('registers the pansou adapter', () => {
    const out = activate(ctx())
    expect(Object.keys(out.adapters ?? {})).toEqual(['pansou'])
  })

  it('registers the pansou normalizer', () => {
    const out = activate(ctx())
    expect(Object.keys(out.normalizers ?? {})).toEqual(['pansou'])
  })

  // 宿主不再替这个包读任何专用配置项（config.yaml 里没有它的键）：显式覆盖只有包自己读的
  // PANSOU_URL 环境变量这一条（README 写明）。
  it('显式覆盖走包自己读的 PANSOU_URL，压过宿主给的容器地址', async () => {
    process.env.PANSOU_URL = 'http://example.test:9999'
    const out = activate(ctx())
    const fetchMock = okFetch()
    await out.adapters!.pansou.fetch({ keyword: 'x' }, manifest)
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://example.test:9999/api/search')
  })

  it('宿主递进来的 ctx.config 不再被当成地址来源', async () => {
    delete process.env.PANSOU_URL
    const out = activate(ctx({ url: 'http://stale.example:1' }))
    const fetchMock = okFetch()
    await out.adapters!.pansou.fetch({ keyword: 'x' }, manifest)
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://pansou:8888/api/search')
  })

  it('没有显式覆盖时容器地址来自 ctx.backendUrl，且经 ctx.withAwake 唤醒', async () => {
    delete process.env.PANSOU_URL
    const seen: string[] = []
    const withAwake: PluginContext['withAwake'] = async (service, fn) => { seen.push(service); return fn() }
    const out = activate(ctx({}, { backendUrl: () => 'http://127.0.0.1:44888', withAwake }))
    const fetchMock = okFetch()
    await out.adapters!.pansou.fetch({ keyword: 'x' }, manifest)
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:44888/api/search')
    expect(seen).toEqual(['pansou'])
  })
})
