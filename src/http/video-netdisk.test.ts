import { describe, expect, it, vi } from 'vitest'
import { createHttpApp } from './app.ts'

describe('video resolve — netdisk direct-link only', () => {
  it('mapped episode redirects to its AList raw URL; unmapped episode is unavailable', async () => {
    const netdisk = {
      lookup: vi.fn((key: string) => key === 'item:ep-1'
        ? { setId: 'map_x', dirPath: '/d', rightFile: '01.mp4' }
        : undefined),
      resolveUrl: vi.fn(async () => 'https://alist.test/raw/01.mp4'),
      markError: vi.fn(),
    }
    const app = createHttpApp({
      itemStore: { get: () => undefined, recent: () => [] },
      netdisk,
    } as any)

    const resolved = await app.request('/api/media/videos/resolve?id=ep-1')
    expect(resolved.status).toBe(302)
    expect(resolved.headers.get('location')).toBe('https://alist.test/raw/01.mp4')
    expect(netdisk.lookup).toHaveBeenCalledWith('item:ep-1')

    expect((await app.request('/api/media/videos/resolve?id=missing')).status).toBe(404)
  })

  it('AList failure marks the mapping and never redirects to an official URL', async () => {
    const hit = { setId: 'map_x', dirPath: '/d', rightFile: '01.mp4' }
    const netdisk = {
      lookup: vi.fn(() => hit),
      resolveUrl: vi.fn(async () => { throw new Error('alist down') }),
      markError: vi.fn(),
    }
    const app = createHttpApp({
      itemStore: { get: () => undefined, recent: () => [] },
      netdisk,
    } as any)

    const res = await app.request('/api/media/videos/resolve?id=ep-1')
    expect(res.status).toBe(502)
    expect(res.headers.get('location')).toBeNull()
    expect(netdisk.markError).toHaveBeenCalledWith(hit, 'alist down')
  })

  // 用户在夸克删了文件 → AList `object not found`：这是终局，报精准 404（播放器分类器据此显示
  // 「文件已从网盘删除」而不是笼统「播放失败·重试后仍失败」），区别于临时故障的可重试 502。
  // 并触发一次后台自愈同步：改名/移动会被重新配上，真删除降级成 unmatched。
  it('a file deleted on the netdisk (object not found) → terminal 404 + fires self-heal', async () => {
    const hit = { setId: 'map_x', dirPath: '/d', rightFile: '01.mp4' }
    const netdisk = {
      lookup: vi.fn(() => hit),
      resolveUrl: vi.fn(async () => { throw new Error('[alist] code 500: object not found') }),
      markError: vi.fn(),
      resyncAfterGone: vi.fn(),
    }
    const app = createHttpApp({ itemStore: { get: () => undefined, recent: () => [] }, netdisk } as any)

    const res = await app.request('/api/media/videos/resolve?id=ep-1')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'netdisk_file_gone', detail: '该视频文件已从网盘中删除或移动' })
    expect(netdisk.markError).toHaveBeenCalledWith(hit, '[alist] code 500: object not found')
    expect(netdisk.resyncAfterGone).toHaveBeenCalledWith('map_x')
  })

  it('a transient AList failure → 502 and does NOT fire self-heal (no needless re-list)', async () => {
    const netdisk = {
      lookup: vi.fn(() => ({ setId: 'map_x', dirPath: '/d', rightFile: '01.mp4' })),
      resolveUrl: vi.fn(async () => { throw new Error('[alist] HTTP 502') }),
      markError: vi.fn(),
      resyncAfterGone: vi.fn(),
    }
    const app = createHttpApp({ itemStore: { get: () => undefined, recent: () => [] }, netdisk } as any)

    expect((await app.request('/api/media/videos/resolve?id=ep-1')).status).toBe(502)
    expect(netdisk.resyncAfterGone).not.toHaveBeenCalled()
  })
})

describe('video resolve — transcode-capable netdisk (quark), format=json', () => {
  const mkDeps = (rightFile: string) => {
    const hit = { setId: 'map_x', dirPath: '/quark/From Stream/movie', rightFile }
    const netdisk = {
      lookup: vi.fn(() => hit),
      resolveUrl: vi.fn(async () => '/_p/alist/p/quark/movie/raw.mp4?sign=z'),
      markError: vi.fn(),
    }
    const netdiskPlay = { supports: vi.fn((b: string) => b === 'quark') }
    const app = createHttpApp({
      itemStore: { get: () => undefined, recent: () => [] },
      netdisk,
      netdiskPlay,
    } as any)
    return { app, netdisk }
  }

  it('browser-native file (h264/aac mp4) → mode:native with the AList raw link', async () => {
    const { app, netdisk } = mkDeps('The.Movie.2026.1080p.x264.AAC.mp4')
    const res = await app.request('/api/media/videos/resolve?key=tmdb:1&format=json')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: 'native', url: '/_p/alist/p/quark/movie/raw.mp4?sign=z' })
    expect(netdisk.resolveUrl).toHaveBeenCalled()
  })

  it('transcode-needed file (hevc/mkv) → mode:hls pointing at the netdisk-play proxy', async () => {
    const { app, netdisk } = mkDeps('The.Movie.2026.2160p.HEVC.DTS.mkv')
    const res = await app.request('/api/media/videos/resolve?key=tmdb:1&format=json')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      mode: 'hls',
      url: `/api/media/netdisk-play?path=${encodeURIComponent('/quark/From Stream/movie/The.Movie.2026.2160p.HEVC.DTS.mkv')}`,
    })
    expect(netdisk.resolveUrl).not.toHaveBeenCalled()
  })

  it('non-json request keeps the legacy 302-to-transcode behavior', async () => {
    const { app } = mkDeps('The.Movie.2026.2160p.HEVC.DTS.mkv')
    const res = await app.request('/api/media/videos/resolve?key=tmdb:1')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `/api/media/netdisk-play?path=${encodeURIComponent('/quark/From Stream/movie/The.Movie.2026.2160p.HEVC.DTS.mkv')}`,
    )
  })
})

// 一集只有一份可播文件：同集的其余画质是整理的删除候选（只留最高质量那份），不是可切换的
// 播放候选——resolve 的 JSON 恒为 `{ mode, url }`，没有画质列表。
describe('video resolve — 一集一份可播文件, format=json', () => {
  it('响应只有 mode/url,不带画质候选', async () => {
    const hit = {
      setId: 'map_x',
      dirPath: '/quark/From Stream/show',
      rightFile: 'Show.S01E01.1080p.h264.mp4',
    }
    const netdisk = {
      lookup: vi.fn(() => hit),
      resolveUrl: vi.fn(async (h: { rightFile: string }) => `/_p/alist/p/quark/show/${h.rightFile}?sign=z`),
      markError: vi.fn(),
    }
    const netdiskPlay = { supports: vi.fn((b: string) => b === 'quark') }
    const app = createHttpApp({ itemStore: { get: () => undefined, recent: () => [] }, netdisk, netdiskPlay } as any)

    const res = await app.request('/api/media/videos/resolve?key=tmdb:1:S01E01&format=json')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      mode: 'native',
      url: '/_p/alist/p/quark/show/Show.S01E01.1080p.h264.mp4?sign=z',
    })
  })
})

describe('netdisk-play — HLS playlist rewrite + segment proxy', () => {
  const M3U8 = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXTINF:2.0,',
    'seg-0.ts?auth_key=AAA',
    '#EXTINF:2.0,',
    'seg-1.ts?auth_key=BBB',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n')

  it('rewrites relative segment URIs to the same-origin seg proxy', async () => {
    const netdisk = { fileId: vi.fn(async () => 'FID'), rawGatewayUrl: vi.fn(async () => '/raw') }
    const netdiskPlay = { stream: vi.fn(async () => ({ url: 'https://oss.quark.test/qv/abc/media.m3u8?token=T' })) }
    const credentialProvider = { cookieString: vi.fn(async () => 'ck=1') }
    const fetchMock = vi.fn(async () => new Response(M3U8, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }))
    vi.stubGlobal('fetch', fetchMock)

    const app = createHttpApp({
      itemStore: { get: () => undefined, recent: () => [] },
      netdisk,
      netdiskPlay,
      credentialProvider,
    } as any)

    const res = await app.request(`/api/media/netdisk-play?path=${encodeURIComponent('/quark/From Stream/m/x.mkv')}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.mpegurl')
    const body = await res.text()
    const seg0 = `/api/media/netdisk-play?seg=${encodeURIComponent('https://oss.quark.test/qv/abc/seg-0.ts?auth_key=AAA')}&backend=quark`
    expect(body).toContain(seg0)
    expect(body).not.toMatch(/^seg-0\.ts/m) // no raw relative segment left
    expect(fetchMock).toHaveBeenCalledWith('https://oss.quark.test/qv/abc/media.m3u8?token=T', expect.objectContaining({ headers: expect.objectContaining({ cookie: 'ck=1', referer: 'https://pan.quark.cn/' }) }))
    vi.unstubAllGlobals()
  })

  it('seg proxy relays segment bytes with quark cookie + referer', async () => {
    const credentialProvider = { cookieString: vi.fn(async () => 'ck=1') }
    const fetchMock = vi.fn(async () => new Response('TSDATA', { status: 200, headers: { 'content-type': 'video/mp2t', 'content-length': '6' } }))
    vi.stubGlobal('fetch', fetchMock)

    const app = createHttpApp({
      itemStore: { get: () => undefined, recent: () => [] },
      netdisk: {},
      netdiskPlay: {},
      credentialProvider,
    } as any)

    const seg = 'https://oss.quark.test/qv/abc/seg-0.ts?auth_key=AAA'
    const res = await app.request(`/api/media/netdisk-play?seg=${encodeURIComponent(seg)}&backend=quark`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp2t')
    expect(await res.text()).toBe('TSDATA')
    expect(fetchMock).toHaveBeenCalledWith(seg, expect.objectContaining({ headers: expect.objectContaining({ cookie: 'ck=1', referer: 'https://pan.quark.cn/' }) }))
    vi.unstubAllGlobals()
  })

  it('unsupported seg backend is rejected', async () => {
    const app = createHttpApp({ itemStore: { get: () => undefined, recent: () => [] }, netdisk: {}, netdiskPlay: {} } as any)
    const res = await app.request('/api/media/netdisk-play?seg=https%3A%2F%2Fx%2Fy.ts&backend=bogus')
    expect(res.status).toBe(400)
  })

  // 转码文件（mkv）走这条路：格式预检返回 hls url 后，真正的字节请求命中 netdisk-play。文件被删时
  // fileId 抛 object not found，原始直链回落也求不出 → 精准 404（这才是夸克 mkv 删档的实际出口）。
  it('a deleted transcode file (object not found on both fileId and raw fallback) → terminal 404 + self-heal by path', async () => {
    const netdisk = {
      fileId: vi.fn(async () => { throw new Error('[alist] code 500: object not found') }),
      rawGatewayUrl: vi.fn(async () => { throw new Error('[alist] code 500: object not found') }),
      // netdisk-play 只握着文件 path，靠 bindingForPath 反查出绑定 id 再自愈
      bindingForPath: vi.fn(() => ({ id: 'map_mkv' })),
      resyncAfterGone: vi.fn(),
    }
    const netdiskPlay = { stream: vi.fn() }
    const app = createHttpApp({ itemStore: { get: () => undefined, recent: () => [] }, netdisk, netdiskPlay } as any)

    const path = '/quark/From Stream/m/x.mkv'
    const res = await app.request(`/api/media/netdisk-play?path=${encodeURIComponent(path)}`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'netdisk_file_gone', detail: '该视频文件已从网盘中删除或移动' })
    expect(netdisk.bindingForPath).toHaveBeenCalledWith(path)
    expect(netdisk.resyncAfterGone).toHaveBeenCalledWith('map_mkv')
  })

  // 临时故障（cookie 失效 / CDN 抖）不是文件被删：fileId 挂但原始直链仍可求出 → 照旧 302 回落，
  // 播放器静默重试。守住「别把可重试的错误也报成终局 404」。
  it('a transient fileId failure still falls back to the raw direct link (302), not 404', async () => {
    const netdisk = {
      fileId: vi.fn(async () => { throw new Error('[alist] HTTP 502') }),
      rawGatewayUrl: vi.fn(async () => '/_p/alist/p/quark/m/x.mkv?sign=z'),
    }
    const netdiskPlay = { stream: vi.fn() }
    const app = createHttpApp({ itemStore: { get: () => undefined, recent: () => [] }, netdisk, netdiskPlay } as any)

    const res = await app.request(`/api/media/netdisk-play?path=${encodeURIComponent('/quark/From Stream/m/x.mkv')}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/_p/alist/p/quark/m/x.mkv?sign=z')
  })
})
