import { describe, it, expect, vi, afterEach } from 'vitest'
import { transcribableMedia, resolveMediaBytes } from './media.ts'
import { fetchUrlFor as douyinFetchUrlFor } from '../../packages/Douyin_TikTok_Download_API/fetch-url.ts'
import { fetchUrlFor as bilibiliFetchUrlFor } from '../../packages/bilibili/fetch-url.ts'
import type { VideoResolver } from '../video/resolve-video.ts'
import type { BilibiliClient } from '../../packages/bilibili/client.ts'
import type { HybridClient } from '../../packages/Douyin_TikTok_Download_API/fetch-url.ts'

/**
 * 粘贴 → 转成文字的**取字节那一段**的串联证明（活体 2026-11-15 断过）：包的 from-url 产出
 * （`fetchUrlFor`）→ `transcribableMedia` 认得 → `resolveMediaBytes` 走到 `resolveVideo` 取音轨。
 * 中间任何一环缺格（video 项没有 provider/vid），症状都是 from-url 明明成功、转换秒回 no_media，
 * 而没有任何一处说清缺了什么——所以产出形状在这里逐格钉住。
 */

afterEach(() => { vi.unstubAllGlobals() })

const bytesResponse = () => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'audio/mp4' }),
  arrayBuffer: async () => new ArrayBuffer(8),
} as unknown as Response)

describe('抖音：from-url 产出 → 转写取音轨', () => {
  const hybrid: HybridClient = {
    hybridVideoData: async () => ({
      aweme_id: '7684184358583930148',
      desc: '一条视频',
      video: {
        play_addr: { url_list: ['https://v26-web.douyinvod.com/a/v.mp4'] },
        cover: { url_list: ['https://p3-sign.douyinpic.com/c.jpg'] },
        duration: 631_000, // 毫秒
      },
    }),
  }

  it('产出带 provider/vid/page_url，duration_s 是数字', async () => {
    const r = await douyinFetchUrlFor(hybrid, 'douyin', 'https://www.douyin.com/video/7684184358583930148')
    const v = r.media.find((m) => m.kind === 'video')
    expect(v).toMatchObject({
      provider: 'douyin',
      vid: '7684184358583930148',
      page_url: 'https://www.douyin.com/video/7684184358583930148',
      duration_s: 631, // 数字，不是字符串——下游按秒算分窗
    })
  })

  it('transcribableMedia 认得；resolveMediaBytes 经 resolveVideo 取音轨（没有纯音轨退整片）', async () => {
    const r = await douyinFetchUrlFor(hybrid, 'douyin', 'https://www.douyin.com/video/7684184358583930148')
    expect(transcribableMedia(r.media)).toBeTruthy()
    const calls: Array<[string, string, string]> = []
    const resolveVideo: VideoResolver = vi.fn(async (platform, vid, format) => {
      calls.push([platform, vid, format])
      // 抖音没有独立音轨：audio 那一档 null，退到 progressive 整片（与 resolveMember 的合同一致）。
      return format === 'audio'
        ? Promise.resolve(null)
        : Promise.resolve({ kind: 'progressive' as const, url: 'https://v26-web.douyinvod.com/a/v.mp4', headers: {} })
    })
    vi.stubGlobal('fetch', vi.fn(bytesResponse))
    const out = await resolveMediaBytes(r.media, { resolveVideo })
    expect(out?.mime).toBe('audio/mp4')
    expect(calls).toEqual([
      ['douyin', '7684184358583930148', 'audio'],
      ['douyin', '7684184358583930148', 'progressive'],
    ])
  })
})

describe('B 站：from-url 产出 → 转写取音轨', () => {
  const client = { view: async () => ({ title: '一个视频', owner: { name: 'up主', face: '' } }) }

  it('产出带 provider/vid/page_url', async () => {
    const r = await bilibiliFetchUrlFor(client as unknown as Pick<BilibiliClient, 'view'>,
      'https://www.bilibili.com/video/BV1GJ411x7h7', { fetch: fetch })
    const v = r.media.find((m) => m.kind === 'video')
    expect(v).toMatchObject({
      provider: 'bilibili',
      vid: 'BV1GJ411x7h7',
      page_url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    })
  })

  it('transcribableMedia 认得；resolveMediaBytes 经 resolveVideo 取 DASH 音轨', async () => {
    const r = await bilibiliFetchUrlFor(client as unknown as Pick<BilibiliClient, 'view'>,
      'https://www.bilibili.com/video/BV1GJ411x7h7', { fetch: fetch })
    expect(transcribableMedia(r.media)).toBeTruthy()
    const calls: Array<[string, string, string]> = []
    const resolveVideo: VideoResolver = vi.fn(async (platform, vid, format) => {
      calls.push([platform, vid, format])
      return format === 'audio'
        ? Promise.resolve({ kind: 'progressive' as const, url: 'https://upos.example/audio.m4s', headers: {} })
        : Promise.resolve(null)
    })
    vi.stubGlobal('fetch', vi.fn(bytesResponse))
    const out = await resolveMediaBytes(r.media, { resolveVideo })
    expect(out?.mime).toBe('audio/mp4')
    expect(calls).toEqual([['bilibili', 'BV1GJ411x7h7', 'audio']])
  })
})

describe('no_media 的人话（缺哪一格说清哪一格）', () => {
  it('video 项没有任何定位符 → 说缺 vid/provider/page_url', async () => {
    const { explainNoTranscribableMedia } = await import('./media.ts')
    const message = explainNoTranscribableMedia([{ kind: 'video', url: 'https://v26-web.douyinvod.com/a/v.mp4' }])
    expect(message).toMatch(/视频项没有 vid \/ embed \/ page_url/)
  })

  it('有页址但没有 provider+vid → 说走不到 resolveVideo', async () => {
    const { explainNoTranscribableMedia } = await import('./media.ts')
    const message = explainNoTranscribableMedia([{ kind: 'video', url: 'https://x/v.mp4', page_url: 'https://www.douyin.com/video/1' }])
    expect(message).toMatch(/缺 provider\+vid/)
    expect(message).toMatch(/provider=\(缺\)/)
  })

  it('什么 media 都没有 → 也说清楚', async () => {
    const { explainNoTranscribableMedia } = await import('./media.ts')
    expect(explainNoTranscribableMedia([])).toMatch(/没有任何 media/)
  })
})
