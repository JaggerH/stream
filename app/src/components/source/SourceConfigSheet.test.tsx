import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { SourceConfigSheet } from './SourceConfigSheet.tsx'
import { api } from '../../lib/api.ts'
import { PreviewContext } from '../../lib/previewStage.ts'
import type { ProviderView, SourceDetail } from '../../lib/types.ts'

const conn = { baseUrl: '', token: undefined } as const
const source = { id: 'rsshub:foo', pluginId: 'rsshub', pluginName: 'RSSHub', title: 'Foo', categories: [], capabilities: ['timeline'], auth: 'none', paramCount: 0, requiredParamCount: 0, paramsSchema: {} } as unknown as SourceDetail
// SourceConfigSheet uses usePreview() (its live-preview trigger); in the app it renders inside
// App.tsx's PreviewContext.Provider. Tests render it in isolation, so supply the same context.
const Wrapper = ({ children }: { children: ReactNode }) => (
  <PreviewContext.Provider value={{ openPreview: vi.fn() }}>{children}</PreviewContext.Provider>
)
beforeEach(() => vi.restoreAllMocks())

it('edit-member target shows params only, no role picker, and PATCHes on save', async () => {
  const spy = vi.spyOn(api, 'patchProvider').mockResolvedValue({} as never)
  const provider = { id: 'p1', label: 'P1', variant: 'search', serves: [], strategy: 'concurrent', status: 'live', callSites: [], members: [{ source: 'foo', params: { a: '1' } }], resolvedMembers: [{ name: 'foo', priority: 1, health: 'unknown', source }], calls: { total: 0, byMember: {}, lastCalledAt: null }, options: {} } as never
  render(<SourceConfigSheet open onOpenChange={() => {}} conn={conn} source={source} target={{ kind: 'provider', providerId: 'p1', memberIndex: 0 }} streams={[]} providers={[provider]} channels={[]} initialParams={{ a: '1' }} onSubmitted={() => {}} />, { wrapper: Wrapper })
  expect(screen.queryByText('频道')).toBeNull()   // no create-stream channel picker on an edit target
  fireEvent.click(screen.getByRole('button', { name: /保存|加入|添加/ }))
  await waitFor(() => expect(spy).toHaveBeenCalled())
})

it('renders a description section: param reference + a per-field info HoverCard trigger', async () => {
  const withDocs = { ...source, paramsSchema: { uid: { required: true, description: '用户主页 URL 里的 uid' } } } as unknown as SourceDetail
  render(<SourceConfigSheet open onOpenChange={() => {}} conn={conn} source={withDocs} target={{ kind: 'provider', providerId: 'p1', memberIndex: 0 }} streams={[]} providers={[]} channels={[]} />, { wrapper: Wrapper })
  // the Sheet's direct param reference is kept (both places explain the field)
  expect(await screen.findByText('参数')).toBeTruthy()
  expect(screen.getByText('用户主页 URL 里的 uid')).toBeTruthy()
  // the input field no longer dumps the desc inline — it exposes an info trigger instead
  expect(screen.getByRole('button', { name: 'uid 说明' })).toBeTruthy()
})

// perInstance 源（llm-openai）：一个源带不同 params 多次进同一条梯子，每个实例自带端点+模型+key。
const llmSource = {
  id: 'llm-openai', pluginId: 'builtin', pluginName: 'Builtin', title: 'OpenAI 兼容 LLM', categories: [],
  capabilities: ['anchor'], auth: 'none', paramCount: 2, requiredParamCount: 2,
  paramsSchema: {
    baseUrl: { type: 'string', required: true, description: '端点' },
    model: { type: 'string', required: true, description: '模型' },
  },
  runtimeConfig: { ref: 'llm-openai', perInstance: true, fields: { apiKey: { type: 'secret', label: 'API Key', required: true } } },
} as unknown as SourceDetail
const llmProvider = { id: 'llm', label: 'LLM', variant: 'llm', serves: ['*'], strategy: 'sequential', status: 'live', callSites: [], members: [], resolvedMembers: [], calls: { total: 0, byMember: {}, lastCalledAt: null }, options: {} } as never

it('perInstance 源加进梯子：必须起实例名，key 写到 llm:<实例名>，成员带上 name + tokenName', async () => {
  const patch = vi.spyOn(api, 'patchProvider').mockResolvedValue({} as never)
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ values: {}, secrets: { apiKey: { configured: false } } }) })
  vi.stubGlobal('fetch', fetchMock)
  render(<SourceConfigSheet open onOpenChange={() => {}} conn={conn} source={llmSource} target={{ kind: 'provider', providerId: 'llm' }} streams={[]} providers={[llmProvider]} channels={[]} />, { wrapper: Wrapper })

  fireEvent.change(screen.getByLabelText('baseUrl *'), { target: { value: 'https://k/v1' } })
  fireEvent.change(screen.getByLabelText('model *'), { target: { value: 'k2' } })
  fireEvent.change(screen.getByLabelText('API Key *'), { target: { value: 'sek' } })

  // 实例名必填：空着直接存 → 报错，且一个请求都不发
  fireEvent.click(screen.getByRole('button', { name: /添加|保存/ }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('实例名'))
  expect(patch).not.toHaveBeenCalled()

  fireEvent.change(screen.getByLabelText('实例名 *'), { target: { value: 'kimi' } })
  fireEvent.click(screen.getByRole('button', { name: /添加|保存/ }))

  await waitFor(() => expect(patch).toHaveBeenCalled())
  const put = fetchMock.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'PUT')!
  // key 落到这个实例自己的 ref —— 不是 manifest 的共享 ref
  expect(JSON.parse((put[1] as { body: string }).body)).toMatchObject({ ref: 'llm:kimi', values: { apiKey: 'sek' } })
  expect(patch.mock.calls[0][2]).toEqual({ members: [
    { source: 'llm-openai', name: 'kimi', params: { baseUrl: 'https://k/v1', model: 'k2', tokenName: 'llm:kimi' } },
  ] })
})

it('成员写入失败 → key 一个字都不落盘（实例名撞车时不能先把对方的凭据覆盖掉）', async () => {
  const patch = vi.spyOn(api, 'patchProvider').mockRejectedValue(new Error('duplicate member name: kimi'))
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ values: {}, secrets: { apiKey: { configured: false } } }) })
  vi.stubGlobal('fetch', fetchMock)
  render(<SourceConfigSheet open onOpenChange={() => {}} conn={conn} source={llmSource} target={{ kind: 'provider', providerId: 'llm' }} streams={[]} providers={[llmProvider]} channels={[]} />, { wrapper: Wrapper })

  fireEvent.change(screen.getByLabelText('baseUrl *'), { target: { value: 'https://k/v1' } })
  fireEvent.change(screen.getByLabelText('model *'), { target: { value: 'k2' } })
  fireEvent.change(screen.getByLabelText('实例名 *'), { target: { value: 'kimi' } })
  fireEvent.change(screen.getByLabelText('API Key *'), { target: { value: 'sek' } })
  fireEvent.click(screen.getByRole('button', { name: /添加|保存/ }))

  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('duplicate member name'))
  // key 写入排在成员 PATCH **之后**：PATCH 没过 → 一次 PUT 都不该发出去
  expect(fetchMock.mock.calls.some((c) => (c[1] as { method?: string } | undefined)?.method === 'PUT')).toBe(false)
  expect(patch).toHaveBeenCalled()
})

it('成员建好但 key 写入失败 → 明说"成员已建、key 未存"，不装成功', async () => {
  vi.spyOn(api, 'patchProvider').mockResolvedValue({} as never)
  const fetchMock = vi.fn().mockImplementation((_url: string, init?: { method?: string }) =>
    init?.method === 'PUT'
      ? Promise.resolve({ ok: false, status: 500, json: async () => ({}) })
      : Promise.resolve({ ok: true, json: async () => ({ values: {}, secrets: { apiKey: { configured: false } } }) }))
  vi.stubGlobal('fetch', fetchMock)
  const onOpenChange = vi.fn()
  render(<SourceConfigSheet open onOpenChange={onOpenChange} conn={conn} source={llmSource} target={{ kind: 'provider', providerId: 'llm' }} streams={[]} providers={[llmProvider]} channels={[]} />, { wrapper: Wrapper })

  fireEvent.change(screen.getByLabelText('baseUrl *'), { target: { value: 'https://k/v1' } })
  fireEvent.change(screen.getByLabelText('model *'), { target: { value: 'k2' } })
  fireEvent.change(screen.getByLabelText('实例名 *'), { target: { value: 'kimi' } })
  fireEvent.change(screen.getByLabelText('API Key *'), { target: { value: 'sek' } })
  fireEvent.click(screen.getByRole('button', { name: /添加|保存/ }))

  const alert = await screen.findByRole('alert')
  await waitFor(() => expect(alert.textContent).toContain('key 未保存'))
  expect(onOpenChange).not.toHaveBeenCalledWith(false) // 别关掉——关了就等于说成功了
})

it('memberWritten 不跨会话泄漏：换了个新源/新目的地后必须真发成员写入', async () => {
  const patch = vi.spyOn(api, 'patchProvider').mockResolvedValue({} as never)
  const onOpenChange = vi.fn()
  const sourceA = { id: 'src-a', pluginId: 'rsshub', pluginName: 'RSSHub', title: 'A', categories: [], capabilities: [], auth: 'none', paramCount: 0, requiredParamCount: 0, paramsSchema: {} } as unknown as SourceDetail
  const sourceB = { id: 'src-b', pluginId: 'rsshub', pluginName: 'RSSHub', title: 'B', categories: [], capabilities: [], auth: 'none', paramCount: 0, requiredParamCount: 0, paramsSchema: {} } as unknown as SourceDetail
  const providerA = { id: 'p1', label: 'P1', variant: 'search', serves: [], strategy: 'concurrent', status: 'live', callSites: [], members: [], resolvedMembers: [], calls: { total: 0, byMember: {}, lastCalledAt: null }, options: {} } as never
  const providerB = { id: 'p2', label: 'P2', variant: 'search', serves: [], strategy: 'concurrent', status: 'live', callSites: [], members: [], resolvedMembers: [], calls: { total: 0, byMember: {}, lastCalledAt: null }, options: {} } as never

  // PluginPanel.tsx 挂载模式的复现：同一个 <SourceConfigSheet> 实例先后配置两个不同的源，中间只翻
  // open（不清 picked，不remount）——这里用 rerender 模拟同一份 React 树。
  const { rerender } = render(
    <SourceConfigSheet open onOpenChange={onOpenChange} conn={conn} source={sourceA} target={{ kind: 'provider', providerId: 'p1' }} streams={[]} providers={[providerA]} channels={[]} onSubmitted={() => {}} />,
    { wrapper: Wrapper })
  fireEvent.click(screen.getByRole('button', { name: /保存|加入|添加/ }))
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
  expect(onOpenChange).toHaveBeenCalledWith(false) // sourceA 无 runtimeConfig，成员写完直接算完整成功

  // 模拟 PluginPanel：先把 open 翻回 false（sheetOpen=false，picked 没清），再翻回 true 并换成新源/新目的地
  rerender(<SourceConfigSheet open={false} onOpenChange={onOpenChange} conn={conn} source={sourceA} target={{ kind: 'provider', providerId: 'p1' }} streams={[]} providers={[providerA]} channels={[]} onSubmitted={() => {}} />)
  rerender(<SourceConfigSheet open onOpenChange={onOpenChange} conn={conn} source={sourceB} target={{ kind: 'provider', providerId: 'p2' }} streams={[]} providers={[providerB]} channels={[]} onSubmitted={() => {}} />)

  fireEvent.click(screen.getByRole('button', { name: /保存|加入|添加/ }))
  // 第二个源必须真的发起了成员写入——不能因为上一份会话已经 memberWritten=true 就被静默跳过
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
  expect(patch.mock.calls[1][1]).toBe('p2')
})

it('半成功后原地重存：跳过成员写入(不再撞 append 重名)，只重试 key 写入', async () => {
  const patch = vi.spyOn(api, 'patchProvider').mockResolvedValue({} as never)
  let putCalls = 0
  const fetchMock = vi.fn().mockImplementation((_url: string, init?: { method?: string }) => {
    if (init?.method === 'PUT') {
      putCalls += 1
      // 第一次 PUT 失败(半成功)，第二次(原地重存)成功
      return putCalls === 1
        ? Promise.resolve({ ok: false, status: 500, json: async () => ({}) })
        : Promise.resolve({ ok: true, json: async () => ({ values: {}, secrets: { apiKey: { configured: true } } }) })
    }
    return Promise.resolve({ ok: true, json: async () => ({ values: {}, secrets: { apiKey: { configured: false } } }) })
  })
  vi.stubGlobal('fetch', fetchMock)
  const onOpenChange = vi.fn()
  render(<SourceConfigSheet open onOpenChange={onOpenChange} conn={conn} source={llmSource} target={{ kind: 'provider', providerId: 'llm' }} streams={[]} providers={[llmProvider]} channels={[]} onSubmitted={() => {}} />, { wrapper: Wrapper })

  fireEvent.change(screen.getByLabelText('baseUrl *'), { target: { value: 'https://k/v1' } })
  fireEvent.change(screen.getByLabelText('model *'), { target: { value: 'k2' } })
  fireEvent.change(screen.getByLabelText('实例名 *'), { target: { value: 'kimi' } })
  fireEvent.change(screen.getByLabelText('API Key *'), { target: { value: 'sek' } })
  fireEvent.click(screen.getByRole('button', { name: /添加|保存/ }))

  const alert = await screen.findByRole('alert')
  await waitFor(() => expect(alert.textContent).toContain('key 未保存'))
  expect(patch).toHaveBeenCalledTimes(1)

  // 用户不换任何字段，原地再点一次保存
  fireEvent.click(screen.getByRole('button', { name: /添加|保存/ }))

  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  // 成员写入没有被重放——还是只有第一次那一次，不会撞 duplicate member name
  expect(patch).toHaveBeenCalledTimes(1)
  expect(putCalls).toBe(2)
})

it('改实例名不冲掉已输入未保存的 key', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ values: {}, secrets: { apiKey: { configured: false } } }) })
  vi.stubGlobal('fetch', fetchMock)
  render(<SourceConfigSheet open onOpenChange={() => {}} conn={conn} source={llmSource} target={{ kind: 'provider', providerId: 'llm' }} streams={[]} providers={[llmProvider]} channels={[]} />, { wrapper: Wrapper })

  fireEvent.change(screen.getByLabelText('实例名 *'), { target: { value: 'kim' } })
  const key = screen.getByLabelText('API Key *') as HTMLInputElement
  fireEvent.change(key, { target: { value: 'sek' } })
  fireEvent.change(screen.getByLabelText('实例名 *'), { target: { value: 'kimi' } })
  // 换名会重拉这一档的状态；重拉的响应里没有 secret（后端从不回显），别拿它把用户刚敲的 key 抹掉
  await waitFor(() => expect(fetchMock.mock.calls.some((c) => JSON.parse((c[1] as { body: string }).body).ref === 'llm:kimi')).toBe(true))
  expect((screen.getByLabelText('API Key *') as HTMLInputElement).value).toBe('sek')
})

it('perInstance 源实例名非法（空格/斜杠）→ 拦在前端，不发请求', async () => {
  const patch = vi.spyOn(api, 'patchProvider').mockResolvedValue({} as never)
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ values: {}, secrets: {} }) })
  vi.stubGlobal('fetch', fetchMock)
  render(<SourceConfigSheet open onOpenChange={() => {}} conn={conn} source={llmSource} target={{ kind: 'provider', providerId: 'llm' }} streams={[]} providers={[llmProvider]} channels={[]} />, { wrapper: Wrapper })
  fireEvent.change(screen.getByLabelText('baseUrl *'), { target: { value: 'https://k/v1' } })
  fireEvent.change(screen.getByLabelText('model *'), { target: { value: 'k2' } })
  fireEvent.change(screen.getByLabelText('实例名 *'), { target: { value: 'a/b c' } })
  fireEvent.click(screen.getByRole('button', { name: /添加|保存/ }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('实例名'))
  expect(patch).not.toHaveBeenCalled()
})

it('编辑已有实例：实例名回显且不可改（改了就与已存的 key 对不上）', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ values: {}, secrets: { apiKey: { configured: true } } }) })
  vi.stubGlobal('fetch', fetchMock)
  render(<SourceConfigSheet open onOpenChange={() => {}} conn={conn} source={llmSource} target={{ kind: 'provider', providerId: 'llm', memberIndex: 0 }}
    initialParams={{ baseUrl: 'https://k/v1', model: 'k2', tokenName: 'llm:kimi' }} streams={[]} providers={[llmProvider]} channels={[]} />, { wrapper: Wrapper })
  const input = await screen.findByLabelText('实例名 *') as HTMLInputElement
  expect(input.value).toBe('kimi')
  expect(input.disabled).toBe(true)
  // 状态查询按这个实例的 ref 走，否则显示的是别人的「已配 key」
  await waitFor(() => expect(fetchMock.mock.calls.some((c) => JSON.parse((c[1] as { body: string }).body).ref === 'llm:kimi')).toBe(true))
})

it('pick target renders the destination selector', async () => {
  render(<SourceConfigSheet open onOpenChange={() => {}} conn={conn} source={source} target={{ kind: 'pick' }} streams={[]} providers={[]} channels={[]} />, { wrapper: Wrapper })
  expect(await screen.findByText('加到哪里')).toBeTruthy()
})

it('pick destination uses a searchable Combobox trigger (not a plain Select)', async () => {
  render(<SourceConfigSheet open onOpenChange={() => {}} conn={conn} source={source} target={{ kind: 'pick' }} streams={[]} providers={[]} channels={[]} />, { wrapper: Wrapper })
  // the acrylic Combobox renders a role=combobox trigger showing the placeholder;
  // the search box only mounts on open (Radix Popover), so we assert the trigger here.
  const trigger = await screen.findByRole('combobox')
  expect(trigger.textContent).toContain('选择目的地')
})

// 必填判据要和执行时同一个口径：部署环境变量兜得住的格（status.envFallback）空着也能跑，不能拦；
// 兜不住的照拦。缺这一条的表现是只靠环境变量配好的用户在面板里存不了盘（活体 2026-09-26，Cloudflare accountId）。
describe('必填的 runtime_config 格 × 部署环境变量', () => {
  const cfSource = {
    id: 'cf-whisper', pluginId: 'cloudflare', pluginName: 'Cloudflare', title: 'CF', categories: [], capabilities: ['anchor'],
    auth: 'none', paramCount: 0, requiredParamCount: 0, paramsSchema: {},
    runtimeConfig: { ref: 'cloudflare', fields: {
      apiKey: { type: 'secret', label: 'Token' },
      accountId: { type: 'string', label: 'Account ID', required: true },
    } },
  } as unknown as SourceDetail
  const tProvider = { id: 'transcribe', label: 'T', variant: 'transcribe', serves: ['*'], strategy: 'sequential', status: 'live', callSites: [], members: [], resolvedMembers: [], calls: { total: 0, byMember: {} } } as unknown as ProviderView
  const statusWith = (envFallback: string[]) => vi.fn().mockImplementation((_url: string, init?: { method?: string }) =>
    Promise.resolve({ ok: true, json: async () => (init?.method === 'PUT' ? {} : { values: {}, secrets: { apiKey: { configured: false } }, provisioner: null, envFallback }) }))

  it('环境变量兜得住 → 空着也放行', async () => {
    const patch = vi.spyOn(api, 'patchProvider').mockResolvedValue({} as never)
    vi.stubGlobal('fetch', statusWith(['accountId']))
    render(<SourceConfigSheet open onOpenChange={() => {}} conn={conn} source={cfSource} target={{ kind: 'provider', providerId: 'transcribe' }} streams={[]} providers={[tProvider]} channels={[]} />, { wrapper: Wrapper })
    await new Promise((r) => setTimeout(r, 350)) // 状态查询有 300ms 防抖
    fireEvent.click(screen.getByRole('button', { name: /添加|保存/ }))
    await waitFor(() => expect(patch).toHaveBeenCalled())
  })

  it('环境变量兜不住 → 照拦，一个写请求都不发', async () => {
    const patch = vi.spyOn(api, 'patchProvider').mockResolvedValue({} as never)
    vi.stubGlobal('fetch', statusWith([]))
    render(<SourceConfigSheet open onOpenChange={() => {}} conn={conn} source={cfSource} target={{ kind: 'provider', providerId: 'transcribe' }} streams={[]} providers={[tProvider]} channels={[]} />, { wrapper: Wrapper })
    await new Promise((r) => setTimeout(r, 350))
    fireEvent.click(screen.getByRole('button', { name: /添加|保存/ }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Account ID'))
    expect(patch).not.toHaveBeenCalled()
  })
})
