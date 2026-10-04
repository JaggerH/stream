import { describe, it, expect, vi } from 'vitest'
import { resolveVideoSource, type VideoSourceDeps } from './video-source.ts'
import { makeVideoResolver } from '../video/resolve-video.ts'
import type { InvokeResult } from '../providers/executor.ts'
import type { Media } from '../content/types.ts'

const netdiskVideo = (q: string): Media => ({ kind: 'video', url: `/api/media/videos/resolve?${q}` })

describe('resolveVideoSource — netdisk leg', () => {
  it('resolves a Stream-managed netdisk video to its AList raw url, no headers', async () => {
    const lookup = vi.fn().mockReturnValue({ dirPath: '/quark/show', rightFile: 'S01E01.mp4' })
    const rawUrl = vi.fn().mockResolvedValue('https://alist.example.com/d/quark/show/S01E01.mp4')
    const deps: VideoSourceDeps = { netdisk: { lookup, rawUrl } }

    const out = await resolveVideoSource([netdiskVideo('key=tmdb:296286:S01E01')], deps)

    expect(out).toEqual({ url: 'https://alist.example.com/d/quark/show/S01E01.mp4' })
    expect(lookup).toHaveBeenCalledWith('tmdb:296286:S01E01')
    expect(rawUrl).toHaveBeenCalledWith('/quark/show/S01E01.mp4')
  })

  it('returns null when the leftKey has no binding (lookup misses)', async () => {
    const deps: VideoSourceDeps = { netdisk: { lookup: vi.fn().mockReturnValue(undefined), rawUrl: vi.fn() } }
    const out = await resolveVideoSource([netdiskVideo('key=tmdb:1:S01E01')], deps)
    expect(out).toBeNull()
  })

  it('returns null (not throw) when the netdisk dep is not injected', async () => {
    const out = await resolveVideoSource([netdiskVideo('key=tmdb:1:S01E01')], {})
    expect(out).toBeNull()
  })
})

describe('resolveVideoSource — generic (provider, vid) leg via resolveVideo', () => {
  const media: Media[] = [{ kind: 'video', provider: 'somesite', vid: 'ID1' }]

  it('带 provider+vid 的视频 → 要 progressive，原样交出 url+headers', async () => {
    const resolveVideo = vi.fn().mockResolvedValue({ kind: 'progressive', url: 'https://cdn.test/v.mp4', headers: { Referer: 'https://site.test' } })
    const out = await resolveVideoSource(media, { resolveVideo })
    expect(resolveVideo).toHaveBeenCalledWith('somesite', 'ID1', 'progressive', undefined, expect.any(Object))
    expect(out).toEqual({ url: 'https://cdn.test/v.mp4', headers: { Referer: 'https://site.test' } })
  })

  it('解析不出 progressive（只有 dash）→ null，不硬塞', async () => {
    const out = await resolveVideoSource(media, {
      resolveVideo: async () => ({ kind: 'dash', manifest: { durationS: 1, video: [], audio: [] } }),
    })
    expect(out).toBeNull()
  })

  it('解析器说没有（null）→ null', async () => {
    expect(await resolveVideoSource(media, { resolveVideo: async () => null })).toBeNull()
  })

  it('returns null when resolveVideo is not injected', async () => {
    expect(await resolveVideoSource(media, {})).toBeNull()
  })

  // 作品被删 / 设私密时解析成员抛 `ContentUnavailableError`（站方原话），但**真解析器不往上抛**：
  // 执行器把它收进 `misses`、值为 null。这条腿要经 sink 把那句原话捞出来抛给 converter，落成说得出
  // 理由的 `source_failed`——吞成 null 会记成「探过，没源」。所以这里用真 `makeVideoResolver` 套一个
  // 桩执行器，而不是 mock 一个会 reject 的解析器（那是真解析器没有的合同）。
  it('成员 miss 带 unavailable（作品被删）→ 抛站方原话，不吞成 null', async () => {
    const invoke = async (): Promise<InvokeResult> =>
      ({ strategy: 'sequential', value: null, misses: [{ member: 'video-somesite', reason: '作品不见了', stack: 'Error: 作品不见了', unavailable: true }] } as unknown as InvokeResult)
    const resolveVideo = makeVideoResolver({ executor: { invoke } })
    await expect(resolveVideoSource(media, { resolveVideo })).rejects.toThrow('作品不见了')
  })

  it('成员抛了普通错（容器报错）→ 同样抛它的原话', async () => {
    const invoke = async (): Promise<InvokeResult> =>
      ({ strategy: 'sequential', value: null, misses: [{ member: 'video-somesite', reason: 'fetch failed', stack: 'Error: fetch failed' }] } as unknown as InvokeResult)
    await expect(resolveVideoSource(media, { resolveVideo: makeVideoResolver({ executor: { invoke } }) })).rejects.toThrow('fetch failed')
  })

  it('成员只是 decline（没有 stack / 标记）或压根没有 miss → null（没有东西可取，不是取失败）', async () => {
    const declined = async (): Promise<InvokeResult> =>
      ({ strategy: 'sequential', value: null, misses: [{ member: 'video-somesite', reason: 'declined (no result)' }] } as unknown as InvokeResult)
    expect(await resolveVideoSource(media, { resolveVideo: makeVideoResolver({ executor: { invoke: declined } }) })).toBeNull()
    const noRow = async (): Promise<InvokeResult | null> => null
    expect(await resolveVideoSource(media, { resolveVideo: makeVideoResolver({ executor: { invoke: noRow } }) })).toBeNull()
  })

  // 这条钉的是：ffmpeg 绝不能拿到一个「报错时回 200 + JSON」的中转端点——这条腿只认解析成员给的直链。
  it('never hands ffmpeg a proxied download endpoint — the resolver url is passed through verbatim', async () => {
    const resolveVideo = vi.fn().mockResolvedValue({ kind: 'progressive', url: 'https://cdn.test/direct.mp4' })
    const out = await resolveVideoSource(media, { resolveVideo })
    expect(out?.url).toBe('https://cdn.test/direct.mp4')
    expect(out?.url).not.toContain('/api/download')
  })

  it('只有 page_url、没有 vid 的视频落不到任何腿 → null（平台知识归包，宿主不按 URL 认平台）', async () => {
    const resolveVideo = vi.fn()
    const out = await resolveVideoSource(
      [{ kind: 'video', provider: 'somesite', page_url: 'https://xiaohongshu.com/explore/1' }],
      { resolveVideo },
    )
    expect(out).toBeNull()
    expect(resolveVideo).not.toHaveBeenCalled()
  })
})

describe('resolveVideoSource — no video source', () => {
  it('returns null for an audio-only item (nothing to extract frames from)', async () => {
    const media: Media[] = [{ kind: 'audio', url: 'https://cdn.example.com/ep.mp3' }]
    const out = await resolveVideoSource(media, {})
    expect(out).toBeNull()
  })

  it('returns null when there is no media at all', async () => {
    const out = await resolveVideoSource(undefined, {})
    expect(out).toBeNull()
  })

  it('returns null for a bare remote video url with no provider/netdisk/vid signal', async () => {
    const media: Media[] = [{ kind: 'video', url: 'https://cdn.example.com/v.mp4' }]
    const out = await resolveVideoSource(media, {})
    expect(out).toBeNull()
  })
})
