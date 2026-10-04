import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { DouyinTiktokDownloadApiAdapter, DOUYIN_SERVICE, isDouyinUrl, type AdapterDeps } from './adapter.ts'
import { DETAIL_UNAVAILABLE_FIELD } from '../douyin-detail.ts'
import { isUnavailable } from '../../../shared/package-sdk/errors.ts'
import type { ApiBinding, SourceManifest } from '../../../src/manifest/types.ts'

const BASE = 'http://api.test'
const src = (api: ApiBinding, id = 's'): SourceManifest =>
  ({ id, adapter: 'Douyin_TikTok_Download_API', api }) as SourceManifest

/** 宿主经 `ctx` 递进来的两样：容器地址 thunk + 唤醒包装。测试里唤醒直接透传。 */
const deps = (over: Partial<AdapterDeps> = {}): AdapterDeps => ({
  backendUrl: () => BASE,
  withAwake: (_s, fn) => fn(),
  // 缺省**抛**，不回空：抖音详情已经不经容器，哪条路误走到 readSource 上要当场红，
  // 而不是拿一个空数组静默产出「读到了、只是没内容」。
  readSource: async (id) => { throw new Error(`本条用例没给 readSource，却跑了源 ${id}`) },
  ...over,
})

/** 抖音作品详情跑的是本包的 `douyin-detail` recipe。这个假 readSource 记下问了哪条源、带什么参数，
 *  并按 recipe 的 output 形状回一行（`douyin` 那格是整条 aweme）。传 Error 就模拟 recipe 跑挂。 */
function recipeSource(result: Record<string, unknown> | Error) {
  const seen: { sourceId: string; params: Record<string, string> }[] = []
  const readSource: AdapterDeps['readSource'] = async (sourceId, params) => {
    seen.push({ sourceId, params })
    if (result instanceof Error) throw result
    return [{ guid: String(result.aweme_id ?? ''), douyin: result }]
  }
  return { seen, readSource }
}

/** 「作品没了」那一路：recipe **正常产出**一条带站方判词的条目（不是抛异常——抛了会被判成 drift，
 *  三次就把整个源隔离，活体真撞过）。 */
function goneSource(said: string) {
  const readSource: AdapterDeps['readSource'] = async () => [{ guid: 'x', [DETAIL_UNAVAILABLE_FIELD]: said }]
  return { readSource }
}

/** Capture every fetched URL and reply with a canned payload keyed by path (json + text). */
function mockFetch(replies: Record<string, unknown>) {
  const calls: string[] = []
  const fn = vi.fn(async (url: string) => {
    calls.push(url)
    const path = new URL(url).pathname
    const body = replies[path] ?? { code: 200, data: {} }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response
  })
  vi.stubGlobal('fetch', fn)
  return { calls }
}

const adapter = (d: AdapterDeps = deps()) => new DouyinTiktokDownloadApiAdapter(d)

// 容器地址只有两个来源：环境变量 `DOUYIN_API_URL`（显式覆盖，包自己读）> 宿主经 `ctx.backendUrl()`
// 递进来的托管容器地址。两个都没有 → 空串（fetch 会报 URL 解析失败，宿主那侧的 plugin-target
// 频道负责喊）。
describe('DouyinTiktokDownloadApiAdapter — 容器地址接线', () => {
  beforeEach(() => { delete process.env.DOUYIN_API_URL })
  afterEach(() => {
    delete process.env.DOUYIN_API_URL
    vi.unstubAllGlobals()
  })

  it('backendUrl 回 http://x → 请求打 http://x/api/…（尾斜杠剃掉）', async () => {
    const { calls } = mockFetch({})
    await adapter(deps({ backendUrl: () => 'http://x/' })).fetch({ bv_id: 'BV1' }, src({ handler: 'bilibili-comments' }))
    expect(calls[0]).toMatch(/^http:\/\/x\/api\/bilibili\/web\/fetch_video_comments\?/)
  })

  it('DOUYIN_API_URL 设了就优先于 backendUrl', async () => {
    process.env.DOUYIN_API_URL = 'http://10.0.0.21:3007'
    const { calls } = mockFetch({})
    await adapter(deps({ backendUrl: () => 'http://x' })).fetch({ bv_id: 'BV1' }, src({ handler: 'bilibili-comments' }))
    expect(calls[0]).toMatch(/^http:\/\/10\.0\.0\.21:3007\/api\//)
  })

  it('两个来源都没有 → base 是空串，不再默认任何 loopback', async () => {
    const { calls } = mockFetch({})
    await adapter(deps({ backendUrl: () => undefined })).fetch({ bv_id: 'BV1' }, src({ handler: 'bilibili-comments' })).catch(() => {})
    expect(calls[0]).toMatch(/^\/api\//)
  })

  it('每一次容器请求都经 withAwake，且以本包的 service 名为键', async () => {
    const seen: string[] = []
    const withAwake: AdapterDeps['withAwake'] = async (service, fn) => { seen.push(service); return fn() }
    mockFetch({ '/api/bilibili/web/fetch_one_video': { code: 200, data: { code: 0, data: { cid: 5 } } }, '/api/bilibili/web/fetch_video_danmaku': '<i></i>' })
    await adapter(deps({ withAwake })).fetch({ bv_id: 'BV1' }, src({ handler: 'bilibili-danmaku' }))
    expect(seen).toEqual([DOUYIN_SERVICE, DOUYIN_SERVICE])
    expect(DOUYIN_SERVICE).toBe('douyin-tiktok-download-api')
  })

  it('backendUrl 是惰性的：构造时答空、请求时才有值（host 档开机时容器睡着）', async () => {
    let origin: string | undefined
    const a = adapter(deps({ backendUrl: () => origin }))
    origin = 'http://127.0.0.1:45123'
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, status: 200 }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await a.follow('u1')
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:45123/douyin/follow')
  })
})

describe('DouyinTiktokDownloadApiAdapter — declarative routing', () => {
  afterEach(() => vi.unstubAllGlobals())

  // Real backend wraps bilibili's official envelope, so the payload is DOUBLY nested
  // ({code,data:{code,message,ttl,data:{…}}}) and the yaml unwrap is `data.data`. Mock the
  // real shape so this test can't drift from production the way the old single-layer mocks did.
  it('bilibili-video: unwraps the doubly-nested envelope (data.data), param mapped', async () => {
    const { calls } = mockFetch({
      '/api/bilibili/web/fetch_one_video': { code: 200, data: { code: 0, message: 'OK', ttl: 1, data: { bvid: 'BV1', title: 'hi' } } },
    })
    const items = await adapter().fetch(
      { bv_id: 'BV1' },
      src({ endpoint: '/api/bilibili/web/fetch_one_video', query: { bv_id: { from: 'bv_id', required: true } }, unwrap: 'data.data' })
    )
    expect(calls[0]).toContain(`${BASE}/api/bilibili/web/fetch_one_video?bv_id=BV1`)
    expect(items).toEqual([{ bvid: 'BV1', title: 'hi' }])
  })

  // NOTE: tiktok unwrap paths are PROVISIONAL (not curl-verified); this exercises the
  // executor wiring + query mapping, not a confirmed production shape. See the yaml banner.
  it('tiktok-user-post: nested unwrap + defaults', async () => {
    const { calls } = mockFetch({
      '/api/tiktok/web/fetch_user_post': { code: 200, data: { itemList: [{ id: 'a' }, { id: 'b' }] } },
    })
    const items = await adapter().fetch(
      { sec_uid: 'SEC' },
      src({
        endpoint: '/api/tiktok/web/fetch_user_post',
        query: { secUid: { from: 'sec_uid', required: true }, cursor: { from: 'cursor', default: 0 }, count: { from: 'count', default: 35 } },
        unwrap: 'data.itemList',
      })
    )
    expect(calls[0]).toContain('secUid=SEC')
    expect(calls[0]).toContain('cursor=0')
    expect(calls[0]).toContain('count=35')
    expect(items).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('rejects a missing required param before any fetch', async () => {
    const { calls } = mockFetch({})
    await expect(
      adapter().fetch({}, src({ endpoint: '/api/bilibili/web/fetch_one_video', query: { bv_id: { from: 'bv_id', required: true } }, unwrap: 'data' }))
    ).rejects.toThrow(/bv_id/)
    expect(calls).toHaveLength(0)
  })

  it('throws when a source has no api binding', async () => {
    mockFetch({})
    await expect(adapter().fetch({}, { id: 'x', adapter: 'Douyin_TikTok_Download_API' } as SourceManifest)).rejects.toThrow(/no api binding/)
  })
})

describe('DouyinTiktokDownloadApiAdapter — handlers', () => {
  afterEach(() => vi.unstubAllGlobals())

  // douyin-user / douyin-follow 也搬走了（本包的 douyin-user.recipe.json / douyin-follow.recipe.json，
  // 源 id 没变）。两条搬的理由不一样，都钉在这里免得谁把容器那条路接回来：
  //   · user   —— `/aweme/v1/web/aweme/post/` 恒 403 `Blocked by ArgusSecurityPlugin`，和 listcollection /
  //               aweme-detail 同一道闸，与 cookie 新旧无关（活体 2026-09-22 整份登录 cookie 直打，同样 403）。
  //   · follow —— 它打的容器端点 `/api/douyin/web/fetch_follow_feed` **在 fork 里根本不存在**（恒 404），
  //               也就是说它从来没成功过。
  it.each(['douyin-user', 'douyin-follow'])('%s: handler no longer exists (源已迁成本包的 recipe)', async (handler) => {
    const { calls } = mockFetch({})
    await expect(adapter().fetch({ count: 5 }, src({ handler }))).rejects.toThrow(/unknown handler/)
    expect(calls).toHaveLength(0)
  })

  // 收藏也搬去 recipes/douyin 了（进收藏页拦第一发 listcollection + 页内调站点自己的签名客户端）。
  // 它原来打的那个 HTTP 端点是死路：`/aweme/v1/web/aweme/listcollection/` 恒 403
  // `Blocked by ArgusSecurityPlugin`——挪到 Argus 签名头后面了，和 bogus 无关（X-Bogus 与
  // a_bogus × GET/POST 四种组合实测同样的 403），上游至今没有任何 Argus 实现。钉住 handler
  // 确实没了，免得谁又把这条路接回来。
  it('douyin-collection: handler no longer exists (collection lives in recipes/douyin)', async () => {
    mockFetch({})
    await expect(adapter().fetch({}, src({ handler: 'douyin-collection' }))).rejects.toThrow(/unknown handler|douyin-collection/i)
  })

  // Keyword search moved to recipes/douyin (登录态浏览器拦 XHR). The HTTP endpoint it used to
  // fall back to is a dead end — no cookie → inner status_code 2483「请先登录」 under an outer
  // 200 (a SILENT empty list), and the real cookie is 7KB+, too big for a query param. Assert
  // the handler is gone so nobody wires that path back in.
  it('douyin-search: handler no longer exists (search lives in recipes/douyin)', async () => {
    mockFetch({})
    await expect(adapter().fetch({ keyword: '露营' }, src({ handler: 'douyin-search' }))).rejects.toThrow(/unknown handler|douyin-search/i)
  })

  it('bilibili-comments: rpid switches to the reply endpoint, unwraps replies', async () => {
    const { calls } = mockFetch({
      '/api/bilibili/web/fetch_comment_reply': { code: 200, data: { code: 0, data: { replies: [{ rpid: 9 }] } } },
    })
    const items = await adapter().fetch({ bv_id: 'BV1', rpid: '9' }, src({ handler: 'bilibili-comments' }))
    expect(calls[0]).toContain('/api/bilibili/web/fetch_comment_reply')
    expect(calls[0]).toContain('rpid=9')
    expect(items).toEqual([{ rpid: 9 }])
  })

  it('bilibili-danmaku: two-step cid → xml → parsed list', async () => {
    const { calls } = mockFetch({
      '/api/bilibili/web/fetch_one_video': { code: 200, data: { code: 0, data: { cid: 555 } } },
      '/api/bilibili/web/fetch_video_danmaku': '<i><d p="1.5,1,25">hello</d><d p="3,1,25">world</d></i>',
    })
    const items = await adapter().fetch({ bv_id: 'BV1' }, src({ handler: 'bilibili-danmaku' }))
    expect(calls[0]).toContain('/api/bilibili/web/fetch_one_video')
    expect(calls[1]).toContain('cid=555')
    expect(items).toEqual([{ time: 1.5, text: 'hello' }, { time: 3, text: 'world' }])
  })

  it('tiktok-comments: comment_id switches to the reply endpoint', async () => {
    const { calls } = mockFetch({
      '/api/tiktok/web/fetch_post_comment_reply': { code: 200, data: { comments: [{ cid: 'r1' }] } },
    })
    const items = await adapter().fetch({ aweme_id: 'A1', comment_id: 'C1' }, src({ handler: 'tiktok-comments' }))
    expect(calls[0]).toContain('/api/tiktok/web/fetch_post_comment_reply')
    expect(calls[0]).toContain('comment_id=C1')
    expect(items).toEqual([{ cid: 'r1' }])
  })

  it('tiktok-user-collect: injects the tiktok cookie as a query param', async () => {
    const a = adapter()
    await a.init({ TIKTOK_COOKIE: 'TCK' })
    const { calls } = mockFetch({
      '/api/tiktok/web/fetch_user_collect': { code: 200, data: { itemList: [{ id: 'k1' }] } },
    })
    const items = await a.fetch({ sec_uid: 'SEC' }, src({ handler: 'tiktok-user-collect' }))
    expect(calls[0]).toContain('cookie=TCK')
    expect(calls[0]).toContain('secUid=SEC')
    expect(items).toEqual([{ id: 'k1' }])
  })

  it('unknown handler throws', async () => {
    mockFetch({})
    await expect(adapter().fetch({}, src({ handler: 'nope' }))).rejects.toThrow(/unknown handler/)
  })
})

// The upstream wraps EVERY response in `{code, data}`; an expired cookie / risk-control /
// upstream fault surfaces as a non-200 envelope (HTTP 200) or a 4xx or a login HTML page.
// These must become specific, actionable messages — not a silent empty list or "HTTP 4xx".
describe('DouyinTiktokDownloadApiAdapter — error reporting', () => {
  afterEach(() => vi.unstubAllGlobals())

  function mockOnce(res: { ok?: boolean; status?: number; text: string }) {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: res.ok ?? true,
      status: res.status ?? 200,
      text: async () => res.text,
    }) as unknown as Response))
  }

  it('non-200 envelope code → explicit upstream error with a cookie hint', async () => {
    mockOnce({ text: JSON.stringify({ code: 401, message: 'user not login', router: '/api/douyin/web/fetch_video_comments' }) })
    await expect(adapter().fetch({ aweme_id: '1' }, src({ endpoint: '/api/douyin/web/fetch_video_comments', query: { aweme_id: { from: 'aweme_id', required: true } }, unwrap: 'data.comments' })))
      .rejects.toThrow(/code=401.*(登录|cookie)/i)
  })

  it('HTTP 4xx → status + body snippet + cookie hint for 401/403/422', async () => {
    mockOnce({ ok: false, status: 422, text: '{"detail":"cookie is required"}' })
    await expect(adapter().fetch({ aweme_id: '1' }, src({ endpoint: '/api/douyin/web/fetch_video_comments', query: { aweme_id: { from: 'aweme_id', required: true } }, unwrap: 'data.comments' })))
      .rejects.toThrow(/HTTP 422.*(登录|cookie).*cookie is required/is)
  })

  it('non-JSON body (login/风控 page) → an explicit non-JSON error, not a JSON crash', async () => {
    mockOnce({ text: '<!doctype html><title>登录</title>' })
    await expect(adapter().fetch({ aweme_id: '1' }, src({ endpoint: '/api/douyin/web/fetch_video_comments', query: { aweme_id: { from: 'aweme_id', required: true } }, unwrap: 'data.comments' })))
      .rejects.toThrow(/非 JSON/)
  })

  it('a healthy 200 envelope (code=200) still passes through', async () => {
    mockOnce({ text: JSON.stringify({ code: 200, data: { comments: [{ cid: 'c1', text: 'hi' }] } }) })
    const items = (await adapter().fetch({ aweme_id: '1' }, src({ endpoint: '/api/douyin/web/fetch_video_comments', query: { aweme_id: { from: 'aweme_id', required: true } }, unwrap: 'data.comments' }))) as Array<Record<string, unknown>>
    expect(items[0].cid).toBe('c1')
  })
})

// play_addr 路径 calibrated 2026-07-06 against live video-service (:3007), aweme 7658131616287867377:
// data.video.play_addr.url_list = [ <douyinvod CDN mp4>, <backup CDN>, <www.douyin.com/aweme/v1/play 兜底> ]
// CDN 需 Referer https://www.douyin.com/（无则 403），且honor Range → 206。见 scratchpad/vd.json。
describe('DouyinTiktokDownloadApiAdapter — resolveVideoPlayAddr (video-douyin member)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('resolves the first CDN play_addr url + the required Referer header', async () => {
    const { seen, readSource } = recipeSource({ aweme_id: '123', video: { play_addr: { url_list: [
      'https://v26-web.douyinvod.com/a/v.mp4',
      'https://v11-weba.douyinvod.com/b/v.mp4',
      'https://www.douyin.com/aweme/v1/play/?video_id=x',
    ] } } })
    const r = await adapter(deps({ readSource })).resolveVideoPlayAddr('https://www.douyin.com/video/123')
    expect(r).toEqual({ url: 'https://v26-web.douyinvod.com/a/v.mp4', headers: { Referer: 'https://www.douyin.com/' } })
    // 抖音这条路**一个容器请求都不发**：跑的是本包的 douyin-detail recipe，原链接原样当入口递过去。
    expect(seen).toEqual([{ sourceId: 'douyin-detail', params: { url: 'https://www.douyin.com/video/123' } }])
  })

  it('returns null when the work has no play_addr at all (genuinely empty, not a filtered work)', async () => {
    const { readSource } = recipeSource({ aweme_id: '7658131616287867377', video: {} })
    expect(await adapter(deps({ readSource })).resolveVideoPlayAddr('https://www.douyin.com/video/7658131616287867377')).toBeNull()
  })

  // 作品被删 / 私密：判据发生在 recipe 的页内 call（站方回 status_code 0 却没有 aweme_detail），
  // `readDouyinAweme` 据 `DETAIL_UNAVAILABLE_MARKER` 把它翻成 ContentUnavailableError —— 调用点
  // 据此回 404 而不是 502，成员管道据此不记源的健康账。
  it('deleted/private video: ContentUnavailableError (isUnavailable)，带站方原话', async () => {
    const said = '因作品权限或已被删除，无法观看，去看看其他作品吧'
    const err = await adapter(deps(goneSource(said)))
      .resolveVideoPlayAddr('https://www.iesdouyin.com/share/video/7662668719604420273/?region=CN')
      .catch((e: unknown) => e)
    expect(isUnavailable(err)).toBe(true)
    expect((err as Error).message).toBe(said)
  })

  // recipe 自己跑挂（风控挑战 / webpack 布局变了）**不是**「内容不可用」——原错误照传，别翻成 404：
  // 前者要人去看采集，后者告诉用户「这条没了」，说反了就把一次故障藏成一条正常的空结果。
  it('recipe failure propagates as-is, never as ContentUnavailable', async () => {
    const { readSource } = recipeSource(new Error('douyin-detail: signed-request module not found in any webpackChunk global'))
    const err = await adapter(deps({ readSource })).resolveVideoPlayAddr('https://v.douyin.com/abcXYZ/').catch((e: unknown) => e)
    expect(isUnavailable(err)).toBe(false)
    expect((err as Error).message).toMatch(/webpackChunk/)
  })
})

// 分路判据：这条链接归抖音（recipe）还是 TikTok（容器）。它决定走哪条路，所以单独钉住。
describe('isDouyinUrl', () => {
  it('认抖音主站 / 短链 / 分享域，不认 TikTok 和撞名域', () => {
    for (const u of [
      'https://www.douyin.com/video/123',
      'https://v.douyin.com/abcXYZ/',
      'https://www.iesdouyin.com/share/video/1/?region=CN',
      'douyin.com',
    ]) expect(isDouyinUrl(u)).toBe(true)
    for (const u of [
      'https://www.tiktok.com/@a/video/1',
      'https://www.douyin.com.evil.example/video/1',
      'https://notdouyin.com/video/1',
    ]) expect(isDouyinUrl(u)).toBe(false)
  })
})

// 解析成员：`video-douyin` / `video-tiktok` Provider 行的唯一成员，入参是执行器摊开的
// `{ vid, format }`（非 builtin 源的对象输入进 params），出参是 `VideoResolved[]`（空 = decline）。
// vid 是作品 id（抖音 aweme_id / TikTok 作品 id），成员自己拼成主站链接交给容器。
describe('DouyinTiktokDownloadApiAdapter — douyin-resolve / tiktok-resolve members', () => {
  afterEach(() => vi.unstubAllGlobals())

  const PLAY = {
    code: 200,
    data: { video: { play_addr: { url_list: [
      'https://v26-web.douyinvod.com/a/v.mp4',
      'https://www.douyin.com/aweme/v1/play/?video_id=x',
    ] } } },
  }

  /** recipe 产物形状的同一条作品（`douyin` 那格 = 整条 aweme）。 */
  const AWEME = { aweme_id: '123', video: { play_addr: { url_list: [
    'https://v26-web.douyinvod.com/a/v.mp4',
    'https://www.douyin.com/aweme/v1/play/?video_id=x',
  ] } } }

  it('douyin-resolve: { vid, format: progressive } → 跑 douyin-detail recipe（入口是主站链接），回 progressive + Referer', async () => {
    const { seen, readSource } = recipeSource(AWEME)
    const { calls } = mockFetch({})
    const out = await adapter(deps({ readSource })).fetch({ vid: '123', format: 'progressive' }, src({ handler: 'douyin-resolve' }, 'douyin-resolve'))
    expect(out).toEqual([{ kind: 'progressive', url: 'https://v26-web.douyinvod.com/a/v.mp4', headers: { Referer: 'https://www.douyin.com/' } }])
    expect(seen).toEqual([{ sourceId: 'douyin-detail', params: { url: 'https://www.douyin.com/video/123' } }])
    expect(calls).toHaveLength(0) // 容器一次都没被打扰
  })

  it('douyin-resolve: format 缺省也按 progressive 走（音轨那一档给整片，抖音没有独立音轨）', async () => {
    const { seen, readSource } = recipeSource(AWEME)
    const a = adapter(deps({ readSource }))
    expect(await a.fetch({ vid: '123', format: 'audio' }, src({ handler: 'douyin-resolve' }))).toHaveLength(1)
    expect(await a.fetch({ vid: '123' }, src({ handler: 'douyin-resolve' }))).toHaveLength(1)
    expect(seen).toHaveLength(2)
  })

  it('douyin-resolve: format: dash → [] 如实报没有，不跑 recipe', async () => {
    const { seen, readSource } = recipeSource(AWEME)
    expect(await adapter(deps({ readSource })).fetch({ vid: '123', format: 'dash' }, src({ handler: 'douyin-resolve' }))).toEqual([])
    expect(seen).toHaveLength(0)
  })

  it('douyin-resolve: 没有 vid → [] decline，不跑 recipe', async () => {
    const { seen, readSource } = recipeSource(AWEME)
    expect(await adapter(deps({ readSource })).fetch({ format: 'progressive' }, src({ handler: 'douyin-resolve' }))).toEqual([])
    expect(seen).toHaveLength(0)
  })

  it('douyin-resolve: 读到了作品但它没有可播地址 → []', async () => {
    const { readSource } = recipeSource({ aweme_id: '7658131616287867377', video: {} })
    expect(await adapter(deps({ readSource })).fetch({ vid: '7658131616287867377', format: 'progressive' }, src({ handler: 'douyin-resolve' }))).toEqual([])
  })

  it('douyin-resolve: 作品被删 / 私密 → 抛 ContentUnavailableError（isUnavailable 为 true）', async () => {
    const err = await adapter(deps(goneSource('抱歉，作品不见了'))).fetch({ vid: '7662668719604420273', format: 'progressive' }, src({ handler: 'douyin-resolve' })).catch((e: unknown) => e)
    expect(isUnavailable(err)).toBe(true)
  })

  // ⚠️ TikTok 的 itemStruct 形状 PROVISIONAL — not live-verified（本机容器打 tiktokv.com 回空），
  // 下面三条按 tiktok-types.ts 与站方 web 结构写；拿到真数据后回来重校。
  it('tiktok-resolve: 主站链接拼成 tiktok.com/video/<id>，itemStruct 的 video.playAddr 为主、Referer 是 tiktok 的', async () => {
    const { calls } = mockFetch({
      '/api/hybrid/video_data': { code: 200, data: { id: '7000000000000000001', video: { playAddr: 'https://v16-webapp.tiktok.example/play/', play_addr: { url_list: ['https://aweme-style.example/x.mp4'] } } } },
    })
    const out = await adapter().fetch({ vid: '7000000000000000001', format: 'progressive' }, src({ handler: 'tiktok-resolve' }, 'tiktok-resolve'))
    expect(out).toEqual([{ kind: 'progressive', url: 'https://v16-webapp.tiktok.example/play/', headers: { Referer: 'https://www.tiktok.com/' } }])
    expect(calls[0]).toContain(`url=${encodeURIComponent('https://www.tiktok.com/video/7000000000000000001')}`)
  })

  it('tiktok-resolve: 没有 playAddr → 退到 bitrateInfo[0].PlayAddr.UrlList → 再退到 aweme 风格的 play_addr', async () => {
    mockFetch({
      '/api/hybrid/video_data': { code: 200, data: { video: { playAddr: '', bitrateInfo: [{ PlayAddr: { UrlList: ['https://v19.tiktok.example/br0'] } }] } } },
    })
    expect(await adapter().fetch({ vid: '1' }, src({ handler: 'tiktok-resolve' }))).toEqual([
      { kind: 'progressive', url: 'https://v19.tiktok.example/br0', headers: { Referer: 'https://www.tiktok.com/' } },
    ])
    mockFetch({ '/api/hybrid/video_data': { code: 200, data: { video: { play_addr: { url_list: ['https://aweme-style.example/x.mp4'] } } } } })
    expect((await adapter().fetch({ vid: '1' }, src({ handler: 'tiktok-resolve' })))[0]).toMatchObject({ url: 'https://aweme-style.example/x.mp4' })
  })

  it('tiktok-resolve: 三条路径都没有 → [] decline（只打一次容器）', async () => {
    const { calls } = mockFetch({ '/api/hybrid/video_data': { code: 200, data: { video: { cover: 'x' } } } })
    expect(await adapter().fetch({ vid: '1' }, src({ handler: 'tiktok-resolve' }))).toEqual([])
    expect(calls.map((u) => new URL(u).pathname)).toEqual(['/api/hybrid/video_data'])
  })

  it('tiktok-resolve: 容器失败时原错误照传，不翻译成「内容不可用」', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(new URL(url).pathname)
      return { ok: false, status: 400, text: async () => 'An error occurred.' } as unknown as Response
    }))
    const err = await adapter().fetch({ vid: '7000000000000000001', format: 'progressive' }, src({ handler: 'tiktok-resolve' })).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/HTTP 400/)
    expect(isUnavailable(err)).toBe(false)
    expect(calls).toEqual(['/api/hybrid/video_data'])
  })

  it('tiktok-resolve: format: dash → []；没有 vid → []', async () => {
    const { calls } = mockFetch({ '/api/hybrid/video_data': PLAY })
    expect(await adapter().fetch({ vid: '1', format: 'dash' }, src({ handler: 'tiktok-resolve' }))).toEqual([])
    expect(await adapter().fetch({}, src({ handler: 'tiktok-resolve' }))).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

// 贴链接抓媒体：`douyin-url` / `tiktok-url` Provider 行的成员，manifest `output: object`，
// 返回 `[FetchUrlResult]`。字段映射归 fetch-url.test.ts；这里只钉派发与 hybridVideoData 的契约。
describe('DouyinTiktokDownloadApiAdapter — douyin-fetch-url / tiktok-fetch-url members', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('hybridVideoData: 抖音链接（含短链）→ 跑 douyin-detail recipe，原链接原样当入口，容器不参与', async () => {
    const { seen, readSource } = recipeSource({ aweme_id: '1', desc: 'd' })
    const { calls } = mockFetch({})
    expect(await adapter(deps({ readSource })).hybridVideoData('https://v.douyin.com/abc/')).toEqual({ aweme_id: '1', desc: 'd' })
    // 短链不在我们这儿解析——浏览器自己跟完跳转就落在作品页上。
    expect(seen).toEqual([{ sourceId: 'douyin-detail', params: { url: 'https://v.douyin.com/abc/' } }])
    expect(calls).toHaveLength(0)
  })

  it('hybridVideoData: recipe 跑完了却没有产物 → 抛，不回 {}（空成功会静默产出一条没媒体的结果）', async () => {
    const readSource: AdapterDeps['readSource'] = async () => []
    await expect(adapter(deps({ readSource })).hybridVideoData('https://www.douyin.com/video/1')).rejects.toThrow(/没有读到作品详情/)
  })

  it('hybridVideoData: TikTok 链接照旧打容器 /api/hybrid/video_data?url=…&minimal=false', async () => {
    const { calls } = mockFetch({ '/api/hybrid/video_data': { code: 200, data: { id: '1', desc: 'd' } } })
    expect(await adapter().hybridVideoData('https://www.tiktok.com/@a/video/1')).toEqual({ id: '1', desc: 'd' })
    expect(calls[0]).toContain(`/api/hybrid/video_data?url=${encodeURIComponent('https://www.tiktok.com/@a/video/1')}`)
    expect(calls[0]).toContain('minimal=false')
  })

  it('hybridVideoData: TikTok 那条路 HTTP 200 却没有 data → 抛，不回 {}', async () => {
    mockFetch({ '/api/hybrid/video_data': { code: 200 } })
    await expect(adapter().hybridVideoData('https://www.tiktok.com/@a/video/1')).rejects.toThrow(/没有回 data/)
  })

  it('douyin-fetch-url: { url } → [FetchUrlResult]，platform=douyin，download_url 走通用播放路由', async () => {
    const { readSource } = recipeSource({ aweme_id: '7301234567890123456', desc: 't', author: { nickname: 'a' }, video: { play_addr: { url_list: ['https://cdn.example/v.mp4'] } } })
    const out = await adapter(deps({ readSource })).fetch({ url: 'https://www.douyin.com/video/7301234567890123456' }, src({ handler: 'douyin-fetch-url' }, 'douyin-fetch-url'))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ platform: 'douyin', title: 't', author: 'a' })
    expect((out[0] as { media: Array<{ download_url?: string }> }).media[0].download_url).toBe('/api/media/play?platform=douyin&vid=7301234567890123456&dl=1')
  })

  it('douyin-fetch-url: recipe 跑挂 → 结果里带原话，不抛（认领了却失败要把原话带出去）', async () => {
    const { readSource } = recipeSource(new Error('douyin-detail: aweme/detail refused (status_code=undefined)'))
    const out = await adapter(deps({ readSource })).fetch({ url: 'https://www.douyin.com/video/1' }, src({ handler: 'douyin-fetch-url' }))
    expect(out[0]).toMatchObject({ platform: 'douyin', media: [] })
    expect((out[0] as { error?: string }).error).toMatch(/aweme\/detail refused/)
  })

  it('tiktok-fetch-url: platform=tiktok，vid 取作品 id', async () => {
    mockFetch({
      '/api/hybrid/video_data': { code: 200, data: { id: '7400000000000000000', desc: 'tt', video: { playAddr: 'https://v16.tiktok.example/play/' } } },
    })
    const out = await adapter().fetch({ url: 'https://www.tiktok.com/@a/video/7400000000000000000' }, src({ handler: 'tiktok-fetch-url' }))
    expect(out[0]).toMatchObject({ platform: 'tiktok', title: 'tt' })
    expect((out[0] as { media: Array<{ url: string; download_url?: string }> }).media[0]).toMatchObject({
      url: 'https://v16.tiktok.example/play/',
      download_url: '/api/media/play?platform=tiktok&vid=7400000000000000000&dl=1',
    })
  })
})
