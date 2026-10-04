/**
 * 面板里的研究频道。钉四件事：
 *  1. 切到 `present === 'research'` 的频道画的是**研究 run 列表**，不是默认图文流——
 *     这条最要命：研究数据是 live 的、永不入库，落回 PostFeed 不会报错，只会画出一页空
 *     （`channelItems` 对这个频道恒返回空），看起来像"这个频道没内容"而不是"判路漏了一档"；
 *  2. 研究频道**不去取频道时间线**：那批 items 没人吃，失败还会把好好的列表盖成一条错误；
 *  3. 点进某个 run 的详情**绝不写 `window.location`**——那条 URL 归 DSH；
 *  4. 浮层态（420px）**照样画研究列表**：它是一列文字行，不是海报墙/五列表，排得下；
 *     而落回 PostFeed 在这里是纯亏（live 数据没入库，那一档必然是空页）。
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { StreamPanel } from './StreamPanel.tsx'
import { researchBundle } from './researchBundle.ts'
import { channelStore } from './nav/channel-store.ts'
import { api } from '../lib/api.ts'
import * as transport from '../lib/transport.ts'
import { DEFAULT_TIMELINE_CHANNEL_ID, type ChannelView } from '../lib/types.ts'

const RESEARCH_CHANNEL_ID = 'research'
const STREAM_ID = 'runs-dir'
const RUN_ID = '20260825-alpha'

const RESEARCH_CHANNEL = {
  id: RESEARCH_CHANNEL_ID,
  label: '研究',
  present: 'research',
  system: true,
  kind: 'timeline',
  streams: [{ id: STREAM_ID, description: '研究 run', sources: [] }],
} as unknown as ChannelView

const TIMELINE_CHANNEL = {
  id: DEFAULT_TIMELINE_CHANNEL_ID,
  label: '时间线',
  present: 'timeline',
  system: true,
  kind: 'timeline',
  streams: [],
} as unknown as ChannelView

const LIVE_ITEM = {
  id: `research-run:${RUN_ID}`,
  stream_id: STREAM_ID,
  source_id: STREAM_ID,
  type: 'post',
  title: '动量因子回测',
  body_text: 'IC 0.031',
  timestamp: '2026-08-25T00:00:00Z',
  fetched_at: '2026-08-25T00:00:00Z',
}

const MANIFEST = {
  schema: 'run/v1',
  id: RUN_ID,
  name: '动量因子回测',
  variant: null,
  tags: [],
  params: {},
  status: 'finished',
  metrics: { ic: 0.031 },
  artifacts: [],
  created_at: '2026-08-25T00:00:00Z',
  finished_at: '2026-08-25T00:10:00Z',
}

/** 研究的取数走 `lib/api.ts` 的裸 `get()`（不在 `api` 命名空间对象里），所以按 URL 桩 fetch——
 *  桩的是网络那一层，`artifact.ts` 里真实的路径拼接/解包照常跑。 */
function stubResearchFetch() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const path = String(url)
    const body = path.includes('/api/live/streams/') ? { items: [LIVE_ITEM] }
      : path.includes('/runs/') ? MANIFEST
      : {}
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  }))
}

beforeEach(async () => {
  // 频道名录/当前频道住在模块级 store（见 nav/channel-store.ts）：不清就是上一条用例停在
  // 研究频道的状态漏进下一条，"不切过去就不装 bundle" 那条会莫名其妙地红。
  channelStore.reset()
  // `researchBundle.load` 在生产里是一次真的网络脚本加载（见 panelBundleLoader.ts 头注），
  // jsdom 不会真的取网执行 `<script src>`。换成直接 import 源码级的 `research-entry.tsx`——
  // 跳过网络那一步，但 mount/update/unmount 跑的是真实现，不是自造一个假的。
  const researchEntry = await import('./research-entry.tsx')
  vi.spyOn(researchBundle, 'load').mockResolvedValue(researchEntry)
  // ResearchChannel 挂上来就订 WS（live-changed）——jsdom 里真连会一直重试重连。
  vi.spyOn(transport, 'selectTransport').mockReturnValue({
    fetch: vi.fn(),
    openSocket: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })),
  } as unknown as ReturnType<typeof transport.selectTransport>)
  vi.spyOn(api, 'channels').mockResolvedValue([TIMELINE_CHANNEL, RESEARCH_CHANNEL])
  // 名录和空间同一趟拉（侧栏按空间分组）。不挡这一条，它会落进下面那个通用的
  // `stubResearchFetch`，拿回一个不是数组的东西。
  vi.spyOn(api, 'spaces').mockResolvedValue([])
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [] })
  stubResearchFetch()
})

/** 渲染并切到研究频道。切换要等名录到货——外部 setter 只受理**当下**名录里 supported 的 id。 */
async function renderOnResearch(props: { onWidthChange?: (w: string) => void } = {}) {
  render(<StreamPanel onWidthChange={props.onWidthChange} />)
  // 切频道走 store（导航是另一个 root，见 nav/channel-store.ts）——名录到货后才切得动。
  await waitFor(() => expect(channelStore.getSnapshot().channels.length).toBe(2))
  channelStore.setActive(RESEARCH_CHANNEL_ID)
  await waitFor(() => expect(channelStore.getSnapshot().active).toBe(RESEARCH_CHANNEL_ID))
}

test('切到 research 频道画的是研究 run 列表，不是默认图文流', async () => {
  await renderOnResearch()
  // 列表里那一条 run——只有 ResearchChannel 画得出来。
  await waitFor(() => expect(screen.getByText('动量因子回测')).toBeTruthy())
  expect(screen.getByTestId('panel-research')).toBeTruthy()
  // 图文流那一套整个不在场。
  expect(screen.queryByTestId('panel-scroll')).toBeNull()
})

test('研究频道不去取频道时间线——那批 items 没人吃', async () => {
  await renderOnResearch()
  await waitFor(() => expect(screen.getByTestId('panel-research')).toBeTruthy())
  expect(api.channelItems).not.toHaveBeenCalledWith(expect.anything(), RESEARCH_CHANNEL_ID, expect.anything())
})

test('点进 run 详情不写 window.location', async () => {
  const before = window.location.pathname
  await renderOnResearch()
  await waitFor(() => expect(screen.getByText('动量因子回测')).toBeTruthy())

  fireEvent.click(screen.getByText('动量因子回测'))

  // 进了详情：返回键 + manifest 头只在那一层出现。
  await waitFor(() => expect(screen.getByText('← 返回列表')).toBeTruthy())
  expect(window.location.pathname).toBe(before)
})

test('按需装：不切到研究频道就一个字节都不下', async () => {
  render(<StreamPanel />)
  await waitFor(() => expect(api.channels).toHaveBeenCalled())
  expect(researchBundle.load).not.toHaveBeenCalled()
})

test('浮层态（420px）照样画研究列表——落回 PostFeed 只会是一页空', async () => {
  await renderOnResearch({ onWidthChange: () => {} })
  await waitFor(() => expect(screen.getByText('动量因子回测')).toBeTruthy())
  expect(screen.getByTestId('panel-research')).toBeTruthy()
  expect(screen.queryByTestId('panel-scroll')).toBeNull()
})
