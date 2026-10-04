import { describe, it, expect, vi } from 'vitest'
import { quarkPlayStream } from './play.ts'

const cookieFor = async () => 'quark-cookie'
const mkList = (rows: Array<{ res: string; accessable?: boolean; trans?: string; url?: string; w?: number; size?: number; bitrate?: number }>) =>
  rows.map((r) => ({
    resolution: r.res,
    accessable: r.accessable ?? true,
    trans_status: r.trans ?? 'success',
    video_info: r.url === null ? undefined : { url: r.url ?? `https://cdn/${r.res}.mp4`, width: r.w, codec: 'h264', audio: { codec: 'aac' }, size: r.size, bitrate: r.bitrate },
  }))
const playResp = (list: unknown[]) =>
  ({ ok: true, json: async () => ({ code: 0, data: { video_list: list } }) }) as unknown as Response

describe('quarkPlayStream', () => {
  it('picks the highest accessible resolution (4k over super)', async () => {
    const fetchFn = vi.fn(async () => playResp(mkList([{ res: 'super', w: 1440 }, { res: '4k', w: 3840 }])))
    const s = await quarkPlayStream('fid', { cookieFor, fetchFn: fetchFn as unknown as typeof fetch })
    expect(s?.resolution).toBe('4k')
    expect(s?.width).toBe(3840)
    expect(s?.audioCodec).toBe('aac')
  })

  it('skips resolutions that are not accessible', async () => {
    const fetchFn = vi.fn(async () => playResp(mkList([{ res: '4k', accessable: false }, { res: 'super', w: 1440 }])))
    const s = await quarkPlayStream('fid', { cookieFor, fetchFn: fetchFn as unknown as typeof fetch })
    expect(s?.resolution).toBe('super')
  })

  it('skips resolutions still transcoding or without a url', async () => {
    const fetchFn = vi.fn(async () =>
      playResp(mkList([{ res: '4k', trans: 'running' }, { res: 'high', url: null as unknown as string }, { res: 'low', w: 480 }])),
    )
    const s = await quarkPlayStream('fid', { cookieFor, fetchFn: fetchFn as unknown as typeof fetch })
    expect(s?.resolution).toBe('low')
  })

  it('returns null when nothing is accessible', async () => {
    const fetchFn = vi.fn(async () => playResp(mkList([{ res: '4k', accessable: false }, { res: 'low', accessable: false }])))
    expect(await quarkPlayStream('fid', { cookieFor, fetchFn: fetchFn as unknown as typeof fetch })).toBeNull()
  })

  it('returns null without a quark login', async () => {
    const fetchFn = vi.fn()
    expect(await quarkPlayStream('fid', { cookieFor: async () => undefined, fetchFn: fetchFn as unknown as typeof fetch })).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('carries every playable rendition, best → cheapest, for the cost decision', async () => {
    // Playback takes `url`/`resolution` (the best); pulling audio for transcription reads
    // `renditions` and picks from the other end. One API call answers both.
    const fetchFn = vi.fn(async () =>
      playResp(mkList([{ res: 'low', w: 480, size: 300_000_000 }, { res: '4k', w: 3840, bitrate: 18_000_000 }])),
    )
    const s = await quarkPlayStream('fid', { cookieFor, fetchFn: fetchFn as unknown as typeof fetch })
    expect(s?.resolution).toBe('4k')
    expect(s?.renditions?.map((r) => r.resolution)).toEqual(['4k', 'low'])
    expect(s?.renditions?.[0]).toMatchObject({ bitrateBps: 18_000_000 })
    expect(s?.renditions?.[1]).toMatchObject({ sizeBytes: 300_000_000, url: 'https://cdn/low.mp4' })
  })

  it('drops a zero size/bitrate rather than reporting a free 2GB stream', async () => {
    const fetchFn = vi.fn(async () => playResp(mkList([{ res: 'low', size: 0, bitrate: 0 }])))
    const s = await quarkPlayStream('fid', { cookieFor, fetchFn: fetchFn as unknown as typeof fetch })
    expect(s?.renditions?.[0].sizeBytes).toBeUndefined()
    expect(s?.renditions?.[0].bitrateBps).toBeUndefined()
  })

  it('omits renditions that are not playable — they are not routes', async () => {
    const fetchFn = vi.fn(async () => playResp(mkList([{ res: '4k', accessable: false }, { res: 'low', w: 480 }])))
    const s = await quarkPlayStream('fid', { cookieFor, fetchFn: fetchFn as unknown as typeof fetch })
    expect(s?.renditions?.map((r) => r.resolution)).toEqual(['low'])
  })

  it('returns null on a non-zero API code', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ code: 31001, message: 'require login' }) }) as unknown as Response)
    expect(await quarkPlayStream('fid', { cookieFor, fetchFn: fetchFn as unknown as typeof fetch })).toBeNull()
  })
})
