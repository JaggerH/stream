import { renderHook, waitFor, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { api, type Connection } from '../lib/api.ts'
import { ChannelsProvider, useChannels } from '../lib/channels.tsx'
import { useInbox } from './useInbox.ts'

vi.mock('./useWs.ts', () => ({ useWs: () => {} }))

const conn = { baseUrl: '', token: '' } as Connection

const wrapper = ({ children }: { children: ReactNode }) => (
  <ChannelsProvider conn={conn}>{children}</ChannelsProvider>
)

/**
 * 频道名录在前端只能有一份。
 *
 * 这里守的不是某个功能，是「有几份副本」这件事本身——`useInbox` 曾经自持一份
 * `useState<ChannelView[]>`，和 `ChannelsProvider` 各拉各的。两份的害处是隐性的：
 * 谁都不算错，但读代码的人（和 agent）无从知道哪份是真相源，而任何经 `patchChannel`
 * 写进 Provider 的改动，`useInbox` 那份看不见。
 */
describe('useInbox 的频道名录来自 ChannelsProvider，不自持第二份', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, 'streams').mockResolvedValue([])
    vi.spyOn(api, 'status').mockResolvedValue({} as never)
    vi.spyOn(api, 'channels').mockResolvedValue([
      { id: 'default-timeline', label: '时间线', present: 'timeline', system: true, streams: [] },
    ] as never)
    vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [], next_cursor: undefined } as never)
    vi.spyOn(api, 'items').mockResolvedValue([] as never)
  })

  it('挂载一次只拉一次名录——两份副本时这里是 2', async () => {
    renderHook(() => useInbox(conn, null), { wrapper })
    await waitFor(() => expect(api.channels).toHaveBeenCalled())
    // 稳定一拍，让任何"第二份"的自发拉取有机会发生
    await act(async () => { await Promise.resolve() })
    expect(api.channels).toHaveBeenCalledTimes(1)
  })

  it('经 patchChannel 新增的频道，useInbox 当场认它是频道（自持副本时看不见）', async () => {
    const refreshChannel = vi.spyOn(api, 'refreshChannel').mockResolvedValue({ streams: [], fetched: 0, written: 0, failed: 0 })
    vi.spyOn(api, 'refreshStream').mockResolvedValue({ fetched: 0, written: 0 })
    vi.spyOn(api, 'updateChannel').mockResolvedValue({
      id: 'later-channel', label: '后来的', present: 'timeline', system: false, streams: [{ id: 's9' }],
    } as never)

    const { result } = renderHook(
      () => ({ inbox: useInbox(conn, 'later-channel'), channels: useChannels() }),
      { wrapper },
    )
    await waitFor(() => expect(api.channels).toHaveBeenCalled())

    // 名录里还没有它 → 被当成单个流刷新
    await act(async () => { await result.current.inbox.harvestSelected() })
    expect(refreshChannel).not.toHaveBeenCalled()

    // 写进 Provider 后，useInbox 必须当场改判为「频道」
    await act(async () => { await result.current.channels.patchChannel('later-channel', { label: '后来的' }) })
    await act(async () => { await result.current.inbox.harvestSelected() })
    expect(refreshChannel).toHaveBeenCalledWith(conn, 'later-channel')
  })
})
