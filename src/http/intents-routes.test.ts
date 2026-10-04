// src/http/intents-routes.test.ts
// HTTP 面 /api/intents*——立/列/档案/招源/消化/退休。deps.intents 缺席 → 全部 503（与 seenStore 同款约定）。
import { describe, it, expect, vi } from 'vitest'
import { createHttpApp } from './app.ts'
import type { IntentRecord, DigestOutcome } from '../intent/types.ts'

function rec(over: Partial<IntentRecord> = {}): IntentRecord & { ledgerCount: number } {
  return {
    id: 'in_1',
    goal: '盯 AI 硬件',
    criteria: '发布/评测新硬件',
    streamIds: [],
    cadenceHours: 24,
    status: 'active',
    createdAt: 0,
    ledgerCount: 0,
    ...over,
  }
}

function fakeIntents(over: Partial<{
  create: unknown; list: unknown; get: unknown; dossier: unknown
  recruit: unknown; digestNow: unknown; retire: unknown
}> = {}) {
  return {
    create: vi.fn(async () => rec()),
    list: vi.fn(() => [rec()]),
    get: vi.fn((id: string) => (id === 'in_1' ? rec() : null)),
    dossier: vi.fn((id: string) => (id === 'in_1' ? '# 档案\n\n正文' : null)),
    recruit: vi.fn(async () => ({ subscribed: [{ streamId: 's1', sourceId: 'src-a' }], reused: [], dropped: 2 })),
    digestNow: vi.fn(async () => ({ judged: 3, relevantNew: 1, errors: 0 }) as DigestOutcome),
    retire: vi.fn((id: string) => (id === 'in_1' ? rec({ status: 'retired' }) : null)),
    ...over,
  }
}

const stubs = { itemStore: { get: () => undefined }, service: { streamsResource: () => [] }, health: async () => ({}) } as never

function build(intents: unknown) {
  return createHttpApp({ ...(stubs as object), intents } as never)
}

describe('POST /api/intents', () => {
  it('201，body 带 fake service 给的 criteria', async () => {
    const intents = fakeIntents()
    const app = build(intents)
    const res = await app.request('/api/intents', { method: 'POST', body: JSON.stringify({ goal: '盯 AI 硬件' }) })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { criteria: string }
    expect(body.criteria).toBe('发布/评测新硬件')
  })

  it('service.create 抛 LLM 未配置 → 500 upstream_error（LLM/落盘失败非参数错）', async () => {
    const intents = fakeIntents({ create: vi.fn(async () => { throw new Error('LLM 未配置') }) })
    const app = build(intents)
    const res = await app.request('/api/intents', { method: 'POST', body: JSON.stringify({ goal: 'x' }) })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('upstream_error')
  })

  it('goal 缺失/空串 → 400 validation_error（F7）', async () => {
    const intents = fakeIntents()
    const app = build(intents)
    const res1 = await app.request('/api/intents', { method: 'POST', body: JSON.stringify({}) })
    expect(res1.status).toBe(400)
    const res2 = await app.request('/api/intents', { method: 'POST', body: JSON.stringify({ goal: '   ' }) })
    expect(res2.status).toBe(400)
  })

  it('recruit: true → 201 且响应带 recruited（招源结果同步返回，F7）', async () => {
    const intents = fakeIntents()
    const app = build(intents)
    const res = await app.request('/api/intents', { method: 'POST', body: JSON.stringify({ goal: '盯 AI 硬件', recruit: true }) })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { recruited?: { subscribed: unknown[]; reused: unknown[]; dropped: number } }
    expect(body.recruited).toEqual({ subscribed: [{ streamId: 's1', sourceId: 'src-a' }], reused: [], dropped: 2 })
  })

  it('recruit: true → 201 响应体是招源后的记录（重新 get，不是 create 返回的旧引用）', async () => {
    // recruit 成功后 store.put 会换新对象（streamIds 从招源结果里补上）；
    // 201 顶层字段必须来自 get(rec.id) 的最新态，不能是 create() 时那份创建瞬间的空 streamIds。
    let current = rec()
    const intents = fakeIntents({
      create: vi.fn(async () => current),
      get: vi.fn((id: string) => (id === current.id ? current : null)),
      recruit: vi.fn(async () => {
        current = { ...current, streamIds: ['s1'] }
        return { subscribed: [{ streamId: 's1', sourceId: 'src-a' }], reused: [], dropped: 0 }
      }),
    })
    const app = build(intents)
    const res = await app.request('/api/intents', { method: 'POST', body: JSON.stringify({ goal: '盯 AI 硬件', recruit: true }) })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { streamIds: string[] }
    expect(body.streamIds).toEqual(['s1'])
  })

  it('streamIds 传了但不是 string[] → 400（F6）', async () => {
    const intents = fakeIntents()
    const app = build(intents)
    const res = await app.request('/api/intents', { method: 'POST', body: JSON.stringify({ goal: 'x', streamIds: [1, 2] }) })
    expect(res.status).toBe(400)
    expect(intents.create).not.toHaveBeenCalled()
  })
})

describe('GET /api/intents 与 GET /api/intents/:id', () => {
  it('列表 / 单条 200 / 未知 id 404', async () => {
    const intents = fakeIntents()
    const app = build(intents)
    expect(await (await app.request('/api/intents')).json()).toEqual({ intents: [rec()] })
    expect((await app.request('/api/intents/in_1')).status).toBe(200)
    expect((await app.request('/api/intents/nope')).status).toBe(404)
  })
})

describe('GET /api/intents/:id/dossier', () => {
  it('200，text/markdown; charset=utf-8，body 为档案原文', async () => {
    const intents = fakeIntents()
    const app = build(intents)
    const res = await app.request('/api/intents/in_1/dossier')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(await res.text()).toBe('# 档案\n\n正文')
  })
})

describe('POST /api/intents/:id/digest', () => {
  it('200，DigestOutcome 透传', async () => {
    const intents = fakeIntents()
    const app = build(intents)
    const res = await app.request('/api/intents/in_1/digest', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ judged: 3, relevantNew: 1, errors: 0 })
  })
})

describe('POST /api/intents/:id/retire', () => {
  it('200，status: retired', async () => {
    const intents = fakeIntents()
    const app = build(intents)
    const res = await app.request('/api/intents/in_1/retire', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { status: string }).status).toBe('retired')
  })
})

describe('POST /api/intents/:id/recruit', () => {
  it('200，同步返回招源结果（RecruitOutcome）', async () => {
    const intents = fakeIntents()
    const app = build(intents)
    const res = await app.request('/api/intents/in_1/recruit', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ subscribed: [{ streamId: 's1', sourceId: 'src-a' }], reused: [], dropped: 2 })
  })

  it('service.recruit 抛"未配置" → 503 unavailable', async () => {
    const intents = fakeIntents({ recruit: vi.fn(async () => { throw new Error('recruit 未配置') }) })
    const app = build(intents)
    const res = await app.request('/api/intents/in_1/recruit', { method: 'POST' })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unavailable')
  })

  it('service.recruit 抛"意图已退休" → 409 conflict（调用方错误，不是上游故障）', async () => {
    const intents = fakeIntents({ recruit: vi.fn(async () => { throw new Error('意图已退休') }) })
    const app = build(intents)
    const res = await app.request('/api/intents/in_1/recruit', { method: 'POST' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('conflict')
  })

  it('service.recruit 抛其余错误（如上游 LLM 失败）→ 500 upstream_error', async () => {
    const intents = fakeIntents({ recruit: vi.fn(async () => { throw new Error('LLM 端点超时') }) })
    const app = build(intents)
    const res = await app.request('/api/intents/in_1/recruit', { method: 'POST' })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('upstream_error')
  })

  it('service.recruit 抛"LLM 未配置" → 500（含"未配置"字样但不是 recruit 动作面未装配，不得吞进 503）', async () => {
    const intents = fakeIntents({ recruit: vi.fn(async () => { throw new Error('LLM 未配置') }) })
    const app = build(intents)
    const res = await app.request('/api/intents/in_1/recruit', { method: 'POST' })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('upstream_error')
  })
})

describe('recruit/digest 未知 id → 404（F6）', () => {
  it('recruit 未知 id → 404，不调用 service.recruit', async () => {
    const intents = fakeIntents()
    const app = build(intents)
    const res = await app.request('/api/intents/nope/recruit', { method: 'POST' })
    expect(res.status).toBe(404)
    expect(intents.recruit).not.toHaveBeenCalled()
  })

  it('digest 未知 id → 404，不调用 service.digestNow', async () => {
    const intents = fakeIntents()
    const app = build(intents)
    const res = await app.request('/api/intents/nope/digest', { method: 'POST' })
    expect(res.status).toBe(404)
    expect(intents.digestNow).not.toHaveBeenCalled()
  })
})

describe('deps.intents 缺席', () => {
  it('每条路由 503', async () => {
    const app = build(undefined)
    expect((await app.request('/api/intents', { method: 'POST', body: JSON.stringify({ goal: 'x' }) })).status).toBe(503)
    expect((await app.request('/api/intents')).status).toBe(503)
    expect((await app.request('/api/intents/in_1')).status).toBe(503)
    expect((await app.request('/api/intents/in_1/dossier')).status).toBe(503)
    expect((await app.request('/api/intents/in_1/recruit', { method: 'POST' })).status).toBe(503)
    expect((await app.request('/api/intents/in_1/digest', { method: 'POST' })).status).toBe(503)
    expect((await app.request('/api/intents/in_1/retire', { method: 'POST' })).status).toBe(503)
  })
})
