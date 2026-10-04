import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

const { videoSearchStream } = vi.hoisted(() => ({ videoSearchStream: vi.fn(async () => {}) }))
vi.mock('../lib/api.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api.ts')>()
  return {
    ...mod,
    api: {
      ...mod.api,
      videoSearchStream,
      providerCallsites: vi.fn(async () => [{
        id: 'search.resources', label: '资源搜索', description: '', variant: 'search', mode: 'fixed',
        entries: [], binding: { callsiteId: 'search.resources', providerIds: ['p1'] },
        providers: [{ id: 'p1', label: '全局搜索' }],
      }]),
      channels: vi.fn(async () => [{ id: 'c1', label: '影视', kind: 'video', present: 'video', streams: [] }]),
    },
  }
})
import { VideoSearchResults } from './VideoSearchResults.tsx'
import { ChannelsProvider } from '../lib/channels.tsx'

const conn = { baseUrl: '' } as never
// chip 的频道记录来自共享状态（见 lib/channels.tsx）
const renderResults = (ui: React.ReactElement) => render(<ChannelsProvider conn={conn}>{ui}</ChannelsProvider>)

describe('VideoSearchResults + SlotSwitcher', () => {
  it('带 channelId 时渲染 SlotSwitcher', async () => {
    renderResults(<VideoSearchResults conn={conn} query="q" channelId="c1" />)
    expect(await screen.findByText(/全局搜索/)).toBeTruthy()
  })
  it('不带 channelId 时不渲染（全局入口没有频道语境可改）', async () => {
    renderResults(<VideoSearchResults conn={conn} query="q" />)
    expect(screen.queryByText(/全局搜索/)).toBeNull()
  })
})
