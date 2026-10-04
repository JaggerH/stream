import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { registerNetdiskRoutes, type NetdiskDeps } from './netdisk-routes.ts'

const SET = { id: 'map_1', follow: { enabled: true, dryRuns: 0 } }

function makeApp(follow?: Record<string, unknown>) {
  const f = follow && {
    view: vi.fn(() => ({ follow: SET.follow, missingAired: ['tv:261471:S03E14'], upcoming: 2, shares: [], runs: [] })),
    setEnabled: vi.fn(() => SET),
    runOnce: vi.fn(async (setId: string, trigger: string) => ({ id: 'run_1', setId, trigger, missingAired: [], revisited: [], saved: [], synced: { matchedBefore: 0, matchedAfter: 0 }, errors: [] })),
    ensureBinding: vi.fn(async () => SET),
    recordShare: vi.fn(),
    ...follow,
  }
  const app = new Hono()
  registerNetdiskRoutes(app, {
    service: {}, store: { list: () => [SET], get: (id: string) => (id === 'map_1' ? SET : undefined) }, alist: {}, follow: f,
  } as unknown as NetdiskDeps)
  return { app, follow: f as unknown as Record<string, ReturnType<typeof vi.fn>> }
}

const post = (app: Hono, path: string, body?: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const patch = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('追更路由：没装配就 503（而不是假装成功）', () => {
  it('四条路由在 follow 缺席时全 503', async () => {
    const { app } = makeApp(undefined)
    expect((await app.request('/api/netdisk/mappings/map_1/follow')).status).toBe(503)
    expect((await patch(app, '/api/netdisk/mappings/map_1/follow', { enabled: true })).status).toBe(503)
    expect((await post(app, '/api/netdisk/mappings/map_1/follow/run')).status).toBe(503)
    expect((await post(app, '/api/netdisk/follow', { tmdb: { id: '1', media: 'tv', title: 'X' } })).status).toBe(503)
  })
})

describe('GET /api/netdisk/mappings/:id/follow', () => {
  it('回 view()', async () => {
    const { app, follow } = makeApp({})
    const res = await app.request('/api/netdisk/mappings/map_1/follow')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ missingAired: ['tv:261471:S03E14'], upcoming: 2 })
    expect(follow.view).toHaveBeenCalledWith('map_1')
  })

  it('不存在的绑定 ⇒ 404', async () => {
    const { app } = makeApp({ view: vi.fn(() => { throw new Error('unknown binding: nope') }) })
    const res = await app.request('/api/netdisk/mappings/nope/follow')
    expect(res.status).toBe(404)
    expect((await res.json() as any).error.message).toContain('unknown binding')
  })
})

describe('PATCH /api/netdisk/mappings/:id/follow', () => {
  it('enabled 必须是布尔——给字符串是 400，不是"真值即开"', async () => {
    const { app, follow } = makeApp({})
    const res = await patch(app, '/api/netdisk/mappings/map_1/follow', { enabled: 'true' })
    expect(res.status).toBe(400)
    expect(follow.setEnabled).not.toHaveBeenCalled()
  })

  it('认不出的字段 ⇒ 400（严格输入闸）', async () => {
    const { app } = makeApp({})
    expect((await patch(app, '/api/netdisk/mappings/map_1/follow', { enable: true })).status).toBe(400)
  })

  it('布尔就转给 setEnabled，回 MappingSet', async () => {
    const { app, follow } = makeApp({})
    const res = await patch(app, '/api/netdisk/mappings/map_1/follow', { enabled: false })
    expect(res.status).toBe(200)
    expect(follow.setEnabled).toHaveBeenCalledWith('map_1', false)
    expect(await res.json()).toMatchObject({ id: 'map_1' })
  })

  it('绑定不存在 ⇒ 404（与 GET / run 同一口径，不是 400）', async () => {
    const { app, follow } = makeApp({})
    const res = await patch(app, '/api/netdisk/mappings/map_nope/follow', { enabled: true })
    expect(res.status).toBe(404)
    expect(follow.setEnabled).not.toHaveBeenCalled()
  })

  it('只有 TMDb 剧集能追更 ⇒ service 抛 ⇒ 400', async () => {
    const { app } = makeApp({ setEnabled: vi.fn(() => { throw new Error('只有 TMDb 剧集绑定能追更') }) })
    const res = await patch(app, '/api/netdisk/mappings/map_1/follow', { enabled: true })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/netdisk/mappings/:id/follow/run', () => {
  it('手动跑一轮，trigger 是 manual', async () => {
    const { app, follow } = makeApp({})
    const res = await post(app, '/api/netdisk/mappings/map_1/follow/run')
    expect(res.status).toBe(200)
    expect(follow.runOnce).toHaveBeenCalledWith('map_1', 'manual')
    expect(await res.json()).toMatchObject({ trigger: 'manual', setId: 'map_1' })
  })

  it('不存在的绑定 ⇒ 404', async () => {
    const { app } = makeApp({ runOnce: vi.fn(async () => { throw new Error('unknown binding: nope') }) })
    expect((await post(app, '/api/netdisk/mappings/nope/follow/run')).status).toBe(404)
  })
})

describe('POST /api/netdisk/follow', () => {
  it('建/开一部剧的追更：目录落在 <quark 挂载点>/From Stream/tv-<id>', async () => {
    const { app, follow } = makeApp({})
    const res = await post(app, '/api/netdisk/follow', { tmdb: { id: '261471', media: 'tv', title: '凡人修仙传', year: 2020 } })
    expect(res.status).toBe(200)
    const [ref, dirPath] = follow.ensureBinding.mock.calls[0]
    expect(ref).toEqual({ id: '261471', media: 'tv', title: '凡人修仙传', year: 2020 })
    expect(dirPath).toMatch(/\/From Stream\/tv-261471$/)
  })

  it('year 缺省不写进 ref（undefined 会污染绑定左侧）', async () => {
    const { app, follow } = makeApp({})
    await post(app, '/api/netdisk/follow', { tmdb: { id: '1', media: 'tv', title: 'X' } })
    expect(follow.ensureBinding.mock.calls[0][0]).toEqual({ id: '1', media: 'tv', title: 'X' })
  })

  it('media 只收 tv；缺 id/title 或认不出的字段一律 400', async () => {
    const { app, follow } = makeApp({})
    expect((await post(app, '/api/netdisk/follow', { tmdb: { id: '1', media: 'movie', title: 'X' } })).status).toBe(400)
    expect((await post(app, '/api/netdisk/follow', { tmdb: { media: 'tv', title: 'X' } })).status).toBe(400)
    expect((await post(app, '/api/netdisk/follow', { tmdb: { id: '1', media: 'tv' } })).status).toBe(400)
    expect((await post(app, '/api/netdisk/follow', { tmdbId: '1' })).status).toBe(400)
    expect(follow.ensureBinding).not.toHaveBeenCalled()
  })
})
