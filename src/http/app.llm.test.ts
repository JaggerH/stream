// 从 app.test.ts 拆出(2026-07-22):按路由域分文件,理由见 __fixtures__/app-harness.ts 头注。

import { describe, it, expect } from 'vitest'
import { createHttpApp } from './app.ts'

describe('摘要 prompt 路由', () => {
  const baseStubs = {
    service: { streamsResource: () => [] },
    itemStore: { get: () => undefined },
    health: async () => ({ cookies: { domains: [], updatedAt: null }, manifests: 0, streams: 0 }),
  } as never

  // LLM 的连接/模型配置已经收口到 Providers 页（成员实例 + 调用点绑定），settings 里只剩
  // 摘要 prompt 这一个字段，端点跟着收窄成 /api/settings/summary-prompt。
  it('GET/PUT /api/settings/summary-prompt round-trips prompt + 梯子就绪状态', async () => {
    let prompt = ''
    const app = createHttpApp({
      ...(baseStubs as object),
      summaryPrompt: {
        status: () => ({ prompt, configured: true }),
        set: (next: string) => { prompt = next; return { prompt, configured: true } },
      },
    } as never)
    const put = await app.request('/api/settings/summary-prompt', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '用中文总结' }),
    })
    expect(await put.json()).toEqual({ prompt: '用中文总结', configured: true })
    const get = await app.request('/api/settings/summary-prompt')
    expect(await get.json()).toEqual({ prompt: '用中文总结', configured: true })
  })

  it('PUT 400s when prompt is not a string', async () => {
    const app = createHttpApp({
      ...(baseStubs as object),
      summaryPrompt: { status: () => ({ prompt: '', configured: false }), set: () => ({ prompt: '', configured: false }) },
    } as never)
    const r = await app.request('/api/settings/summary-prompt', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 42 }),
    })
    expect(r.status).toBe(400)
  })

  it('旧的 /api/settings/llm 已下线（连接配置只在 Providers 页写）', async () => {
    const app = createHttpApp({ ...(baseStubs as object) } as never)
    expect((await app.request('/api/settings/llm')).status).toBe(404)
    expect((await app.request('/api/settings/llm', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connections: [] }),
    })).status).toBe(404)
  })
})
