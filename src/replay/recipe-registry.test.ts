import { describe, expect, it } from 'vitest'
import { npmRegistryClient, officialRegistryIfMirror, OFFICIAL_REGISTRY } from './recipe-registry.ts'

describe('npmRegistryClient', () => {
  it('fetches packument with scope slash encoded', async () => {
    const calls: string[] = []
    const fake = (async (url: RequestInfo | URL) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ 'dist-tags': { latest: '1.2.0' }, versions: {} }))
    }) as typeof fetch
    const c = npmRegistryClient('https://reg.example', fake)
    const p = await c.packument('@streamapp/xhs')
    expect(calls[0]).toBe('https://reg.example/@streamapp%2fxhs')
    expect(p['dist-tags'].latest).toBe('1.2.0')
  })
  it('encodes every slash, not just the first', async () => {
    const calls: string[] = []
    const fake = (async (url: RequestInfo | URL) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ 'dist-tags': { latest: '1.0.0' }, versions: {} }))
    }) as typeof fetch
    await npmRegistryClient('https://reg.example', fake).packument('@scope/pkg/sub')
    expect(calls[0]).toBe('https://reg.example/@scope%2fpkg%2fsub')
  })
  it('throws a readable error on 404', async () => {
    const fake = (async () => new Response('not found', { status: 404 })) as typeof fetch
    await expect(npmRegistryClient('https://reg.example', fake).packument('@x/y')).rejects.toThrow(/404/)
  })
  it('downloads tarball as Buffer', async () => {
    const fake = (async () => new Response(Uint8Array.from([1, 2, 3]))) as typeof fetch
    const buf = await npmRegistryClient('https://reg.example', fake).tarball('https://reg.example/t.tgz')
    expect([...buf]).toEqual([1, 2, 3])
  })
})

describe('npmRegistryClient.search', () => {
  const searchResponse = {
    objects: [
      { package: { name: '@streamapp/xhs', version: '1.2.0', description: '小红书' } },
      { package: { name: '@streamapp/telegram', version: '0.3.1' } },
      { package: { name: '@broken/no-version' } },
    ],
  }

  it('把关键词编码进 query，并由服务端固定拼上 stream-recipe 关键词限定', async () => {
    const calls: string[] = []
    const fake = (async (url: RequestInfo | URL) => {
      calls.push(String(url))
      return new Response(JSON.stringify(searchResponse))
    }) as typeof fetch
    await npmRegistryClient('https://reg.example', fake).search('xhs')
    expect(calls[0]).toBe('https://reg.example/-/v1/search?text=xhs%20keywords%3Astream-recipe&size=50')
  })

  it('调用方塞进来的 registry / URL 参数进不去——地址只由构造时的 base 决定', async () => {
    const calls: string[] = []
    const fake = (async (url: RequestInfo | URL) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ objects: [] }))
    }) as typeof fetch
    await npmRegistryClient('https://reg.example', fake).search('https://evil.example/-/v1/search?text=x')
    expect(calls[0]!.startsWith('https://reg.example/-/v1/search?text=')).toBe(true)
    expect(calls[0]).not.toContain('//evil.example')
  })

  it('把 registry 的返回收窄成 {name,version,description}，缺 version 的条目丢掉', async () => {
    const fake = (async () => new Response(JSON.stringify(searchResponse))) as typeof fetch
    const hits = await npmRegistryClient('https://reg.example', fake).search('x')
    expect(hits).toEqual([
      { name: '@streamapp/xhs', version: '1.2.0', description: '小红书' },
      { name: '@streamapp/telegram', version: '0.3.1', description: '' },
    ])
  })

  it('非 2xx 抛可读错误', async () => {
    const fake = (async () => new Response('boom', { status: 502 })) as typeof fetch
    await expect(npmRegistryClient('https://reg.example', fake).search('x')).rejects.toThrow(/502/)
  })
})

describe('officialRegistryIfMirror', () => {
  const noFetch = (async () => { throw new Error('should not fetch') }) as unknown as typeof fetch
  it('主 registry 就是官方源（含尾斜杠 / 大小写）→ undefined，不多核', () => {
    expect(officialRegistryIfMirror(OFFICIAL_REGISTRY, noFetch)).toBeUndefined()
    expect(officialRegistryIfMirror('https://registry.npmjs.org/', noFetch)).toBeUndefined()
    expect(officialRegistryIfMirror('https://REGISTRY.NPMJS.ORG', noFetch)).toBeUndefined()
  })
  it('镜像 → 返回一个打官方源的客户端', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(url)
      return { ok: true, json: async () => ({ 'dist-tags': {}, versions: {} }) }
    }) as unknown as typeof fetch
    const official = officialRegistryIfMirror('https://registry.npmmirror.com', fetchImpl)
    expect(official).toBeDefined()
    await official!.packument('@streamapp/wechat')
    expect(urls).toEqual([`${OFFICIAL_REGISTRY}/@streamapp%2fwechat`])
  })
  it('base 不是合法 URL → 当镜像（核不上就不给凭据，宁可多核）', () => {
    expect(officialRegistryIfMirror('not a url', noFetch)).toBeDefined()
  })
})
