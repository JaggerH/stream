import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { BundleShareDialog } from './BundleShareDialog.tsx'

const { decide, run } = vi.hoisted(() => ({ decide: vi.fn(async () => ({ item: { id: 'itm-1', status: 'decided' } })), run: {
  id: 'imp-t',
  at: '2026-07-24T00:00:00.000Z',
  meta: { title: 'Caps', revision: '1.0.0' },
  remaps: {},
  recipeDecisions: {},
  netdiskBindings: [],
  items: [
    { id: 'itm-1', kind: 'notice', status: 'open', subject: { reason: 'missing-plugin', dep: 'douyin' }, choices: ['dismiss'], detail: '代码插件 douyin 未安装' },
    {
      id: 'itm-2', kind: 'slot-conflict', status: 'open', subject: { channelId: 'default-video', callsiteId: 'netdisk.share.verify' },
      mine: { providerIds: ['local-p'], providers: [{ id: 'local-p', label: '本机夸克', parked: false }] },
      theirs: { providerIds: ['their-p'], providers: [{ id: 'their-p', label: '作者的夸克', parked: true }] },
      choices: ['keep-mine', 'use-imported', 'dismiss'], detail: '槽位冲突',
    },
    {
      id: 'itm-3', kind: 'parked-provider', status: 'open', subject: { providerId: 'their-p', label: '作者的夸克', serves: ['quark-verify'] },
      choices: ['use-imported', 'keep-mine', 'append', 'dismiss'], detail: '待激活', conflicts: [],
    },
  ],
} }))

vi.mock('../lib/api.ts', async (orig) => {
  const actual = await orig() as Record<string, unknown>
  return {
    ...actual,
    api: {
      sharing: {
        exportBundle: vi.fn(),
        importBundle: vi.fn(async () => run),
        importRun: vi.fn(async () => run),
        imports: vi.fn(async () => []),
        decide,
      },
      providers: vi.fn(async () => []),
      netdisk: { list: vi.fn(async () => []) },
    },
  }
})

describe('BundleShareDialog', () => {
  it('导入后逐 item 渲染：notice / slot-conflict 左右两栏 / parked-provider，decision 走统一端点', async () => {
    render(<BundleShareDialog conn={{ baseUrl: '' } as never} mode="import" seededBundle={{ format: 'stream-bundle/v1' } as never} />)
    expect(await screen.findByText(/douyin 未安装/)).toBeTruthy()
    // slot-conflict：两栏 + 双方 provider label
    expect(await screen.findByText(/本机（现在生效）/)).toBeTruthy()
    expect(await screen.findByText(/包内传入/)).toBeTruthy()
    expect(await screen.findByText(/本机夸克/)).toBeTruthy()
    expect((await screen.findAllByText(/作者的夸克/)).length).toBeGreaterThanOrEqual(2) // 冲突栏 + parked 卡片
    // choices 渲染成按钮并回传 decide(runId, itemId, choice)
    fireEvent.click((await screen.findAllByText('用导入的'))[0])
    await waitFor(() => expect(decide).toHaveBeenCalledWith(expect.anything(), 'imp-t', 'itm-2', 'use-imported'))
  })
})
