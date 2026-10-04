// 媒体的可点区域 = **画面本身**，不是 MediaBox 那条 `w-full` 外框。
//
// MediaBox 是两层：外层恒占满整列（列表 490px），里层 frame 才是按比例算出来的画面
// （竖版视频 507×9/16 ≈ 285px，左对齐）。交互挂在外层时，画面右边那条 205px 空档就有了
// 两种"用户觉得坏了"的表现，**都只在竖版上显形**（横版画面铺满，看不出差别）：
//
//  1. 没播的时候点空档 → 触发播放（用户点的是空白，得到的是播放，而不是打开详情）；
//  2. 正在播的时候点空档 → 那层 `stopPropagation` 把它吃掉 → **什么都不发生**。
//
// 这里钉的就是这两条：空档必须落回行（= 打开详情），画面上的点击照旧归媒体。
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createHtmlPortalNode, InPortal } from 'react-reverse-portal'
import { PostItemRow } from './PostItemRow.tsx'
import { AudioStageContext, type AudioStage } from '../../lib/audioStage.ts'
import { VideoStageContext, type VideoStage } from '../../lib/videoStage.ts'
import type { Item } from '../../lib/types.ts'

const audioStage: AudioStage = {
  current: null, playing: false, duration: 0, activeKind: 'music',
  queues: { music: [], podcast: [] }, queue: [],
  play: () => {}, playQueue: () => {}, playAt: () => {}, toggle: () => {}, seek: () => {}, stop: () => {},
  getVolume: () => 1, setVolume: () => {},
}

function makeVideoStage(over: Partial<VideoStage> = {}): VideoStage {
  return {
    activeId: null, openId: null, node: null, videoSize: null,
    play: () => {}, stop: () => {}, seek: () => {},
    ...over,
  }
}

const wrap = (node: ReactNode, videoStage: VideoStage) => (
  <VideoStageContext.Provider value={videoStage}>
    <AudioStageContext.Provider value={audioStage}>{node}</AudioStageContext.Provider>
  </VideoStageContext.Provider>
)

// 带 (provider, vid) 的条目可以预取评论，行挂了 usePrefetchOnApproach；jsdom 没有
// IntersectionObserver，给个哑的——本测试只关心点击落在哪一层。
vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} } as unknown as typeof IntersectionObserver)

const videoItem = {
  id: 'v-1', stream_id: 'xhs', type: 'post', title: '一条竖版视频', author: '作者',
  timestamp: '2026-08-14T00:00:00.000Z', fetched_at: '2026-08-14T00:00:00.000Z',
  content: {
    archetype: 'video',
    // 带 (provider, vid) 的站点视频走 dash 档、可以行内播；本测试只关心可点区域，不关心平台。
    media: [{ kind: 'video', provider: 'xhs', vid: 'v1', poster: 'https://x/poster.jpg' }],
  },
} as unknown as Item

const imageItem = {
  id: 'i-1', stream_id: 's1', type: 'post', title: '一张竖图', author: '作者',
  timestamp: '2026-08-14T00:00:00.000Z', fetched_at: '2026-08-14T00:00:00.000Z',
  content: { archetype: 'text', text: '正文', media: [{ kind: 'image', url: 'https://x/a.jpg', w: 1080, h: 1920 }] },
} as unknown as Item

/** MediaBox 的外框（`w-full`，竖版下比画面宽出一大截）。 */
const boxOf = (c: HTMLElement) => c.querySelector('[data-slot="media-box"]') as HTMLElement
/** 画面本身那一层。 */
const hitOf = (c: HTMLElement) => c.querySelector('[data-slot="media-hit"]')

describe('列表行的媒体可点区域', () => {
  it('没播时：点画面 → 播放；点外框（竖版右边那条空档）→ 打开详情', () => {
    const play = vi.fn()
    const onOpen = vi.fn()
    const { container } = render(
      wrap(<PostItemRow item={videoItem} last onOpen={onOpen} />, makeVideoStage({ play })),
    )

    fireEvent.click(screen.getByRole('button', { name: '播放视频' }))
    expect(play).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()

    // 外框上的点击 = 空档上的点击：它冒泡到行，开详情，而不是播放。
    fireEvent.click(boxOf(container))
    expect(play).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect((onOpen.mock.calls[0][1] as { intent?: string } | undefined)?.intent).toBe('read')
  })

  it('正在播时：点外框的空档不再被 stopPropagation 吃掉——照样开详情', () => {
    const onOpen = vi.fn()
    const node = createHtmlPortalNode()
    const stage = makeVideoStage({ activeId: videoItem.id, node })
    const { container } = render(
      wrap(
        <>
          <InPortal node={node}><video /></InPortal>
          <PostItemRow item={videoItem} last onOpen={onOpen} />
        </>,
        stage,
      ),
    )
    // 前提：确实进了"内联播放"那一档（不是海报档）。
    expect(container.querySelector('[data-slot="acrylic-inline-video"]')).toBeTruthy()

    fireEvent.click(boxOf(container))
    expect(onOpen).toHaveBeenCalledTimes(1)

    // 播放器本身仍然吃掉点击——点画面不该顺手把详情页弹出来。
    const player = container.querySelector('[data-slot="acrylic-inline-video"] video') as HTMLElement
    fireEvent.click(player)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('图片同理：画面上点是"看这张"，外框空档落回行', () => {
    const onOpen = vi.fn()
    const { container } = render(wrap(<PostItemRow item={imageItem} last onOpen={onOpen} />, makeVideoStage()))

    expect(hitOf(container)).toBeTruthy()
    fireEvent.click(hitOf(container) as Element)
    expect((onOpen.mock.calls[0][1] as { intent?: string } | undefined)?.intent).toBe('watch')

    fireEvent.click(boxOf(container))
    expect((onOpen.mock.calls[1][1] as { intent?: string } | undefined)?.intent).toBe('read')
  })
})
