import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { it, expect, vi, beforeEach } from 'vitest'
import { SourceBrowser } from './SourceBrowser.tsx'
import { api } from '../../lib/api.ts'

const conn = { baseUrl: '', token: undefined } as const
beforeEach(() => vi.restoreAllMocks())

it('lists plugins and emits onPick with the clicked source', async () => {
  vi.spyOn(api, 'plugins').mockResolvedValue([
    { id: 'rsshub', name: 'RSSHub', capabilities: [], sourceCount: 1, status: 'ready', launch: { mode: 'builtin' } } as never,
  ])
  vi.spyOn(api, 'pluginSources').mockResolvedValue({
    plugin: { id: 'rsshub', sourceGrouping: { enabled: false, resolver: '' } } as never,
    sources: [{ id: 'rsshub:foo', pluginId: 'rsshub', pluginName: 'RSSHub', title: 'Foo', categories: [], capabilities: ['timeline'], auth: 'none', paramCount: 0, requiredParamCount: 0 }],
    groups: [], facets: { categories: [], capabilities: [], facilities: [] },
  } as never)
  const onPick = vi.fn()
  render(<SourceBrowser conn={conn} onPick={onPick} />)
  const row = await screen.findByText('Foo')
  fireEvent.click(row)
  await waitFor(() => expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'rsshub:foo' })))
})

// 这一页只管找源：启用开关、配置齿轮、AList 的绑定汇总都搬去了「包」页。
// 这条测试钉住"没搬干净"——同一个开关在两处各写一份实现，迟早说法不一致。
it('不再有任何管理控件：开关、配置齿轮都不在这一页', async () => {
  vi.spyOn(api, 'plugins').mockResolvedValue([
    { id: 'rsshub', name: 'RSSHub', capabilities: [], sourceCount: 1, status: 'ready', enabled: true, required: true, launch: { mode: 'builtin' } } as never,
    { id: 'alist', name: 'AList', capabilities: [], sourceCount: 0, status: 'ready', enabled: true, required: false, launch: { mode: 'external' } } as never,
  ])
  vi.spyOn(api, 'pluginSources').mockResolvedValue({
    plugin: { id: 'rsshub', enabled: true, required: true, sourceGrouping: { enabled: false, resolver: '' } } as never,
    sources: [], groups: [], facets: { categories: [], capabilities: [], facilities: [] },
  } as never)
  const setEnabled = vi.spyOn(api, 'setPluginEnabled')
  render(<SourceBrowser conn={conn} onPick={vi.fn()} />)

  // 左栏和详情头各出现一次，所以是 findAll
  await screen.findAllByText('RSSHub')
  expect(screen.queryByLabelText('停用插件')).toBeNull()
  expect(screen.queryByLabelText('启用插件')).toBeNull()
  expect(screen.queryByText('配置')).toBeNull()
  expect(setEnabled).not.toHaveBeenCalled()
})

// 落点由**宿主**注入（页内切 tab），不再写地址栏：这棵树现在跑在工作台里（频道配置页的
// 「添加来源」就是它），那条 URL 归 DSH。宿主没给落点就不画那颗键。
it('「这是什么包」把包 id 交给宿主；宿主没给落点就不画这颗键', async () => {
  vi.spyOn(api, 'plugins').mockResolvedValue([
    { id: 'rsshub', name: 'RSSHub', capabilities: [], sourceCount: 1, status: 'ready', enabled: true, required: true, launch: { mode: 'builtin' } } as never,
  ])
  vi.spyOn(api, 'pluginSources').mockResolvedValue({
    plugin: { id: 'rsshub', sourceGrouping: { enabled: false, resolver: '' } } as never,
    sources: [], groups: [], facets: { categories: [], capabilities: [], facilities: [] },
  } as never)
  const onOpenPackage = vi.fn()
  const { unmount } = render(<SourceBrowser conn={conn} onPick={vi.fn()} onOpenPackage={onOpenPackage} />)
  fireEvent.click(await screen.findByText('这是什么包'))
  expect(onOpenPackage).toHaveBeenCalledWith('rsshub')
  unmount()

  render(<SourceBrowser conn={conn} onPick={vi.fn()} />)
  await screen.findAllByText('RSSHub')
  expect(screen.queryByText('这是什么包')).toBeNull()
})

it('停用的包在左栏有只读标记 —— 不说的话用户会以为自己配的源坏了', async () => {
  vi.spyOn(api, 'plugins').mockResolvedValue([
    { id: 'rsshub', name: 'RSSHub', capabilities: [], sourceCount: 1, status: 'ready', enabled: true, required: true, launch: { mode: 'builtin' } } as never,
    { id: 'mineru', name: 'MinerU', capabilities: [], sourceCount: 0, status: 'disabled', enabled: false, required: false, launch: { mode: 'external' } } as never,
  ])
  vi.spyOn(api, 'pluginSources').mockResolvedValue({
    plugin: { id: 'rsshub', sourceGrouping: { enabled: false, resolver: '' } } as never,
    sources: [], groups: [], facets: { categories: [], capabilities: [], facilities: [] },
  } as never)
  render(<SourceBrowser conn={conn} onPick={vi.fn()} />)
  expect(await screen.findByText('已停用')).toBeTruthy()
})
