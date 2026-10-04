// 详情页开出来，左边那格视频**自己播不播**：由调用方按「用户这一下点的是媒体还是正文」给
// （App 的 openDetail → autoPlaysDetailMedia → Detail 的 autoPlayMedia）。
//
// 为什么要钉：这里以前没有开关，进详情页一律 autoplay——那是"只有点缩略图才进得来"年代的
// 假设。列表行/瀑布流卡片点标题也进得来之后，表现就是「点帖子就自己放视频」，而且不报错：
// 详情页确实开对了，只是画面被一段视频占了。
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { Detail } from './Detail.tsx'
import { VideoStageContext, type VideoStage } from '../lib/videoStage.ts'
import type { Item } from '../lib/types.ts'

// 播放器本体在 ArtPlayer.test.tsx 里钉（autoplay 进不进 Artplayer 的构造选项）；这里只钉
// 「Detail 把哪个值递给它」——两段合起来才是从点击到构造选项的完整链路。
const artProps: Array<Record<string, unknown>> = []
vi.mock('./ArtPlayer.tsx', () => ({
  ArtPlayer: (props: Record<string, unknown>) => {
    artProps.push(props)
    return <div data-testid="art-player" />
  },
}))

const videoStage: VideoStage = {
  activeId: null, openId: null, node: null, videoSize: null,
  play: () => {}, stop: () => {}, seek: () => {},
}
const conn = { baseUrl: 'http://x' }

const videoItem: Item = {
  id: 'v1', stream_id: 'rss-s1', type: 'post', title: '一段视频',
  url: 'https://example.com/a',
  content: { archetype: 'video', media: [{ kind: 'video', url: 'https://cdn.example.com/clip.mp4' }] },
  timestamp: '2026-08-13T00:00:00.000Z', fetched_at: '2026-08-13T00:00:00.000Z',
}

function renderDetail(over: Partial<Parameters<typeof Detail>[0]> = {}) {
  artProps.length = 0
  return render(
    <VideoStageContext.Provider value={videoStage}>
      <Detail item={videoItem} conn={conn} onClose={() => {}} canExtract={() => false} {...over} />
    </VideoStageContext.Provider>,
  )
}

describe('Detail 的 autoPlayMedia', () => {
  it('缺省不自动播——没人说过这一下是冲着看来的', () => {
    renderDetail()
    expect(artProps.length).toBeGreaterThan(0)
    expect(artProps[0].autoplay).toBe(false)
  })

  it('点正文进来（autoPlayMedia=false）：播放器挂着但不播', () => {
    renderDetail({ autoPlayMedia: false })
    expect(artProps[0].autoplay).toBe(false)
  })

  it('点媒体进来（autoPlayMedia=true）：照旧自动播', () => {
    renderDetail({ autoPlayMedia: true })
    expect(artProps[0].autoplay).toBe(true)
  })
})
