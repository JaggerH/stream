/**
 * 面板里的影视频道。钉五件事：
 *  1. 壳态下切到 video 频道画的是影视视图（不是把海报塞进 PostFeed），且**不再**去取频道时间线；
 *  2. 层级跳转（海报墙 → 作品详情）**绝不写 `window.location`**——那条 URL 归 DSH；
 *  3. 浮层态（420px）不画影视，给一句说得清的话，而不是一个挤扁的空壳；
 *  4. **按需装**：不切到影视就一个字节都不下（影视是第三个独立 IIFE bundle，2.6MB）；
 *  5. 装的期间有过渡态、装失败说得出话，且切走要把那棵独立的 root 卸掉。
 *
 * `movieBundle.load` 在生产里是一次真的网络脚本加载（见 `panelBundleLoader.ts` 头注），jsdom
 * 不会真的取网执行 `<script src>`。测试换成直接 import 源码级的 `movie-entry.tsx`——跳过网络
 * 那一步，但 mount/unmount/update 跑的是真实现，不是自造一个假的。
 */
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { StreamPanel } from './StreamPanel.tsx'
import { movieBundle } from './movieBundle.ts'
import { channelStore } from './nav/channel-store.ts'
import { api } from '../lib/api.ts'
import { DEFAULT_TIMELINE_CHANNEL_ID, type ChannelStream, type ChannelView } from '../lib/types.ts'
import { addOverlay } from '../lib/overlayPresence.ts'
import { setAskChatSink } from '../lib/askExtract.ts'
import type { PanelItemContextState } from './itemRef.ts'

const VIDEO_CHANNEL_ID = 'default-video'

function stream(id: string, description: string): ChannelStream {
  return { id, description, newCount: 0 } as ChannelStream
}

const CHANNELS: ChannelView[] = [
  { id: DEFAULT_TIMELINE_CHANNEL_ID, label: '时间线', present: 'timeline', space_id: 'default-space', system: true, kind: 'timeline', streams: [] } as ChannelView,
  { id: VIDEO_CHANNEL_ID, label: '影视', present: 'video', space_id: 'default-space', system: true, kind: 'timeline', streams: [stream('got', '权力的游戏')] } as ChannelView,
]

beforeEach(async () => {
  // 频道名录/当前频道住在模块级 store（见 nav/channel-store.ts）——不清就是上一条用例
  // 停在影视频道的状态漏进下一条，"不切过去就不装 bundle" 那类断言会莫名其妙地红。
  channelStore.reset()
  const movieEntry = await import('./movie-entry.tsx')
  vi.spyOn(movieBundle, 'load').mockResolvedValue(movieEntry)
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [] })
  // MovieChannel 自己要的那几份取数：都给空，本文件只关心判路和路由，不关心内容。
  vi.spyOn(api, 'items').mockResolvedValue([])
  vi.spyOn(api, 'collectionItems').mockResolvedValue([])
  vi.spyOn(api, 'watchProgressList').mockResolvedValue([])
  vi.spyOn(api, 'markStreamSeen').mockResolvedValue(undefined as never)
  // 作品详情走裸 fetch（不经 api.ts）——给一个不解析的桩，详情页会自己降级成"没有元数据"。
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response)))
})

/** 切频道的入口：导航是另一个 React root，测试直接写 store（见 nav/channel-store.ts）。
 *  名录到货之前 `setActive` 不受理任何 id，所以名录没到时报 undefined——调用方 `waitFor`
 *  它变成函数，语义和以前等宿主注册那个 setter 一样。 */
function channelSetter(): ((id: string) => void) | undefined {
  if (channelStore.getSnapshot().channels.length === 0) return undefined
  return (id) => { act(() => { channelStore.setActive(id) }) }
}

/** 壳态 = 宽度归壳管 = 不传 `onWidthChange`（见 StreamPanel 的 `shellMode`）。 */
function renderShell() {
  render(<StreamPanel />)
  return channelSetter
}

test('壳态：切到 video 频道画的是影视视图，且不去取频道时间线', async () => {
  const getSetter = renderShell()
  await waitFor(() => expect(getSetter()).toBeDefined())
  const before = vi.mocked(api.channelItems).mock.calls.length

  getSetter()!(VIDEO_CHANNEL_ID)

  await waitFor(() => expect(screen.getByTestId('panel-movie')).toBeTruthy())
  await waitFor(() => expect(screen.getByText('权力的游戏')).toBeTruthy())
  // 影视的内容由 MovieChannel 按 stream 取；这里再打一次频道时间线是白打，失败还会盖住海报墙。
  expect(vi.mocked(api.channelItems).mock.calls.length).toBe(before)
})

// 这次分包的**核心收益**就是这一条：不看影视的人不该为那 1.65MB 付钱。它在源码层面唯一
// 看得见的形状就是"load 没被调过"——产物层面那一半由 panel-split.build.test.ts 钉。
test('按需装：停在时间线不装影视 bundle，切过去才装', async () => {
  const getSetter = renderShell()
  await waitFor(() => expect(getSetter()).toBeDefined())
  // 名录都到货了、面板画完了，还是不该碰它。
  await waitFor(() => expect(vi.mocked(api.channels)).toHaveBeenCalled())
  expect(movieBundle.load).not.toHaveBeenCalled()

  getSetter()!(VIDEO_CHANNEL_ID)

  await waitFor(() => expect(screen.getByTestId('panel-movie')).toBeTruthy())
  expect(movieBundle.load).toHaveBeenCalled()
})

// 装 2.6MB 要一会儿。白屏和"面板挂了"长得一模一样，所以这一格必须有话说；装失败同理——
// 静默空白是这条链路上最难诊断的失败形状。
test('装载期间有过渡态，装失败说得出话', async () => {
  let resolveLoad!: (v: Awaited<ReturnType<typeof movieBundle.load>>) => void
  const pending = new Promise<Awaited<ReturnType<typeof movieBundle.load>>>((r) => { resolveLoad = r })
  vi.mocked(movieBundle.load).mockReturnValue(pending)

  const getSetter = renderShell()
  await waitFor(() => expect(getSetter()).toBeDefined())
  getSetter()!(VIDEO_CHANNEL_ID)

  await waitFor(() => expect(screen.getByTestId('panel-movie-host')).toBeTruthy())
  expect(screen.getByTestId('panel-movie-loading')).toBeTruthy()
  expect(screen.queryByTestId('panel-movie')).toBeNull()

  resolveLoad(await import('./movie-entry.tsx'))
  await waitFor(() => expect(screen.getByTestId('panel-movie')).toBeTruthy())
  // 两处都不能想当然，各栽过一次（循环跑 10 遍逼出来的）：
  //  1. **按 testid 不按文字**："加载中…"这四个字 `MovieChannel` 自己那格骨架上也有，
  //     按文字找会同时命中它，断言随对方取数的时序变红。
  //  2. **必须 waitFor 不能同步断言**：影视那棵树是**另一个 React root**，`mount()` 一回来
  //     `panel-movie` 就在 DOM 里了，而收掉这层罩子是**外层** root 的下一次渲染
  //     （`setMovieReady(true)`）——两者不在同一拍。同步读就是在赌调度顺序。
  await waitFor(() => expect(screen.queryByTestId('panel-movie-loading')).toBeNull())
})

test('装失败：画出失败原因，不是一片空白', async () => {
  vi.mocked(movieBundle.load).mockRejectedValue(new Error('影视 bundle 加载失败'))

  const getSetter = renderShell()
  await waitFor(() => expect(getSetter()).toBeDefined())
  getSetter()!(VIDEO_CHANNEL_ID)

  const box = await screen.findByTestId('panel-movie-error')
  expect(box.textContent).toContain('影视频道加载失败')
  // 原因必须原样带出来。只画一句"加载失败"等于把唯一的线索吞掉。
  expect(box.textContent).toContain('影视 bundle 加载失败')
})

// 独立 root 没有 `key` 这回事：切走时那棵树是 `StreamPanel` 自己 unmount 的。不卸的后果是
// 一棵看不见但还活着的 React 树留在那儿（还挂着 MovieChannel 的轮询/订阅），而且切回来会
// 在同一个容器上再 createRoot 一次。
test('切走把影视那棵独立的 root 卸掉，切回来重新挂', async () => {
  const getSetter = renderShell()
  await waitFor(() => expect(getSetter()).toBeDefined())

  getSetter()!(VIDEO_CHANNEL_ID)
  await waitFor(() => expect(screen.getByTestId('panel-movie')).toBeTruthy())

  getSetter()!(DEFAULT_TIMELINE_CHANNEL_ID)
  await waitFor(() => expect(screen.queryByTestId('panel-movie-host')).toBeNull())
  // 容器没了，那棵树也必须真的从 DOM 里消失——留着就是一棵看不见还活着的树。
  await waitFor(() => expect(screen.queryByTestId('panel-movie')).toBeNull())

  getSetter()!(VIDEO_CHANNEL_ID)
  await waitFor(() => expect(screen.getByTestId('panel-movie')).toBeTruthy())
  await waitFor(() => expect(screen.getByText('权力的游戏')).toBeTruthy())
})

// 这一条是**这次改动的主要风险**：MovieChannel 的二级路由默认写浏览器地址栏，而面板住在 DSH
// 的页面里——那条 URL 归 DSH。写上去不会报任何错，只会静默劫持宿主的路由。
test('层级跳转不写 window.location：海报墙 → 作品详情，地址栏原地不动', async () => {
  const before = window.location.pathname
  const pushState = vi.spyOn(window.history, 'pushState')
  const getSetter = renderShell()
  await waitFor(() => expect(getSetter()).toBeDefined())
  getSetter()!(VIDEO_CHANNEL_ID)
  await waitFor(() => expect(screen.getByText('权力的游戏')).toBeTruthy())

  fireEvent.click(screen.getByText('权力的游戏'))

  // 进了二级页：一级页的「正在追的」抬头没了，返回键出来了。
  await waitFor(() => expect(screen.getByRole('button', { name: '返回' })).toBeTruthy())
  expect(pushState).not.toHaveBeenCalled()
  expect(window.location.pathname).toBe(before)
})

// 「影视频道能画出来」和「影视频道能用」是两回事——当初把影视灰掉的理由正是后者。播放是这条线
// 的终点，所以钉住它：从「继续观看」的卡一路走到播放器（DetailShell + 真的 <video>）确实挂进
// **面板这棵树里**。这里证不了声音真的出来（jsdom 没有媒体栈），但能证它不是一个点了没反应的空壳。
//
// **两段，不是一段**（`9a946f68`）：卡片只把人送到作品详情页，起播是那一页上「继续播放」那一下。
// 这条测试当时漏改了，在 main 上红着——`MovieChannel.test.tsx` 里同一件事的那条更新了，这条没有。
test('壳态：继续观看 → 作品详情页 → 继续播放，播放器真的挂在面板里（不是点了没反应的空壳）', async () => {
  vi.mocked(api.watchProgressList).mockResolvedValue([{
    key: 'tmdb:1399:S01E01',
    workKey: 'tmdb:1399',
    workTitle: '继续看的那一部',
    epLabel: 'S01E01',
    position: 120,
    duration: 3600,
    updatedAt: 1,
  }])
  const getSetter = renderShell()
  await waitFor(() => expect(getSetter()).toBeDefined())
  getSetter()!(VIDEO_CHANNEL_ID)

  const card = await screen.findByLabelText('继续看的那一部')
  fireEvent.click(card)

  // 第一段：进作品详情页，**还没起播**。点一下就全屏起播的话，用户没机会先看一眼这部作品
  // 有几季几集、要不要换一集（改成两段的理由）。
  const resume = await screen.findByRole('button', { name: /继续播放/ })
  expect(screen.queryByRole('dialog')).toBeNull()

  // 第二段：这一下才起播。
  fireEvent.click(resume)
  const dialog = await screen.findByRole('dialog')
  // 播放器必须在面板自己那棵子树里：`DetailShell` 的根是 `fixed inset-0`，靠外面那层
  // `translateZ(0)` 关在这一列里（见 PanelMovieChannel 头注 §3）。跑到面板外面 = 盖住 DSH 整页。
  expect(screen.getByTestId('panel-movie').contains(dialog)).toBe(true)
  await waitFor(() => expect(dialog.querySelector('video')).toBeTruthy())
})

test('浮层态（420px）不画影视，给一句说得清的话，也不装 bundle', async () => {
  render(<StreamPanel onWidthChange={() => {}} />)
  await waitFor(() => expect(channelSetter()).toBeDefined())
  channelSetter()!(VIDEO_CHANNEL_ID)

  await waitFor(() => expect(screen.getByTestId('panel-movie-too-narrow')).toBeTruthy())
  expect(screen.queryByTestId('panel-movie')).toBeNull()
  // 420px 里本来就画不下，那 2.6MB 更没有理由下：这一档的 bundle 一个字节都不该取。
  expect(movieBundle.load).not.toHaveBeenCalled()
})

/**
 * 看片时对话列要让位——这条线的接力有四棒：`DetailShell` 报到 → 影视 bundle 那份
 * `overlayPresence` → `movie-entry` 经 `onOverlayChange` 转发 → `StreamPanel` 合进推给壳的
 * `fullscreen`。这里跑的是后三棒的真实现（第一棒由 DetailShell.overlay.test.tsx 钉）。
 *
 * **`open` 在这一档恒为 null**：看片没有一条 item 可引用。所以任何"从 open 推 fullscreen"的
 * 改法都会让这条红——那正是它存在的理由（症状是看片时对话列一直杵着，不报错）。
 */
test('影视全屏看片：open 仍是 null，但 fullscreen 推成 true；切走频道要归 false', async () => {
  const states: PanelItemContextState[] = []
  render(<StreamPanel onItemContext={(s) => states.push(s)} />)
  await waitFor(() => expect(channelSetter()).toBeDefined())
  channelSetter()!(VIDEO_CHANNEL_ID)
  await waitFor(() => expect(screen.getByTestId('panel-movie')).toBeTruthy())

  // 影视那棵树里开了一块全屏覆盖层（真实链路上是 DetailShell 挂载时报的这一声）。
  let release!: () => void
  act(() => { release = addOverlay() })
  await waitFor(() => expect(states.at(-1)?.fullscreen).toBe(true))
  expect(states.at(-1)?.open).toBeNull()

  act(() => { release() })
  await waitFor(() => expect(states.at(-1)?.fullscreen).toBe(false))

  // 正开着播放器就切走频道：那棵树被卸掉，"还占着"必须跟着撤——不撤的话对话列再也回不来。
  act(() => { addOverlay() })
  await waitFor(() => expect(states.at(-1)?.fullscreen).toBe(true))
  channelSetter()!(DEFAULT_TIMELINE_CHANNEL_ID)
  await waitFor(() => expect(states.at(-1)?.fullscreen).toBe(false))
})

/**
 * 「两份 JS 运行时」那个坑的第三格。详情那棵树早就为它付过一次（见
 * `StreamPanel.extract.test.tsx` 里同名的那条），影视这棵树是后来才长出对话入口的
 * （引用作品 / 引用分集 / AI 匹配），当时**没有把通道递进来**。
 *
 * 症状极像"点了什么都没发生"：按钮点得动、没有报错，`composeIntoChat` 在那份 bundle 里读到
 * 的 `sink` 恒为 undefined，于是弹一句"这一页没有对话输入框"——而用户明明就在带对话的那张页里。
 * 活体撞到过（2026-09-02）。
 */
test('对话通道要递给影视那棵树（不递 = 引用/AI 匹配点了只弹一句"这一页没有对话输入框"）', async () => {
  const sink = vi.fn()
  setAskChatSink(sink)
  const mount = vi.fn()
  const update = vi.fn()
  const movieEntry = await import('./movie-entry.tsx')
  vi.mocked(movieBundle.load).mockResolvedValue({ ...movieEntry, mount, update })

  render(<StreamPanel />)
  await waitFor(() => expect(channelSetter()).toBeDefined())
  channelSetter()!(VIDEO_CHANNEL_ID)
  await waitFor(() => expect(mount).toHaveBeenCalled())

  expect((mount.mock.calls[0][1] as { askChat?: unknown }).askChat).toBe(sink)
  // `update` 是整份 opts 重渲染——漏这一格等于在"管理频道改完"那一刻把通道悄悄掐了。
  await waitFor(() => expect(update).toHaveBeenCalled())
  expect((update.mock.calls.at(-1)![0] as { askChat?: unknown }).askChat).toBe(sink)
  setAskChatSink(undefined)
})
