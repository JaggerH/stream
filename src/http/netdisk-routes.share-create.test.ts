import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { registerNetdiskRoutes, type NetdiskDeps } from './netdisk-routes.ts'
import { ShareCreateError } from '../netdisk/share-create.ts'

/** `POST /api/netdisk/share/create`：网盘内目录 → 夸克分享链接（+ 提取码）。下游导出脚本首发时调一次。 */
function makeApp(shareCreate?: ReturnType<typeof vi.fn>) {
  const app = new Hono()
  registerNetdiskRoutes(app, { alist: {}, service: {}, store: {}, shareCreate } as unknown as NetdiskDeps)
  return app
}
const post = (app: Hono, body: unknown) =>
  app.request('/api/netdisk/share/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('POST /api/netdisk/share/create', () => {
  it('path + passcode + expireDays → {url, passcode}', async () => {
    const fn = vi.fn(async () => ({ url: 'https://pan.quark.cn/s/abc', passcode: '1234', pwdId: 'abc' }))
    const res = await post(makeApp(fn), { path: '/quark/闲鱼数据包/pack-1', passcode: '1234', expireDays: 0 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: 'https://pan.quark.cn/s/abc', passcode: '1234', pwdId: 'abc' })
    expect(fn).toHaveBeenCalledWith({ path: '/quark/闲鱼数据包/pack-1', passcode: '1234', expireDays: 0 })
  })

  it('passcode 缺省 = 不设提取码；给了就必须是 4 位字母数字', async () => {
    const fn = vi.fn(async () => ({ url: 'u', passcode: undefined, pwdId: 'p' }))
    const app = makeApp(fn)
    expect((await post(app, { path: '/quark/a' })).status).toBe(200)
    expect(fn).toHaveBeenCalledWith({ path: '/quark/a', passcode: undefined, expireDays: undefined })
    expect((await post(app, { path: '/quark/a', passcode: '12345' })).status).toBe(400)
    expect((await post(app, { path: '/quark/a', passcode: 'a-1!' })).status).toBe(400)
    expect((await post(app, { path: '/quark/a', expireDays: -1 })).status).toBe(400)
    expect((await post(app, { path: '/quark/a', expireDays: '0' })).status).toBe(400)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('缺 path / 认不出的字段 → 400；未装配 → 503', async () => {
    const fn = vi.fn()
    expect((await post(makeApp(fn), {})).status).toBe(400)
    const bad = await post(makeApp(fn), { dir: '/quark/a' })
    expect(bad.status).toBe(400)
    expect((await bad.json() as { error: { message: string } }).error.message).toContain('path')
    expect(fn).not.toHaveBeenCalled()
    expect((await post(makeApp(undefined), { path: '/quark/a' })).status).toBe(503)
  })

  it('编排层的错误按 code 翻成状态：unsupported 501 / not_found 404 / unavailable 503 / upstream_error 502', async () => {
    for (const [code, status] of [['unsupported', 501], ['not_found', 404], ['unavailable', 503], ['upstream_error', 502], ['validation_error', 400]] as const) {
      const res = await post(makeApp(vi.fn(async () => { throw new ShareCreateError(code, `msg ${code}`) })), { path: '/quark/a' })
      expect(res.status, code).toBe(status)
      expect(await res.json()).toEqual({ error: { code, message: `msg ${code}` } })
    }
  })
})
