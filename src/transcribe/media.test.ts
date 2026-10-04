import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transcribableMedia, resolveMediaBytes } from './media.ts'
import { makeVideoResolver } from '../video/resolve-video.ts'
import type { InvokeResult } from '../providers/executor.ts'
import type { TrackSource } from '../audio/track-source.ts'
import * as extractAudio from '../netdisk/extract-audio.ts'
import * as serving from '../media/serving.ts'
import type { Media } from '../content/types.ts'
import { AudioCache } from '../media/audio-cache.ts'

/** 注入用的缓存：**真 `AudioCache`**，只把落盘的 read/write 换成桩。在途表与 readOrCompute
 *  的编排是这里要测的东西，拿假的顶就等于自己给自己作证。 */
function realCache<T extends { read: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }>(over: T) {
  const cache = new AudioCache('/nonexistent-audio-cache-dir')
  vi.spyOn(cache, 'read').mockImplementation(over.read as never)
  vi.spyOn(cache, 'write').mockImplementation(over.write as never)
  return cache as AudioCache & T
}

vi.mock('../netdisk/extract-audio.ts', () => ({ extractNetdiskAudio: vi.fn() }))
vi.mock('../media/serving.ts', () => ({ servingPolicyFor: vi.fn(), serveWithPolicy: vi.fn() }))

const netdiskVideo = (q: string): Media => ({ kind: 'video', url: `/api/media/videos/resolve?${q}` })

describe('transcribableMedia — netdisk videos', () => {
  it('recognizes a Stream-managed netdisk video by its resolve url (key form)', () => {
    expect(transcribableMedia([netdiskVideo('key=tmdb:296286:S01E01')])).toBeDefined()
  })

  it('recognizes the followed-stream id form', () => {
    expect(transcribableMedia([netdiskVideo('id=7db591bd27a5daa1')])).toBeDefined()
  })

  it('still ignores a bare remote video url that carries no key/id resolve endpoint', () => {
    expect(transcribableMedia([{ kind: 'video', url: 'https://cdn.example.com/v.mp4' }])).toBeUndefined()
  })
})

describe('resolveMediaBytes — netdisk branch', () => {
  const lookup = vi.fn()
  const netdisk = { lookup, rawUrl: vi.fn() }
  const deps = { netdisk }

  beforeEach(() => {
    vi.mocked(extractAudio.extractNetdiskAudio).mockReset()
    lookup.mockReset()
  })

  it('resolves key → leftKey → lookup → extractNetdiskAudio(path)', async () => {
    lookup.mockReturnValue({ dirPath: '/quark/show', rightFile: 'e1.mkv' })
    vi.mocked(extractAudio.extractNetdiskAudio).mockResolvedValue({ bytes: new Uint8Array([1, 2]), mime: 'audio/x-matroska' })

    const out = await resolveMediaBytes([netdiskVideo('key=tmdb:296286:S01E01')], deps)

    expect(lookup).toHaveBeenCalledWith('tmdb:296286:S01E01')
    // legacy 腿也必须带上判路候选与缓存的接线口（和 source.ts 主腿同一套优化）
    expect(extractAudio.extractNetdiskAudio).toHaveBeenCalledWith(
      netdisk, '/quark/show/e1.mkv',
      expect.objectContaining({ cache: undefined, transcodeCandidates: undefined }),
    )
    expect(out).toEqual({ bytes: new Uint8Array([1, 2]), mime: 'audio/x-matroska' })
  })

  it('threads the transcode candidates + audio cache through — the legacy leg must ride the same optimizations', async () => {
    lookup.mockReturnValue({ dirPath: '/quark/show', rightFile: 'e1.mkv' })
    vi.mocked(extractAudio.extractNetdiskAudio).mockResolvedValue({ bytes: new Uint8Array([1]), mime: 'audio/x-matroska' })
    const audioCache = { read: vi.fn(), write: vi.fn() }
    const transcodeCandidates = vi.fn(async () => [])

    await resolveMediaBytes([netdiskVideo('key=tmdb:296286:S01E01')], { ...deps, audioCache, transcodeCandidates } as never)

    const opts = vi.mocked(extractAudio.extractNetdiskAudio).mock.calls[0][2]!
    expect(opts.cache).toBe(audioCache)
    await opts.transcodeCandidates!()
    expect(transcodeCandidates).toHaveBeenCalledWith('/quark/show/e1.mkv')
  })

  it('maps the id form to the item:<id> leftKey', async () => {
    lookup.mockReturnValue({ dirPath: '/quark', rightFile: 'e.mkv' })
    vi.mocked(extractAudio.extractNetdiskAudio).mockResolvedValue({ bytes: new Uint8Array(), mime: 'audio/x-matroska' })

    await resolveMediaBytes([netdiskVideo('id=7db591bd27a5daa1')], deps)

    expect(lookup).toHaveBeenCalledWith('item:7db591bd27a5daa1')
  })

  it('returns null when the binding has no match (lookup miss)', async () => {
    lookup.mockReturnValue(undefined)
    expect(await resolveMediaBytes([netdiskVideo('key=x')], deps)).toBeNull()
    expect(extractAudio.extractNetdiskAudio).not.toHaveBeenCalled()
  })

  it('degrades to null (does not throw) when extraction fails — one bad episode must not fail the queue', async () => {
    lookup.mockReturnValue({ dirPath: '/quark', rightFile: 'e.mkv' })
    vi.mocked(extractAudio.extractNetdiskAudio).mockRejectedValue(new Error('no audio stream found'))
    expect(await resolveMediaBytes([netdiskVideo('key=x')], deps)).toBeNull()
  })

  it('returns null for a netdisk-shaped url when no netdisk service is wired', async () => {
    expect(await resolveMediaBytes([netdiskVideo('key=x')], {})).toBeNull()
    expect(extractAudio.extractNetdiskAudio).not.toHaveBeenCalled()
  })
})

describe('transcribableMedia / resolveMediaBytes — 音频走统一漏斗', () => {
  const LIZHI_URL = 'http://cdn5.lizhi.fm/audio/2023/01/08/x_hd.mp3'
  const podcast = (over: Partial<Extract<Media, { kind: 'audio' }>> = {}): Media =>
    ({ kind: 'audio', url: LIZHI_URL, platform: 'lizhi', track_id: '1', ...over })
  const fetchMock = vi.fn()
  /** 漏斗的答案由 bootstrap 绑好后以函数形式注入——转写层不认识 provider executor。 */
  const withTrack = (source: TrackSource, over: Record<string, unknown> = {}) =>
    ({ resolveTrack: vi.fn(async () => source), ...over }) as never

  beforeEach(() => {
    vi.mocked(serving.servingPolicyFor).mockReset()
    vi.mocked(serving.serveWithPolicy).mockReset()
    vi.mocked(extractAudio.extractNetdiskAudio).mockReset()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('带直链的音频认得出来（免费集：库里 2922 条就是这个形状）', () => {
    expect(transcribableMedia([podcast()])).toBeDefined()
  })

  it('付费集（resolveOnly、无 url）认得出来——有 platform+track_id 就能喂给漏斗', () => {
    expect(transcribableMedia([podcast({ url: undefined, resolveOnly: true })])).toBeDefined()
  })

  it('免费集**没有** resolveOnly 也照样能喂给漏斗（归档/官方源两档就住在那儿）', () => {
    expect(transcribableMedia([podcast({ url: undefined })])).toBeDefined()
  })

  it('既没直链也没 platform+track_id 的音频仍然不算可转写', () => {
    expect(transcribableMedia([{ kind: 'audio', poster: 'https://x/p.jpg' }])).toBeUndefined()
  })

  // 活体撞出来的（2026-08-12）：只传 platform+id、不传源站直链，等于砍掉漏斗第四档——免费播客
  // 前三档全落空，3ms 就判「没地址」。单测当时全绿，因为没有一条钉住"传了什么进去"。
  it('把这条 media 身上的源站直链一并递给漏斗（否则第四档手里是空的）', async () => {
    const deps = withTrack({ kind: 'fallback', url: LIZHI_URL })
    vi.mocked(serving.servingPolicyFor).mockReturnValue(undefined)
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } }))
    await resolveMediaBytes([podcast()], deps)
    expect((deps as unknown as { resolveTrack: ReturnType<typeof vi.fn> }).resolveTrack)
      .toHaveBeenCalledWith('lizhi', '1', LIZHI_URL)
  })

  it('存量那种 url 本身就是内部 resolve 路由的，不当源站直链递进去', async () => {
    const deps = withTrack({ kind: 'unresolved' })
    await expect(
      resolveMediaBytes([podcast({ url: '/api/media/tracks/resolve?platform=lizhi&id=1' })], deps)
    ).rejects.toThrow()
    expect((deps as unknown as { resolveTrack: ReturnType<typeof vi.fn> }).resolveTrack)
      .toHaveBeenCalledWith('lizhi', '1', undefined)
  })

  it('第 1 档 归档命中 → 直接读本地文件，一个网络请求都不发', async () => {
    const abs = join(mkdtempSync(join(tmpdir(), 'tm-')), 'a.mp3')
    writeFileSync(abs, Buffer.from([1, 2, 3]))
    const deps = withTrack({ kind: 'archive', absPath: abs, format: 'mp3', assetId: 1 })
    const out = await resolveMediaBytes([podcast()], deps)
    expect(out).toEqual({ bytes: new Uint8Array([1, 2, 3]), mime: 'audio/mpeg' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(serving.serveWithPolicy).not.toHaveBeenCalled()
  })

  it('第 2 档 网盘绑定 → 取返回的直链', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([4]), { status: 200, headers: { 'content-type': 'audio/mp4' } }))
    const out = await resolveMediaBytes([podcast({ url: undefined, resolveOnly: true })], withTrack({ kind: 'netdisk', url: 'https://alist.test/raw/e1.m4a' }))
    expect(fetchMock).toHaveBeenCalledWith('https://alist.test/raw/e1.m4a', undefined)
    expect(out).toEqual({ bytes: new Uint8Array([4]), mime: 'audio/mp4' })
  })

  it('第 3 档 官方梯子带 headers → 请求要带上（不带就是 403）', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([5]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }))
    await resolveMediaBytes([podcast()], withTrack({ kind: 'stream', url: 'https://p.test/s.mp3', headers: { Referer: 'https://p.test/' } }))
    expect(fetchMock).toHaveBeenCalledWith('https://p.test/s.mp3', { headers: { Referer: 'https://p.test/' } })
  })

  it('第 4 档 回落直链命中服务策略 → serveWithPolicy，不裸 fetch（荔枝冷对象裸取必 403）', async () => {
    const policy = { match: '.lizhi.fm', label: '荔枝 FM' }
    vi.mocked(serving.servingPolicyFor).mockReturnValue(policy)
    vi.mocked(serving.serveWithPolicy).mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
    )
    const out = await resolveMediaBytes([podcast()], withTrack({ kind: 'fallback', url: LIZHI_URL }))
    expect(serving.serveWithPolicy).toHaveBeenCalledWith(LIZHI_URL, policy)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(out).toEqual({ bytes: new Uint8Array([1, 2, 3]), mime: 'audio/mpeg' })
  })

  it('回落直链没命中策略 → 普通 fetch，上游没给 content-type 按 audio/mpeg 兜底', async () => {
    vi.mocked(serving.servingPolicyFor).mockReturnValue(undefined)
    fetchMock.mockResolvedValue(new Response(new Uint8Array([9]), { status: 200 }))
    const out = await resolveMediaBytes([podcast()], withTrack({ kind: 'fallback', url: 'https://other.example/a.mp3' }))
    expect(out).toEqual({ bytes: new Uint8Array([9]), mime: 'audio/mpeg' })
  })

  it('漏斗四档全空 → 抛出原因，绝不退回 null（null 会被读成「这条没东西可转写」）', async () => {
    await expect(resolveMediaBytes([podcast()], withTrack({ kind: 'unresolved', detail: 'src:a: declined' })))
      .rejects.toThrow('src:a: declined')
  })

  it('上游拒绝 → 抛出上游原话', async () => {
    const policy = { match: '.lizhi.fm', label: '荔枝 FM' }
    vi.mocked(serving.servingPolicyFor).mockReturnValue(policy)
    vi.mocked(serving.serveWithPolicy).mockResolvedValue(
      new Response(JSON.stringify({ error: 'upstream_rejected', detail: '荔枝 FM 拒绝了这次请求（HTTP 403）' }), {
        status: 502, headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(resolveMediaBytes([podcast()], withTrack({ kind: 'fallback', url: LIZHI_URL }))).rejects.toThrow('403')
  })

  it('音轨缓存按 track:<platform>:<id> 记，命中就不解析也不打上游', async () => {
    const audioCache = realCache({
      read: vi.fn().mockResolvedValue({ bytes: new Uint8Array([7]), mime: 'audio/mpeg' }),
      write: vi.fn(),
    })
    const deps = withTrack({ kind: 'fallback', url: LIZHI_URL }, { audioCache })
    const out = await resolveMediaBytes([podcast()], deps)
    expect(audioCache.read).toHaveBeenCalledWith('track:lizhi:1')
    expect((deps as { resolveTrack: ReturnType<typeof vi.fn> }).resolveTrack).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(out).toEqual({ bytes: new Uint8Array([7]), mime: 'audio/mpeg' })
  })

  it('两个消费方同时要同一条音轨：只取一次，两边拿到同一份', async () => {
    // 取白文 ‖ 声纹时间轴——并行之后这是常态。落盘缓存拦不住（取完才写），只有在途表能。
    const audioCache = realCache({ read: vi.fn().mockResolvedValue(null), write: vi.fn(async () => {}) })
    const deps = withTrack({ kind: 'fallback', url: LIZHI_URL }, { audioCache })
    vi.mocked(serving.servingPolicyFor).mockReturnValue(undefined)
    fetchMock.mockResolvedValue(new Response(new Uint8Array([9]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }))

    const [a, b] = await Promise.all([
      resolveMediaBytes([podcast()], deps),
      resolveMediaBytes([podcast()], deps),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1) // ← 整条规则就是这个数字
    expect((deps as { resolveTrack: ReturnType<typeof vi.fn> }).resolveTrack).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })

  it('老形状（只有裸 url、没有 platform/track_id）走直链兜底', async () => {
    vi.mocked(serving.servingPolicyFor).mockReturnValue(undefined)
    fetchMock.mockResolvedValue(new Response(new Uint8Array([2]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }))
    const bare: Media = { kind: 'audio', url: 'https://other.example/legacy.mp3' }
    const out = await resolveMediaBytes([bare], withTrack({ kind: 'unresolved' }))
    expect(fetchMock).toHaveBeenCalledWith('https://other.example/legacy.mp3', undefined)
    expect(out).toEqual({ bytes: new Uint8Array([2]), mime: 'audio/mpeg' })
  })

  it('没接漏斗（deps 没给 resolveTrack）时仍能靠裸 url 取，两者都没有才 null', async () => {
    vi.mocked(serving.servingPolicyFor).mockReturnValue(undefined)
    fetchMock.mockResolvedValue(new Response(new Uint8Array([3]), { status: 200 }))
    expect(await resolveMediaBytes([podcast()], {})).toEqual({ bytes: new Uint8Array([3]), mime: 'audio/mpeg' })
    expect(await resolveMediaBytes([podcast({ url: undefined })], {})).toBeNull()
  })
})

describe('resolveMediaBytes — 带 (provider, vid) 的视频经 resolveVideo 取音轨', () => {
  const AUDIO_URL = 'https://cdn.test/a.m4a'
  const VIDEO_URL = 'https://cdn.test/v.mp4'
  const video: Media[] = [{ kind: 'video', provider: 'somesite', vid: 'ID1' }]
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  it('带 provider+vid 的视频：先要 audio', async () => {
    const resolveVideo = vi.fn().mockResolvedValue({ kind: 'progressive', url: AUDIO_URL, headers: { Referer: 'https://site.test' }, mime: 'audio/mp4' })
    const out = await resolveMediaBytes(video, { resolveVideo })
    expect(resolveVideo).toHaveBeenCalledWith('somesite', 'ID1', 'audio')
    expect(fetchMock).toHaveBeenCalledWith(AUDIO_URL, { headers: { Referer: 'https://site.test' } })
    expect(out?.mime).toBe('audio/mp4')
  })

  it('这个平台没有独立音轨（audio 空）→ 退一档要 progressive', async () => {
    const resolveVideo = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ kind: 'progressive', url: VIDEO_URL })
    const out = await resolveMediaBytes(video, { resolveVideo })
    expect(resolveVideo.mock.calls.map((c) => c[2])).toEqual(['audio', 'progressive'])
    expect(fetchMock).toHaveBeenCalledWith(VIDEO_URL, { headers: undefined })
    expect(out).not.toBeNull()
  })

  it('两档都空 → 抛（有东西但取不到），真实原因走到转换记录里', async () => {
    await expect(resolveMediaBytes(video, { resolveVideo: async () => null }))
      .rejects.toThrow(/音轨/)
  })

  // 真解析器不抛成员的错（执行器收进 misses、值为 null），所以要用真 makeVideoResolver 套桩执行器
  // 来钉「站方原话走得到转换记录」——mock 一个会 reject 的解析器钉的是真解析器没有的合同。
  it('作品被删（成员 miss 带 unavailable）→ 抛的是站方原话，不是那句通用的「没解析到音轨」', async () => {
    const invoke = async (): Promise<InvokeResult> =>
      ({ strategy: 'sequential', value: null, misses: [{ member: 'video-somesite', reason: '作品已被作者删除', stack: 'Error: x', unavailable: true }] } as unknown as InvokeResult)
    const resolveVideo = makeVideoResolver({ executor: { invoke } })
    await expect(resolveMediaBytes(video, { resolveVideo })).rejects.toThrow('作品已被作者删除')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('两档都只是 decline（没有成员抛错）→ 落回通用那句', async () => {
    const invoke = async (): Promise<InvokeResult> =>
      ({ strategy: 'sequential', value: null, misses: [{ member: 'video-somesite', reason: 'declined (no result)' }] } as unknown as InvokeResult)
    const resolveVideo = makeVideoResolver({ executor: { invoke } })
    await expect(resolveMediaBytes(video, { resolveVideo })).rejects.toThrow('这条视频没有解析到可取的音轨地址')
  })

  it('解析器只给得出 dash → 同样是「有东西但取不到」，抛', async () => {
    const resolveVideo = vi.fn().mockResolvedValue({ kind: 'dash', manifest: { durationS: 1, video: [], audio: [] } })
    await expect(resolveMediaBytes(video, { resolveVideo })).rejects.toThrow(/音轨/)
  })

  it('没注入 resolveVideo → null，不去猜地址', async () => {
    expect(await resolveMediaBytes(video, {})).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('缓存键是 provider:vid', async () => {
    const readOrCompute = vi.fn().mockResolvedValue({ bytes: new Uint8Array(), mime: 'audio/mp4' })
    await resolveMediaBytes(video, {
      resolveVideo: async () => ({ kind: 'progressive', url: AUDIO_URL }),
      audioCache: { readOrCompute } as never,
    })
    expect(readOrCompute).toHaveBeenCalledWith('somesite:ID1', expect.any(Function))
  })

  it('provider=douyin 带 vid 和别的平台一样走 resolveVideo（宿主没有任何平台专用腿）', async () => {
    const resolveVideo = vi.fn()
      .mockResolvedValueOnce(null) // 这个平台没有独立音轨
      .mockResolvedValueOnce({ kind: 'progressive', url: VIDEO_URL, headers: { Referer: 'https://www.douyin.com/' } })
    const out = await resolveMediaBytes(
      [{ kind: 'video', provider: 'douyin', vid: '7659053070483203953', page_url: 'https://www.douyin.com/video/7659053070483203953' }],
      { resolveVideo },
    )
    // 第二档（整片）多带 slotCtx=undefined + sink：成员失败的原话经它取回
    expect(resolveVideo.mock.calls).toEqual([
      ['douyin', '7659053070483203953', 'audio'],
      ['douyin', '7659053070483203953', 'progressive', undefined, expect.any(Object)],
    ])
    expect(fetchMock).toHaveBeenCalledWith(VIDEO_URL, { headers: { Referer: 'https://www.douyin.com/' } })
    expect(out).not.toBeNull()
  })
})

describe('resolveMediaBytes — 取不到字节 ≠ 这条没东西可转写', () => {
  const video: Media[] = [{ kind: 'video', provider: 'somesite', vid: 'ID1' }]
  const resolveVideo = async () => ({ kind: 'progressive' as const, url: 'https://cdn.test/a.m4a' })
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('抛出上游原话，而不是退回 null 让它退化成「这条内容里没有可转写的东西」', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: '下载接口失败：HTTP状态错误: 403' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(resolveMediaBytes(video, { resolveVideo })).rejects.toThrow('HTTP状态错误: 403')
  })

  it('上游没给人话时兜底成带状态码的一句，不返回空原因', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }))
    await expect(resolveMediaBytes(video, { resolveVideo })).rejects.toThrow('500')
  })

  it('压根没有可转写的 media 仍然是 null（两种失败必须分得开）', async () => {
    expect(await resolveMediaBytes([{ kind: 'image', url: 'https://x/a.png' }], {})).toBeNull()
  })
})
