// 点一条内容时，**点的是媒体还是正文**必须一路传到详情页——它决定详情页开出来自己播不播
// （判据 lib/openDetail.ts 的 autoPlaysDetailMedia，消费端见 Detail 的 autoPlayMedia）。
//
// 这一格信息以前在 `onOpen(item, mediaIndex?)` 的签名处就被抹平了：点正文（不带 index）和
// 点第 0 张媒体，到了 `openDetail(item, mediaIndex = 0)` 之后长得一模一样。表现是在时间线里
// 点帖子标题，详情页开了、但整块画面立刻开始放视频。两种布局同一批用例：这条语义不该跟着
// 布局变（列表行的媒体是内联播放，网格的封面是进详情页播，但"点媒体 = 想看"两边一致）。
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { PostItemRow } from './PostItemRow.tsx'
import { PostCard } from './PostCard.tsx'
import { AudioStageContext, type AudioStage } from '../../lib/audioStage.ts'
import { VideoStageContext, type VideoStage } from '../../lib/videoStage.ts'
import { autoPlaysDetailMedia } from '../../lib/openDetail.ts'
import type { Item } from '../../lib/types.ts'

const videoStage: VideoStage = {
  activeId: null, openId: null, node: null, videoSize: null,
  play: () => {}, stop: () => {}, seek: () => {},
}
const audioStage: AudioStage = {
  current: null, playing: false, duration: 0, activeKind: 'music',
  queues: { music: [], podcast: [] }, queue: [],
  play: () => {}, playQueue: () => {}, playAt: () => {}, toggle: () => {}, seek: () => {}, stop: () => {},
  getVolume: () => 1, setVolume: () => {},
}

const wrap = (node: ReactNode) => (
  <VideoStageContext.Provider value={videoStage}>
    <AudioStageContext.Provider value={audioStage}>{node}</AudioStageContext.Provider>
  </VideoStageContext.Provider>
)

// 一条带封面图的帖子：两种布局都会画出媒体那一格（列表行 → PostMedia，网格 → CardMedia）。
const item = {
  id: 'i-1', stream_id: 's1', type: 'post', title: '一条内容', author: '作者',
  timestamp: '2026-08-13T00:00:00.000Z', fetched_at: '2026-08-13T00:00:00.000Z',
  content: { archetype: 'text', text: '正文', media: [{ kind: 'image', url: 'https://x/a.jpg', w: 800, h: 600 }] },
} as unknown as Item

const layouts = {
  列表行: (onOpen: (item: Item, opts?: unknown) => void) =>
    render(wrap(<PostItemRow item={item} last onOpen={onOpen} />)),
  瀑布流卡片: (onOpen: (item: Item, opts?: unknown) => void) =>
    render(wrap(<PostCard item={item} onOpen={onOpen} />)),
}

describe.each(Object.entries(layouts))('%s：点正文 vs 点媒体', (_name, renderLayout) => {
  it('点标题(非媒体区) → intent 是 read，详情页不自己播', () => {
    const onOpen = vi.fn()
    renderLayout(onOpen)
    fireEvent.click(screen.getByText('一条内容'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    const opts = onOpen.mock.calls[0][1] as { intent?: 'watch' | 'read' } | undefined
    expect(opts?.intent).toBe('read')
    expect(autoPlaysDetailMedia(opts?.intent)).toBe(false)
  })

  it('点媒体 → intent 是 watch，详情页照旧自动播', () => {
    const onOpen = vi.fn()
    const { container } = renderLayout(onOpen)
    // 两种布局的"媒体"是哪一块：列表行是**画面本身**（`media-hit`，铺在 MediaBox 的 frame 里，
    // 不是那条 w-full 的外框——外框的空档归行，见 PostItemRow 的 MediaHitArea），网格是 CardMedia。
    const media = container.querySelector('[data-slot="media-hit"], [data-slot="card-media"]')
    expect(media).toBeTruthy()
    fireEvent.click(media as Element)
    expect(onOpen).toHaveBeenCalledTimes(1)
    const opts = onOpen.mock.calls[0][1] as { intent?: 'watch' | 'read' } | undefined
    expect(opts?.intent).toBe('watch')
    expect(autoPlaysDetailMedia(opts?.intent)).toBe(true)
  })
})

describe('autoPlaysDetailMedia', () => {
  it('说不清意图时不播——安静地开着比抢着播更不会错', () => {
    expect(autoPlaysDetailMedia(undefined)).toBe(false)
  })
})
