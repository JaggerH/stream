import { describe, it, expect, vi } from 'vitest'
import { fetchUrlFor } from './fetch-url.ts'

/** 容器 `/api/hybrid/video_data` 回的 `data`（抖音 aweme 形状）——只写成员会读的那几格。 */
const VIDEO_DATA = {
  aweme_id: '7301234567890123456',
  desc: '一条视频的文案',
  author: { nickname: '作者', avatar_thumb: { url_list: ['https://p3.example/avatar.jpg'] } },
  video: {
    play_addr: { url_list: ['https://v3.example/play.mp4', 'https://www.example/aweme/v1/play'] },
    cover: { url_list: ['https://p3.example/cover.jpg'] },
    duration: 15400,
  },
}

const IMAGES_DATA = {
  aweme_id: '7309876543210987654',
  desc: '图集',
  author: { nickname: '摄影' },
  images: [
    { url_list: ['https://p3.example/1.jpg'] },
    { url_list: ['https://p3.example/2.jpg'] },
    { url_list: [] }, // 没有地址的一张：跳过，不给一条空 url
  ],
}

const client = (data: Record<string, unknown>) => ({ hybridVideoData: vi.fn(async () => data) })

describe('douyin-fetch-url / tiktok-fetch-url', () => {
  it('视频：标题 / 作者 / 头像 / 一条 video media，download_url 走宿主的通用播放路由', async () => {
    const c = client(VIDEO_DATA)
    const r = await fetchUrlFor(c, 'douyin', 'https://v.douyin.com/abc/')
    expect(c.hybridVideoData).toHaveBeenCalledWith('https://v.douyin.com/abc/')
    expect(r.platform).toBe('douyin')
    expect(r.title).toBe('一条视频的文案')
    expect(r.author).toBe('作者')
    expect(r.author_avatar).toBe('https://p3.example/avatar.jpg')
    expect(r.media).toHaveLength(1)
    expect(r.media[0]).toMatchObject({
      kind: 'video',
      url: 'https://v3.example/play.mp4',
      poster: 'https://p3.example/cover.jpg',
      duration_s: 15,
    })
    expect(r.media[0].download_url).toBe('/api/media/play?platform=douyin&vid=7301234567890123456&dl=1')
    expect(r.raw).toBe(VIDEO_DATA)
    expect(r.error).toBeUndefined()
  })

  it('图集：逐张给 image media，没地址的那张跳过', async () => {
    const r = await fetchUrlFor(client(IMAGES_DATA), 'douyin', 'https://www.douyin.com/note/7309876543210987654')
    expect(r.title).toBe('图集')
    expect(r.author_avatar).toBeUndefined()
    expect(r.media).toEqual([
      { kind: 'image', url: 'https://p3.example/1.jpg' },
      { kind: 'image', url: 'https://p3.example/2.jpg' },
    ])
  })

  it('容器报错 → 带原话的失败结果，不抛（认领了却失败要把原话带出去）', async () => {
    const c = { hybridVideoData: async () => { throw new Error('[Douyin_TikTok_Download_API] /api/hybrid/video_data → HTTP 400') } }
    const r = await fetchUrlFor(c, 'douyin', 'https://www.douyin.com/video/1')
    expect(r).toEqual({ platform: 'douyin', media: [], error: '[Douyin_TikTok_Download_API] /api/hybrid/video_data → HTTP 400' })
  })

  it('有 play_addr 却抠不到 vid → 不给 download_url 也不给 video media（拼不出播放路由的键）', async () => {
    const { aweme_id: _omit, ...noId } = VIDEO_DATA
    const r = await fetchUrlFor(client(noId), 'douyin', 'https://www.douyin.com/video/1')
    expect(r.media).toEqual([])
    expect(r.title).toBe('一条视频的文案')
  })

  it('TikTok：平台名随成员走，vid 取作品 id，媒体地址按 itemStruct 形状抠', async () => {
    const data = {
      id: '7400000000000000000',
      desc: 'tt',
      author: { nickname: 'tt-author', avatarThumb: 'x' },
      video: { playAddr: 'https://v16.example/play/', cover: 'https://p16.example/cover.jpg', duration: 30 },
    }
    const r = await fetchUrlFor(client(data), 'tiktok', 'https://www.tiktok.com/@a/video/7400000000000000000')
    expect(r.platform).toBe('tiktok')
    expect(r.media[0]).toMatchObject({ kind: 'video', url: 'https://v16.example/play/', poster: 'https://p16.example/cover.jpg', duration_s: 30 })
    expect(r.media[0].download_url).toBe('/api/media/play?platform=tiktok&vid=7400000000000000000&dl=1')
  })
})
