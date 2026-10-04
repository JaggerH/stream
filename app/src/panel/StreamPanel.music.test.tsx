/**
 * 面板里的音乐/播客频道：壳态下画的必须是**歌单视图**（主应用那一份 MusicChannel），
 * 不是和时间线一模一样的图文流；而它的层级跳转**绝不能写宿主的地址栏**。
 *
 * 这两条各自钉一次，是因为它们坏起来都很安静：
 * - 画成 PostFeed 不会报错，只是这个频道看起来和时间线一样（就是这次要修的现象）；
 * - 写地址栏也不会报错，只是刷新后落到 DSH 的 404、后退键跳我们的层——在测试里根本看不见，
 *   所以只能直接钉 `window.location.pathname` 没动过（`useSubRoute.test.tsx` 里那条反着钉的
 *   断言是同一个理由）。
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { StreamPanel } from './StreamPanel.tsx'
import { channelStore } from './nav/channel-store.ts'
import { api } from '../lib/api.ts'
import * as transport from '../lib/transport.ts'
import { DEFAULT_TIMELINE_CHANNEL_ID, type ChannelView, type Item } from '../lib/types.ts'

const AUDIO_CHANNEL = {
  id: 'default-audio',
  label: '音乐/播客',
  present: 'audio',
  system: true,
  kind: 'timeline',
  streams: [{ id: 'pl-1', description: '我的歌单', sources: [] }],
} as unknown as ChannelView

const TIMELINE_CHANNEL = {
  id: DEFAULT_TIMELINE_CHANNEL_ID,
  label: '时间线',
  present: 'timeline',
  system: true,
  kind: 'timeline',
  streams: [],
} as unknown as ChannelView

function item(id: string, title: string): Item {
  return {
    id,
    stream_id: 'panel-test',
    type: 'post',
    title,
    url: `https://example.com/${id}`,
    timestamp: '2026-08-17T00:00:00Z',
    fetched_at: '2026-08-17T00:00:00Z',
    published_at: '2026-08-17T00:00:00Z',
  } as Item
}

beforeEach(() => {
  // MusicChannel 挂上来就订 WS（下载进度）——jsdom 里真连会一直重试重连，噪音还漏进下一条用例。
  vi.spyOn(transport, 'selectTransport').mockReturnValue({
    fetch: vi.fn(),
    openSocket: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })),
  } as unknown as ReturnType<typeof transport.selectTransport>)
  vi.spyOn(api, 'channels').mockResolvedValue([TIMELINE_CHANNEL, AUDIO_CHANNEL])
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [] })
  vi.spyOn(api, 'enrich').mockResolvedValue({ comments: [], total: 0 })
  // MusicChannel 挂载即取的那几样（喜欢 / 播单 / 下载态 / 曲目）——按"空"应答，本文件不验它们。
  vi.spyOn(api, 'collectionItems').mockResolvedValue([])
  vi.spyOn(api, 'collections').mockResolvedValue([])
  vi.spyOn(api, 'downloadJobs').mockResolvedValue({ jobs: [] })
  vi.spyOn(api, 'archiveStatus').mockResolvedValue({ archived: {} })
  vi.spyOn(api, 'items').mockResolvedValue([])
})

/**
 * 渲染并切到音乐频道。
 *
 * 切换必须**等名录到货之后**再发：面板的外部 setter 有第二道闸（只受理当下名录里
 * supported 的 id），名录还空着时切什么都不动。
 *
 * `onWidthChange` 一律不传 = 壳态（宽度归壳的网格列管，见 StreamPanel 的 shellMode）。
 */
async function renderShellOnAudio(props: { onWidthChange?: (w: string) => void } = {}) {
  channelStore.reset()
  render(<StreamPanel onWidthChange={props.onWidthChange} />)
  // 切频道走 store（导航是另一个 root，见 nav/channel-store.ts）——名录到货后才切得动。
  await waitFor(() => expect(channelStore.getSnapshot().channels.length).toBe(2))
  channelStore.setActive('default-audio')
  await waitFor(() => expect(channelStore.getSnapshot().active).toBe('default-audio'))
}

test('壳态下的 audio 频道画歌单视图，而不是 PostFeed', async () => {
  await renderShellOnAudio()
  // 歌单网格的分区标题 + 那张歌单卡：两者都只有 MusicChannel 画得出来。
  await waitFor(() => expect(screen.getByText('歌单')).toBeTruthy())
  expect(screen.getByLabelText('我的歌单')).toBeTruthy()
  expect(screen.getByTestId('panel-music')).toBeTruthy()
  // 图文流那一套整个不在场。
  expect(screen.queryByTestId('panel-scroll')).toBeNull()
})

test('音乐频道不去取频道时间线——那批 items 没人吃', async () => {
  await renderShellOnAudio()
  await waitFor(() => expect(screen.getByTestId('panel-music')).toBeTruthy())
  expect(api.channelItems).not.toHaveBeenCalledWith(expect.anything(), 'default-audio', expect.anything())
})

test('层级跳转（进歌单）不写 window.location', async () => {
  const before = window.location.pathname
  await renderShellOnAudio()
  await waitFor(() => expect(screen.getByLabelText('我的歌单')).toBeTruthy())

  fireEvent.click(screen.getByLabelText('我的歌单'))

  // 进了 L2：曲目表的表头只在那一层出现。
  await waitFor(() => expect(screen.getByText('专辑')).toBeTruthy())
  // 而地址栏纹丝不动——面板住在 DSH 的页面里，那条 URL 不是我们的。
  expect(window.location.pathname).toBe(before)
})

test('浮层态（420px 窄条）维持 PostFeed，不塞一张五列的表', async () => {
  vi.mocked(api.channelItems).mockResolvedValue({ items: [item('a', '第一条')] })
  await renderShellOnAudio({ onWidthChange: () => {} })
  await waitFor(() => expect(screen.getByText('第一条')).toBeTruthy())
  expect(screen.queryByTestId('panel-music')).toBeNull()
  expect(screen.getByTestId('panel-scroll')).toBeTruthy()
})
