import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { registerNetdiskRoutes, type NetdiskDeps } from './netdisk-routes.ts'

function makeApp(remove = vi.fn(async () => {})) {
  const app = new Hono()
  registerNetdiskRoutes(app, { alist: { remove }, service: {}, store: {} } as unknown as NetdiskDeps)
  return { app, remove }
}
const post = (app: Hono, body: unknown) =>
  app.request('/api/netdisk/fs/remove', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

describe('POST /api/netdisk/fs/remove', () => {
  it('删除指定目录下的文件', async () => {
    const { app, remove } = makeApp()
    const res = await post(app, { dir: '/quark/lib/下架', names: ['怡乐·455.现代版木仓下留人.mp3'] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, removed: 1 })
    expect(remove).toHaveBeenCalledWith('/quark/lib/下架', ['怡乐·455.现代版木仓下留人.mp3'])
  })

  it('缺 dir / names 空 → 400,且不碰网盘(空 names 一律当参数错,别静默成功)', async () => {
    const { app, remove } = makeApp()
    expect((await post(app, { names: ['x.mp3'] })).status).toBe(400)
    expect((await post(app, { dir: '/d' })).status).toBe(400)
    expect((await post(app, { dir: '/d', names: [] })).status).toBe(400)
    expect(remove).not.toHaveBeenCalled()
  })

  it('上游失败 → 502', async () => {
    const { app } = makeApp(vi.fn(async () => { throw new Error('alist down') }))
    const res = await post(app, { dir: '/d', names: ['x.mp3'] })
    expect(res.status).toBe(502)
  })
})
