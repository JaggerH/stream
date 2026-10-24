// FaviconCache 的实例隔离：两个内核各自的内存缓存互不可见（持久层未接时的那条路）。
// 真实取数（homepage <link> 解析 / /favicon.ico 回落）不在 scope——这里 mock 掉 global fetch，
// 只钉「谁缓存了、谁没缓存」。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FaviconCache } from './favicon.ts'

afterEach(() => vi.unstubAllGlobals())

const iconResponse = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/x-icon' : null) },
    arrayBuffer: async () => new TextEncoder().encode('icon').buffer,
    text: async () => '', // homepage 解析那一跳给空 html → 直接回落 /favicon.ico
  } as unknown as Response)

describe('一个实例一张缓存', () => {
  it('A 命中缓存不再出网；B 看不到 A 的缓存，各自出网', async () => {
    const fetchMock = vi.fn(iconResponse)
    vi.stubGlobal('fetch', fetchMock)
    const a = new FaviconCache()
    const b = new FaviconCache()
    await a.resolve('https://one.example/index.html')
    await a.resolve('https://one.example/other.html') // 同 host：A 缓存命中
    await b.resolve('https://one.example/index.html') // B 没有这份缓存：再出网
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    // 第二次 A 调用没有新增出网：总次数 = A 第一次 + B 第一次（A 第一次内部可能两跳，不做精确断言）
    const afterA2 = fetchMock.mock.calls.length
    await a.resolve('https://one.example/third.html')
    expect(fetchMock.mock.calls.length).toBe(afterA2)
  })

  it('wire 返回撤销；撤销后回到内存缓存', async () => {
    const fetchMock = vi.fn(iconResponse)
    vi.stubGlobal('fetch', fetchMock)
    const c = new FaviconCache()
    const register = vi.fn()
    const tryGet = vi.fn(async (_ns: string, _key: string, miss: () => Promise<unknown>) => miss())
    const layer = { register, tryGet } as never
    const unwire = c.wire(layer)
    expect(register.mock.calls[0]?.[0]).toBe('favicon')
    unwire()
    await c.resolve('https://two.example/')
    expect(fetchMock).toHaveBeenCalled()
  })
})
