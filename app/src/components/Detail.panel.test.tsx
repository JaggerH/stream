// 详情页的右面板：**只有一档**（详情），所以没有切换器。
//
// 对话曾经是第二档（ChatStage），随原生对话抽屉一起退役
// （spec 2026-08-17-native-chat-drawer-removal）；转写更早（2026-08-12）就不在这儿了。
//
// 这里钉的是拆完之后还必须成立的几件事：面板在不在场仍只由 hasArtifacts 说了算（一条没有
// 评论的视频照样有面板，否则下载 / 转成文字在详情页里一个入口都没有，而且不会有任何一处报错）、
// 面板里装着作者块 + 标题 + 动作行、评论区的显隐判据没被改掉，以及**详情页不去拉转换记录**。
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Detail } from './Detail.tsx'
import { VideoStageContext, type VideoStage } from '../lib/videoStage.ts'
import type { Item } from '../lib/types.ts'

vi.mock('./ArtPlayer.tsx', () => ({ ArtPlayer: () => <div data-testid="art-player" /> }))

const forItem = vi.fn()
vi.mock('../lib/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.ts')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      conversions: { ...actual.api.conversions, forItem: (...a: unknown[]) => forItem(...a) },
      voiceprint: {
        ...actual.api.voiceprint,
        listClusters: () => Promise.resolve([]),
        listPersons: () => Promise.resolve([]),
        blocks: () => Promise.resolve([]),
      },
    },
  }
})

const videoStage: VideoStage = {
  activeId: null, openId: null, node: null, videoSize: null,
  play: () => {}, stop: () => {}, seek: () => {},
}
const conn = { baseUrl: 'http://x' }

/** 有媒体 + 有评论（包写了便宜的 content.enrich → hasCommentThread 真）：走 DetailShell，右面板 = info。 */
const videoWithComments: Item = {
  id: 'vc1', stream_id: 'forum-s1', type: 'post', title: '一段带评论的视频',
  url: 'https://forum.example/t/1024',
  content: {
    archetype: 'video', text: '正文段落', media: [{ kind: 'video', url: 'https://cdn.example.com/clip.mp4' }],
    enrich: { source: 'demo-comments', params: { id: '1024' }, prefetch: true },
  },
  timestamp: '2026-08-11T00:00:00.000Z', fetched_at: '2026-08-11T00:00:00.000Z',
}

/** 有媒体、没有评论线程（rss）：面板仍在场（canExtract 真）。 */
const videoNoComments: Item = {
  id: 'vn1', stream_id: 'rss-s1', type: 'post', title: '一段没有评论的视频',
  url: 'https://example.com/a',
  content: { archetype: 'video', media: [{ kind: 'video', url: 'https://cdn.example.com/clip.mp4' }] },
  timestamp: '2026-08-11T00:00:00.000Z', fetched_at: '2026-08-11T00:00:00.000Z',
}

/** 无媒体 + 有面板：左栏正文 / 右栏 readingPanelNode。 */
const textWithPanel: Item = {
  id: 't1', stream_id: 'forum-s1', type: 'post', title: '一个话题',
  url: 'https://forum.example/t/2048',
  content: { archetype: 'text', text: '左栏的正文', enrich: { source: 'demo-comments', params: { id: '2048' }, prefetch: true } },
  timestamp: '2026-08-11T00:00:00.000Z', fetched_at: '2026-08-11T00:00:00.000Z',
}

/** 纯图文帖：没评论、取不了正文、没媒体 → 单栏阅读页，不长面板。 */
const plainPost: Item = {
  id: 'p1', stream_id: 'rss-s1', type: 'post', title: '一篇纯图文',
  url: 'https://example.com/plain',
  content: { archetype: 'text', text: '单栏里的正文' },
  timestamp: '2026-08-11T00:00:00.000Z', fetched_at: '2026-08-11T00:00:00.000Z',
}

function renderDetail(item: Item, canExtract = true) {
  return render(
    <VideoStageContext.Provider value={videoStage}>
      <Detail item={item} conn={conn} onClose={() => {}} canExtract={() => canExtract} />
    </VideoStageContext.Provider>
  )
}

beforeEach(() => {
  localStorage.clear()
  forItem.mockReset()
  forItem.mockResolvedValue({ items: [] })
})

describe('Detail — 右面板只剩详情一档', () => {
  it('面板里装着标题和动作行（有媒体那个分支）', () => {
    renderDetail(videoWithComments)
    expect(screen.getByRole('heading', { name: videoWithComments.title })).toBeTruthy()
    expect(screen.getByRole('button', { name: /转成文字/ })).toBeTruthy()
  })

  it('无媒体 + 有面板：作者头进面板，左栏正文只有一份（没被复制进面板）', () => {
    renderDetail(textWithPanel)
    expect(screen.getByRole('heading', { name: textWithPanel.title })).toBeTruthy()
    expect(screen.getAllByText('左栏的正文')).toHaveLength(1)
  })

  it('纯图文帖不受影响：单栏里照常有作者头 + 标题 + 正文', () => {
    renderDetail(plainPost, false)
    expect(screen.getByRole('heading', { name: plainPost.title })).toBeTruthy()
    expect(screen.getByText('单栏里的正文')).toBeTruthy()
  })

  // 面板在不在场只由 hasArtifacts 说了算。这一格坏掉的表现是一条没有评论的视频在详情页里
  // 再也点不到下载 / 转成文字，而且没有任何一处会报错。
  it('没有评论的条目照样有面板——否则下载/转成文字在详情页里没有任何入口', () => {
    renderDetail(videoNoComments)
    expect(screen.getByRole('button', { name: /转成文字/ })).toBeTruthy()
  })

  // 一档不画切换器：一个只有一个选项的分段控件是纯噪声。
  it('不画任何档位切换器', () => {
    renderDetail(videoWithComments)
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
  })

  // 对话档没了，页面上不该再有对话的任何痕迹（舞台、对话格）。
  it('页面上没有对话舞台', () => {
    renderDetail(videoWithComments)
    expect(screen.queryByTestId('chat-stage')).toBeNull()
    expect(screen.queryByTestId('chat-pane')).toBeNull()
  })

  it('详情档里的评论区带「评论」抬头', () => {
    renderDetail(videoWithComments)
    expect(screen.getByText(/^评论/)).toBeTruthy()
  })

  // 没有评论线程的条目由调用方传 enr=null（`hasCommentThread(item) ? enr : null`）。这一格
  // 坏掉（有人改回 `enr={enr}`）的表现是每条 RSS 视频的详情档底下多出一句「暂无评论」。
  it('没有评论线程的条目：面板里压根不画评论区', () => {
    renderDetail(videoNoComments)
    expect(screen.queryByText('暂无评论')).toBeNull()
    expect(screen.queryByText(/^评论/)).toBeNull()
  })

  // 转写档没了，详情页就不该再碰 /api/conversions——那一份 `expand=result` 驮的是整份
  // segments（分钟级）。谁要是把它接回详情页，每开一次详情页就白拉一遍。
  it('详情页不去拉转换记录', () => {
    renderDetail(videoWithComments)
    expect(forItem).not.toHaveBeenCalled()
  })
})
