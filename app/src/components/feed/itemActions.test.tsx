// 一条内容的动作**全部住在右键菜单里**（`ItemContextMenu`），列表行和瀑布流卡片共用同一份。
//
// 为什么这样收：动作条是常驻的，一屏 118 行 × 一排按钮就是 118 排噪音，而其中「看详情」和
// 「点这一行」本来就是同一件事。菜单只在被叫出来时才占地方。
//
// **收不进菜单的只有一类：带状态/带数字、需要一眼看见的东西。** 今天就一样——包声明的点赞/收藏
// 这类 toggle（选中态是它自己的 useState，菜单里再放一份就是两个各自为政的状态，会静默分叉），它走
// hover 浮出，两种布局同一个位置。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { PostItemRow } from './PostItemRow.tsx'
import { PostCard } from './PostCard.tsx'
import { AudioStageContext, type AudioStage } from '../../lib/audioStage.ts'
import { VideoStageContext, type VideoStage } from '../../lib/videoStage.ts'
import { ExtractCapsProvider } from '../../lib/extractCaps.tsx'
import { NO_CAPS, type ExtractCapabilities } from '../../lib/extract.ts'
import type { Item } from '../../lib/types.ts'

/** 后端三档全开。不传就是全关（NO_CAPS）——「转成文字」那一项据此显隐。 */
const ALL_CAPS: ExtractCapabilities = { stt: true, ocr: true, article: true }

// 「转成文字」的动作面（两个入口共用的那一份，lib/askExtract.ts）。这里只钉「点了有没有调它、
// 带的是不是这条 item」——它自己发什么话、走哪条路由它自己那份测试管。
const askExtractMock = vi.hoisted(() => vi.fn())
vi.mock('../../lib/askExtract.ts', () => ({ askExtract: askExtractMock }))

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

function makeItem(over: Partial<Item> = {}): Item {
  return {
    id: 'i-1', stream_id: 's1', type: 'post', title: '一条内容',
    timestamp: '2026-08-12T00:00:00.000Z', fetched_at: '2026-08-12T00:00:00.000Z',
    content: { archetype: 'text', text: '正文' },
    ...over,
  } as Item
}

function wrap(node: ReactNode, { caps = NO_CAPS }: { caps?: ExtractCapabilities } = {}) {
  return (
    <VideoStageContext.Provider value={videoStage}>
      <AudioStageContext.Provider value={audioStage}>
        <ExtractCapsProvider caps={caps}>{node}</ExtractCapsProvider>
      </AudioStageContext.Provider>
    </VideoStageContext.Provider>
  )
}

type LayoutOpts = { caps?: ExtractCapabilities }

/** 两种布局跑同一批用例：动作住在哪儿不该跟着布局变。 */
const layouts = {
  列表行: (item: Item, onOpen: (item: Item) => void, opts?: LayoutOpts) =>
    wrap(<PostItemRow item={item} last onOpen={onOpen} />, opts),
  瀑布流卡片: (item: Item, onOpen: (item: Item) => void, opts?: LayoutOpts) =>
    wrap(<PostCard item={item} onOpen={onOpen} />, opts),
}

const openMenu = () => fireEvent.contextMenu(screen.getByText('一条内容'))
/** 菜单确实开出来了。**不能拿某一项当锚**——下面几条恰恰是在证明某一项不在场，
 *  锚点自己缺席时 `queryByText(...) === null` 会因为"菜单压根没开"而假绿。 */
const menuOpen = () => screen.findByRole('menu')

beforeEach(() => {
  localStorage.clear()
  askExtractMock.mockClear()
})

describe.each(Object.entries(layouts))('%s 的动作全在右键菜单里', (_name, renderLayout) => {
  it('没有常驻动作条——一个动作按钮都不画在外面', () => {
    render(renderLayout(makeItem({ url: 'https://example.com/a', comment_count: 12 }), () => {}))
    // 菜单没打开时，这些动作在页面上一个都不该在场。
    expect(screen.queryByText('打开原文')).toBeNull()
    expect(screen.queryByText('下载视频')).toBeNull()
    expect(screen.queryByText(/条评论/)).toBeNull()
  })

  it('有原文链接 → 菜单里有「打开原文」，指向那个地址', async () => {
    render(renderLayout(makeItem({ url: 'https://example.com/a' }), () => {}))
    openMenu()
    const link = (await screen.findByText('打开原文')).closest('a')
    expect(link?.getAttribute('href')).toBe('https://example.com/a')
    expect(link?.getAttribute('target')).toBe('_blank')
  })

  it('没有原文链接 → 菜单里就没这一项，不画一个点了没反应的灰条', async () => {
    render(renderLayout(makeItem(), () => {}))
    openMenu()
    await menuOpen()
    expect(screen.queryByText('打开原文')).toBeNull()
  })

  // 菜单里**没有任何一项只是"打开详情"**——点这一行/这张卡片本来就是它。曾经有过「看详情」
  // 和「查看 N 条评论」，两个点下去都是同一个动作，先后都撤了。
  it('不画任何「打开详情」的替身（看详情 / 查看 N 条评论）', async () => {
    render(renderLayout(makeItem({ comment_count: 12 }), () => {}))
    openMenu()
    await menuOpen()
    expect(screen.queryByText(/条评论/)).toBeNull()
    expect(screen.queryByText('查看详情')).toBeNull()
  })

  it('能转成文字时菜单里有这一项，点它把这条交给对话', async () => {
    const item = makeItem({
      content: { archetype: 'video', media: [{ kind: 'video', url: 'https://x/v.mp4' }] } as never,
    })
    render(renderLayout(item, () => {}, { caps: ALL_CAPS }))
    openMenu()
    fireEvent.click(await screen.findByText('转成文字'))
    expect(askExtractMock).toHaveBeenCalledWith(expect.anything(), item)
  })

  // 判定权威在 shared/extract/plan.ts（后端选分支用的同一份）。后端那档没配上就别亮出来——
  // 一个点了必失败的入口比没有更糟。
  it('后端能力还没回来（NO_CAPS）时不画「转成文字」', async () => {
    const item = makeItem({
      content: { archetype: 'video', media: [{ kind: 'video', url: 'https://x/v.mp4' }] } as never,
    })
    render(renderLayout(item, () => {}))
    openMenu()
    await menuOpen()
    expect(screen.queryByText('转成文字')).toBeNull()
  })

  // 纯文字帖的正文已经画在卡片上了，对它「转成文字」只会拿回它自己（planExtract 的 inline 档）。
  it('正文本来就在卡片上的条目不画「转成文字」，哪怕后端三档全开', async () => {
    render(renderLayout(makeItem(), () => {}, { caps: ALL_CAPS }))
    openMenu()
    await menuOpen()
    expect(screen.queryByText('转成文字')).toBeNull()
  })

  // 对话入口随原生抽屉退役（spec 2026-08-17-native-chat-drawer-removal）：对话只剩 DSH
  // 工作台，它读当前视图靠 MCP 工具，不靠前端往会话里塞引用。
  it('菜单里没有任何对话入口', async () => {
    render(renderLayout(makeItem({ url: 'https://example.com/a' }), () => {}))
    openMenu()
    await menuOpen()
    expect(screen.queryByText('引用到对话')).toBeNull()
  })
})

describe('包声明的可点动作不进菜单', () => {
  const noteItem = makeItem({
    id: 'note-1',
    stream_id: 'demo:home',
    url: 'https://demo.example/p/abc123',
    content: { archetype: 'text', text: '正文' },
    // 动作由产出这条的包声明、后端投影成 `item.actions`——前端不看 stream_id / 链接域名 / enrich 猜。
    actions: [
      { id: 'like', icon: 'heart', label: '点赞', recipe: '@acme/demo/demo-like', params: { postId: 'abc123' }, toggle: ['like', 'unlike'] },
    ],
  })

  it('两种布局都把它画在外面（带状态的东西藏进菜单就看不见自己赞没赞）', () => {
    const { unmount } = render(wrap(<PostItemRow item={noteItem} last onOpen={() => {}} />))
    expect(screen.queryByLabelText('点赞')).toBeTruthy()
    unmount()
    render(wrap(<PostCard item={noteItem} onOpen={() => {}} />))
    expect(screen.queryByLabelText('点赞')).toBeTruthy()
  })

  it('没有投影出动作 → 不画', () => {
    render(wrap(<PostItemRow item={makeItem({ id: 'plain', stream_id: 's', content: { archetype: 'text', text: 'x' } })} last onOpen={() => {}} />))
    expect(screen.queryByLabelText('点赞')).toBeNull()
  })
})
