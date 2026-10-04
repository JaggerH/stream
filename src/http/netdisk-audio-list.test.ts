// src/http/netdisk-audio-list.test.ts — 抽音轨判决的只读解释视图
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createHttpApp } from './app.ts'

vi.mock('../media/extract.ts', () => ({ probeStreams: vi.fn(), extractStream: vi.fn(), headerArgs: vi.fn(() => []) }))
import { probeStreams } from '../media/extract.ts'

const FILE_BYTES = 5_911_523_677
const LOW_BYTES = 143_139_304
const hit = { setId: 'map_x', dirPath: '/quark/show', rightFile: 'e17.mkv' }
const netdisk = {
  lookup: (k: string) => (k === 'tmdb:1:S01E17' ? hit : undefined),
  rawUrl: async (p: string) => `http://fake${p}`,
  fileSize: async () => FILE_BYTES,
  fileId: async () => 'fid-1',
}
const ask = (extra: Record<string, unknown> = {}) =>
  createHttpApp({ itemStore: { get: () => undefined, recent: () => [] }, netdisk, ...extra } as never)
    .request('/api/media/netdisk-audio-list?key=tmdb:1:S01E17')

describe('GET /api/media/netdisk-audio-list', () => {
  beforeEach(() => vi.mocked(probeStreams).mockReset())

  it('摊开每个容器的大小并指出会选哪个——重点是回答「为什么」', async () => {
    vi.mocked(probeStreams).mockResolvedValue({
      video: [], subtitle: [], durationS: 2796,
      audio: [{ index: 1, codec: 'aac', channels: 6, bitrate: 47_000 }],
    })
    const netdiskPlay = {
      supports: () => true,
      stream: async () => ({
        url: 'https://cdn/4k.mp4?sign=secret',
        renditions: [
          { resolution: '4k', url: 'https://cdn/4k.mp4?sign=secret', sizeBytes: 1_791_699_008 },
          { resolution: 'low', url: 'https://cdn/low.mp4?sign=secret', sizeBytes: LOW_BYTES },
        ],
      }),
    }
    const body = await (await ask({ netdiskPlay })).json()

    expect(body.containers.map((c: { label: string }) => c.label)).toEqual(['original', 'transcode:4k', 'transcode:low'])
    expect(body.containers[0].bytes).toBe(FILE_BYTES)
    expect(body.chosen).toMatchObject({ kind: 'transcode', label: 'transcode:low', bytes: LOW_BYTES })
    // 摊开了才能自己算比值：原盘是选中那个的 41 倍
    expect(body.containers[0].bytes / body.chosen.bytes).toBeGreaterThan(40)
  })

  it('探的是**选中的那个**容器，不是原盘——两者的音轨是两套', async () => {
    vi.mocked(probeStreams).mockResolvedValue({ video: [], subtitle: [], audio: [{ index: 1, codec: 'aac', channels: 2 }] })
    const netdiskPlay = {
      supports: () => true,
      stream: async () => ({ url: 'https://cdn/low.mp4', renditions: [{ resolution: 'low', url: 'https://cdn/low.mp4', sizeBytes: LOW_BYTES }] }),
    }
    await ask({ netdiskPlay })
    expect(probeStreams).toHaveBeenCalledWith('https://cdn/low.mp4', expect.anything())
  })

  it('不泄漏签名直链和 cookie', async () => {
    vi.mocked(probeStreams).mockResolvedValue({ video: [], subtitle: [], audio: [{ index: 1, codec: 'aac', channels: 2 }] })
    const netdiskPlay = {
      supports: () => true,
      stream: async () => ({ url: 'https://cdn/low.mp4?sign=secret', renditions: [{ resolution: 'low', url: 'https://cdn/low.mp4?sign=secret', sizeBytes: LOW_BYTES }] }),
    }
    const credentialProvider = { cookieString: async () => 'session=secret' }
    const body = await (await ask({ netdiskPlay, credentialProvider })).json()
    expect(JSON.stringify(body)).not.toContain('secret')
  })

  it('每条轨都带上有效码率，能看出哪条是估的', async () => {
    vi.mocked(probeStreams).mockResolvedValue({
      video: [], subtitle: [],
      audio: [{ index: 1, codec: 'flac', channels: 2 }, { index: 2, codec: 'aac', channels: 2, bitrate: 128_000 }],
    })
    const body = await (await ask()).json()
    expect(body.tracks[0]).toMatchObject({ label: 'flac/2ch/900kbps', effectiveBitrate: 900_000 })
    expect(body.track).toMatchObject({ index: 2 }) // 不会被低估的 FLAC 骗走
  })

  it('没有网盘绑定 → 200 空清单', async () => {
    const res = await createHttpApp({ itemStore: { get: () => undefined, recent: () => [] }, netdisk } as never)
      .request('/api/media/netdisk-audio-list?key=tmdb:1:S09E09')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ containers: [], tracks: [] })
  })

  it('解析失败当数据报，不是 5xx——这是个观察窗，不是依赖', async () => {
    const gone = { ...netdisk, rawUrl: async () => { throw new Error('object not found') } }
    const res = await createHttpApp({ itemStore: { get: () => undefined, recent: () => [] }, netdisk: gone } as never)
      .request('/api/media/netdisk-audio-list?key=tmdb:1:S01E17')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ containers: [], tracks: [], error: 'object not found' })
  })
})
