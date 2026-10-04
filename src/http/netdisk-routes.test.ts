import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { registerNetdiskRoutes, type NetdiskDeps } from './netdisk-routes.ts'
import type { MappingSet } from '../netdisk/types.ts'

function sampleSet(id = 'map_1'): MappingSet {
  return {
    id,
    left: { kind: 'stream', streamId: 's', title: 'P' },
    right: { kind: 'alist-dir', path: '/d', boundAt: 'now' },
    rightHistory: [],
    autoSync: true,
    entries: [{ leftKey: 'netease:123', leftTitle: 'A', rightFile: '01.m4a', status: 'auto' }],
  }
}

function makeApp(over: Partial<{ service: any; store: any; alist: any; reconcile: any; adjudicate: any }> = {}) {
  const store = over.store ?? {
    list: vi.fn(() => [sampleSet()]),
    get: vi.fn((id: string) => (id === 'map_1' ? sampleSet() : undefined)),
    remove: vi.fn(),
  }
  const service = over.service ?? {
    bind: vi.fn(async (i: any) => ({ ...sampleSet('map_new'), left: { kind: 'stream', streamId: i.streamId, title: i.title } })),
    sync: vi.fn(async (s: any) => s),
    rebind: vi.fn(async (_id: string, dirPath: string) => ({ ...sampleSet(), right: { kind: 'alist-dir', path: dirPath, boundAt: 'now' } })),
    setEntry: vi.fn((_id: string, leftKey: string) => ({ ...sampleSet(), _touched: leftKey })),
    clearCorrection: vi.fn((_id: string, leftKey: string) => ({ ...sampleSet(), _released: leftKey })),
  }
  const alist = over.alist ?? {
    listEntries: vi.fn(async () => [{ name: '01.m4a', size: 10, isDir: false }, { name: 'sub', size: 0, isDir: true }]),
    listDirRecursive: vi.fn(async () => [{ name: '01.m4a', size: 10, isDir: false }, { name: 'sub/02.m4a', size: 20, isDir: false }]),
  }
  const app = new Hono()
  registerNetdiskRoutes(app, { service, store, alist, reconcile: over.reconcile, adjudicate: over.adjudicate } as unknown as NetdiskDeps)
  return { app, store, service, alist, reconcile: over.reconcile, adjudicate: over.adjudicate }
}

describe('netdisk routes', () => {
  it('GET /api/netdisk/mappings lists sets', async () => {
    const { app } = makeApp()
    const res = await app.request('/api/netdisk/mappings')
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveLength(1)
  })

  it('GET /:id → 200 / 404', async () => {
    const { app } = makeApp()
    expect((await app.request('/api/netdisk/mappings/map_1')).status).toBe(200)
    const miss = await app.request('/api/netdisk/mappings/nope')
    expect(miss.status).toBe(404)
    expect((await miss.json()).error.code).toBe('not_found')
  })

  it('POST create → 200; missing fields → 400', async () => {
    const { app, service } = makeApp()
    const ok = await app.request('/api/netdisk/mappings', {
      method: 'POST',
      body: JSON.stringify({ streamId: 's1', dirPath: '/x' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(ok.status).toBe(200)
    expect(service.bind).toHaveBeenCalled()
    const bad = await app.request('/api/netdisk/mappings', {
      method: 'POST',
      body: JSON.stringify({ streamId: 's1' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(bad.status).toBe(400)
  })

  it('POST /:id/sync → 200; unknown → 404', async () => {
    const { app, service } = makeApp()
    const ok = await app.request('/api/netdisk/mappings/map_1/sync', { method: 'POST' })
    expect(ok.status).toBe(200)
    expect(service.sync).toHaveBeenCalled()
    const miss = await app.request('/api/netdisk/mappings/nope/sync', { method: 'POST' })
    expect(miss.status).toBe(404)
  })

  it('POST /:id/rebind → 200; missing dirPath → 400; service throw → 404', async () => {
    const { app } = makeApp()
    const ok = await app.request('/api/netdisk/mappings/map_1/rebind', {
      method: 'POST', body: JSON.stringify({ dirPath: '/new' }), headers: { 'content-type': 'application/json' },
    })
    expect(ok.status).toBe(200)
    const bad = await app.request('/api/netdisk/mappings/map_1/rebind', {
      method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' },
    })
    expect(bad.status).toBe(400)

    const throwing = makeApp({ service: { rebind: vi.fn(async () => { throw new Error('绑定不存在') }) } })
    const err = await throwing.app.request('/api/netdisk/mappings/x/rebind', {
      method: 'POST', body: JSON.stringify({ dirPath: '/n' }), headers: { 'content-type': 'application/json' },
    })
    expect(err.status).toBe(404)
  })

  it('DELETE /:id → ok', async () => {
    const { app, store } = makeApp()
    const res = await app.request('/api/netdisk/mappings/map_1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(store.remove).toHaveBeenCalledWith('map_1')
  })

  it('PATCH entry with encoded leftKey (netease:123) roundtrips', async () => {
    const { app, service } = makeApp()
    const leftKey = encodeURIComponent('netease:123')
    const res = await app.request(`/api/netdisk/mappings/map_1/entries/${leftKey}`, {
      method: 'PATCH', body: JSON.stringify({ status: 'confirmed' }), headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(service.setEntry).toHaveBeenCalledWith('map_1', 'netease:123', { status: 'confirmed' })
  })

  it('PATCH entry: missing body → 400; service throw → 404', async () => {
    const { app } = makeApp()
    const bad = await app.request('/api/netdisk/mappings/map_1/entries/x', {
      method: 'PATCH', body: 'not-json', headers: { 'content-type': 'application/json' },
    })
    expect(bad.status).toBe(400)

    const throwing = makeApp({ service: { setEntry: vi.fn(() => { throw new Error('条目不存在') }) } })
    const err = await throwing.app.request('/api/netdisk/mappings/map_1/entries/x', {
      method: 'PATCH', body: JSON.stringify({ status: 'confirmed' }), headers: { 'content-type': 'application/json' },
    })
    expect(err.status).toBe(404)
  })

  it('POST entry reset releases an encoded temporary correction', async () => {
    const { app, service } = makeApp()
    const res = await app.request('/api/netdisk/mappings/map_1/entries/netease%3A123/reset', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(service.clearCorrection).toHaveBeenCalledWith('map_1', 'netease:123')

    const throwing = makeApp({ service: { clearCorrection: vi.fn(() => { throw new Error('条目不存在') }) } })
    expect((await throwing.app.request('/api/netdisk/mappings/map_1/entries/x/reset', { method: 'POST' })).status).toBe(404)
  })

  it('POST /:id/spec/preview → 200; missing spec → 400; invalid spec → 400', async () => {
    const { app, service } = makeApp({ service: { previewSpec: vi.fn(async (_id: string, spec: unknown) => ({ candidateSpec: spec })) } })
    const ok = await app.request('/api/netdisk/mappings/map_1/spec/preview', {
      method: 'POST', body: JSON.stringify({ spec: { version: 2, stages: [] } }), headers: { 'content-type': 'application/json' },
    })
    expect(ok.status).toBe(200)
    expect(service.previewSpec).toHaveBeenCalledWith('map_1', { version: 2, stages: [] })

    const noSpec = await app.request('/api/netdisk/mappings/map_1/spec/preview', {
      method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' },
    })
    expect(noSpec.status).toBe(400)

    const invalid = makeApp({ service: { previewSpec: vi.fn(async () => { throw new Error('invalid matchSpec: version must be 2') }) } })
    const bad = await invalid.app.request('/api/netdisk/mappings/map_1/spec/preview', {
      method: 'POST', body: JSON.stringify({ spec: { version: 1 } }), headers: { 'content-type': 'application/json' },
    })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.code).toBe('validation_error')
  })

  it('POST /:id/spec/apply → 200; binding gone → 404', async () => {
    const { app, service } = makeApp({ service: { applySpec: vi.fn(async () => sampleSet()) } })
    const ok = await app.request('/api/netdisk/mappings/map_1/spec/apply', {
      method: 'POST', body: JSON.stringify({ spec: { version: 2, stages: [] } }), headers: { 'content-type': 'application/json' },
    })
    expect(ok.status).toBe(200)
    expect(service.applySpec).toHaveBeenCalledWith('map_1', { version: 2, stages: [] })

    const throwing = makeApp({ service: { applySpec: vi.fn(async () => { throw new Error('绑定不存在: x') }) } })
    const res = await throwing.app.request('/api/netdisk/mappings/x/spec/apply', {
      method: 'POST', body: JSON.stringify({ spec: {} }), headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(404)
  })

  it('GET /api/netdisk/fs → files; upstream error → 502', async () => {
    const { app } = makeApp()
    const ok = await app.request('/api/netdisk/fs?path=/d')
    expect(ok.status).toBe(200)
    expect((await ok.json()).files).toHaveLength(2)

    const failing = makeApp({ alist: { listEntries: vi.fn(async () => { throw new Error('conn refused') }) } })
    const res = await failing.app.request('/api/netdisk/fs?path=/d')
    expect(res.status).toBe(502)
    expect((await res.json()).error.code).toBe('upstream_error')
  })

  it('GET /api/netdisk/fs?recursive=1 → recursive files (subpaths), not the single-level list', async () => {
    const { app, alist } = makeApp()
    const res = await app.request('/api/netdisk/fs?path=/d&recursive=1')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.files.map((f: { name: string }) => f.name)).toEqual(['01.m4a', 'sub/02.m4a'])
    // 目录行默认不出现：文件选择框的平铺列表以「没有可下钻的目录」为前提。
    expect(alist.listDirRecursive).toHaveBeenCalledWith('/d', 5, false, false)
    expect(alist.listEntries).not.toHaveBeenCalled()
  })

  it('GET /api/netdisk/fs?refresh=1 forces AList to bypass its directory cache', async () => {
    const { app, alist } = makeApp()
    await app.request('/api/netdisk/fs?path=/d&recursive=1&refresh=1')
    expect(alist.listDirRecursive).toHaveBeenCalledWith('/d', 5, true, false)
  })

  // 目录选择框搜子树用的开关：递归结果里也带上目录行。默认关（上面两条钉着），
  // 只有显式 dirs=1 才打开。
  it('GET /api/netdisk/fs?recursive=1&dirs=1 → 递归结果里带上目录行', async () => {
    const { app, alist } = makeApp()
    await app.request('/api/netdisk/fs?path=/d&recursive=1&dirs=1')
    expect(alist.listDirRecursive).toHaveBeenCalledWith('/d', 5, false, true)

    const { app: app2, alist: alist2 } = makeApp()
    await app2.request('/api/netdisk/fs?path=/d&recursive=1&dirs=true&refresh=1')
    expect(alist2.listDirRecursive).toHaveBeenCalledWith('/d', 5, true, true)
  })

  /**
   * **按路径取直链**。整理面板要让人当场听一听某份网盘文件——"这份到底是哪一集"只有耳朵答得了
   * （活体 2026-08-02：`37.申与酉.mp3` 其实是《037.三谈身边灵异事》，编号是搬文件时错配的）。
   *
   * 现成的取链口全是**按集**的（`/api/media/videos/resolve` 要 `id`/`key` → `netdisk.lookup`），
   * 而这批文件恰恰是**没被任何集认领**的那些——按集反查恒空。所以这一条只吃路径。
   */
  describe('GET /api/netdisk/raw —— 按路径取直链（整理面板试听）', () => {
    const rawApp = (over: Record<string, unknown> = {}) =>
      makeApp({ service: { rawGatewayUrl: vi.fn(async (p: string) => `/_p/alist/d${p}?sign=x`), ...over } })

    it('302 到同源直链（<audio src> 跟着跳）', async () => {
      const { app, service } = rawApp()
      const res = await app.request('/api/netdisk/raw?path=/lib/%E4%BB%98%E8%B4%B9/37.mp3')
      expect(res.status).toBe(302)
      // 路径按 query 解码后原样交给取链（**不是**把 `%E4%BB%98%E8%B4%B9` 那串当文件名去 AList 找）。
      expect(service.rawGatewayUrl).toHaveBeenCalledWith('/lib/付费/37.mp3')
      // Location 头里非 ASCII 会被百分号编码（HTTP 规定它得是合法 URI），解回来才是那条直链。
      expect(decodeURIComponent(res.headers.get('location')!)).toBe('/_p/alist/d/lib/付费/37.mp3?sign=x')
    })

    it('缺 path → 400', async () => {
      const { app } = rawApp()
      const res = await app.request('/api/netdisk/raw')
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('validation_error')
    })

    // 文件已经被删/AList 够不着 → 502，别把一个坏 URL 塞给播放器（那样只会静默播不出来）。
    it('取链失败 → 502 upstream_error', async () => {
      const { app } = rawApp({ rawGatewayUrl: vi.fn(async () => { throw new Error('[alist] code 500: object not found') }) })
      const res = await app.request('/api/netdisk/raw?path=/lib/x.mp3')
      expect(res.status).toBe(502)
      expect((await res.json()).error.code).toBe('upstream_error')
    })
  })

  describe('reconcile routes', () => {
    it('POST /api/netdisk/reconcile/yile/preview → 200 {plan, counts}', async () => {
      const { app } = makeApp({
        reconcile: { preview: vi.fn(async () => ({ plan: [], counts: { move: 0, deleteDup: 0, pending: 0 } })) },
      })
      const res = await app.request('/api/netdisk/reconcile/yile/preview', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(await res.json()).toHaveProperty('counts')
    })

    // 整轮撤销（spec 2026-09-03 §4）。三格分别是：没接线 → 503（不是 404，用户该去接线不是去找 id）、
    // 缺 runId → 400、正常 → 原样把 {undone, skipped} 交出去（撤不回的删有几条，调用方得看得见）。
    it('POST /api/netdisk/reconcile/undo-run：未接线 503、缺 runId 400、正常回 {undone,skipped}', async () => {
      const post = async (target: ReturnType<typeof makeApp>['app'], body: unknown) =>
        await target.request('/api/netdisk/reconcile/undo-run', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        })

      expect((await post(makeApp().app, { runId: 'r1' })).status).toBe(503)

      const undoRun = vi.fn(async () => ({ undone: 3, skipped: 1 }))
      const { app } = makeApp({ reconcile: { undoRun, bindingOfRun: vi.fn(() => undefined) } })
      expect((await post(app, {})).status).toBe(400)
      expect(undoRun).not.toHaveBeenCalled()

      const ok = await post(app, { runId: 'r1' })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ undone: 3, skipped: 1 })
      expect(undoRun).toHaveBeenCalledWith('r1')
    })

    // 轮末裁决器手动入口（spec 2026-09-03-netdisk-llm-adjudicator §3 触发点 2）。
    it('POST /api/netdisk/reconcile/bindings/:id/adjudicate：未接线 503、losers 非布尔 400、正常原样回执', async () => {
      expect(
        (await makeApp().app.request('/api/netdisk/reconcile/bindings/map_1/adjudicate', { method: 'POST' })).status,
      ).toBe(503)

      const run = vi.fn(async () => ({ runId: 'adj_1', asked: 3, applied: 1, rejected: 2, unsure: 0 }))
      const { app } = makeApp({ adjudicate: { run } })

      const bad = await app.request('/api/netdisk/reconcile/bindings/map_1/adjudicate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ losers: 'yes' }),
      })
      expect(bad.status).toBe(400)
      expect(run).not.toHaveBeenCalled()

      const ok = await app.request('/api/netdisk/reconcile/bindings/map_1/adjudicate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ losers: true }),
      })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ runId: 'adj_1', asked: 3, applied: 1, rejected: 2, unsure: 0 })
      expect(run).toHaveBeenCalledWith('map_1', { trigger: 'manual', losers: true })
    })

    it('adjudicate：losers 缺省为 false；applied>0 时重新同步 tmdb tv 绑定，applied:0 不同步', async () => {
      const tvSet = { ...sampleSet('map_tv'), left: { kind: 'tmdb', id: '9', media: 'tv', title: '某剧' } }
      const store = { list: vi.fn(() => [tvSet]), get: vi.fn(() => tvSet), remove: vi.fn() }
      const sync = vi.fn(async (s: unknown) => s)
      const run = vi.fn(async () => ({ runId: 'adj_1', asked: 1, applied: 1, rejected: 0, unsure: 0 }))
      const { app } = makeApp({ store, service: { sync }, adjudicate: { run } })
      await app.request('/api/netdisk/reconcile/bindings/map_tv/adjudicate', { method: 'POST' })
      expect(run).toHaveBeenCalledWith('map_tv', { trigger: 'manual', losers: false })
      expect(sync).toHaveBeenCalledWith(tvSet)

      sync.mockClear()
      run.mockResolvedValueOnce({ runId: 'adj_2', asked: 1, applied: 0, rejected: 1, unsure: 0 })
      await app.request('/api/netdisk/reconcile/bindings/map_tv/adjudicate', { method: 'POST' })
      expect(sync).not.toHaveBeenCalled()
    })

    it('POST /api/netdisk/reconcile/bindings/:id/adjudicate/revoke：未接线 503、缺 runId 400、正常回 {ok,revoked}', async () => {
      expect(
        (await makeApp().app.request('/api/netdisk/reconcile/bindings/map_1/adjudicate/revoke', { method: 'POST' })).status,
      ).toBe(503)

      const revoke = vi.fn(async () => 5)
      const { app } = makeApp({ adjudicate: { revoke } })
      const bad = await app.request('/api/netdisk/reconcile/bindings/map_1/adjudicate/revoke', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      })
      expect(bad.status).toBe(400)
      expect(revoke).not.toHaveBeenCalled()

      const ok = await app.request('/api/netdisk/reconcile/bindings/map_1/adjudicate/revoke', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'adj_1' }),
      })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ ok: true, revoked: 5 })
      expect(revoke).toHaveBeenCalledWith('adj_1')
    })

    /**
     * 归档动完文件之后，绑定里存的那些相对路径全过时了（文件搬进了 `S<nn>/`、名字加了编号前缀）。
     * 不重新同步一次，节目单那一侧还指着旧路径——点播放 404，而没有一处会喊。
     * 撤销同理，方向相反。同步失败不许影响这次请求的回执：文件已经动完了，回执讲的是那件事。
     */
    it('执行 / 撤销之后重新同步一次 tmdb tv 绑定；同步炸了不影响回执', async () => {
      const tvSet = { ...sampleSet('map_tv'), left: { kind: 'tmdb', id: '9', media: 'tv', title: '某剧' } }
      const store = { list: vi.fn(() => [tvSet]), get: vi.fn(() => tvSet), remove: vi.fn() }
      const sync = vi.fn(async (s: unknown) => s)
      const reconcile = {
        executeBinding: vi.fn(async () => ({ moved: 1, runId: 'r1' })),
        undoRun: vi.fn(async () => ({ undone: 1, skipped: 0 })),
        bindingOfRun: vi.fn(() => 'map_tv'),
      }
      const { app } = makeApp({ store, service: { sync }, reconcile })

      expect((await app.request('/api/netdisk/reconcile/bindings/map_tv/execute', { method: 'POST' })).status).toBe(200)
      expect(sync).toHaveBeenCalledWith(tvSet)

      sync.mockClear()
      const undone = await app.request('/api/netdisk/reconcile/undo-run', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'r1' }),
      })
      expect(undone.status).toBe(200)
      expect(reconcile.bindingOfRun).toHaveBeenCalledWith('r1')
      expect(sync).toHaveBeenCalledWith(tvSet)

      // 同步炸了：回执仍是 200，动作本身已经做完了。
      sync.mockRejectedValueOnce(new Error('alist down'))
      expect((await app.request('/api/netdisk/reconcile/bindings/map_tv/execute', { method: 'POST' })).status).toBe(200)
    })

    // 不是 tmdb tv 的绑定不碰同步：播客那条路的整理不改节目单指着的路径。
    // resyncBinding 内部只把 `deps.service.sync(...)` 那一次调用包在自己的 try 里（同步失败不该
    // 影响回执），但 `deps.store.get(bindingId)` 在那之前——若它本身抛错，且路由处理器仍把整个
    // resyncBinding 摆在自己的 try 里，这个异常会被外层 catch 一把接住、答成"绑定不存在"的 404，
    // 而此时归档其实已经成功搬完了文件。resync 侧的任何异常都不许把这次回执改写成 404。
    it('resync 阶段（store.get）抛错，不把已经执行成功的整理误判成 404', async () => {
      const store = { list: vi.fn(() => []), get: vi.fn(() => { throw new Error('store 炸了') }), remove: vi.fn() }
      const executeBinding = vi.fn(async () => ({ moved: 1, deleted: 0, pending: 0, errors: [], ledger: { runId: 'r1' } }))
      const { app } = makeApp({ store, service: { sync: vi.fn() }, reconcile: { executeBinding } })
      const res = await app.request('/api/netdisk/reconcile/bindings/map_tv/execute', { method: 'POST' })
      expect(executeBinding).toHaveBeenCalledWith('map_tv')
      expect(res.status).not.toBe(404)
    })

    it('非 tmdb tv 的绑定：执行后不重新同步', async () => {
      const sync = vi.fn(async (s: unknown) => s)
      const { app } = makeApp({
        service: { sync },
        reconcile: { executeBinding: vi.fn(async () => ({ moved: 1, runId: 'r1' })), bindingOfRun: vi.fn(() => undefined) },
      })
      expect((await app.request('/api/netdisk/reconcile/bindings/map_1/execute', { method: 'POST' })).status).toBe(200)
      expect(sync).not.toHaveBeenCalled()
    })

    // 字段名写错不许静默变成"撤回了个寂寞"——`id` 是单条撤销那条路的键，打到这里就是 400。
    it('POST undo-run 传不认识的字段 → 400 并指向正确的名字', async () => {
      const undoRun = vi.fn()
      const { app } = makeApp({ reconcile: { undoRun } })
      const res = await app.request('/api/netdisk/reconcile/undo-run', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'r1' }),
      })
      expect(res.status).toBe(400)
      expect(JSON.stringify(await res.json())).toContain('runId')
      expect(undoRun).not.toHaveBeenCalled()
    })

    // 写错字段名不再静默变成"撤回"（活体：传 decision 拿到 {ok:true}，实际走了 verdict==null 分支）。
    it('POST decisions 传不认识的字段 → 400 并指向正确的名字，绝不静默丢弃', async () => {
      const setIsEpisode = vi.fn()
      const { app } = makeApp({ reconcile: { setIsEpisode } })
      const res = await app.request('/api/netdisk/reconcile/decisions', {
        method: 'POST',
        body: JSON.stringify({ decision: 'is-episode', leftKey: 'item:1', path: '/d/f.mp3' }),
        headers: { 'content-type': 'application/json' },
      })
      expect(res.status).toBe(400)
      const msg = ((await res.json()) as { error: { message: string } }).error.message
      expect(msg).toContain('decision')
      expect(msg).toContain('verdict')
      expect(setIsEpisode).not.toHaveBeenCalled() // 更没有走撤回——什么都没动
    })

    it('POST /api/netdisk/reconcile/decisions 缺 key → 400 validation_error', async () => {
      const { app } = makeApp({ reconcile: { setDecision: vi.fn() } })
      const res = await app.request('/api/netdisk/reconcile/decisions', {
        method: 'POST', body: JSON.stringify({ verdict: 'exempt' }), headers: { 'content-type': 'application/json' },
      })
      expect(res.status).toBe(400)
    })

    // 问句的两个答案走同一个端点的另一种形状：两侧齐了才收，组合键由后端拼（前端不许自造 key）。
    it('POST decisions：leftKey + path → setNotEpisode / setIsEpisode；只给一侧 → 400', async () => {
      const setNotEpisode = vi.fn()
      const setIsEpisode = vi.fn()
      const { app } = makeApp({ reconcile: { setNotEpisode, setIsEpisode } })
      const ok = await app.request('/api/netdisk/reconcile/decisions', {
        method: 'POST',
        body: JSON.stringify({ leftKey: 'L756', path: '/lib/x.mp3', verdict: 'not-episode' }),
        headers: { 'content-type': 'application/json' },
      })
      expect(ok.status).toBe(200)
      expect(setNotEpisode).toHaveBeenCalledWith('L756', '/lib/x.mp3')
      // 另一半答案：就是这一集
      const yes = await app.request('/api/netdisk/reconcile/decisions', {
        method: 'POST', body: JSON.stringify({ leftKey: 'L005', path: '/lib/y.mp3', verdict: 'is-episode' }),
        headers: { 'content-type': 'application/json' },
      })
      expect(yes.status).toBe(200)
      expect(setIsEpisode).toHaveBeenCalledWith('L005', '/lib/y.mp3')
      // verdict: null = 撤回。**两半都撤**——前端不回传"他当初答的是哪一半"，后端也不该猜。
      await app.request('/api/netdisk/reconcile/decisions', {
        method: 'POST', body: JSON.stringify({ leftKey: 'L756', path: '/lib/x.mp3', verdict: null }),
        headers: { 'content-type': 'application/json' },
      })
      expect(setNotEpisode).toHaveBeenLastCalledWith('L756', '/lib/x.mp3', false)
      expect(setIsEpisode).toHaveBeenLastCalledWith('L756', '/lib/x.mp3', false)
      const half = await app.request('/api/netdisk/reconcile/decisions', {
        method: 'POST', body: JSON.stringify({ path: '/lib/x.mp3', verdict: 'not-episode' }),
        headers: { 'content-type': 'application/json' },
      })
      expect(half.status).toBe(400)
      // 组合键这条路不许拿 exempt 混进来（那是按集身份的全局豁免，语义完全不同）
      const wrongVerdict = await app.request('/api/netdisk/reconcile/decisions', {
        method: 'POST', body: JSON.stringify({ leftKey: 'L756', path: '/lib/x.mp3', verdict: 'exempt' }),
        headers: { 'content-type': 'application/json' },
      })
      expect(wrongVerdict.status).toBe(400)
    })

    // 「AI 建议 vs 人最终选择」的账本：**只读**，两半都是别处的副作用（没有写入口）。
    it('GET suggestions：筛选参数原样下传；坏值 400；未装配 503', async () => {
      const listSuggestions = vi.fn(() => ({ items: [], summary: { total: 0 } }))
      const { app } = makeApp({ reconcile: { listSuggestions } })

      expect((await app.request('/api/netdisk/reconcile/suggestions')).status).toBe(200)
      expect(listSuggestions).toHaveBeenCalledWith({})

      await app.request('/api/netdisk/reconcile/suggestions?agreement=disagree&state=answered&limit=10&cursor=7')
      expect(listSuggestions).toHaveBeenLastCalledWith({ agreement: 'disagree', state: 'answered', limit: 10, cursor: 7 })

      // 认不得的枚举值必须**当场拒**：静默忽略会让人看着一个没筛过的列表以为筛过了。
      expect((await app.request('/api/netdisk/reconcile/suggestions?state=nope')).status).toBe(400)
      expect((await app.request('/api/netdisk/reconcile/suggestions?agreement=nope')).status).toBe(400)

      const { app: bare } = makeApp()
      expect((await bare.request('/api/netdisk/reconcile/suggestions')).status).toBe(503)
    })

    it('reconcile service 未装配（无 netdisk 配置）→ 503', async () => {
      const { app: appWithoutReconcile } = makeApp()
      const res = await appWithoutReconcile.request('/api/netdisk/reconcile/yile/preview', { method: 'POST' })
      expect(res.status).toBe(503)
    })

    it('PUT /api/netdisk/reconcile/config：source/lib 目录重叠(ValidationError) → 400,不是 500/404', async () => {
      const { ValidationError } = await import('../netdisk/reconcile/service.ts')
      const { app } = makeApp({
        reconcile: { putConfig: vi.fn(() => { throw new ValidationError('overlap') }) },
      })
      const res = await app.request('/api/netdisk/reconcile/config', {
        method: 'PUT', body: JSON.stringify({ shows: [] }), headers: { 'content-type': 'application/json' },
      })
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('validation_error')
    })
  })

  // 查权威清单的唯一一扇门。存在的理由：`/api/items` 上挂着播放投影（付费集没配上 → 音频换成
  // 封面图，时长全没），拿它判"库里存了什么"必然得出假结论。
  describe('reconcile 权威清单查询', () => {
    // `source` 是清单自己申报的取数口——门是纯透传，少一格就说明有人在路上把它吃掉了。
    const VIEW = { entries: [{ leftKey: 'item:a', title: '750', durationS: 1000, paid: true }], stats: { entries: 1, paid: 1, withDuration: 1 }, source: 'stream:s1' }

    it('GET /:show/authority → 200 {entries, stats}，showId 原样传给服务', async () => {
      const authority = vi.fn(async () => VIEW)
      const { app } = makeApp({ reconcile: { authority } })
      const res = await app.request('/api/netdisk/reconcile/yile/authority')
      expect(res.status).toBe(200)
      expect(authority).toHaveBeenCalledWith('yile')
      // 时长必须原样带出来——这扇门存在的全部理由就是它在投影里会消失。
      expect(await res.json()).toEqual(VIEW)
    })

    it('GET /bindings/:id/authority → 200，bindingId 原样传给服务', async () => {
      const authorityForBinding = vi.fn(async () => VIEW)
      const { app } = makeApp({ reconcile: { authorityForBinding } })
      const res = await app.request('/api/netdisk/reconcile/bindings/map_1/authority')
      expect(res.status).toBe(200)
      expect(authorityForBinding).toHaveBeenCalledWith('map_1')
    })

    it('未知 show → 404', async () => {
      const { app } = makeApp({ reconcile: { authority: vi.fn(async () => { throw new Error('unknown show: nope') }) } })
      expect((await app.request('/api/netdisk/reconcile/nope/authority')).status).toBe(404)
    })

    // 网盘入口靠这条答"你该用整理还是该挂载"。它必须走 `streams/` 这一段而不是被前面那条
    // `/:show/authority` 吃掉——真被吃掉的表现是拿 "streams" 当 showId 去查配置，然后 404。
    it('GET /streams/:id/authority → 200，streamId 原样传给服务（不经 show 配置）', async () => {
      const authorityForStream = vi.fn(async () => VIEW)
      const authority = vi.fn(async () => VIEW)
      const { app } = makeApp({ reconcile: { authorityForStream, authority } })
      const res = await app.request('/api/netdisk/reconcile/streams/lizhi-yile/authority')
      expect(res.status).toBe(200)
      expect(authorityForStream).toHaveBeenCalledWith('lizhi-yile')
      expect(authority).not.toHaveBeenCalled()
    })

    it('reconcile service 未装配 → 503（三条都是）', async () => {
      const { app } = makeApp()
      expect((await app.request('/api/netdisk/reconcile/yile/authority')).status).toBe(503)
      expect((await app.request('/api/netdisk/reconcile/bindings/map_1/authority')).status).toBe(503)
      expect((await app.request('/api/netdisk/reconcile/streams/s1/authority')).status).toBe(503)
    })
  })

  // 影视「一键去重」的两步：先出将删清单，人确认后才执行（删除类动作必过预览，spec §5）。
  describe('reconcile 按绑定的原地整理', () => {
    it('POST /bindings/:id/preview → 200，bindingId 原样传给服务', async () => {
      const previewBinding = vi.fn(async () => ({ plan: [], counts: { move: 0, deleteDup: 0, deleteLoser: 0, pending: 0 }, ledger: { runId: 'r1' } }))
      const { app } = makeApp({ reconcile: { previewBinding } })
      const res = await app.request('/api/netdisk/reconcile/bindings/map_1/preview', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(previewBinding).toHaveBeenCalledWith('map_1')
      expect(await res.json()).toHaveProperty('counts')
    })

    it('POST /bindings/:id/execute → 200 {moved, deleted, errors}', async () => {
      const executeBinding = vi.fn(async () => ({ moved: 0, deleted: 2, pending: 1, errors: [], ledger: { runId: 'r2' } }))
      const { app } = makeApp({ reconcile: { executeBinding } })
      const res = await app.request('/api/netdisk/reconcile/bindings/map_1/execute', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(executeBinding).toHaveBeenCalledWith('map_1')
      expect(await res.json()).toMatchObject({ deleted: 2 })
    })

    it('绑定不存在 → 404 not_found（原文带上,那是用户唯一的线索）', async () => {
      const { app } = makeApp({
        reconcile: { previewBinding: vi.fn(async () => { throw new Error('unknown binding: nope') }) },
      })
      const res = await app.request('/api/netdisk/reconcile/bindings/nope/preview', { method: 'POST' })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error.code).toBe('not_found')
      expect(body.error.message).toContain('unknown binding')
    })

    // 货架解不出来/不能用是配置问题（用户改得动），不是"找不到"——别混成 404/500。
    it('ValidationError → 400 validation_error', async () => {
      const { ValidationError } = await import('../netdisk/reconcile/service.ts')
      const { app } = makeApp({
        reconcile: { executeBinding: vi.fn(async () => { throw new ValidationError('没有落地目录') }) },
      })
      const res = await app.request('/api/netdisk/reconcile/bindings/map_1/execute', { method: 'POST' })
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('validation_error')
    })

    it('reconcile 未装配 → 503', async () => {
      const { app } = makeApp()
      expect((await app.request('/api/netdisk/reconcile/bindings/map_1/preview', { method: 'POST' })).status).toBe(503)
      expect((await app.request('/api/netdisk/reconcile/bindings/map_1/execute', { method: 'POST' })).status).toBe(503)
    })
  })
})

/**
 * 严格输入闸（docs/API.md §2）：写错一个键名过去曾是 200 + 一份看起来正常的响应，
 * 界面撞不到（字段名写死在前端），程序化调用方一撞一个准。这里逐个端点钉住三件事：
 * 400 + 指出该写哪个 + **副作用一个都没发生**（不是"改了但没改到"）。
 */
describe('netdisk 写入面：不认识的键 → 400，绝不静默丢弃', () => {
  const spy = {
    bind: vi.fn(async () => sampleSet()),
    rebind: vi.fn(async () => sampleSet()),
    setEntry: vi.fn(() => sampleSet()),
    previewSpec: vi.fn(async () => ({})),
    applySpec: vi.fn(async () => sampleSet()),
    mkdir: vi.fn(async () => {}),
    move: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    setAlistMounts: vi.fn(),
    putConfig: vi.fn(),
    undo: vi.fn(async () => {}),
  }

  function gatedApp() {
    for (const fn of Object.values(spy)) fn.mockClear()
    const app = new Hono()
    registerNetdiskRoutes(app, {
      store: { list: vi.fn(() => []), get: vi.fn(() => sampleSet()), remove: vi.fn() },
      service: {
        bind: spy.bind, rebind: spy.rebind, setEntry: spy.setEntry,
        previewSpec: spy.previewSpec, applySpec: spy.applySpec,
      },
      alist: {
        mkdir: spy.mkdir, move: spy.move, remove: spy.remove, rename: spy.rename,
        listStorages: vi.fn(async () => []),
      },
      settings: { get: vi.fn(() => ({})), setAlistMounts: spy.setAlistMounts },
      fetchCookies: vi.fn(async () => ({})),
      reconcile: { putConfig: spy.putConfig, undo: spy.undo },
    } as unknown as NetdiskDeps)
    return app
  }

  // 每行：端点 / 打过去的错键 / 它该被指向的那个合法键 / 一旦放行就会被调到的那个副作用
  const cases: Array<{
    name: string; method: string; path: string; body: Record<string, unknown>
    bad: string; hint: string; effect: keyof typeof spy
  }> = [
    { name: 'POST mappings', method: 'POST', path: '/api/netdisk/mappings', body: { streamId: 's', dir_path: '/d' }, bad: 'dir_path', hint: 'dirPath', effect: 'bind' },
    { name: 'POST mappings/:id/rebind', method: 'POST', path: '/api/netdisk/mappings/map_1/rebind', body: { dir_path: '/d' }, bad: 'dir_path', hint: 'dirPath', effect: 'rebind' },
    { name: 'PATCH mappings/:id/entries/:leftKey', method: 'PATCH', path: '/api/netdisk/mappings/map_1/entries/k', body: { right_file: 'a.mp3' }, bad: 'right_file', hint: 'rightFile', effect: 'setEntry' },
    { name: 'POST spec/preview', method: 'POST', path: '/api/netdisk/mappings/map_1/spec/preview', body: { specs: {} }, bad: 'specs', hint: 'spec', effect: 'previewSpec' },
    { name: 'POST spec/apply', method: 'POST', path: '/api/netdisk/mappings/map_1/spec/apply', body: { specs: {} }, bad: 'specs', hint: 'spec', effect: 'applySpec' },
    { name: 'POST fs/mkdir', method: 'POST', path: '/api/netdisk/fs/mkdir', body: { dirPath: '/d/x' }, bad: 'dirPath', hint: 'path', effect: 'mkdir' },
    { name: 'POST fs/move', method: 'POST', path: '/api/netdisk/fs/move', body: { src_dir: '/a', dstDir: '/b', names: ['x'] }, bad: 'src_dir', hint: 'srcDir', effect: 'move' },
    { name: 'POST fs/remove', method: 'POST', path: '/api/netdisk/fs/remove', body: { dirs: '/a', names: ['x'] }, bad: 'dirs', hint: 'dir', effect: 'remove' },
    { name: 'POST fs/rename', method: 'POST', path: '/api/netdisk/fs/rename', body: { path: '/a/x', newName: 'y' }, bad: 'newName', hint: 'name', effect: 'rename' },
    { name: 'PUT mounts', method: 'PUT', path: '/api/netdisk/mounts', body: { mount: [] }, bad: 'mount', hint: 'mounts', effect: 'setAlistMounts' },
    { name: 'PUT reconcile/config', method: 'PUT', path: '/api/netdisk/reconcile/config', body: { show: [] }, bad: 'show', hint: 'shows', effect: 'putConfig' },
    { name: 'POST reconcile/undo', method: 'POST', path: '/api/netdisk/reconcile/undo', body: { runId: 'r1' }, bad: 'runId', hint: 'id', effect: 'undo' },
  ]

  for (const t of cases) {
    it(`${t.name} 传 ${t.bad} → 400 并指向 ${t.hint}`, async () => {
      const app = gatedApp()
      const res = await app.request(t.path, {
        method: t.method, body: JSON.stringify(t.body), headers: { 'content-type': 'application/json' },
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('validation_error')
      // 必须是**这道闸**说的话，不是碰巧撞上某条形状校验（`shows[] required` 里也含 "show"）。
      expect(body.error.message).toContain('不认识的字段')
      expect(body.error.message).toContain(t.bad)
      expect(body.error.message).toContain(t.hint)
      expect(spy[t.effect]).not.toHaveBeenCalled()
    })
  }

  it('合法键照常放行——闸不是把正常调用挡在门外', async () => {
    const app = gatedApp()
    const res = await app.request('/api/netdisk/fs/mkdir', {
      method: 'POST', body: JSON.stringify({ path: '/d/x' }), headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(spy.mkdir).toHaveBeenCalledWith('/d/x')
  })
})
