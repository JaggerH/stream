import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, type Connection } from './api.ts'

const conn: Connection = { baseUrl: 'http://backend' }
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))

describe('recipe 市场 API 客户端', () => {
  it('searchRecipePackages 把查询词编进 q', async () => {
    fetchMock.mockReturnValue(ok([{ name: '@streamapp/xhs', version: '1.2.0', description: '小红书' }]))
    const hits = await api.searchRecipePackages(conn, '小红 书')
    expect(fetchMock.mock.calls[0][0]).toBe('http://backend/api/recipes/packages/search?q=%E5%B0%8F%E7%BA%A2%20%E4%B9%A6')
    expect(hits[0].name).toBe('@streamapp/xhs')
  })

  it('listInstalledRecipePackages 打 GET /api/recipes/packages', async () => {
    fetchMock.mockReturnValue(ok([{ name: '@streamapp/xhs', version: '1.2.0', facility: 'xhs', sourceIds: ['xhs-home'] }]))
    const list = await api.listInstalledRecipePackages(conn)
    expect(fetchMock.mock.calls[0][0]).toBe('http://backend/api/recipes/packages')
    expect(list[0].sourceIds).toEqual(['xhs-home'])
  })

  it('previewRecipePackage POST name+version', async () => {
    fetchMock.mockReturnValue(ok({ name: '@streamapp/xhs', version: '1.2.0', facility: 'xhs', recipes: [], overrides: [], confirm: 'sha512-x' }))
    const preview = await api.previewRecipePackage(conn, '@streamapp/xhs', '1.2.0')
    expect(fetchMock.mock.calls[0][0]).toBe('http://backend/api/recipes/packages/preview')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: '@streamapp/xhs', version: '1.2.0' })
    expect(preview.confirm).toBe('sha512-x')
  })

  it('installRecipePackage 带 confirm 凭据', async () => {
    fetchMock.mockReturnValue(ok({ dir: '/data/recipes/streamapp__xhs', version: '1.2.0' }))
    await api.installRecipePackage(conn, '@streamapp/xhs', '1.2.0', 'sha512-x')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: '@streamapp/xhs', version: '1.2.0', confirm: 'sha512-x' })
  })

  it('uninstallRecipePackage POST name', async () => {
    fetchMock.mockReturnValue(ok({ removed: true }))
    const res = await api.uninstallRecipePackage(conn, '@streamapp/xhs')
    expect(fetchMock.mock.calls[0][0]).toBe('http://backend/api/recipes/packages/uninstall')
    expect(res.removed).toBe(true)
  })

  it('recipePackageUpdates 打 GET /api/recipes/packages/updates', async () => {
    fetchMock.mockReturnValue(ok([{ name: '@streamapp/xhs', installed: '1.0.0', latest: '1.2.0' }]))
    const ups = await api.recipePackageUpdates(conn)
    expect(fetchMock.mock.calls[0][0]).toBe('http://backend/api/recipes/packages/updates')
    expect(ups[0].latest).toBe('1.2.0')
  })

  it('503 抛出的 ApiError 带得住 status（页面据此渲染「未启用」而不是报错）', async () => {
    fetchMock.mockReturnValue(Promise.resolve(new Response(JSON.stringify({ error: { code: 'unavailable', message: 'recipe package ops not configured' } }), { status: 503, headers: { 'content-type': 'application/json' } })))
    await expect(api.listInstalledRecipePackages(conn)).rejects.toMatchObject({ status: 503 })
    await expect(api.listInstalledRecipePackages(conn)).rejects.toBeInstanceOf(ApiError)
  })
})
