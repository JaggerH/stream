import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { registerNetdiskRoutes, type NetdiskDeps } from './netdisk-routes.ts'
import { ShareCreateError } from '../netdisk/share-create.ts'

/** `GET /api/netdisk/share/list` + `POST /api/netdisk/share/delete`：建出去的链接之后归谁管。 */
function makeApp(over: Partial<NetdiskDeps>) {
  const app = new Hono()
  registerNetdiskRoutes(app, { alist: {}, service: {}, store: {}, ...over } as unknown as NetdiskDeps)
  return app
}
const del = (app: Hono, body: unknown) =>
  app.request('/api/netdisk/share/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('GET /api/netdisk/share/list', () => {
  it('page / size 透传；回 {items,page,size,total}', async () => {
    const shareList = vi.fn(async () => ({ items: [{ shareId: 's1', pwdId: 'p1' }], page: 2, size: 8, total: 20 }))
    const res = await makeApp({ shareList } as never).request('/api/netdisk/share/list?page=2&size=8')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [{ shareId: 's1', pwdId: 'p1' }], page: 2, size: 8, total: 20 })
    expect(shareList).toHaveBeenCalledWith({ page: 2, size: 8 })
  })

  it('不带参数 = 交给编排层的缺省（不在这里再抄一份默认值）', async () => {
    const shareList = vi.fn(async () => ({ items: [], page: 1, size: 50, total: 0 }))
    expect((await makeApp({ shareList } as never).request('/api/netdisk/share/list')).status).toBe(200)
    expect(shareList).toHaveBeenCalledWith({ page: undefined, size: undefined })
  })

  it('page/size 不是整数 → 400，不往下打（笔误不该被当成"第 0 页"静默生效）', async () => {
    const shareList = vi.fn()
    const app = makeApp({ shareList } as never)
    expect((await app.request('/api/netdisk/share/list?page=1x')).status).toBe(400)
    expect((await app.request('/api/netdisk/share/list?size=abc')).status).toBe(400)
    expect((await app.request('/api/netdisk/share/list?page=1.5')).status).toBe(400)
    expect(shareList).not.toHaveBeenCalled()
  })

  it('编排层的错误按 code 翻状态；未装配 → 503', async () => {
    for (const [code, status] of [['validation_error', 400], ['unavailable', 503], ['upstream_error', 502]] as const) {
      const app = makeApp({ shareList: vi.fn(async () => { throw new ShareCreateError(code, `msg ${code}`) }) } as never)
      const res = await app.request('/api/netdisk/share/list')
      expect(res.status, code).toBe(status)
      expect(await res.json()).toEqual({ error: { code, message: `msg ${code}` } })
    }
    expect((await makeApp({}).request('/api/netdisk/share/list')).status).toBe(503)
  })
})

describe('POST /api/netdisk/share/delete', () => {
  it('批量删 → 200 逐条结果；一条失败其余照常（failed>0 仍是 200，判据在 body 里）', async () => {
    const shareDelete = vi.fn(async () => ({
      results: [{ shareId: 's1', ok: true }, { shareId: 's2', ok: false, message: 'inner error' }],
      deleted: 1, failed: 1,
    }))
    const res = await del(makeApp({ shareDelete } as never), { shareIds: ['s1', 's2'] })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ deleted: 1, failed: 1 })
    expect(shareDelete).toHaveBeenCalledWith({ shareIds: ['s1', 's2'] })
  })

  it('空数组 / 非字符串项 / 认不出的字段 → 400，一条都不删', async () => {
    const shareDelete = vi.fn()
    const app = makeApp({ shareDelete } as never)
    expect((await del(app, {})).status).toBe(400)
    expect((await del(app, { shareIds: [] })).status).toBe(400)
    expect((await del(app, { shareIds: ['s1', 3] })).status).toBe(400)
    expect((await del(app, { shareIds: ['s1', ''] })).status).toBe(400)
    const bad = await del(app, { ids: ['s1'] })
    expect(bad.status).toBe(400)
    expect((await bad.json() as { error: { message: string } }).error.message).toContain('shareIds')
    expect(shareDelete).not.toHaveBeenCalled()
  })

  it('编排层的错误按 code 翻状态；未装配 → 503', async () => {
    for (const [code, status] of [['validation_error', 400], ['unavailable', 503], ['upstream_error', 502]] as const) {
      const app = makeApp({ shareDelete: vi.fn(async () => { throw new ShareCreateError(code, `msg ${code}`) }) } as never)
      const res = await del(app, { shareIds: ['s1'] })
      expect(res.status, code).toBe(status)
    }
    expect((await del(makeApp({}), { shareIds: ['s1'] })).status).toBe(503)
  })
})
