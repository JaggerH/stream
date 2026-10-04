import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../lib/api.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api.ts')>()
  return { ...mod, api: { ...mod.api, updateChannel: vi.fn(async () => ({})) } }
})
import { ChannelSlotFields } from './ChannelSlotFields.tsx'
import { ChannelsProvider } from '../../lib/channels.tsx'
import type { ChannelView, PresentSlotView, ProviderView } from '../../lib/types.ts'

const channel: ChannelView = {
  id: 'c1', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [],
  options: { slots: { 'search.resources': ['p-nsfw'] } },
}
const slots: PresentSlotView[] = [
  { callsiteId: 'search.resources', label: '资源搜索', category: 'search', mode: 'fixed' },
  { callsiteId: 'video.resolve', label: '视频解析', category: 'resolve', mode: 'dispatch' },
]
const providers = [
  { id: 'p-nsfw', label: '成人搜索', category: 'search', parked: false },
  { id: 'p-parked', label: '停用行', category: 'search', parked: true },
  { id: 'p-video', label: '解析器', category: 'resolve', parked: false },
] as unknown as ProviderView[]

describe('ChannelSlotFields', () => {
  it('每个槽位一个选择器；有覆盖的显示覆盖 provider，没有的显示默认', () => {
    render(
      <ChannelsProvider conn={{ baseUrl: '' } as any}>
        <ChannelSlotFields channel={channel} slots={slots} providers={providers} onSaved={() => {}} />
      </ChannelsProvider>,
    )
    expect(screen.getByText('资源搜索')).toBeTruthy()
    expect(screen.getByText('视频解析')).toBeTruthy()
    // search.resources 有覆盖 → trigger 显示覆盖行 label；video.resolve 无覆盖 → 显示默认
    expect(screen.getByText('成人搜索')).toBeTruthy()
    expect(screen.getByText('默认（跟随全局）')).toBeTruthy()
    // parked 行不该出现在任何 trigger 上
    expect(screen.queryByText('停用行')).toBeNull()
  })
})
