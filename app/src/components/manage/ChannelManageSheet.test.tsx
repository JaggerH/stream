import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const unsubscribeMock = vi.hoisted(() => vi.fn(async () => ({ removed: true, deleted: true })))

const spaces = [
  { id: 'default-space', label: 'Default', position: 0, system: true },
  { id: 'sp-research', label: '研究', position: 1 },
]

const timelineChannel = {
  id: 'c1', label: '自定义频道', kind: 'timeline', present: 'timeline', space_id: 'sp-research',
  streams: [{ id: 's1', description: '流一', sources: [], cadence_seconds: 3600, vault_subdir: '' }],
}
// s3 有一个来源成员——移除它应走共享 unsubscribe op；s1（上面）保持零来源，走引用剥离兜底
const withSourceChannel = {
  id: 'c3', label: '带来源频道', kind: 'timeline', present: 'timeline',
  streams: [{
    id: 's3', description: '流三',
    sources: [{ source: { id: 'src1', pluginId: 'p1', pluginName: 'P1', title: 'Src 1', categories: [], capabilities: [], auth: 'none', paramCount: 0, requiredParamCount: 0 }, params: { foo: 'bar' } }],
    cadence_seconds: 3600, vault_subdir: '',
  }],
}
const searchChannel = { id: 'c2', label: '搜索频道', kind: 'timeline', present: 'search', streams: [], system: true }
// present 值不在 /api/presents 返回里（后端摘掉某 Present / 旧分享包导入）
const unknownPresentChannel = { id: 'c4', label: '孤儿频道', kind: 'timeline', present: 'no-such-present', streams: [] }
// live 频道——打开时现读、不入库
const researchChannel = {
  id: 'c5', label: '研究', kind: 'timeline', present: 'research',
  streams: [{ id: 's4', description: '实时研究流', sources: [], cadence_seconds: 3600, vault_subdir: '' }],
}
// 外接面板——不绑流、没有槽位，专属区块只有一个 URL
const embedChannel = { id: 'c6', label: '监控', kind: 'timeline', present: 'embed', streams: [], options: { url: 'http://127.0.0.1:8123/live' } }
const presents = [
  { id: 'timeline', label: '时间线', needsStreams: true, data: 'collected' as const, slots: [] },
  { id: 'embed', label: '外接面板', needsStreams: false, data: 'live' as const, slots: [] },
  { id: 'search', label: '搜索', needsStreams: false, data: 'collected' as const, slots: [{ callsiteId: 'search.global', label: '全局搜索', category: 'search', mode: 'fixed' }] },
  { id: 'research', label: '研究', needsStreams: true, data: 'live' as const, slots: [] },
]
vi.mock('../../lib/api.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api.ts')>()
  return {
    ...mod,
    api: {
      ...mod.api,
      channels: vi.fn(async () => [timelineChannel, searchChannel, withSourceChannel, unknownPresentChannel, researchChannel, embedChannel]),
      presents: vi.fn(async () => ({ items: presents })),
      providers: vi.fn(async () => []),
      streams: vi.fn(async () => [
        { id: 's1', description: '流一', sources: [], cadence_seconds: 3600, vault_subdir: '' },
        { id: 's2', description: '流二', sources: [], cadence_seconds: 3600, vault_subdir: '' },
        { id: 's4', description: '实时研究流', sources: [], cadence_seconds: 3600, vault_subdir: '' },
      ]),
      spaces: vi.fn(async () => spaces),
      updateChannel: vi.fn(async () => ({})),
    },
  }
})
vi.mock('@subscribe/subscribe.ts', () => ({ unsubscribe: unsubscribeMock }))
import { ChannelManageSheet } from './ChannelManageSheet.tsx'
import { ChannelsProvider } from '../../lib/channels.tsx'

const noop = () => {}
const conn = { baseUrl: '' } as never
// 频道记录来自共享状态（见 lib/channels.tsx）——Sheet 与 chip 订阅同一份，渲染要包 Provider
const renderSheet = (channelId: string) =>
  render(
    <ChannelsProvider conn={conn}>
      <ChannelManageSheet open onOpenChange={noop} conn={conn} channelId={channelId} />
    </ChannelsProvider>,
  )

describe('ChannelManageSheet — 按 Present 描述符长出区块', () => {
  beforeEach(() => { unsubscribeMock.mockClear() })

  it('needsStreams 的 present → 有订阅区；slots 空 → 无槽位区', async () => {
    renderSheet('c1')
    expect(await screen.findByText('自定义频道')).toBeTruthy()
    expect(screen.getByText('订阅列表')).toBeTruthy()
    expect(screen.queryByText('能力槽位')).toBeNull()
    // 非系统频道给删除入口
    expect(screen.getByRole('button', { name: '删除频道' })).toBeTruthy()
  })
  it('needsStreams 假 → 无订阅区；slots 非空 → 有槽位区；系统频道禁删', async () => {
    renderSheet('c2')
    expect(await screen.findByText('搜索频道')).toBeTruthy()
    expect(screen.queryByText('订阅')).toBeNull()
    expect(screen.getByText('能力槽位')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '删除频道' })).toBeNull()
  })
  // 导出**不在这张面上**——它在频道标题菜单里（`ChannelTitleMenu` 那条测试钉着）。这张面是
  // "改这个频道的某个属性"，导出是"对这个频道整体做一件事"，别在这里再长一个平行入口出来。
  it('embed 频道：无订阅区、无槽位区，PRESENT_EXTRAS 长出「面板地址」并回填 options.url；改完走 updateChannel 写 options.url', async () => {
    const { api } = await import('../../lib/api.ts')
    renderSheet('c6')
    expect(await screen.findByText('监控')).toBeTruthy()
    expect(screen.queryByText('订阅列表')).toBeNull()
    expect(screen.queryByText('能力槽位')).toBeNull()
    const input = screen.getByRole('textbox', { name: '面板地址' }) as HTMLInputElement
    expect(input.value).toBe('http://127.0.0.1:8123/live')
    fireEvent.change(input, { target: { value: 'https://grafana.example/d/1' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await vi.waitFor(() => {
      expect(api.updateChannel).toHaveBeenCalledWith(expect.anything(), 'c6', { options: { url: 'https://grafana.example/d/1' } })
    })
  })
  it('配置面上没有导出入口', async () => {
    renderSheet('c1')
    expect(await screen.findByText('自定义频道')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '导出为分享包' })).toBeNull()
  })
  it('订阅区列出成员流，且有「挂已有的」和「添加来源」入口', async () => {
    renderSheet('c1')
    expect(await screen.findByText('流一')).toBeTruthy()
    expect(screen.getByRole('button', { name: '挂已有的' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '添加来源' })).toBeTruthy()
  })
  it('「挂已有的」弹出候选（不含已挂的 s1，含 s2），点挂入调 updateChannel 合并 stream_ids', async () => {
    const { api } = await import('../../lib/api.ts')
    renderSheet('c1')
    fireEvent.click(await screen.findByRole('button', { name: '挂已有的' }))
    const dialog = await screen.findByRole('dialog', { name: '挂入已有的 Stream' })
    expect(within(dialog).getByText('流二')).toBeTruthy()
    // 已挂入的 s1 不该出现在候选里（此前这里断言的是一个任何实现都不会渲染的字符串，永真）
    expect(within(dialog).queryByText('流一')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '挂入 流二' }))
    await vi.waitFor(() => {
      expect(api.updateChannel).toHaveBeenCalledWith(expect.anything(), 'c1', { stream_ids: ['s1', 's2'] })
    })
  })
  it('拉完了但频道不在返回里 → 说清「已不存在」，不是永远转圈', async () => {
    renderSheet('gone')
    expect(await screen.findByText(/这个频道已不存在/)).toBeTruthy()
    expect(screen.queryByText('加载中…')).toBeNull()
  })
  it('频道在、但它的 present 不在 /api/presents 里 → 说清 Present 已不存在', async () => {
    renderSheet('c4')
    expect(await screen.findByText(/Present「no-such-present」已不存在/)).toBeTruthy()
  })
  it('移除一个带来源的 Stream → 走共享 unsubscribe op（候选取自它的第一个来源成员）', async () => {
    const { api } = await import('../../lib/api.ts')
    ;(api.updateChannel as any).mockClear()
    renderSheet('c3')
    const more = await screen.findByLabelText('流三 更多操作')
    fireEvent.keyDown(more, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    await vi.waitFor(() => {
      expect(unsubscribeMock).toHaveBeenCalledWith(
        expect.anything(),
        { sourceId: 'src1', params: { foo: 'bar' }, title: '流三' },
        expect.objectContaining({ id: 'c3' }),
        expect.any(Array),
      )
    })
    expect(api.updateChannel).not.toHaveBeenCalled()
  })
  it('移除一个零来源的 Stream → 不能表达为 unsubscribe 候选，走 updateChannel 引用剥离兜底', async () => {
    const { api } = await import('../../lib/api.ts')
    renderSheet('c1')
    const more = await screen.findByLabelText('流一 更多操作')
    fireEvent.keyDown(more, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    await vi.waitFor(() => {
      expect(api.updateChannel).toHaveBeenCalledWith(expect.anything(), 'c1', { stream_ids: [] })
    })
    expect(unsubscribeMock).not.toHaveBeenCalled()
  })
  it('live present 的订阅区改称「绑定的数据源」,并说明不入库', async () => {
    renderSheet('c5')
    expect(await screen.findByText('绑定的数据源')).toBeTruthy()
    expect(screen.getByText(/不入库/)).toBeTruthy()
  })
  it('collected present 仍叫订阅列表', async () => {
    renderSheet('c1')
    expect(await screen.findByText('自定义频道')).toBeTruthy()
    expect(screen.getByText('订阅列表')).toBeTruthy()
  })

  // 侧栏只管建/删/改空间本身；**把已有频道搬进某个空间只有这一个入口**，缺了它新建的空间
  // 永远只能装新频道。
  // 下拉是 acrylic 的 Select（Radix）：当前值画在 trigger 上，选项在点开后的浮层里。
  it('画出所属空间，选中的是当前那个', async () => {
    renderSheet('c1')
    expect((await screen.findByLabelText('所属空间')).textContent).toContain('研究')
  })

  it('换一个空间 → PATCH 该频道的 space_id', async () => {
    const { api } = await import('../../lib/api.ts')
    renderSheet('c1')
    const trigger = await screen.findByLabelText('所属空间')
    // Radix 的 Select 在 jsdom 里认键盘：点击靠 pointer 事件，jsdom 不给。
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: 'Default' }))
    await waitFor(() => expect(api.updateChannel).toHaveBeenCalledWith(
      expect.anything(), 'c1', expect.objectContaining({ space_id: 'default-space' }),
    ))
  })
})
