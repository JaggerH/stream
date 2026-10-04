import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Detail } from './Detail.tsx'
import { VideoStageContext, type VideoStage } from '../lib/videoStage.ts'
import { createHtmlPortalNode } from '../lib/portal.ts'
import type { Item } from '../lib/types.ts'
import type { EnrichmentState } from '../lib/preload.ts'

// mock 把收到的 blurb 原样画出来——这样断言能真的抓住「blurb 有没有传到 ArtPlayer」这条缺陷，
// 而不是只验证 mock 组件本身存在（那种断言对「漏转发一个 prop」没有牙）。
vi.mock('./ArtPlayer.tsx', () => ({
  ArtPlayer: ({ blurb }: { blurb?: string }) => <div data-testid="art-player">{blurb}</div>,
}))

// Detail 的富化状态来自内部 hook（useEnrichment），不是 prop——要在测试里控制 art.text，
// 只能 mock 这个 hook。默认给"没富化"的空状态，和真实网络环境下大多数用例的观感一致；
// 单条用例按需覆盖返回值。
const enrichmentMock = vi.fn<() => EnrichmentState>(() => ({
  article: null, comments: [], total: 0, loading: false, err: false, hasMore: false, loadMore: () => {},
}))
vi.mock('../lib/preload.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/preload.ts')>()
  return { ...actual, useEnrichment: () => enrichmentMock() }
})

const videoStage: VideoStage = {
  activeId: null, openId: null, node: null, videoSize: null,
  play: () => {}, stop: () => {}, seek: () => {},
}
const conn = { baseUrl: 'http://x' }

function renderDetail(node: ReactNode) {
  return render(
    <VideoStageContext.Provider value={videoStage}>{node}</VideoStageContext.Provider>
  )
}

const gallery: Item = {
  id: 'g1', stream_id: 's1', type: 'post', title: '一组图',
  timestamp: '2026-08-11T00:00:00.000Z', fetched_at: '2026-08-11T00:00:00.000Z',
  content: {
    archetype: 'gallery',
    text: '这是一段简介',
    media: [{ kind: 'image', url: 'https://cdn.example.com/1.jpg' }],
  },
}

describe('Detail — 简介下沉到媒体台', () => {
  it('图集条目的简介画在浮层里，且右面板不再重复画一遍', () => {
    renderDetail(<Detail item={gallery} conn={conn} onClose={() => {}} />)
    const box = screen.getByTestId('blurb-overlay')
    expect(box.textContent).toContain('这是一段简介')
    // 全文档里只出现一次 = 面板那份已经撤了
    expect(screen.getAllByText('这是一段简介')).toHaveLength(1)
  })

  // 点卡片整行打开详情页（PostItemRow）不会调 stage.play，视频走的是「stage.activeId 不等于
  // 本条 item」这条分支——VideoView 自己起一份 ArtPlayer，而不是复用 OutPortal 拉进来的那份。
  // 这条分支曾经拿不到 blurb：媒体台的常驻浮层只画给"没有会自动隐的控制条"的形态（播客/图集），
  // 视频这档指望播放器自己画，但 VideoView 没转发 blurb 给它——两处都不画，简介直接消失。
  const video: Item = {
    id: 'v1', stream_id: 's1', type: 'post', title: '一条视频',
    timestamp: '2026-08-11T00:00:00.000Z', fetched_at: '2026-08-11T00:00:00.000Z',
    content: {
      archetype: 'video',
      text: '视频简介文本',
      media: [{ kind: 'video', url: '/media/v1.mp4' }],
    },
  }

  it('视频条目走"未接管播放"分支时，简介仍要传进播放器（而不是两处都消失）', () => {
    // videoStage.activeId 是 null，不等于 video.id，所以走的正是 VideoView 自渲染 ArtPlayer 那条分支。
    renderDetail(<Detail item={video} conn={conn} onClose={() => {}} />)
    const player = screen.getByTestId('art-player')
    expect(player.textContent).toContain('视频简介文本')
  })

  // 第三方嵌入视频：没有 url、不是 bilibili/douyin/xhs，只有 embed —— planVideo 落进
  // 'iframe' 档（见 videoPlan.ts 第 85 行），这一档根本不起 ArtPlayer（点了才挂 <iframe>），
  // 所以 blurb 转发到播放器那条路对它不成立；media 台上的常驻浮层也因为 videos.length>0
  // 被跳过、右面板又被 blurb 非空抹掉——简介两处同时消失且不报错，是同一类缺陷换了分支。
  const iframeVideo: Item = {
    id: 'v2', stream_id: 's1', type: 'post', title: '一条第三方嵌入视频',
    timestamp: '2026-08-11T00:00:00.000Z', fetched_at: '2026-08-11T00:00:00.000Z',
    content: {
      archetype: 'video',
      text: '嵌入视频简介文本',
      media: [{ kind: 'video', embed: 'https://player.example.com/embed/xyz', provider: 'generic' }],
    },
  }

  it('第三方 iframe 嵌入视频（未起 ArtPlayer）时，简介要画在媒体台的常驻浮层里', () => {
    renderDetail(<Detail item={iframeVideo} conn={conn} onClose={() => {}} />)
    const box = screen.getByTestId('blurb-overlay')
    expect(box.textContent).toContain('嵌入视频简介文本')
    expect(screen.getAllByText('嵌入视频简介文本')).toHaveLength(1)
  })

  // 只有封面、没有可播流（既没有 url 也没有 embed）：planVideo 落进 'poster' 档（videoPlan.ts
  // 第 86 行），和 iframe 一样根本不起 ArtPlayer，走的是同一条"常驻浮层"路径，但此前没有
  // 专门覆盖过这一档。
  const posterOnlyVideo: Item = {
    id: 'v4', stream_id: 's1', type: 'post', title: '一条只有封面的视频',
    timestamp: '2026-08-11T00:00:00.000Z', fetched_at: '2026-08-11T00:00:00.000Z',
    content: {
      archetype: 'video',
      text: '只有封面的视频简介文本',
      media: [{ kind: 'video', poster: 'https://cdn.example.com/poster.jpg' }],
    },
  }

  it('只有封面(poster 档，未起 ArtPlayer)时，简介要画在媒体台的常驻浮层里', () => {
    renderDetail(<Detail item={posterOnlyVideo} conn={conn} onClose={() => {}} />)
    const box = screen.getByTestId('blurb-overlay')
    expect(box.textContent).toContain('只有封面的视频简介文本')
    expect(screen.getAllByText('只有封面的视频简介文本')).toHaveLength(1)
  })

  // 共用播放器实例经 OutPortal 骑走这一支：真正画出来的那份 blurb 是 App.tsx 自己算的
  // （overlayBlurb(activeVideo.item)，不带 art?.text/art?.html）。这条 item 的
  // content.text 是空的——正文只靠详情页富化的 art.text 才有值。如果 Detail 用自己
  // 算的那份（带 art?.text）去判断"这段还画不画"，会得到非空 blurb：常驻浮层因
  // blurbRidesPlayer 为真被跳过（合理，播放器自己画），但右面板也因为 blurb 非空被
  // 抹掉——而 portal 里那份播放器实例根本没拿到这份富化文本，画的是空串。简介三处
  // 同时消失，且不报错。断言：右面板要照常画出正文（因为对齐 App.tsx 后 Detail 判断
  // 出的 blurb 应为空，不该抑制右面板）。
  const portalVideo: Item = {
    id: 'v3', stream_id: 's1', type: 'post', title: '一条经共用播放器打开的视频',
    timestamp: '2026-08-11T00:00:00.000Z', fetched_at: '2026-08-11T00:00:00.000Z',
    content: {
      archetype: 'video',
      text: '',
      media: [{ kind: 'video', url: '/media/v3.mp4' }],
    },
  }

  it('骑共用播放器(OutPortal)时，右面板判断要和 App.tsx 那份实例同源，不能静默抹掉正文', () => {
    enrichmentMock.mockReturnValueOnce({
      article: { sourceUrl: '', text: '详情页富化拿到的正文' },
      comments: [], total: 0, loading: false, err: false, hasMore: false, loadMore: () => {},
    })
    const node = createHtmlPortalNode({ attributes: { class: 'h-full w-full' } })
    const sharedStage: VideoStage = { ...videoStage, activeId: portalVideo.id, node }
    render(
      <VideoStageContext.Provider value={sharedStage}>
        <Detail item={portalVideo} conn={conn} onClose={() => {}} />
      </VideoStageContext.Provider>
    )
    // 右面板没被静默抑制：art.text（详情页富化拿到、App.tsx 那份播放器实例根本看不到的正文）
    // 应该照常画出来，而不是因为 Detail 自己算出的 blurb 非空被 `blurb ? null : ...` 吞掉。
    expect(screen.getByText('详情页富化拿到的正文')).toBeTruthy()
  })
})
