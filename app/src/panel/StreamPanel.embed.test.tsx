/**
 * 面板里的外接面板（embed）频道。钉三件事：
 *  1. 切到 `present === 'embed'` 的频道画的是一张整高 iframe，src 就是 `options.url`，
 *     不是默认图文流；
 *  2. URL 没填 / 不是 http(s) → 画说明占位，**不画 iframe**（空 iframe 和"面板挂了"长得一样）；
 *  3. 外接面板频道**不去取频道时间线**：本地库里没有它的任何一行。
 */
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { StreamPanel } from './StreamPanel.tsx'
import { channelStore } from './nav/channel-store.ts'
import { api } from '../lib/api.ts'
import * as transport from '../lib/transport.ts'
import { DEFAULT_TIMELINE_CHANNEL_ID, type ChannelView } from '../lib/types.ts'

const EMBED_CHANNEL_ID = 'channel-embed'

const channel = (options: Record<string, unknown> | undefined) => ({
  id: EMBED_CHANNEL_ID,
  label: '套利监控',
  present: 'embed',
  kind: 'timeline',
  streams: [],
  options,
}) as unknown as ChannelView

const TIMELINE_CHANNEL = {
  id: DEFAULT_TIMELINE_CHANNEL_ID,
  label: '时间线',
  present: 'timeline',
  system: true,
  kind: 'timeline',
  streams: [],
} as unknown as ChannelView

beforeEach(() => {
  vi.spyOn(transport, 'selectTransport').mockReturnValue({
    fetch: vi.fn(),
    openSocket: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })),
  } as unknown as ReturnType<typeof transport.selectTransport>)
  vi.spyOn(api, 'spaces').mockResolvedValue([])
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [] })
})

async function renderOnEmbed(options: Record<string, unknown> | undefined) {
  vi.spyOn(api, 'channels').mockResolvedValue([TIMELINE_CHANNEL, channel(options)])
  channelStore.reset()
  render(<StreamPanel />)
  // 切频道走 store（导航是另一个 root，见 nav/channel-store.ts）——名录到货后才切得动。
  await waitFor(() => expect(channelStore.getSnapshot().channels.length).toBe(2))
  channelStore.setActive(EMBED_CHANNEL_ID)
  await waitFor(() => expect(channelStore.getSnapshot().active).toBe(EMBED_CHANNEL_ID))
}

test('切到 embed 频道画的是整高 iframe，src = options.url，title = 频道名', async () => {
  await renderOnEmbed({ url: 'http://127.0.0.1:8123/live' })
  const frame = await screen.findByTestId('panel-embed-frame') as HTMLIFrameElement
  expect(frame.getAttribute('src')).toBe('http://127.0.0.1:8123/live')
  expect(frame.getAttribute('title')).toBe('套利监控')
  expect(frame.getAttribute('sandbox')).toContain('allow-scripts')
  expect(frame.getAttribute('sandbox')).toContain('allow-same-origin')
  expect(screen.queryByTestId('panel-scroll')).toBeNull()
  expect(screen.queryByTestId('panel-embed-empty')).toBeNull()
})

test('URL 没填 → 画说明占位，不画 iframe', async () => {
  await renderOnEmbed(undefined)
  expect(await screen.findByTestId('panel-embed-empty')).toBeTruthy()
  expect(screen.queryByTestId('panel-embed-frame')).toBeNull()
})

test('URL 不是 http(s)（旧包 / 手改库）→ 同样占位，不把坏值喂给 iframe', async () => {
  await renderOnEmbed({ url: 'javascript:alert(1)' })
  expect(await screen.findByTestId('panel-embed-empty')).toBeTruthy()
  expect(screen.queryByTestId('panel-embed-frame')).toBeNull()
})

test('外接面板频道不去取频道时间线——本地库里没有它的行', async () => {
  await renderOnEmbed({ url: 'https://grafana.example/d/1' })
  await screen.findByTestId('panel-embed-frame')
  expect(api.channelItems).not.toHaveBeenCalledWith(expect.anything(), EMBED_CHANNEL_ID, expect.anything())
})
