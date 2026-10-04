import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeLlmOpenAiFn, type LlmChatInput } from './sources.ts'

const input: LlmChatInput = { messages: [{ role: 'user', content: 'q' }], model: 'gpt-x' }

function mockFetch(json: unknown) {
  const fn = vi.fn((..._args: unknown[]) =>
    Promise.resolve({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) })
  )
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

// 成员只有**一种**形状：自己带 baseUrl + model，key 经 params.tokenName 从 TokenProvider 取。
// 这里曾经还测过一支 `connectionId` 分支（去 LlmSettings 的连接表里查端点和 key）。同一件事两种
// 形状 = 两个真相源，"设置页配好了却报 LLM 未配置"就是那么来的；整条腿已退役。
describe('makeLlmOpenAiFn', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('成员自带端点+模型，key 经 token() 取 → 直打 /chat/completions', async () => {
    const fn = mockFetch({ choices: [{ message: { content: 'hi' } }] })
    const out = await makeLlmOpenAiFn({ token: (n) => (n === 'llm:a' ? 'sk-x' : null) })(
      input,
      { baseUrl: 'https://x/v1', model: 'm', tokenName: 'llm:a' },
    )
    expect(out).toHaveLength(1)
    expect((out[0] as { content: string }).content).toBe('hi')
    expect(fn.mock.calls[0][0]).toBe('https://x/v1/chat/completions')
    expect((fn.mock.calls[0][1] as { headers: Record<string, string> }).headers.authorization).toBe('Bearer sk-x')
  })

  it('缺 key → decline，且**不发请求**（decline 要便宜，不能靠对面报错）', async () => {
    const fn = mockFetch({})
    const out = await makeLlmOpenAiFn({ token: () => null })(input, { baseUrl: 'https://x/v1', model: 'm', tokenName: 'llm:missing' })
    expect(out).toEqual([])
    expect(fn).not.toHaveBeenCalled()
  })

  it('缺 baseUrl → decline（成员不自带端点就没有别处可查了）', async () => {
    const fn = mockFetch({})
    const out = await makeLlmOpenAiFn({ token: () => 'sk-x' })(input, { model: 'm', tokenName: 'llm:a' })
    expect(out).toEqual([])
    expect(fn).not.toHaveBeenCalled()
  })

  it('缺 model → decline', async () => {
    const out = await makeLlmOpenAiFn({ token: () => 'sk-x' })(
      { messages: input.messages },
      { baseUrl: 'https://x/v1', tokenName: 'llm:a' },
    )
    expect(out).toEqual([])
  })

  it('input 没给 model 时用成员自己的默认', async () => {
    const fn = mockFetch({ choices: [{ message: { content: 'ok' } }] })
    await makeLlmOpenAiFn({ token: () => 'sk-x' })(
      { messages: input.messages },
      { baseUrl: 'https://x/v1', model: 'from-params', tokenName: 'llm:a' },
    )
    const body = JSON.parse((fn.mock.calls[0][1] as { body: string }).body) as { model: string }
    expect(body.model).toBe('from-params')
  })

  it('input.model 赢过成员默认', async () => {
    const fn = mockFetch({ choices: [{ message: { content: 'ok' } }] })
    await makeLlmOpenAiFn({ token: () => 'sk-x' })(
      input, // input.model = 'gpt-x'
      { baseUrl: 'https://x/v1', model: 'from-params', tokenName: 'llm:a' },
    )
    const body = JSON.parse((fn.mock.calls[0][1] as { body: string }).body) as { model: string }
    expect(body.model).toBe('gpt-x')
  })

  it('没有 messages → decline（没东西可发）', async () => {
    const fn = mockFetch({})
    const out = await makeLlmOpenAiFn({ token: () => 'sk-x' })({ messages: [] }, { baseUrl: 'https://x/v1', model: 'm', tokenName: 'llm:a' })
    expect(out).toEqual([])
    expect(fn).not.toHaveBeenCalled()
  })
})
