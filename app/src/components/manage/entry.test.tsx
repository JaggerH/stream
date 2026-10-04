import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MovieChannel } from '../MovieChannel.tsx'

// MovieChannel 的配置入口不该真的画出完整配置面(那是 ChannelConfigPanel 自己的测试范围)——
// 这里只守接线:入口出现/隐藏的条件 + 把正确的 channelId 递下去。
//
// 两档入口是刻意不同的东西:恰好一个频道 → 标题栏底下那条「内容 | 配置」分页;多个频道 →
// 「配这一个」没有答案,保留原来那颗齿轮(点开先选频道)。
const panelPropsMock = vi.hoisted(() => vi.fn())
vi.mock('./ChannelConfigPanel.tsx', () => ({
  ChannelConfigPanel: (props: { channelId: string }) => {
    panelPropsMock(props)
    return <div data-testid="config-panel">{props.channelId}</div>
  },
}))
vi.mock('./ChannelManageSheet.tsx', () => ({
  ChannelManageSheet: (props: { channelId: string }) => <div data-testid="manage-sheet">{props.channelId}</div>,
}))

// 这些桩的**行为在 beforeEach 里装**，不在工厂里：`restoreMocks: true`（vite.config.ts）会在
// **每个测试之前**把所有 mock 还原，模块求值那一刻设的 mockResolvedValue 连第一个测试都活不到——
// 桩还在、只是变回返回 undefined，于是组件里 `api.x(...).then(...)` 炸在"读不到 then"上，
// 报错指向组件而不是这里，极难往测试配置上想。装在 beforeEach 里就在还原**之后**，稳。
const apiStubs = vi.hoisted(() => ({
  items: vi.fn(), markStreamSeen: vi.fn(), collections: vi.fn(),
  collectionItems: vi.fn(), whereCollected: vi.fn(), watchProgressList: vi.fn(),
}))
vi.mock('../../lib/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api.ts')>()
  return { ...actual, api: { ...actual.api, ...apiStubs } }
})

const conn = { baseUrl: 'http://api' }
const stream = (id: string) => ({ id, description: id, sources: [], cadence_seconds: 1800, vault_subdir: id })

beforeEach(() => {
  panelPropsMock.mockClear()
  apiStubs.items.mockResolvedValue([])
  apiStubs.markStreamSeen.mockResolvedValue(undefined)
  apiStubs.collections.mockResolvedValue([])
  apiStubs.collectionItems.mockResolvedValue([])
  apiStubs.whereCollected.mockResolvedValue({ item: null, collectionIds: [] })
  apiStubs.watchProgressList.mockResolvedValue([])
})

describe('MovieChannel 头部管理入口', () => {
  it('只有一个频道 → 标题栏底下出「内容 | 配置」，切过去配的就是那个频道', async () => {
    render(
      <MovieChannel
        conn={conn}
        channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [stream('work-1')] }]} onReload={vi.fn()} />,
    )
    fireEvent.click(await screen.findByRole('tab', { name: '配置' }))
    expect(screen.getByTestId('config-panel').textContent).toBe('videos')
  })

  // 多频道下拉菜单是 Radix DropdownMenu——在 jsdom 里打开它不可靠(见项目测试约束)，这里只守
  // 「多频道时按钮仍然渲染、且不画分页」这个可靠不变量，菜单本身的展开/选择交给 Radix 自己的
  // 测试覆盖。分页那一条是真判据：多频道下画一条「配置」等于让用户去配一个没指定的频道。
  it('多个频道 → 保留管理齿轮、不画分页(菜单展开留给 Radix 自身测试)', async () => {
    render(
      <MovieChannel
        conn={conn}
        channels={[
          { id: 'ch-a', label: '频道 A', kind: 'video', present: 'video', space_id: 'default-space', streams: [stream('work-a')] },
          { id: 'ch-b', label: '频道 B', kind: 'video', present: 'video', space_id: 'default-space', streams: [stream('work-b')] },
        ]} onReload={vi.fn()} />,
    )
    await waitFor(() => expect(screen.getByLabelText('管理频道')).toBeTruthy())
    expect(screen.queryByRole('tab', { name: '配置' })).toBeNull()
  })
})
