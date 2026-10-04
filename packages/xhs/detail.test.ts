import { describe, it, expect, vi } from 'vitest'
import { makeDetailEnricher, DETAIL_SOURCE } from './detail.ts'
import { StreamTable } from './streams.ts'
import { ValidationError } from '../../shared/package-sdk/errors.ts'
import type { Enrichment } from '../../src/content/types.ts'

const VIDEO_URL = 'http://sns-video-qc.example-cdn.com/stream/x.mp4?sign=s'

function videoItem(noteId = 'n1') {
  return {
    noteId,
    desc: '视频正文',
    imageList: [{ urlDefault: 'http://img/cover.webp', width: 1080, height: 1920 }],
    video_stream: {
      h264: [{ masterUrl: VIDEO_URL, backupUrls: ['http://bak/x.mp4'] }],
    },
    comments: [
      {
        id: 'c1', content: '顶', likeCount: 3, createTime: 1700000000000, ipLocation: '上海',
        userInfo: { nickname: '甲', image: 'http://a/1.png' },
        subComments: [{ id: 'c1-1', content: '回', likeCount: 0, userInfo: { nickname: '乙' } }],
      },
      { id: 'c2', content: '二楼', userInfo: { nickname: '丙' } },
    ],
  }
}

function setup(items: unknown[] = [videoItem()]) {
  const readSource = vi.fn(async () => items)
  const streams = new StreamTable()
  const enricher = makeDetailEnricher({ readSource, streams })['xhs-detail']!
  return { readSource, streams, enricher }
}

describe('xhs-detail enricher', () => {
  it('跑本包的 xhs-detail 源（裸名，带 signal），noteId + xsec_token 原样递过去', async () => {
    const { readSource, enricher } = setup()
    const ac = new AbortController()
    await enricher({ noteId: 'n1', xsec_token: 'tok' }, ac.signal)
    expect(DETAIL_SOURCE).toBe('xhs-detail')
    expect(readSource).toHaveBeenCalledWith('xhs-detail', { noteId: 'n1', xsec_token: 'tok' }, { signal: ac.signal })
  })

  it('视频笔记 → media 是 (provider xhs, vid noteId, poster 第一张图)，流地址进 streams 而不是烘进 embed', async () => {
    const { enricher, streams } = setup()
    const e = (await enricher({ noteId: 'n1', xsec_token: 'tok' })) as Enrichment
    expect(e.article).toEqual({
      sourceUrl: 'https://www.xiaohongshu.com/explore/n1',
      text: '视频正文',
      media: [{ kind: 'video', provider: 'xhs', vid: 'n1', poster: 'http://img/cover.webp' }],
    })
    expect(streams.get('n1')).toBe(VIDEO_URL)
  })

  it('评论映射：id / author / avatar / text / like / ip / time，子回复一层', async () => {
    const { enricher } = setup()
    const e = (await enricher({ noteId: 'n1', xsec_token: 'tok' })) as Enrichment
    expect(e.total).toBe(2)
    expect(e.comments).toEqual([
      {
        id: 'c1', author: '甲', avatar: 'http://a/1.png', text: '顶', like: 3, ip: '上海', time: 1700000000000,
        replies: [{ id: 'c1-1', author: '乙', avatar: undefined, text: '回', like: 0, ip: undefined, time: undefined, replies: undefined }],
      },
      { id: 'c2', author: '丙', avatar: undefined, text: '二楼', like: 0, ip: undefined, time: undefined, replies: undefined },
    ])
  })

  it('图集笔记（没有流）→ image 列表带宽高，streams 不记', async () => {
    const { enricher, streams } = setup([{
      noteId: 'n2', desc: '图集',
      imageList: [{ urlDefault: 'http://img/1.webp', width: 10, height: 20 }, { width: 1 }, { urlDefault: 'http://img/2.webp' }],
    }])
    const e = (await enricher({ noteId: 'n2', xsec_token: 't' })) as Enrichment
    expect(e.article?.media).toEqual([
      { kind: 'image', url: 'http://img/1.webp', w: 10, h: 20 },
      { kind: 'image', url: 'http://img/2.webp', w: undefined, h: undefined },
    ])
    expect(streams.get('n2')).toBeUndefined()
  })

  it('masterUrl 被抹空时取 backupUrls 里第一条非空的；codec 顺序 h264 → h265 → av1 → h266', async () => {
    const { enricher, streams } = setup([{
      noteId: 'n3',
      video_stream: {
        h265: [{ masterUrl: 'http://h265/x.mp4' }],
        h264: [{ masterUrl: '', backupUrls: ['', 'http://bak/h264.mp4'] }],
      },
    }])
    await enricher({ noteId: 'n3', xsec_token: 't' })
    expect(streams.get('n3')).toBe('http://bak/h264.mp4')
  })

  it('站方的 codec 代号不按名单来（活体 2026-09-20：EF4 / EF5，EF6 / EF7 空数组）也能取到流；完全陌生的键按出现顺序兜底', async () => {
    const { enricher, streams } = setup([
      {
        noteId: 'ef',
        video_stream: {
          EF6: [], EF7: [],
          EF5: [{ masterUrl: 'http://sns-video-v3.xhscdn.com/stream/1/110/301/x', backupUrls: ['http://sns-bak-v1.xhscdn.com/x'] }],
          EF4: [{ masterUrl: 'http://sns-video-v3.xhscdn.com/stream/79/110/259/x' }],
        },
      },
      { noteId: 'zz', video_stream: { ZZ9: [{ masterUrl: 'http://unknown-codec/x.mp4' }] } },
    ])
    await enricher({ noteId: 'ef', xsec_token: 't' })
    expect(streams.get('ef')).toBe('http://sns-video-v3.xhscdn.com/stream/79/110/259/x') // EF4 排在 EF5 前
    await enricher({ noteId: 'zz', xsec_token: 't' })
    expect(streams.get('zz')).toBe('http://unknown-codec/x.mp4')
  })

  it('常驻 tab 的状态表里可能带着早先打开过的笔记：优先取 noteId 匹配的那条，而不是位置 0', async () => {
    const { enricher } = setup([{ noteId: 'stale', desc: '旧的' }, { noteId: 'n4', desc: '要的' }])
    const e = (await enricher({ noteId: 'n4', xsec_token: 't' })) as Enrichment
    expect(e.article?.text).toBe('要的')
  })

  it('源一条都没回 → 空 Enrichment（不是抛）', async () => {
    const { enricher } = setup([])
    expect(await enricher({ noteId: 'n5', xsec_token: 't' })).toEqual({})
  })

  it('缺 noteId → ValidationError（调用方写错了，宿主翻 400）', async () => {
    const { enricher, readSource } = setup()
    await expect(enricher({ xsec_token: 't' })).rejects.toBeInstanceOf(ValidationError)
    expect(readSource).not.toHaveBeenCalled()
  })

  // enricher 的调用方是前端，永远带着 token；缺 token 只会落进 fallback-nav 并注定失败，白烧限速名额，一律拒。
  it('缺 xsec_token → ValidationError（token 缺省只在 adapter 的 miss 路径豁免）', async () => {
    const { enricher, readSource } = setup()
    await expect(enricher({ noteId: 'n1' })).rejects.toBeInstanceOf(ValidationError)
    expect(readSource).not.toHaveBeenCalled()
  })

  it('readSource 抛 → 原样抛（宿主翻 502 / WS 发 failed，不吞）', async () => {
    const readSource = vi.fn(async () => { throw new Error('登录墙') })
    const enricher = makeDetailEnricher({ readSource, streams: new StreamTable() })['xhs-detail']!
    await expect(enricher({ noteId: 'n1', xsec_token: 't' })).rejects.toThrow('登录墙')
  })
})
