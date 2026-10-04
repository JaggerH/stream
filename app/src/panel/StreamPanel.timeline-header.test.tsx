/**
 * 图文流那一档的顶栏 + 它底下那条「内容 | 配置」。守的是"四档 Present 在同一个壳里长得一样"
 * 这件事——顶栏或分页整条消失不会报任何错，只会让人觉得切到了另一个应用，所以只能靠用例钉住。
 */
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { StreamPanel } from './StreamPanel.tsx'
import { api } from '../lib/api.ts'
import { DEFAULT_TIMELINE_CHANNEL_ID, type ChannelView, type Item } from '../lib/types.ts'

const CHANNELS = [
  { id: DEFAULT_TIMELINE_CHANNEL_ID, label: '时间线', present: 'timeline', space_id: 'default-space', system: true, kind: 'timeline', streams: [] },
] as ChannelView[]

function item(id: string, title: string): Item {
  return {
    id, stream_id: 'panel-test', type: 'post', title, url: `https://example.com/${id}`,
    timestamp: '2026-08-17T00:00:00Z', fetched_at: '2026-08-17T00:00:00Z', published_at: '2026-08-17T00:00:00Z',
  } as Item
}

beforeEach(() => {
  vi.spyOn(api, 'enrich').mockResolvedValue({ comments: [], total: 0 })
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [item('a', '第一条')] })
})

/** 配置页要拉的那几份名录。不桩就永远停在「加载中…」。 */
function stubConfigLookups(): void {
  vi.spyOn(api, 'presents').mockResolvedValue({
    items: [{ id: 'timeline', label: '时间线', needsStreams: true, data: 'collected', slots: [] }],
  } as never)
  vi.spyOn(api, 'providers').mockResolvedValue([] as never)
  vi.spyOn(api, 'spaces').mockResolvedValue([] as never)
}

// 按 testid 圈住顶栏再找：频道名在这一页出现两次（顶栏 + 下面那条频道切换器），
// 全局找会同时命中两个，断言"顶栏画出来了"就变成一条对切换器也成立的空话。
const header = () => within(screen.getByTestId('panel-timeline-header'))
const tabs = () => within(screen.getByTestId('channel-tabs'))

test('画频道名 + 内容/配置分页', async () => {
  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('第一条')).toBeTruthy())
  expect(header().getByText('时间线')).toBeTruthy()
  expect(tabs().getByRole('tab', { name: '内容' }).getAttribute('aria-selected')).toBe('true')
  expect(tabs().getByRole('tab', { name: '配置' })).toBeTruthy()
})

// 顶栏在滚动容器外面：取内容失败时它更得在——一个频道读不出来，用户的出路是去配置它
// 或者换一个频道，把顶栏一起藏掉等于把人锁死在错误页上。分页同理，配置页正是那条出路。
test('取数失败时顶栏和分页仍在', async () => {
  vi.spyOn(api, 'channelItems').mockRejectedValue(new Error('boom'))
  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByTestId('panel-error').textContent).toContain('boom'))
  expect(header().getByText('时间线')).toBeTruthy()
  expect(tabs().getByRole('tab', { name: '配置' })).toBeTruthy()
})

test('切到配置页出频道配置面，切回来内容还在', async () => {
  stubConfigLookups()
  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('第一条')).toBeTruthy())

  fireEvent.click(tabs().getByRole('tab', { name: '配置' }))
  await waitFor(() => expect(screen.getByText('订阅列表')).toBeTruthy())
  // 配置页盖住的是内容，不是顶栏——顶栏得一直在，否则没有回内容页的路。
  expect(header().getByText('时间线')).toBeTruthy()
  expect(screen.queryByText('第一条')).toBeNull()

  fireEvent.click(tabs().getByRole('tab', { name: '内容' }))
  await waitFor(() => expect(screen.getByText('第一条')).toBeTruthy())
})
