import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { it, expect, vi, beforeEach, describe } from 'vitest'
import type { ReactNode } from 'react'
import { SourceConfigSheet } from './SourceConfigSheet.tsx'
import { PreviewContext } from '../../lib/previewStage.ts'
import type { SourceDetail } from '../../lib/types.ts'

// 「自助申请」那条链的前端一侧。三条各钉一件事：按钮凭什么出现、两颗按钮各自去哪。
// **字符串 groq 只出现在夹具里**——组件里没有任何一处认识它，判据全在后端算好的 provisioner。

const conn = { baseUrl: '', token: undefined } as const
const Wrapper = ({ children }: { children: ReactNode }) => (
  <PreviewContext.Provider value={{ openPreview: vi.fn() }}>{children}</PreviewContext.Provider>
)

const source = {
  id: 'groq-transcribe', pluginId: 'groq', pluginName: 'Groq', title: 'Groq 转写', categories: [],
  capabilities: ['anchor'], auth: 'none', paramCount: 0, requiredParamCount: 0, paramsSchema: {},
  runtimeConfig: { ref: 'groq', fields: { apiKey: { type: 'secret', label: 'Groq API Key', helpUrl: 'https://console.groq.com/keys' } } },
} as unknown as SourceDetail

const PROVISIONER = {
  sourceId: '@streamapp/groq/groq-create-key',
  field: 'apiKey',
  entryUrl: 'https://console.groq.com/keys',
  label: 'Groq',
  paramsSchema: { name: { type: 'string', required: true, description: 'key 名' } },
}

const statusBody = (over: Record<string, unknown> = {}) => ({
  values: {}, secrets: { apiKey: { configured: false } }, provisioner: PROVISIONER, ...over,
})

/** 把 status / provision 两条路分开答；返回 fetch mock 好断言发了什么。 */
const mockBackend = (provision?: { ok: boolean; body: unknown }) => {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith('/provision')) {
      return { ok: provision?.ok ?? true, status: provision?.ok === false ? 502 : 200, json: async () => provision?.body ?? statusBody({ secrets: { apiKey: { configured: true } } }) }
    }
    return { ok: true, status: 200, json: async () => statusBody() }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const open = () => render(
  <SourceConfigSheet open onOpenChange={() => {}} conn={conn} source={source}
    target={{ kind: 'provider', providerId: 'p1', memberIndex: 0 }} streams={[]} providers={[]} channels={[]} />,
  { wrapper: Wrapper },
)

beforeEach(() => vi.restoreAllMocks())

describe('配置卡上的自助申请入口', () => {
  it('后端说有人能填这一格 → 出按钮，并且当场把引导弹窗提出来', async () => {
    mockBackend()
    open()
    // 「需要这把 key 但还没有」这一刻才提——不是打开 Sheet 就提（那时还不知道缺不缺）。
    expect(await screen.findByRole('button', { name: /一键帮我完成/ })).toBeTruthy()
    expect(screen.getByText(/会动你的 Groq 账号/)).toBeTruthy()
  })

  it('后端说没人能填（provisioner: null）→ 一颗按钮都不出，只剩今天那条外链', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => statusBody({ provisioner: null }) })))
    open()
    expect(await screen.findByText('前往申请')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('button', { name: /一键帮我完成/ })).toBeNull())
    expect(screen.queryByRole('button', { name: /一键帮我申请/ })).toBeNull()
  })

  it('「我自己去注册」= manifest 的 helpUrl 外链，不打后端', async () => {
    const fetchMock = mockBackend()
    open()
    const self = await screen.findByRole('link', { name: /我自己去注册/ })
    expect(self.getAttribute('href')).toBe('https://console.groq.com/keys')
    expect(self.getAttribute('target')).toBe('_blank')
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/provision'))).toBe(false)
  })

  it('「一键帮我完成」= POST provision（带这张卡的身份，不带 sourceId 让前端挑 recipe），成功后那一格变成已配置', async () => {
    const fetchMock = mockBackend()
    open()
    fireEvent.click(await screen.findByRole('button', { name: /一键帮我完成/ }))

    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/provision'))).toBe(true))
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/provision'))!
    // mock 的调用签名是 `[url]`（fetch 的第二个参数在类型上不存在），所以要先过 unknown 再断言——
    // 直接 `call[1] as {body:string}` 过不了 tsc（TS2493/TS2352），而这条 red 是静默的：
    // vitest 不跑 tsc，`npm run typecheck` 才看得见。
    const body = JSON.parse(((call as unknown as [string, { body: string }])[1]).body)
    // 身份是**这张配置卡**的，不是那条 recipe 的——该跑哪条留给后端反查。
    expect(body).toMatchObject({ pluginId: 'groq', sourceId: 'groq-transcribe' })
    expect(body).not.toHaveProperty('recipeId')
    expect(body.sourceId).not.toContain('create-key')
    // 不幂等：名字带一段现生成的后缀，不是写死的常量。
    expect(body.params.name).toMatch(/^stream-auto-[0-9a-f]{4}$/)
    // 成功回执直接铺回界面：配置卡上那一格当场变成「留空保持不变」，不用再打一发去问。
    expect(await screen.findByText(/留空保持不变/)).toBeTruthy()
  })

  it('失败 → 原文留在弹窗里（含 failures/ 那条线索），不当成功关掉', async () => {
    mockBackend({ ok: false, body: { error: '跑完了，但没能从 Groq 的页面上抠到 apiKey——失败现场看 failures/' } })
    open()
    fireEvent.click(await screen.findByRole('button', { name: /一键帮我完成/ }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('failures/')
    // 弹窗还在，下一步（重试 / 转去自己注册）都还够得着。
    expect(screen.getByRole('link', { name: /我自己去注册/ })).toBeTruthy()
  })
})
