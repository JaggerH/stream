import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { registerNetdiskRoutes, type NetdiskDeps } from './netdisk-routes.ts'

/** DELETE /api/netdisk/mappings/:id —— 单删绑定，以及 `?files=1` 连网盘目录一起删。 */
function makeApp(opts?: { path?: string; remove?: () => Promise<void>; missing?: boolean }) {
  const alistRemove = vi.fn(opts?.remove ?? (async () => {}))
  const storeRemove = vi.fn()
  const app = new Hono()
  registerNetdiskRoutes(app, {
    alist: { remove: alistRemove },
    service: {},
    store: {
      remove: storeRemove,
      get: (id: string) =>
        opts?.missing ? undefined : { id, right: { path: opts?.path ?? '/quark/From Stream/tv-286506' } },
    },
  } as unknown as NetdiskDeps)
  return { app, alistRemove, storeRemove }
}
const del = (app: Hono, q = '') => app.request(`/api/netdisk/mappings/m1${q}`, { method: 'DELETE' })

describe('DELETE /api/netdisk/mappings/:id', () => {
  it('默认只删绑定，不碰网盘文件', async () => {
    const { app, alistRemove, storeRemove } = makeApp()
    const res = await del(app)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(alistRemove).not.toHaveBeenCalled()
    expect(storeRemove).toHaveBeenCalledWith('m1')
  })

  it('files=1 → 删目录再删绑定（目录名从绑定记录里取，不收客户端传的路径）', async () => {
    const { app, alistRemove, storeRemove } = makeApp()
    const res = await del(app, '?files=1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, filesDeleted: true, dirPath: '/quark/From Stream/tv-286506' })
    expect(alistRemove).toHaveBeenCalledWith('/quark/From Stream', ['tv-286506'])
    expect(storeRemove).toHaveBeenCalledWith('m1')
  })

  it('删文件失败 → 502 且绑定保留（文件还在盘上，删掉唯一指向它们的记录是二次伤害）', async () => {
    const { app, storeRemove } = makeApp({
      remove: async () => {
        throw new Error('alist down')
      },
    })
    const res = await del(app, '?files=1')
    expect(res.status).toBe(502)
    expect(storeRemove).not.toHaveBeenCalled()
  })

  it('绑定指向挂载根 → 400，不下手（那是把整个网盘挂载点端掉）', async () => {
    const { app, alistRemove, storeRemove } = makeApp({ path: '/quark' })
    const res = await del(app, '?files=1')
    expect(res.status).toBe(400)
    expect(alistRemove).not.toHaveBeenCalled()
    expect(storeRemove).not.toHaveBeenCalled()
  })

  it('绑定不存在 → 404，不碰网盘', async () => {
    const { app, alistRemove } = makeApp({ missing: true })
    expect((await del(app, '?files=1')).status).toBe(404)
    expect(alistRemove).not.toHaveBeenCalled()
  })
})
