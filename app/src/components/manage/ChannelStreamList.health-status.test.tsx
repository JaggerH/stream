import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/api.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api.ts')>()
  return { ...mod, api: { ...mod.api, channels: vi.fn(async () => []), streams: vi.fn(async () => []) } }
})
vi.mock('../../lib/api.source-health.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api.source-health.ts')>()
  return { ...mod, fetchSourceHealth: vi.fn(async () => ({ sources: [{ source: { id: '@streamapp/xhs/xhs-home', title: 'HomeFeed' }, status: 'awaiting', health: { state: 'dead', lastAt: 't' }, affectedChannels: [] }] })) }
})

import { ChannelStreamList } from './ChannelStreamList.tsx'
import { ChannelsProvider } from '../../lib/channels.tsx'
import { manageBridge } from '../../panel/manage-bridge.ts'
import type { ChannelView } from '../../lib/types.ts'

const conn = { baseUrl: '' } as never
const channel: ChannelView = {
  id: 'c1', label: '小红书', kind: 'timeline', present: 'timeline',
  streams: [{ id: 's1', description: '首页流', cadence_seconds: 3600, vault_subdir: '', sources: [{ source: { id: '@streamapp/xhs/xhs-home', pluginId: 'replay', pluginName: 'Recipe', title: 'HomeFeed', categories: [], capabilities: ['timeline'], auth: 'none', paramCount: 0, requiredParamCount: 0 }, params: {}, health: 'dead' }] }],
} as unknown as ChannelView

beforeEach(() => { vi.clearAllMocks() })

describe('ChannelStreamList — 源行的修复状态词', () => {
  it('源在源健康表里 → 行上带状态词；宿主登记了桥 → 点状态词打开该源的修复页', async () => {
    const open = vi.fn()
    const off = manageBridge.register(open)
    render(<ChannelsProvider conn={conn}><ChannelStreamList conn={conn} channel={channel} title="订阅列表" /></ChannelsProvider>)
    await waitFor(() => expect(screen.getByText('等你拍板')).toBeTruthy())
    fireEvent.click(screen.getByText('等你拍板'))
    expect(open).toHaveBeenCalledWith({ view: 'source-health', sourceId: '@streamapp/xhs/xhs-home' })
    off()
  })
  it('宿主没登记桥（DSH）→ 状态词照样显示，但不是按钮', async () => {
    render(<ChannelsProvider conn={conn}><ChannelStreamList conn={conn} channel={channel} title="订阅列表" /></ChannelsProvider>)
    await waitFor(() => expect(screen.getByText('等你拍板')).toBeTruthy())
    expect(screen.getByText('等你拍板').closest('button')).toBeNull()
  })
})
