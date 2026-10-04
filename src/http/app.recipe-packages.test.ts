import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHttpApiFixture, type HttpApiFixture } from './__fixtures__/app-harness.ts'
import type { HttpDeps } from './app.ts'

let fixture: HttpApiFixture
beforeEach(() => { fixture = createHttpApiFixture() })
afterEach(() => { fixture.close() })

function stubOps(overrides: Partial<NonNullable<HttpDeps['recipePackageOps']>> = {}): NonNullable<HttpDeps['recipePackageOps']> {
  return {
    preview: vi.fn(async (name: string, version?: string) => ({ name, version: version ?? 'latest', confirm: 'sha512-x' })),
    install: vi.fn(async () => ({ dir: '/tmp/x', version: '1.0.0' })),
    uninstall: vi.fn(async () => true),
    updates: vi.fn(async () => [{ name: 'pkg', installed: '1.0.0', latest: '1.1.0' }]),
    search: vi.fn(async () => [{ name: '@streamapp/xhs', version: '1.2.0', description: '小红书' }]),
    listInstalled: vi.fn(async () => [{ name: '@streamapp/xhs', version: '1.2.0', facility: 'xhs', sourceIds: ['xhs-home'] }]),
    ...overrides,
  }
}

describe('recipe package HTTP endpoints', () => {
  it('POST /api/recipes/packages/preview transparently returns the service result', async () => {
    const ops = stubOps()
    const app = fixture.build(undefined, { recipePackageOps: ops })
    const res = await app.request('/api/recipes/packages/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@scope/pkg', version: '2.0.0' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: '@scope/pkg', version: '2.0.0', confirm: 'sha512-x' })
    expect(ops.preview).toHaveBeenCalledWith('@scope/pkg', '2.0.0')
  })

  it('POST /api/recipes/packages/install without confirm → 400', async () => {
    const ops = stubOps()
    const app = fixture.build(undefined, { recipePackageOps: ops })
    const res = await app.request('/api/recipes/packages/install', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@scope/pkg' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toMatch(/confirm/)
    expect(ops.install).not.toHaveBeenCalled()
  })

  it('POST /api/recipes/packages/install with confirm succeeds', async () => {
    const ops = stubOps()
    const app = fixture.build(undefined, { recipePackageOps: ops })
    const res = await app.request('/api/recipes/packages/install', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@scope/pkg', version: '2.0.0', confirm: 'sha512-x' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ dir: '/tmp/x', version: '1.0.0' })
    expect(ops.install).toHaveBeenCalledWith('@scope/pkg', '2.0.0', 'sha512-x')
  })

  it('POST /api/recipes/packages/uninstall — not installed → 404', async () => {
    const ops = stubOps({ uninstall: vi.fn(async () => false) })
    const app = fixture.build(undefined, { recipePackageOps: ops })
    const res = await app.request('/api/recipes/packages/uninstall', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@scope/missing' }),
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error.message).toMatch(/not installed/)
  })

  it('POST /api/recipes/packages/uninstall — found → removed:true', async () => {
    const ops = stubOps()
    const app = fixture.build(undefined, { recipePackageOps: ops })
    const res = await app.request('/api/recipes/packages/uninstall', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@scope/pkg' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ removed: true })
  })

  it('GET /api/recipes/packages/updates transparently returns the service result', async () => {
    const ops = stubOps()
    const app = fixture.build(undefined, { recipePackageOps: ops })
    const res = await app.request('/api/recipes/packages/updates')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ name: 'pkg', installed: '1.0.0', latest: '1.1.0' }])
  })

  it('POST /api/recipes/packages/uninstall — service throws (e.g. multiple installed dirs claim the name) → 400', async () => {
    const ops = stubOps({ uninstall: vi.fn(async () => { throw new Error('multiple installed directories claim package name "@scope/pkg": a, b — remove the duplicate manually') }) })
    const app = fixture.build(undefined, { recipePackageOps: ops })
    const res = await app.request('/api/recipes/packages/uninstall', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@scope/pkg' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toMatch(/multiple installed directories/)
  })

  it('service function throws → 400 with the error message transparently passed through', async () => {
    const ops = stubOps({ preview: vi.fn(async () => { throw new Error('package foo: version 9.9.9 not in registry') }) })
    const app = fixture.build(undefined, { recipePackageOps: ops })
    const res = await app.request('/api/recipes/packages/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'foo', version: '9.9.9' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toBe('package foo: version 9.9.9 not in registry')
  })

  it('preview requires name → 400', async () => {
    const app = fixture.build(undefined, { recipePackageOps: stubOps() })
    const res = await app.request('/api/recipes/packages/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('all four routes 503 when recipePackageOps is not configured', async () => {
    const app = fixture.build() // no recipePackageOps injected
    const preview = await app.request('/api/recipes/packages/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) })
    const install = await app.request('/api/recipes/packages/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', confirm: 'y' }) })
    const uninstall = await app.request('/api/recipes/packages/uninstall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) })
    const updates = await app.request('/api/recipes/packages/updates')
    expect(preview.status).toBe(503)
    expect(install.status).toBe(503)
    expect(uninstall.status).toBe(503)
    expect(updates.status).toBe(503)
  })

  it('GET /api/recipes/packages/search 透传服务结果，q 原样交给服务', async () => {
    const ops = stubOps()
    const app = fixture.build(undefined, { recipePackageOps: ops })
    const res = await app.request('/api/recipes/packages/search?q=xhs')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ name: '@streamapp/xhs', version: '1.2.0', description: '小红书' }])
    expect(ops.search).toHaveBeenCalledWith('xhs')
  })

  it('GET /api/recipes/packages/search 缺 q → 400，且不打服务', async () => {
    const ops = stubOps()
    const app = fixture.build(undefined, { recipePackageOps: ops })
    const res = await app.request('/api/recipes/packages/search')
    expect(res.status).toBe(400)
    expect(ops.search).not.toHaveBeenCalled()
  })

  it('GET /api/recipes/packages/search 服务抛错 → 400 原样透出消息', async () => {
    const ops = stubOps({ search: vi.fn(async () => { throw new Error('registry 502 for search') }) })
    const app = fixture.build(undefined, { recipePackageOps: ops })
    const res = await app.request('/api/recipes/packages/search?q=xhs')
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toBe('registry 502 for search')
  })

  it('GET /api/recipes/packages/search 未接线 → 503（明确不可用，不静默失败）', async () => {
    const app = fixture.build()
    const res = await app.request('/api/recipes/packages/search?q=xhs')
    expect(res.status).toBe(503)
  })

  it('GET /api/recipes/packages 返回已装清单', async () => {
    const ops = stubOps()
    const app = fixture.build(undefined, { recipePackageOps: ops })
    const res = await app.request('/api/recipes/packages')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { name: '@streamapp/xhs', version: '1.2.0', facility: 'xhs', sourceIds: ['xhs-home'] },
    ])
  })

  it('GET /api/recipes/packages 没装任何包 → 空数组而非错误', async () => {
    const app = fixture.build(undefined, { recipePackageOps: stubOps({ listInstalled: vi.fn(async () => []) }) })
    const res = await app.request('/api/recipes/packages')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('GET /api/recipes/packages 服务抛错 → 400 原样透出消息', async () => {
    const ops = stubOps({ listInstalled: vi.fn(async () => { throw new Error('duplicate install dirs claim @streamapp/xhs') }) })
    const app = fixture.build(undefined, { recipePackageOps: ops })
    const res = await app.request('/api/recipes/packages')
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toBe('duplicate install dirs claim @streamapp/xhs')
  })

  it('GET /api/recipes/packages 未接线 → 503', async () => {
    const app = fixture.build()
    const res = await app.request('/api/recipes/packages')
    expect(res.status).toBe(503)
  })
})
