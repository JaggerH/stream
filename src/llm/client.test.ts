import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildSummaryMessages, chatCompletion, DEFAULT_SUMMARY_PROMPT, type ChatEndpoint } from './client.ts'

const ep: ChatEndpoint = { baseUrl: 'https://relay.test/v1', apiKey: 'sek', model: 'gpt-x' }

function mockFetch(json: unknown, ok = true, status = 200) {
  const fn = vi.fn((..._args: unknown[]) => Promise.resolve({
    ok, status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  }))
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

// 摘要的**发送**归梯子（llm/task.ts summarizeViaLlm），这里只剩"prompt 怎么拼成 messages"。
describe('buildSummaryMessages', () => {
  it('转写正文进 user，prompt + 输出语言进 system', () => {
    const msgs = buildSummaryMessages('原始转写文本', '只要数字', 'en')
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('只要数字')
    expect(msgs[0].content).toContain('English')
    expect(msgs[1]).toEqual({ role: 'user', content: '原始转写文本' })
  })

  it('prompt 空 → 用默认；语言缺省 → 中文', () => {
    const sys = buildSummaryMessages('t', undefined)[0].content
    expect(sys).toContain(DEFAULT_SUMMARY_PROMPT)
    expect(sys).toContain('中文')
    expect(buildSummaryMessages('t', '   ')[0].content).toContain(DEFAULT_SUMMARY_PROMPT)
  })
})

describe('chatCompletion', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('POSTs messages verbatim and returns content + raw; passes tools/temperature through', async () => {
    const fn = mockFetch({ choices: [{ message: { content: 'hi' } }] })
    const tools = [{ type: 'function', function: { name: 'f' } }]
    const r = await chatCompletion([{ role: 'user', content: 'q' }], ep, { tools, temperature: 0.7 })
    expect(r.content).toBe('hi')
    expect(r.raw).toEqual({ choices: [{ message: { content: 'hi' } }] })
    const body = JSON.parse((fn.mock.calls[0][1] as { body: string }).body) as {
      model: string; temperature: number; tools: unknown[]; messages: unknown[]
    }
    expect(body.model).toBe('gpt-x')
    expect(body.temperature).toBe(0.7)
    expect(body.tools).toEqual(tools)
    expect(body.messages).toEqual([{ role: 'user', content: 'q' }])
  })

  it('throws with the HTTP status on a non-ok response', async () => {
    mockFetch({ error: 'boom' }, false, 500)
    await expect(chatCompletion([{ role: 'user', content: 'q' }], ep)).rejects.toThrow(/500/)
  })

  it('returns content null (not throw) when choices are empty', async () => {
    const r = await (async () => {
      mockFetch({ choices: [] })
      return chatCompletion([{ role: 'user', content: 'q' }], ep)
    })()
    expect(r.content).toBeNull()
    expect(r.toolCalls).toBeUndefined()
  })

  it('surfaces tool_calls with null content on a tool-only turn', async () => {
    const toolCalls = [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{}' } }]
    mockFetch({ choices: [{ message: { content: null, tool_calls: toolCalls } }] })
    const r = await chatCompletion([{ role: 'user', content: 'q' }], ep)
    expect(r.content).toBeNull()
    expect(r.toolCalls).toEqual(toolCalls)
  })
})
