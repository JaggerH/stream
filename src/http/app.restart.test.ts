import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHttpApiFixture, type HttpApiFixture } from './__fixtures__/app-harness.ts'

let fixture: HttpApiFixture
beforeEach(() => { fixture = createHttpApiFixture() })
afterEach(() => { fixture.close() })

describe('POST /api/restart', () => {
  it('有正在跑的任务 → 409 列出它们，不触发', async () => {
    const trigger = vi.fn(async () => 'supervised' as const)
    const app = fixture.build(undefined, { restart: { running: async () => [{ id: 'eastmoney-login', label: '东财登录' }], trigger } })
    const res = await app.request('/api/restart', { method: 'POST' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: { code: 'conflict', message: expect.stringContaining('东财登录') }, running: [{ id: 'eastmoney-login', label: '东财登录' }] })
    expect(trigger).not.toHaveBeenCalled()
  })
  it('?force=1 越过闸门', async () => {
    const trigger = vi.fn(async () => 'reexec' as const)
    const app = fixture.build(undefined, { restart: { running: async () => [{ id: 'x', label: 'x' }], trigger } })
    const res = await app.request('/api/restart?force=1', { method: 'POST' })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ mode: 'reexec' })
    expect(trigger).toHaveBeenCalledTimes(1)
  })
  it('trigger 拒绝（开机窗口 still booting）→ 500，不是崩', async () => {
    const app = fixture.build(undefined, { restart: { running: async () => [], trigger: async () => { throw new Error('backend still booting — retry in a moment') } } })
    const res = await app.request('/api/restart', { method: 'POST' })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).toContain('still booting')
  })
  it('没在跑的 → 202 + mode；没接 restart → 503', async () => {
    const app = fixture.build(undefined, { restart: { running: async () => [], trigger: async () => 'supervised' as const } })
    expect((await app.request('/api/restart', { method: 'POST' })).status).toBe(202)
    expect((await fixture.build(undefined, {}).request('/api/restart', { method: 'POST' })).status).toBe(503)
  })
})
