// Detail 的两组「能不能对这条动手」的入口：
//  1) 音频分支：打开一集播客，媒体面板必须给出播放控件，而不是塌成纯文字列（分支前的行为）。
//     规则与列表行一致：舞台可空（没有 provider → 没有控件，也不崩）、点击优先交给队列生产者。
//  2) 解析 / 下载：瀑布流卡片没有常驻动作条，所以这两件事只剩全屏 Detail 一个入口
//     （搜索页默认瀑布流）。闸门必须和列表行同款。
import { afterEach, describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Detail } from './Detail.tsx'
import { AudioStageContext, type AudioStage, type AudioTrack } from '../lib/audioStage.ts'
import { VideoStageContext, type VideoStage } from '../lib/videoStage.ts'
import type { Item } from '../lib/types.ts'

// 「转成文字」的动作面（两个入口共用的那一份）。
const askExtractMock = vi.hoisted(() => vi.fn())
vi.mock('../lib/askExtract.ts', () => ({ askExtract: askExtractMock }))

// 真 Artplayer 在 jsdom 里挂不起来；下载用例只关心动作面，不关心播放器。
vi.mock('./ArtPlayer.tsx', () => ({ ArtPlayer: () => <div data-testid="art-player" /> }))

// 下载走 DOM（造 <a> 再点），在 jsdom 里没有可断言的落点——把它换成一个记账的桩，
// 断言的是「Detail 把派生出来的那条 URL 交给了下载」。其余 feedPresent 导出保持真实。
const dl = vi.hoisted(() => ({ hrefs: [] as string[] }))
vi.mock('../lib/feedPresent.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/feedPresent.ts')>()
  return { ...actual, triggerDownload: (href: string) => { dl.hrefs.push(href) } }
})

afterEach(() => {
  dl.hrefs.length = 0
})

const videoStage: VideoStage = { activeId: null, openId: null, node: null, videoSize: null, play: () => {}, stop: () => {}, seek: () => {}, }

function makeStage(over: Partial<AudioStage> = {}): AudioStage {
  return {
    current: null, playing: false, duration: 0, activeKind: 'music',
    queues: { music: [], podcast: [] }, queue: [],
    play: () => {}, playQueue: () => {}, playAt: () => {}, toggle: () => {}, seek: () => {}, stop: () => {},
    getVolume: () => 1, setVolume: () => {},
    ...over,
  }
}

const episode: Item = {
  id: 'ep1',
  stream_id: 'podcast-s1',
  type: 'post',
  title: '第 42 期：过夜任务',
  author: '某播客',
  content: {
    archetype: 'audio',
    media: [{ kind: 'audio', url: 'https://cdn.example.com/ep42.mp3', poster: 'https://cdn.example.com/cover.jpg', duration_s: 3600 }],
  },
  timestamp: '2026-07-22T20:00:00.000Z',
  fetched_at: '2026-07-22T20:00:00.000Z',
}

const conn = { baseUrl: 'http://x' }

describe('Detail — audio branch', () => {
  it('renders a play affordance for a podcast episode and hands the click to the queue producer', () => {
    const onPlayAudio = vi.fn()
    render(
      <VideoStageContext.Provider value={videoStage}>
        <AudioStageContext.Provider value={makeStage()}>
          <Detail item={episode} conn={conn} onClose={() => {}} onPlayAudio={onPlayAudio} />
        </AudioStageContext.Provider>
      </VideoStageContext.Provider>
    )
    fireEvent.click(screen.getAllByLabelText('播放')[0])
    expect(onPlayAudio).toHaveBeenCalledWith(episode)
  })

  it('shows the pause control for the episode that is already playing', () => {
    const toggle = vi.fn()
    const current: AudioTrack = { id: 'ep1', url: 'https://cdn.example.com/ep42.mp3', kind: 'podcast' }
    render(
      <VideoStageContext.Provider value={videoStage}>
        <AudioStageContext.Provider value={makeStage({ current, playing: true, activeKind: 'podcast', toggle })}>
          <Detail item={episode} conn={conn} onClose={() => {}} />
        </AudioStageContext.Provider>
      </VideoStageContext.Provider>
    )
    fireEvent.click(screen.getAllByLabelText('暂停')[0])
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('renders without the affordance (and without crashing) outside the AudioStage provider', () => {
    render(
      <VideoStageContext.Provider value={videoStage}>
        <Detail item={episode} conn={conn} onClose={() => {}} />
      </VideoStageContext.Provider>
    )
    expect(screen.queryByLabelText('播放')).toBeNull()
  })
})

/** 一条可解析的贴文：PDF 链接（parseableSource 认 image 或 .pdf 链接）。 */
const pdfPost: Item = {
  id: 'pdf1',
  stream_id: 'rss-s1',
  type: 'post',
  title: '2025 年报',
  author: '某上市公司',
  content: {
    archetype: 'link',
    media: [{ kind: 'link', url: 'https://files.example.com/annual-2025.pdf', title: '年报' }],
  },
  timestamp: '2026-07-22T20:00:00.000Z',
  fetched_at: '2026-07-22T20:00:00.000Z',
}

/** 一条带评论区的帖子（包写了便宜的 content.enrich → hasCommentThread 真）：用来钉「评论 + 转成文字同屏」。 */
const forumPost: Item = {
  id: 'forum1',
  stream_id: 'forum-s1',
  type: 'post',
  title: '一个话题',
  author: '某网友',
  url: 'https://forum.example/t/1024',
  content: { archetype: 'text', text: '正文', enrich: { source: 'demo-comments', params: { id: '1024' }, prefetch: true } },
  timestamp: '2026-07-22T20:00:00.000Z',
  fetched_at: '2026-07-22T20:00:00.000Z',
}

/** 一条能下载的视频贴文：带直链 → planVideo 判成 file → videoDownloadUrl 出非空。 */
const videoPost: Item = {
  id: 'vid1',
  stream_id: 'rss-s2',
  type: 'post',
  title: '一段视频',
  author: '某作者',
  content: {
    archetype: 'video',
    media: [{ kind: 'video', url: 'https://cdn.example.com/clip.mp4', poster: 'https://cdn.example.com/p.jpg' }],
  },
  timestamp: '2026-07-22T20:00:00.000Z',
  fetched_at: '2026-07-22T20:00:00.000Z',
}

function renderDetail(node: ReactNode) {
  return render(<VideoStageContext.Provider value={videoStage}>{node}</VideoStageContext.Provider>)
}

describe('Detail — 转成文字 / 下载入口', () => {
  it('可转成文字时显示「转成文字」入口，点它把这条交给对话', () => {
    renderDetail(<Detail item={pdfPost} conn={conn} onClose={() => {}} canExtract={() => true} />)
    fireEvent.click(screen.getByRole('button', { name: /转成文字/ }))
    // 动作面是两个入口共用的那一份（lib/askExtract.ts）——提示语形状与"面板内 / 独立前端"
    // 两条路的判据住在它自己那份测试里，这里只钉「点了有没有调它、带的是不是这条 item」。
    expect(askExtractMock).toHaveBeenCalledWith(conn, pdfPost)
  })

  it('既有评论又能转成文字时：按钮在动作行（右面板只有一档，没有切换器）', () => {
    renderDetail(<Detail item={forumPost} conn={conn} onClose={() => {}} canExtract={() => true} />)
    expect(screen.getByRole('button', { name: /转成文字/ })).toBeTruthy()
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
  })

  it('canExtract 谓词说不行时不显示转成文字入口（判定在 shared/extract/plan.ts，这里只消费）', () => {
    renderDetail(<Detail item={pdfPost} conn={conn} onClose={() => {}} canExtract={() => false} />)
    expect(screen.queryByRole('button', { name: /转成文字/ })).toBeNull()
  })

  it('解析到可下载的视频时显示下载按钮，点击把派生出的那条 URL 交给下载', () => {
    renderDetail(<Detail item={videoPost} conn={conn} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    expect(dl.hrefs).toHaveLength(1)
    expect(dl.hrefs[0]).toContain('https://cdn.example.com/clip.mp4')
    expect(dl.hrefs[0]).toContain('dl=1')
  })

  it('没有可下载视频的条目不显示下载按钮', () => {
    renderDetail(<Detail item={pdfPost} conn={conn} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: '下载' })).toBeNull()
  })

  // 「识别发言人」开关已撤（diarize 归模型：extract 工具自己吃这个参数）。拿播客音频这条钉，
  // 是因为它曾经是这格开关唯一会出现的场景——挂上 AudioStageContext 才算得出 audioTrack，
  // 少了它这条断言会"因为别的原因"变绿，等于没钉。
  it('播客音频条目 + canExtract 为真时，动作行里也没有「识别发言人」开关', () => {
    render(
      <VideoStageContext.Provider value={videoStage}>
        <AudioStageContext.Provider value={makeStage()}>
          <Detail item={episode} conn={conn} onClose={() => {}} canExtract={() => true} />
        </AudioStageContext.Provider>
      </VideoStageContext.Provider>
    )
    // 前提校验：这条确实画出了转成文字入口（否则整个动作行都不在，断言无意义）。
    expect(screen.getByRole('button', { name: /转成文字/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '识别发言人' })).toBeNull()
  })
})
