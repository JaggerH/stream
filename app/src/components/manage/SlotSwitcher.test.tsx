import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { ProviderCallsiteView } from '../../lib/types.ts'

const callsite: ProviderCallsiteView = {
  id: 'search.resources', label: '资源搜索', description: '', category: 'search', mode: 'fixed',
  entries: [], binding: { callsiteId: 'search.resources', providerIds: ['p-global'] },
  providers: [{ id: 'p-global', label: '全局搜索' }, { id: 'p-alt', label: '备用搜索' }],
}
const channel = {
  id: 'c1', label: '影视', kind: 'video', present: 'video', streams: [],
  options: { slots: { 'search.resources': ['p-alt'] } },
}

vi.mock('../../lib/api.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api.ts')>()
  return {
    ...mod,
    api: {
      ...mod.api,
      providerCallsites: vi.fn(async () => [callsite]),
      channels: vi.fn(async () => [channel]),
      updateChannel: vi.fn(async () => ({})),
    },
  }
})
import { SlotSwitcher, slotChipLabel } from './SlotSwitcher.tsx'
import { ChannelsProvider } from '../../lib/channels.tsx'

const conn = { baseUrl: '' } as never
// chip 的频道记录来自共享状态（见 lib/channels.tsx），所以渲染必须包 ChannelsProvider
const renderChip = (ui: React.ReactElement) => render(<ChannelsProvider conn={conn}>{ui}</ChannelsProvider>)

describe('slotChipLabel', () => {
  it('有频道覆盖 → 覆盖行的 label + isOverride', () => {
    expect(slotChipLabel(callsite, 'p-alt', '默认')).toEqual({ name: '备用搜索', isOverride: true })
  })
  it('无覆盖 → 全局 binding 首个 provider 的 label', () => {
    expect(slotChipLabel(callsite, undefined, '默认')).toEqual({ name: '全局搜索', isOverride: false })
  })
  it('覆盖指向的行已不在候选里（已删/parked）→ 原样显示 id，好过瞎报一个名字', () => {
    expect(slotChipLabel(callsite, 'p-gone', '默认')).toEqual({ name: 'p-gone', isOverride: true })
  })
  it('连全局 binding 都没有 → 用调用方给的 i18n 默认文案，不硬编码中文', () => {
    const unbound: ProviderCallsiteView = { ...callsite, binding: null }
    expect(slotChipLabel(unbound, undefined, 'default')).toEqual({ name: 'default', isOverride: false })
  })
})

describe('SlotSwitcher', () => {
  it('挂载后 chip 显示当前生效 provider 名', async () => {
    renderChip(<SlotSwitcher conn={conn} channelId="c1" callsiteId="search.resources" onChanged={() => {}} />)
    expect(await screen.findByText(/备用搜索/)).toBeTruthy()
  })
  it('broken 态给出警示文案', async () => {
    renderChip(<SlotSwitcher conn={conn} channelId="c1" callsiteId="search.resources" broken onChanged={() => {}} />)
    expect(await screen.findByLabelText('Provider 失效，点此更换')).toBeTruthy()
  })
})
