import { describe, it, expect, vi } from 'vitest'
import { fetchUrlFor } from './fetch-url.ts'
import { StreamTable } from './streams.ts'
import { XhsAdapter } from './adapter.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

const ID = '6aafa8f4000000002902e34b'
const SHARE = `https://www.xiaohongshu.com/discovery/item/${ID}?source=webshare&xhsshare=pc_web&xsec_token=ABp6rV=&xsec_source=pc_share`
const VIDEO_URL = 'http://sns-video-qc.example-cdn.com/stream/x.mp4?sign=s'

function note(extra: Record<string, unknown> = {}) {
  return {
    noteId: ID, title: '小星星的大月饼', desc: '正文', author: '早教Bang', author_avatar: 'http://a/1.png',
    imageList: [{ urlDefault: 'http://img/1.webp' }, { urlDefault: 'http://img/2.webp' }],
    ...extra,
  }
}

function setup(items: unknown[]) {
  const readSource = vi.fn(async () => items)
  const streams = new StreamTable()
  return { readSource, streams, deps: { readSource, streams } }
}

describe('xhs-fetch-url', () => {
  it('分享链接（/discovery/item/）→ 用链接里的 noteId + xsec_token 跑 xhs-detail；视频笔记走宿主播放路由', async () => {
    const { deps, readSource, streams } = setup([note({ video_stream: { EF4: [{ masterUrl: VIDEO_URL }] } })])
    const r = await fetchUrlFor(deps, SHARE)
    expect(readSource).toHaveBeenCalledWith('xhs-detail', { noteId: ID, xsec_token: 'ABp6rV=' }, expect.anything())
    expect(r).toMatchObject({ platform: 'xhs', title: '小星星的大月饼', author: '早教Bang', author_avatar: 'http://a/1.png', text: '正文' })
    expect(r.error).toBeUndefined()
    expect(r.media).toEqual([{
      kind: 'video',
      url: `/api/media/play?platform=xhs&vid=${ID}`,
      download_url: `/api/media/play?platform=xhs&vid=${ID}&dl=1`,
      poster: 'http://img/1.webp',
    }])
    // 播放时 xhs-resolve 只吃流地址表——这里必须已经登记。
    expect(streams.get(ID)).toBe(VIDEO_URL)
  })

  it('图文笔记（/explore/）→ 整套图集', async () => {
    const { deps } = setup([note()])
    const r = await fetchUrlFor(deps, `https://www.xiaohongshu.com/explore/${ID}?xsec_token=T`)
    expect(r.media).toEqual([{ kind: 'image', url: 'http://img/1.webp' }, { kind: 'image', url: 'http://img/2.webp' }])
  })

  it('缺 xsec_token → 带原因的失败，且不跑 recipe（白烧限速名额）', async () => {
    const { deps, readSource } = setup([note()])
    const r = await fetchUrlFor(deps, `https://www.xiaohongshu.com/explore/${ID}`)
    expect(r.error).toMatch(/xsec_token/)
    expect(readSource).not.toHaveBeenCalled()
  })

  it('抠不出笔记 id → 带原因的失败', async () => {
    const { deps, readSource } = setup([note()])
    const r = await fetchUrlFor(deps, 'https://www.xiaohongshu.com/user/profile/abc?xsec_token=T')
    expect(r.error).toBeTruthy()
    expect(r.media).toEqual([])
    expect(readSource).not.toHaveBeenCalled()
  })

  it('recipe 读不到笔记 → 带原因的失败，不是空成功', async () => {
    const { deps } = setup([])
    const r = await fetchUrlFor(deps, SHARE)
    expect(r.media).toEqual([])
    expect(r.error).toBeTruthy()
  })

  describe('xhslink.com 短链：只跟一跳', () => {
    const redirecting = (loc: string) =>
      (async () => new Response(null, { status: 302, headers: { location: loc } })) as unknown as typeof fetch

    it('Location 落在主站 → 用长链上的 id 与 token', async () => {
      const { deps, readSource } = setup([note()])
      const r = await fetchUrlFor(deps, 'http://xhslink.com/a/AbCd', { fetch: redirecting(SHARE) })
      expect(r.error).toBeUndefined()
      expect(readSource).toHaveBeenCalledWith('xhs-detail', { noteId: ID, xsec_token: 'ABp6rV=' }, expect.anything())
    })

    it('跳去别的站 → 不当笔记链接看', async () => {
      const { deps, readSource } = setup([note()])
      const r = await fetchUrlFor(deps, 'http://xhslink.com/a/AbCd', { fetch: redirecting(`https://evil.example/explore/${ID}?xsec_token=T`) })
      expect(r.error).toBeTruthy()
      expect(readSource).not.toHaveBeenCalled()
    })
  })

  it('adapter 按 manifest id 分派到这里，回单个对象', async () => {
    const { deps } = setup([note()])
    const out = await new XhsAdapter(deps).fetch({ url: SHARE }, { id: '@streamapp/xhs/xhs-fetch-url' } as unknown as SourceManifest)
    expect(out).toHaveLength(1)
    expect((out[0] as { platform: string }).platform).toBe('xhs')
  })
})
