/**
 * 面板里的定时任务频道。钉两件事：
 *  1. 切到 `present === 'tasks'` 的频道画的是 `TasksPage` 的任务列表，不是默认图文流——
 *     `tasks` present 没有时间线，落回 PostFeed 不会报错，只会画出一页空；
 *  2. 定时任务频道**不去取频道时间线**：`channelItems` 对它没有意义，那批请求没人吃。
 */
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { StreamPanel } from './StreamPanel.tsx'
import { channelStore } from './nav/channel-store.ts'
import { api } from '../lib/api.ts'
import * as transport from '../lib/transport.ts'
import { DEFAULT_TIMELINE_CHANNEL_ID, type ChannelView } from '../lib/types.ts'

const TASKS_CHANNEL_ID = 'default-tasks'

const TASKS_CHANNEL = {
  id: TASKS_CHANNEL_ID,
  label: '定时任务',
  present: 'tasks',
  system: true,
  kind: 'timeline',
  streams: [],
} as unknown as ChannelView

const TIMELINE_CHANNEL = {
  id: DEFAULT_TIMELINE_CHANNEL_ID,
  label: '时间线',
  present: 'timeline',
  system: true,
  kind: 'timeline',
  streams: [],
} as unknown as ChannelView

const TASK = {
  id: 'cookie-refresh', label: '登录态刷新', schedule: '0 */5 * * * *', source: 'builtin',
  enabled: true, effect: 'read-only', lastRun: null,
}

beforeEach(async () => {
  vi.spyOn(transport, 'selectTransport').mockReturnValue({
    fetch: vi.fn(),
    openSocket: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })),
  } as unknown as ReturnType<typeof transport.selectTransport>)
  vi.spyOn(api, 'channels').mockResolvedValue([TIMELINE_CHANNEL, TASKS_CHANNEL])
  vi.spyOn(api, 'spaces').mockResolvedValue([])
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [] })
  // TasksPage 自己走裸 fetch（lib/api.tasks.ts），不经 `api` 命名空间对象——按 URL 桩。
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const path = String(url)
    const body = path.endsWith('/api/tasks') ? { tasks: [TASK] } : { runs: [] }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  }))
})

async function renderOnTasks() {
  channelStore.reset()
  render(<StreamPanel />)
  // 切频道走 store（导航是另一个 root，见 nav/channel-store.ts）——名录到货后才切得动。
  await waitFor(() => expect(channelStore.getSnapshot().channels.length).toBe(2))
  channelStore.setActive(TASKS_CHANNEL_ID)
  await waitFor(() => expect(channelStore.getSnapshot().active).toBe(TASKS_CHANNEL_ID))
}

test('切到 tasks 频道画的是 TasksPage 的任务列表，不是默认图文流', async () => {
  await renderOnTasks()
  // 只有 TasksPage 画得出来的一条任务名——落回 PostFeed 的话这段文字不会出现。
  await waitFor(() => expect(screen.getByText('登录态刷新')).toBeTruthy())
  expect(screen.getByTestId('panel-tasks-host')).toBeTruthy()
  expect(screen.queryByTestId('panel-scroll')).toBeNull()
})

test('定时任务频道不去取频道时间线——那批 items 没人吃', async () => {
  await renderOnTasks()
  await waitFor(() => expect(screen.getByTestId('panel-tasks-host')).toBeTruthy())
  expect(api.channelItems).not.toHaveBeenCalledWith(expect.anything(), TASKS_CHANNEL_ID, expect.anything())
})
