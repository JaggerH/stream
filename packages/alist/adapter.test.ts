import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { AlistAdapter, ALIST_SERVICE, type AlistAdapterDeps } from './adapter.ts'
import { loadPlugins } from '../../src/plugins/loader.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

/** 让 AlistClient 内部的 fetch 命中一个受控响应（AList v3: {code, data}）。 */
function jsonResponse(code: number, data: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => ({ code, data, message: 'msg' }) } as Response
}

const manifest = (mode: 'list' | 'resolve'): SourceManifest =>
  ({ id: `alist-${mode}`, adapter: 'alist', fixed_params: { mode } } as unknown as SourceManifest)

/** 宿主经 ctx 递的两样：这里容器地址恒定、唤醒直通。 */
const deps = (over: Partial<AlistAdapterDeps> = {}): AlistAdapterDeps => ({
  backendUrl: () => 'http://alist:5244',
  withAwake: (_s, fn) => fn(),
  ...over,
})

describe('alist plugin manifests', () => {
  it('loads plugins/alist as a 3-source plugin with the expected shape', () => {
    const pluginsDir = join(dirname(fileURLToPath(import.meta.url)), '..')
    const alist = loadPlugins(pluginsDir).find((p) => p.id === 'alist')
    expect(alist).toBeDefined()
    const sources = alist!.sources ?? []
    // 全名 = `<npm 包名>/<manifests.yaml 里写的局部名>`，前缀由装载期合成（toPluginDescriptor）。
    expect(sources.map((s) => s.id).sort())
      .toEqual(['@streamapp/alist/alist-audio', '@streamapp/alist/alist-list', '@streamapp/alist/alist-resolve'])
    // pluginId stamped by the loader → plugin page groups these under `alist`.
    expect(sources.every((s) => s.pluginId === 'alist')).toBe(true)
    const resolve = sources.find((s) => s.id === '@streamapp/alist/alist-resolve')!
    // provides makes it a Provider member candidate for the netdisk-file target type.
    expect(resolve.provides).toContain('netdisk-file')
    expect(resolve.capabilities).toContain('anchor')
  })

  it('manifests.yaml declares a loadable alist-audio audio source', () => {
    const manifestPath = join(dirname(fileURLToPath(import.meta.url)), 'manifests.yaml')
    const manifests = parse(readFileSync(manifestPath, 'utf8')) as Array<Record<string, unknown>>
    const audio = manifests.find((m) => m.id === 'alist-audio')
    expect(audio).toBeDefined()
    expect(audio!.adapter).toBe('alist')
    expect(audio!.normalizer).toBe('alist')
    expect((audio!.fixed_params as Record<string, unknown>).mode).toBe('audio')
    // schema 硬要求：capabilities 非空 + cadence_hint_seconds
    expect(Array.isArray(audio!.capabilities) && (audio!.capabilities as unknown[]).length > 0).toBe(true)
    expect(typeof audio!.cadence_hint_seconds).toBe('number')
    // params_schema.path 必填（source 的采集目标）
    expect((audio!.params_schema as Record<string, { required?: boolean }>).path.required).toBe(true)
  })
})

describe('AlistAdapter', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.ALIST_TOKEN
    delete process.env.ALIST_URL
  })

  // 网盘底座只有内置托管一种形态：地址和 token 都由宿主给，没有环境变量这一层。
  // 留着它们的后果是「机器上碰巧设了这个变量」就悄悄把请求引到别处 / 换了一把凭据。
  it('ALIST_URL / ALIST_TOKEN 环境变量不再生效：地址只认 ctx.backendUrl，token 只认宿主给的', async () => {
    process.env.ALIST_URL = 'http://from-env'
    process.env.ALIST_TOKEN = 'env-tok'
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { raw_url: 'http://cdn/x' }))
    const adapter = new AlistAdapter(deps(), 'tok')
    await adapter.fetch({ path: '/d/x' }, manifest('resolve'))
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://alist:5244/api/fs/get')
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'tok' })
  })

  it('地址来自 ctx.backendUrl，且惰性：构造期宿主还答不出、请求时才读到（host 档开机时容器睡着）', async () => {
    let target: string | undefined
    const adapter = new AlistAdapter(deps({ backendUrl: () => target }), 'tok')
    target = 'http://127.0.0.1:45001'
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { raw_url: 'http://cdn/x' }))
    await adapter.fetch({ path: '/d/x' }, manifest('resolve'))
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:45001/api/fs/get')
  })

  it('每次打容器都经 deps.withAwake，唤醒键是本包的 service 名', async () => {
    const seen: string[] = []
    const withAwake: AlistAdapterDeps['withAwake'] = async (service, fn) => { seen.push(service); return fn() }
    const adapter = new AlistAdapter(deps({ withAwake }), 'tok')
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { raw_url: 'http://cdn/x' }))
    await adapter.fetch({ path: '/d/x' }, manifest('resolve'))
    expect(seen).toEqual([ALIST_SERVICE])
    expect(ALIST_SERVICE).toBe('alist')
  })

  it('resolve mode → returns {path, raw_url} from AlistClient.rawUrl', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { raw_url: 'http://cdn/01.mp4' }))
    const adapter = new AlistAdapter(deps(), 'tok')
    const out = await adapter.fetch({ path: '/d/01.mp4' }, manifest('resolve'))
    expect(out).toEqual([{ path: '/d/01.mp4', raw_url: 'http://cdn/01.mp4' }])
    // token reached AlistClient → authorization header carries it bare.
    const [, init] = fetchMock.mock.calls[0]
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'tok' })
  })

  it('list mode → returns files (directories filtered out)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { content: [{ name: '01.mp4', size: 10, is_dir: false }, { name: 'sub', size: 0, is_dir: true }] }),
    )
    const adapter = new AlistAdapter(deps(), 'tok')
    const out = await adapter.fetch({ path: '/d' }, manifest('list'))
    expect(out).toEqual([{ name: '01.mp4', size: 10, isDir: false }])
  })

  it('token 和取 token 的通道都没有（宿主没接上）→ fetch 抛错说清，一个请求都不发', async () => {
    process.env.ALIST_TOKEN = 'env-tok' // 环境变量救不了它
    const adapter = new AlistAdapter(deps())
    await expect(adapter.fetch({ path: '/d/x' }, manifest('resolve'))).rejects.toThrow(/宿主未接管/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // 启动时容器在睡 → 宿主没拿到 token，但递了接管通道。第一次真要用时把 token 取来。
  it('没有 token 但宿主给了接管通道 → 第一次 fetch 时取 token 再请求', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { raw_url: 'http://cdn/x' }))
    const refresh = vi.fn(async () => 'provisioned')
    const adapter = new AlistAdapter(deps(), undefined, refresh)
    await adapter.fetch({ path: '/d/x' }, manifest('resolve'))
    await adapter.fetch({ path: '/d/y' }, manifest('resolve'))
    expect(refresh).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'provisioned' })
  })
})

describe('AlistAdapter mode=audio', () => {
  it('recursively lists audio files as raw items with absolute path + clean title', async () => {
    const audioManifest = () => ({ id: 'alist-audio', adapter: 'alist', fixed_params: { mode: 'audio' } } as unknown as SourceManifest)
    const listDirRecursive = vi.fn(async () => [
      { name: '瓜瓜乐3期/详解.mp3', size: 111, isDir: false },
      { name: 'cover.jpg', size: 222, isDir: false },      // 非音频，滤掉
      { name: '中元聊恐怖片.m4a', size: 333, isDir: false },
    ])
    const adapter = new AlistAdapter(deps(), 'tok')
    // 注入假 client，避开真实 HTTP
    ;(adapter as unknown as { client: unknown }).client = { listDirRecursive } as never

    const { items: out } = (await adapter.fetch({ path: '/quark/怡乐下架' }, audioManifest())) as { items: unknown[] }

    expect(out).toEqual([
      { guid: '/quark/怡乐下架/瓜瓜乐3期/详解.mp3', title: '详解', path: '/quark/怡乐下架/瓜瓜乐3期/详解.mp3', name: '详解.mp3', size: 111 },
      { guid: '/quark/怡乐下架/中元聊恐怖片.m4a', title: '中元聊恐怖片', path: '/quark/怡乐下架/中元聊恐怖片.m4a', name: '中元聊恐怖片.m4a', size: 333 },
    ])
    expect(listDirRecursive).toHaveBeenCalledWith('/quark/怡乐下架')
  })

  it('title 走 displayTitle：剥掉分享者电台名前缀,原始文件名(name/path)一字不动', async () => {
    const audioManifest = () => ({ id: 'alist-audio', adapter: 'alist', fixed_params: { mode: 'audio' } } as unknown as SourceManifest)
    const listDirRecursive = vi.fn(async () => [
      { name: '怡乐·455.现代版木仓下留人.mp3', size: 1, isDir: false },
      { name: '怡楽播客 - 069.四谈身边灵异事.mp3', size: 2, isDir: false },
      { name: '玄关笔记 - 07.甲木.mp3', size: 3, isDir: false }, // 两位号子节目前缀：不剥
    ])
    const adapter = new AlistAdapter(deps(), 'tok')
    ;(adapter as unknown as { client: unknown }).client = { listDirRecursive } as never

    const { items: out } = (await adapter.fetch({ path: '/d' }, audioManifest())) as { items: { title: string; name: string }[] }

    expect(out.map((o) => o.title)).toEqual(['455.现代版木仓下留人', '069.四谈身边灵异事', '玄关笔记 - 07.甲木'])
    // 真实文件名保留原样——追溯/对账靠它
    expect(out[0].name).toBe('怡乐·455.现代版木仓下留人.mp3')
  })

  // 一条 audio 流 = 一个目录，目录名就是电台/专辑名——报上去，订阅时名字自动填好。
  // 作者推断兜不住这一档：网盘文件没有 author。
  it('reports the directory name as the feed title', async () => {
    const audioManifest = () => ({ id: 'alist-audio', adapter: 'alist', fixed_params: { mode: 'audio' } } as unknown as SourceManifest)
    const listDirRecursive = vi.fn(async () => [{ name: '01.mp3', size: 1, isDir: false }])
    const adapter = new AlistAdapter(deps(), 'tok')
    ;(adapter as unknown as { client: unknown }).client = { listDirRecursive } as never

    const res = (await adapter.fetch({ path: '/quark/怡楽播客/' }, audioManifest())) as { title?: string }
    expect(res.title).toBe('怡楽播客')
  })

  it('omits the feed title at the netdisk root', async () => {
    const audioManifest = () => ({ id: 'alist-audio', adapter: 'alist', fixed_params: { mode: 'audio' } } as unknown as SourceManifest)
    const listDirRecursive = vi.fn(async () => [])
    const adapter = new AlistAdapter(deps(), 'tok')
    ;(adapter as unknown as { client: unknown }).client = { listDirRecursive } as never

    const res = (await adapter.fetch({ path: '/' }, audioManifest())) as { title?: string }
    expect(res.title).toBeUndefined()
  })
})
