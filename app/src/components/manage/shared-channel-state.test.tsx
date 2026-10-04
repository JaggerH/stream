import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChannelView, PresentSlotView, ProviderView } from '../../lib/types.ts'

/**
 * 承重回归：SlotSwitcher（chip）与 ChannelManageSheet 的槽位区（ChannelSlotFields）同屏时
 * **不能丢更新**。原来两个组件各持一份 `api.channels()` 快照，各自「读旧份 → 整份写回
 * options.slots」，谁后写谁赢——先在 Sheet 里改 video.resolve、再点 chip 改 search.resources，
 * chip 那次写入会把 video.resolve 覆盖回旧值（真覆盖，不是文案陈旧）。
 */

// 一份会真的被写进去的"服务端"频道记录：updateChannel 改它并返回**持久化后的整条**
// （PATCH /api/channels/:id 的契约），这样"用返回体回填"才有东西可回填。
const server = vi.hoisted(() => {
  const callsites = [
    {
      id: 'search.resources', label: '资源搜索', description: '', category: 'search', mode: 'fixed',
      entries: [], binding: { callsiteId: 'search.resources', providerIds: ['p-global'] },
      providers: [{ id: 'p-global', label: '全局搜索' }, { id: 'p-alt', label: '备用搜索' }],
    },
  ]
  return {
    callsites,
    channel: {
      id: 'c1', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [],
      options: { slots: {} as Record<string, string[]> },
    } as ChannelView,
    patches: [] as Array<{ options?: { slots?: Record<string, string[]> } }>,
  }
})

vi.mock('../../lib/api.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api.ts')>()
  return {
    ...mod,
    api: {
      ...mod.api,
      channels: vi.fn(async () => [server.channel]),
      providerCallsites: vi.fn(async () => server.callsites),
      updateChannel: vi.fn(async (_c: unknown, _id: string, body: { options?: Record<string, unknown> }) => {
        server.patches.push(body as { options?: { slots?: Record<string, string[]> } })
        if (body.options) server.channel = { ...server.channel, options: body.options }
        return server.channel
      }),
    },
  }
})

import { ChannelsProvider, useChannels } from '../../lib/channels.tsx'
import { ChannelSlotFields } from './ChannelSlotFields.tsx'
import { SlotSwitcher } from './SlotSwitcher.tsx'

const conn = { baseUrl: '' } as never
const slots: PresentSlotView[] = [
  { callsiteId: 'search.resources', label: '资源搜索', category: 'search', mode: 'fixed' },
  { callsiteId: 'video.resolve', label: '视频解析', category: 'resolve', mode: 'dispatch' },
]
const providers = [
  { id: 'p-global', label: '全局搜索', category: 'search', parked: false },
  { id: 'p-alt', label: '备用搜索', category: 'search', parked: false },
  { id: 'p-video', label: '解析器', category: 'resolve', parked: false },
] as unknown as ProviderView[]

/** 两个订阅者同屏：槽位表单读共享状态里的那条频道，chip 自己也订阅同一份。 */
function SameScreen() {
  const { channels } = useChannels()
  const channel = channels.find((c) => c.id === 'c1')
  return (
    <>
      {channel ? (
        <ChannelSlotFields channel={channel} slots={slots} providers={providers} onSaved={() => {}} />
      ) : null}
      <SlotSwitcher conn={conn} channelId="c1" callsiteId="search.resources" onChanged={() => {}} />
      {/* 探针：直接把共享状态里那条频道的 slots 打出来，断言不必绕 Radix 浮层的渲染细节 */}
      <pre data-testid="shared-slots">{JSON.stringify(channel?.options?.slots ?? null)}</pre>
    </>
  )
}

/** Radix 的浮层一律走键盘开合：jsdom 没有真 PointerEvent，fireEvent.pointerDown 合成出来的
 *  事件丢了 `button`，Radix 的 `event.button === 0` 判定过不去，浮层根本不开。 */
async function pickFromOverlay(trigger: HTMLElement, role: 'option' | 'menuitem', option: string) {
  fireEvent.keyDown(trigger, { key: 'Enter' })
  fireEvent.keyDown(await screen.findByRole(role, { name: option }), { key: 'Enter' })
}

describe('SlotSwitcher 与 ChannelSlotFields 同屏 — 共享频道记录，写入不互相覆盖', () => {
  beforeEach(() => {
    server.channel = {
      id: 'c1', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [],
      options: { slots: {} },
    } as ChannelView
    server.patches.length = 0
  })

  it('先在槽位区改 video.resolve，再点 chip 改 search.resources → 前一个改动不被覆盖回旧值', async () => {
    render(<ChannelsProvider conn={conn}><SameScreen /></ChannelsProvider>)

    // ① Sheet 侧：video.resolve 默认 → 解析器
    await pickFromOverlay(await screen.findByRole('combobox', { name: '视频解析' }), 'option', '解析器')
    await vi.waitFor(() => expect(server.channel.options?.slots).toEqual({ 'video.resolve': ['p-video'] }))

    // ② chip 侧：search.resources 默认 → 备用搜索
    await pickFromOverlay(await screen.findByRole('button', { name: '由 全局搜索 提供' }), 'menuitem', '备用搜索')

    // ③ chip 那次写入必须带上 Sheet 刚存的 video.resolve——丢了就是丢更新
    await vi.waitFor(() => expect(server.patches).toHaveLength(2))
    expect(server.patches[1].options?.slots).toEqual({
      'video.resolve': ['p-video'],
      'search.resources': ['p-alt'],
    })
  })

  it('写完用服务端返回体回填共享状态——不是把本地推测值当结果', async () => {
    const { api } = await import('../../lib/api.ts')
    // 服务端归一化：把 slots 里的空数组丢掉。回填若走本地推测，界面就会显示一个服务端没存的值。
    ;(api.updateChannel as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_c: unknown, _id: string, body: { options?: Record<string, unknown> }) => {
        server.patches.push(body as { options?: { slots?: Record<string, string[]> } })
        server.channel = { ...server.channel, options: { slots: { 'search.resources': ['p-global'] } } }
        return server.channel
      },
    )
    render(<ChannelsProvider conn={conn}><SameScreen /></ChannelsProvider>)

    await pickFromOverlay(await screen.findByRole('button', { name: '由 全局搜索 提供' }), 'menuitem', '备用搜索')

    // 本地推测是 p-alt，服务端存下来的是 p-global —— 共享状态里必须是服务端那份
    await vi.waitFor(() =>
      expect(screen.getByTestId('shared-slots').textContent).toBe(
        JSON.stringify({ 'search.resources': ['p-global'] }),
      ),
    )
    // 于是 chip 的文案说的也是服务端那句（而不是「我以为我改成了备用搜索」）
    expect(screen.getByRole('button', { name: '由 全局搜索 提供' })).toBeTruthy()
  })
})
