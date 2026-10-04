/**
 * 面板的**两个挂载点**：`mount`（内容区）与 `mountNav`（「空间 → 频道」树）。
 *
 * 钉的是"顺序无关、同步在 bundle 内部完成"这件事：两块各是一个独立的 React root，宿主只
 * 决定把它们摆在哪，**不再当中间的转发点**（`onChannelNavState` / `setChannel` 那套往返
 * 契约已退役）。先挂哪个都行、任一方不在时另一方照常工作——这三条一旦破了，症状是"点导航
 * 内容不跟着换"，而两边单看都正常、没有任何一处会报错。
 */
import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api } from '../lib/api.ts'
import { channelStore } from './nav/channel-store.ts'
import { DEFAULT_TIMELINE_CHANNEL_ID, type ChannelView, type SpaceView } from '../lib/types.ts'

function channel(id: string, label: string): ChannelView {
  return { id, label, present: 'timeline', system: false, kind: 'timeline', streams: [], space_id: 'default-space' } as ChannelView
}

const CHANNELS = [channel(DEFAULT_TIMELINE_CHANNEL_ID, '时间线'), channel('reading', '阅读')]
const SPACES: SpaceView[] = [{ id: 'default-space', label: 'Default', position: 1 }]

beforeEach(() => {
  channelStore.reset()
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  vi.spyOn(api, 'spaces').mockResolvedValue(SPACES)
  vi.spyOn(api, 'channelItems').mockImplementation(async (_c, id) =>
    ({ items: [], next_cursor: undefined, _channel: id } as unknown as { items: [] }))
  vi.spyOn(api, 'enrich').mockResolvedValue({ comments: [], total: 0 })
})

afterEach(async () => {
  const m = await import('./entry.tsx')
  act(() => { m.unmountNav(); m.unmount() })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function host(): HTMLDivElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

/** 点导航里那一行，内容区的当前频道要跟着换（两个 root 共读同一份 store）。 */
async function pickReadingAndAssert(): Promise<void> {
  await waitFor(() => expect(screen.getByText('阅读')).toBeTruthy())
  act(() => { screen.getByText('阅读').closest('button')!.click() })
  await waitFor(() => expect(channelStore.getSnapshot().active).toBe('reading'))
  await waitFor(() => expect(api.channelItems).toHaveBeenLastCalledWith(expect.anything(), 'reading', { limit: 60 }))
}

test('先挂导航再挂内容：点导航一行，内容区跟着切频道', async () => {
  const m = await import('./entry.tsx')
  act(() => { m.mountNav(host(), { backend: 'http://127.0.0.1:8900' }) })
  act(() => { m.mount(host(), { backend: 'http://127.0.0.1:8900', manageWidth: false }) })
  await pickReadingAndAssert()
})

test('反序也一样：先挂内容再挂导航', async () => {
  const m = await import('./entry.tsx')
  act(() => { m.mount(host(), { backend: 'http://127.0.0.1:8900', manageWidth: false }) })
  act(() => { m.mountNav(host(), { backend: 'http://127.0.0.1:8900' }) })
  await pickReadingAndAssert()
})

test('unmountNav 之后 mount 照常：导航不在，内容区不画任何频道切换条', async () => {
  const m = await import('./entry.tsx')
  const nav = host()
  act(() => { m.mountNav(nav, { backend: 'http://127.0.0.1:8900' }) })
  await waitFor(() => expect(screen.getByText('阅读')).toBeTruthy())
  act(() => { m.unmountNav() })
  expect(nav.textContent).toBe('')

  act(() => { m.mount(host(), { backend: 'http://127.0.0.1:8900', manageWidth: false }) })
  await waitFor(() => expect(api.channelItems).toHaveBeenCalled())
  // ChannelBar 已退役：导航归面板之后，"宿主没接管导航"这个情形不再存在。
  expect(screen.queryByTestId('panel-channel-bar')).toBeNull()
  expect(screen.queryByRole('tablist', { name: '频道' })).toBeNull()
})

test('mountNav 自己会拉一次名录——导航单独挂时也画得出东西', async () => {
  const m = await import('./entry.tsx')
  act(() => { m.mountNav(host(), { backend: 'http://127.0.0.1:8900' }) })
  await waitFor(() => expect(api.channels).toHaveBeenCalled())
  await waitFor(() => expect(screen.getByLabelText('Stream 频道')).toBeTruthy())
})

test('onPickChannel 报的是"点的是不是此刻高亮那条"（宿主据此做布局联动）', async () => {
  const m = await import('./entry.tsx')
  const picks: boolean[] = []
  act(() => { m.mountNav(host(), { backend: 'http://127.0.0.1:8900', onPickChannel: (cur) => picks.push(cur) }) })
  await waitFor(() => expect(screen.getByText('阅读')).toBeTruthy())
  act(() => { screen.getByText('阅读').closest('button')!.click() })
  act(() => { screen.getByText('阅读').closest('button')!.click() })
  expect(picks).toEqual([false, true])
})

// footer 是宿主给的那条动作栏（「管理」+ 明暗），`mountNav` 只负责转交给 NavTree。
// 不转交的话表现是"独立正门底下什么都没有"，而面板自己的测试全绿。
test('mountNav 把 footer 转交给导航树', async () => {
  const m = await import('./entry.tsx')
  const onManage = vi.fn()
  act(() => {
    m.mountNav(host(), {
      backend: 'http://127.0.0.1:8900',
      footer: { onManage, theme: { isDark: () => false, toggle: () => {} } },
    })
  })
  await waitFor(() => expect(screen.getByRole('button', { name: '管理' })).toBeTruthy())
  expect(screen.getByLabelText('切换到深色')).toBeTruthy()
  act(() => { screen.getByRole('button', { name: '管理' }).click() })
  expect(onManage).toHaveBeenCalledTimes(1)
})
