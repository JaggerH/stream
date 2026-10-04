import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { mountSourceHealthRoutes, type SourceHealthRoutesDeps } from './source-health-routes.ts'
import type { SourceHealthView } from '../intervention/source-health-view.ts'

const view = (id: string, status: SourceHealthView['status']): SourceHealthView => ({
  source: { id, pluginId: 'p', pluginName: 'p', title: id, categories: [], capabilities: [], auth: 'none', paramCount: 0, requiredParamCount: 0 },
  status, health: { state: 'dead', lastAt: 't', lastError: '500' }, affectedChannels: [],
  ...(status === 'awaiting' ? { run: { id: 'r9', status: 'awaiting_confirmation', startedAt: 't', usage: { promptTokens: 0, completionTokens: 0, turns: 0, wallMs: 0, reported: false } } } : {}),
})
const setup = (over: Partial<SourceHealthRoutesDeps> = {}) => {
  const app = new Hono()
  const start = vi.fn(() => ({ runId: 'r1' }) as ReturnType<NonNullable<SourceHealthRoutesDeps['repairs']>['start']>)
  const deps: SourceHealthRoutesDeps = {
    index: { one: (id) => (id === 'a' ? view('a', 'quarantined') : id === 'b' ? view('b', 'awaiting') : undefined), unhealthy: () => [view('a', 'quarantined'), view('b', 'awaiting')] },
    repairs: { start },
    reasonFor: () => '第 2 步 expect 落空',
    affectedFor: (id) => [id],
    ...over,
  }
  mountSourceHealthRoutes(app, deps)
  return { app, start }
}
const post = (app: Hono, body: unknown) =>
  app.request('/api/interventions/repairs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('source-health routes', () => {
  it('列表只给非 ok；详情按 id；不认识 404 unknown-source', async () => {
    const { app } = setup()
    const list = await (await app.request('/api/source-health')).json() as { sources: SourceHealthView[] }
    expect(list.sources.map((s) => s.source.id)).toEqual(['a', 'b'])
    expect(((await (await app.request('/api/source-health/a')).json()) as SourceHealthView).status).toBe('quarantined')
    const nf = await app.request('/api/source-health/zzz')
    expect(nf.status).toBe(404)
    expect(((await nf.json()) as { error: { code: string } }).error.code).toBe('unknown-source')
  })

  it('多段 sourceId（真实源 id 形如 @streamapp/xhs/xhs-home）：裸写与整体 encode 都要命中', async () => {
    const id = '@streamapp/xhs/xhs-home'
    const { app } = setup({
      index: { one: (sid) => (sid === id ? view(id, 'quarantined') : undefined), unhealthy: () => [] },
    })
    const bare = await app.request(`/api/source-health/${id}`)
    expect(bare.status).toBe(200)
    expect(((await bare.json()) as SourceHealthView).source.id).toBe(id)
    const encoded = await app.request(`/api/source-health/${encodeURIComponent(id)}`)
    expect(encoded.status).toBe(200)
    expect(((await encoded.json()) as SourceHealthView).source.id).toBe(id)
  })

  it('手动拉起：201 带 runId；reason 缺省取 reasonFor；affectedSources 随 job 给', async () => {
    const { app, start } = setup()
    const res = await post(app, { sourceId: 'a' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ runId: 'r1' })
    expect(start).toHaveBeenCalledWith({ sourceId: 'a', reason: '第 2 步 expect 落空', affectedSources: ['a'] })
    await post(app, { sourceId: 'a', reason: '我看它不对' })
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ reason: '我看它不对' }))
  })

  it('已有活跃 run → 409 repair-busy 带 runId；没配 agent → 503；未接 repairs → 503；不认识的源 404；写错键 400', async () => {
    const busy = setup({ repairs: { start: () => 'busy' } })
    const r1 = await post(busy.app, { sourceId: 'b' })
    expect(r1.status).toBe(409)
    expect(await r1.json()).toMatchObject({ error: { code: 'repair-busy' }, runId: 'r9' })
    const unconf = setup({ repairs: { start: () => 'unconfigured' } })
    expect((await post(unconf.app, { sourceId: 'a' })).status).toBe(503)
    const none = setup({ repairs: undefined })
    expect((await post(none.app, { sourceId: 'a' })).status).toBe(503)
    expect((await post(setup().app, { sourceId: 'zzz' })).status).toBe(404)
    const bad = await post(setup().app, { source: 'a' })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('unknown-key')
  })

  it('包找不到那种当场失败的 run：仍 201，但 failed:true 如实带回', async () => {
    const { app } = setup({ repairs: { start: () => ({ runId: 'r2', failed: true }) } })
    const res = await post(app, { sourceId: 'a' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ runId: 'r2', failed: true })
  })
})
