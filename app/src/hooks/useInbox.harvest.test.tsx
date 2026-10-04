import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { api, type Connection } from '../lib/api.ts'
import { ChannelsProvider } from '../lib/channels.tsx'
import { ADS_CHANNEL } from '../lib/items.ts'
import { useInbox } from './useInbox.ts'

// WS 只影响增量推送，与「点刷新会不会真去抓」无关——静音掉，省得每个用例都要接一个假 socket。
vi.mock('./useWs.ts', () => ({ useWs: () => {} }))

const conn = { baseUrl: '', token: '' } as Connection

// 频道名录来自 ChannelsProvider（useInbox 不自持副本），所以 hook 必须在它的作用域里跑。
const wrapper = ({ children }: { children: ReactNode }) => (
  <ChannelsProvider conn={conn}>{children}</ChannelsProvider>
)

/**
 * 顶栏刷新按钮到底会不会真的去抓。
 *
 * **这就是那个 bug 本身**：以前 `force` 标志只有 Discovery 那条分支在读，Timeline / 自定义频道 /
 * 单个流全都静默丢掉，按钮只是把数据库重读一遍。视图测试抓不到它——AppView 拿的是 onReload 这个
 * prop，真假都能过；只有在 hook 这一层断言「打了哪个后端」才守得住。
 */
describe('useInbox.harvestSelected', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, 'streams').mockResolvedValue([])
    vi.spyOn(api, 'status').mockResolvedValue({} as never)
    vi.spyOn(api, 'channels').mockResolvedValue([
      { id: 'default-timeline', label: '时间线', present: 'timeline', system: true, streams: [] },
      { id: 'my-channel', label: '我的', present: 'timeline', system: false, streams: [{ id: 's1' }] },
    ] as never)
    vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [], next_cursor: undefined } as never)
    vi.spyOn(api, 'items').mockResolvedValue([] as never)
  })

  it('Timeline（selected=null）扇出刷新默认时间线频道——不是只重读', async () => {
    const refreshChannel = vi.spyOn(api, 'refreshChannel').mockResolvedValue({
      streams: [{ streamId: 's1', fetched: 3, written: 1 }],
      fetched: 3,
      written: 1,
      failed: 0,
    })
    const { result } = renderHook(() => useInbox(conn, null), { wrapper })
    await waitFor(() => expect(api.channels).toHaveBeenCalled())

    const summary = await result.current.harvestSelected()
    expect(refreshChannel).toHaveBeenCalledWith(conn, 'default-timeline')
    expect(summary).toEqual({ kind: 'channel', fetched: 3, written: 1, failed: 0, total: 1 })
  })

  it('抓完要重读一遍——否则新条目抓到了却不出现在列表里', async () => {
    vi.spyOn(api, 'refreshChannel').mockResolvedValue({ streams: [], fetched: 1, written: 1, failed: 0 })
    const { result } = renderHook(() => useInbox(conn, null), { wrapper })
    await waitFor(() => expect(api.channels).toHaveBeenCalled())
    const before = (api.channelItems as unknown as { mock: { calls: unknown[] } }).mock.calls.length

    await result.current.harvestSelected()
    expect((api.channelItems as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(before)
  })

  it('自定义频道刷新的是它自己,不是默认时间线', async () => {
    const refreshChannel = vi.spyOn(api, 'refreshChannel').mockResolvedValue({ streams: [], fetched: 0, written: 0, failed: 0 })
    const { result } = renderHook(() => useInbox(conn, 'my-channel'), { wrapper })
    await waitFor(() => expect(api.channels).toHaveBeenCalled())

    await result.current.harvestSelected()
    expect(refreshChannel).toHaveBeenCalledWith(conn, 'my-channel')
  })

  it('选中单个流时打单流刷新端点', async () => {
    const refreshStream = vi.spyOn(api, 'refreshStream').mockResolvedValue({ fetched: 7, written: 2 })
    const refreshChannel = vi.spyOn(api, 'refreshChannel')
    const { result } = renderHook(() => useInbox(conn, 'some-stream'), { wrapper })
    await waitFor(() => expect(api.channels).toHaveBeenCalled())

    const summary = await result.current.harvestSelected()
    expect(refreshStream).toHaveBeenCalledWith(conn, 'some-stream')
    expect(refreshChannel).not.toHaveBeenCalled()
    expect(summary).toEqual({ kind: 'stream', fetched: 7, written: 2, failed: 0, total: 1 })
  })

  it('广告这种虚拟视图没有上游可抓——只重读,且不打任何刷新端点', async () => {
    const refreshChannel = vi.spyOn(api, 'refreshChannel')
    const refreshStream = vi.spyOn(api, 'refreshStream')
    const { result } = renderHook(() => useInbox(conn, ADS_CHANNEL), { wrapper })
    await waitFor(() => expect(api.channels).toHaveBeenCalled())

    const summary = await result.current.harvestSelected()
    expect(summary).toEqual({ kind: 'reload' })
    expect(refreshChannel).not.toHaveBeenCalled()
    expect(refreshStream).not.toHaveBeenCalled()
  })

  it('部分失败如实带出来（调用方据此说「N 条里 K 条没成」）', async () => {
    vi.spyOn(api, 'refreshChannel').mockResolvedValue({
      streams: [{ streamId: 's1', fetched: 4, written: 2 }, { streamId: 's2', error: 'facility 未登录' }],
      fetched: 4,
      written: 2,
      failed: 1,
    })
    const { result } = renderHook(() => useInbox(conn, null), { wrapper })
    await waitFor(() => expect(api.channels).toHaveBeenCalled())

    expect(await result.current.harvestSelected()).toEqual({ kind: 'channel', fetched: 4, written: 2, failed: 1, total: 2 })
  })

  it('整个请求失败时抛出去,让调用方能报错（而不是静默装作刷新过了）', async () => {
    vi.spyOn(api, 'refreshChannel').mockRejectedValue(new Error('backend down'))
    const { result } = renderHook(() => useInbox(conn, null), { wrapper })
    await waitFor(() => expect(api.channels).toHaveBeenCalled())

    await expect(result.current.harvestSelected()).rejects.toThrow('backend down')
  })
})
