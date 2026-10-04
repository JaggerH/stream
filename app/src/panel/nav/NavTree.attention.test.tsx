/**
 * 「只有拍板时刻打断、连累的频道一起亮」（spec 2026-09-12 §6）。
 * 红点的真相是 channelStore.attention；这里只钉「集合里有它 → 行上有红点；没有 → 一个像素都不多」。
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { NavTree } from './NavTree.tsx'
import { channelStore } from './channel-store.ts'
import { createSpaceCollapseStore } from './space-collapse-store.ts'
import { api } from '../../lib/api.ts'
import { fetchSourceHealth } from '../../lib/api.source-health.ts'
import type { ChannelView } from '../../lib/types.ts'

const channel = (id: string, label: string): ChannelView => ({ id, label, present: 'timeline', system: false, kind: 'timeline', streams: [], space_id: 'default-space' } as ChannelView)

// AttentionWatcher 挂在 footer 分支的 EventsProvider 里（真实那份要真起一条 WS）。这里只要
// 它的 subscribe 通道能被测试代码手动喂帧——换成一个透传壳 + 一份可控 useEvents，把
// subscribe 的回调存到外面这个变量里，用完当 WS 帧调用它。
let capturedSubscribe: ((m: { type?: string; event?: { type?: string } }) => void) | null = null
vi.mock('../../components/EventsProvider.tsx', () => ({
  EventsProvider: ({ children }: { children: ReactNode }) => children,
  useEvents: () => ({
    events: [], unread: 0, markAllRead: () => {}, send: () => {}, dispatchLocal: () => {},
    subscribe: (cb: (m: { type?: string; event?: { type?: string } }) => void) => {
      capturedSubscribe = cb
      return () => { capturedSubscribe = null }
    },
  }),
}))

vi.mock('../../lib/api.source-health.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api.source-health.ts')>()
  return { ...actual, fetchSourceHealth: vi.fn() }
})

beforeEach(() => { cleanup(); channelStore.reset(); vi.restoreAllMocks(); capturedSubscribe = null })

describe('NavTree 红点', () => {
  it('attention 里的频道行带红点，其他行没有；集合清空红点消失', async () => {
    vi.spyOn(api, 'channels').mockResolvedValue([channel('c1', '小红书'), channel('c2', '阅读')])
    vi.spyOn(api, 'spaces').mockResolvedValue([{ id: 'default-space', label: 'Default', position: 1 }])
    await act(async () => { await channelStore.load() })
    render(<NavTree collapse={createSpaceCollapseStore('t.attention')} />)
    act(() => { channelStore.setAttention(['c1']) })
    const row1 = screen.getByText('小红书').closest('button')!
    const row2 = screen.getByText('阅读').closest('button')!
    expect(row1.querySelector('.stream-nav-attention')).not.toBeNull()
    expect(row2.querySelector('.stream-nav-attention')).toBeNull()
    act(() => { channelStore.setAttention([]) })
    expect(row1.querySelector('.stream-nav-attention')).toBeNull()
  })
})

describe('AttentionWatcher（footer 挂着才有；WS 帧驱动重拉）', () => {
  it('intervention.* 帧触发重拉，其他类型的帧不触发', async () => {
    const mockFetch = fetchSourceHealth as unknown as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValue({ sources: [] })
    vi.spyOn(api, 'channels').mockResolvedValue([channel('c1', '小红书')])
    vi.spyOn(api, 'spaces').mockResolvedValue([{ id: 'default-space', label: 'Default', position: 1 }])
    await act(async () => { await channelStore.load() })
    // footer 得给 onManage 这一栏，铃与 AttentionWatcher 才会挂进 EventsProvider 分支。
    render(<NavTree collapse={createSpaceCollapseStore('t.attention.watcher')} footer={{ onManage: () => {} }} />)
    await act(async () => { await Promise.resolve() })
    expect(mockFetch).toHaveBeenCalledTimes(1) // 挂载即 refresh 一次
    expect(capturedSubscribe).not.toBeNull()

    await act(async () => {
      capturedSubscribe!({ type: 'event', event: { type: 'intervention.awaiting' } })
      await Promise.resolve()
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)

    await act(async () => {
      capturedSubscribe!({ type: 'event', event: { type: 'transcribe.done' } })
      await Promise.resolve()
    })
    expect(mockFetch).toHaveBeenCalledTimes(2) // 不认识的类型不触发重拉
  })
})
