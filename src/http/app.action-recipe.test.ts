import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHttpApiFixture, type HttpApiFixture } from './__fixtures__/app-harness.ts'

let fixture: HttpApiFixture
beforeEach(() => { fixture = createHttpApiFixture() })
afterEach(() => { fixture.close() })

// `POST /api/recipes/action` 是动作 recipe 的**脚本入口**（批量上架用）。
//
// 它存在的理由是参数里可能有大块字节：闲鱼上架的商品图只能以 data URL 递进去（页面 CSP 不放行
// fetch），走 MCP 就要让几十 KB base64 穿过一次对话——抄错一个字符就是 `atob` 失败（实测踩过）。
//
// 这里钉的是**转发的忠实度**，不是动作本身的行为（那在 src/mcp/action-recipe.ts 有自己的用例）：
// 两条路必须是同一个实现，路由不许自己加闸、也不许替调用方省掉两步确认。
function run(app: ReturnType<HttpApiFixture['build']>, body: unknown) {
  return app.request('/api/recipes/action', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

// POST 回 `{status:'running', runId}` 之后脚本从这里等结果；不是 action 档的 runId 是 404，
// 投影本身（sourceId / result / note）在 src/mcp/action-run.ts 有自己的用例，这里只钉转发与 404。
describe('GET /api/recipes/action/:runId', () => {
  it('有 → 原样回投影；没有 → 404；没接线 → 503', async () => {
    const actionRun = vi.fn((runId: string) => (runId === 'a1' ? { runId, domain: 'action', status: 'done', sourceId: 'qq-send', result: { status: 'done' }, note: 'n' } : null))
    const app = fixture.build(undefined, { actionRun })
    const ok = await app.request('/api/recipes/action/a1')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ runId: 'a1', status: 'done', result: { status: 'done' } })
    expect((await app.request('/api/recipes/action/nope')).status).toBe(404)
    expect((await fixture.build(undefined, {}).request('/api/recipes/action/a1')).status).toBe(503)
  })
})

describe('POST /api/recipes/action', () => {
  it('原样把 sourceId / params / confirmed 递下去，结果原样回', async () => {
    const runAction = vi.fn(async () => ({ status: 'done', sourceId: 'goofish-publish', items: [{ itemId: '1' }] }))
    const app = fixture.build(undefined, { runAction })
    const res = await run(app, { sourceId: 'goofish-publish', params: { title: 't' }, confirmed: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'done', sourceId: 'goofish-publish', items: [{ itemId: '1' }] })
    expect(runAction).toHaveBeenCalledWith({ sourceId: 'goofish-publish', params: { title: 't' }, confirmed: true })
  })

  it('不传 confirmed 就不许替调用方补上 —— 两步确认只有一份实现，在下游', async () => {
    const runAction = vi.fn(async () => ({ status: 'needs-confirmation' }))
    const app = fixture.build(undefined, { runAction })
    await run(app, { sourceId: 'goofish-publish', params: {} })
    expect(runAction).toHaveBeenCalledWith({ sourceId: 'goofish-publish', params: {}, confirmed: undefined })
  })

  it('`blocked` 这类状态照常 200 原样回 —— 折成 HTTP 错误码会把它压成一个数字', async () => {
    // blocked 恰恰可能是"动作已经生效、只是没读到回执"（2026-09-08 上架实测撞过：商品真发出去了、
    // 回执却是 drift）。调用方必须能读到原状态才判得了要不要重试——重试一次就是第二次上架。
    const runAction = vi.fn(async () => ({ status: 'blocked', sourceId: 'goofish-publish', reason: 'drift' }))
    const app = fixture.build(undefined, { runAction })
    const res = await run(app, { sourceId: 'goofish-publish', confirmed: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'blocked', reason: 'drift' })
  })

  it('没装配 runAction → 503，而不是假装成功', async () => {
    const app = fixture.build(undefined, {})
    expect((await run(app, { sourceId: 'x', confirmed: true })).status).toBe(503)
  })

  it('缺 sourceId → 400，且一次都没往下调', async () => {
    const runAction = vi.fn(async () => ({ status: 'done' }))
    const app = fixture.build(undefined, { runAction })
    expect((await run(app, { params: {}, confirmed: true })).status).toBe(400)
    expect(runAction).not.toHaveBeenCalled()
  })

  it('打错的字段名当场拒 —— 静默忽略会让调用方以为闸生效了', async () => {
    const runAction = vi.fn(async () => ({ status: 'done' }))
    const app = fixture.build(undefined, { runAction })
    // `confirm` 不是 `confirmed`：真收下就等于没确认也发出去了。
    const res = await run(app, { sourceId: 'goofish-publish', confirm: true })
    expect(res.status).toBe(400)
    expect(runAction).not.toHaveBeenCalled()
  })
})
