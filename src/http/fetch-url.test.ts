import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchUrl, legacyHostKeysOf, linkDispatchKeyOf, makeResolveByLink } from './fetch-url.ts'
import { SlotBrokenError } from '../providers/bindings.ts'
import { setLinkDebugSink, setLinkDeclarationSource, type LinkDebug } from '../links/recognize.ts'
import type { LinkTableEntry } from '../replay/recipe-package.ts'

const SITE: LinkTableEntry = { package: '@x/site', hosts: [{ host: 'site.test', platform: 'somesite' }], shortHosts: [], patterns: [] }

afterEach(() => { setLinkDeclarationSource(() => []); setLinkDebugSink(() => {}) })

describe('linkDispatchKeyOf —— content.enrich 的键 = <platform>-link', () => {
  it('被认领 → <platform>-link（子域同样）', () => {
    setLinkDeclarationSource(() => [SITE])
    expect(linkDispatchKeyOf('https://www.site.test/video/1')).toBe('somesite-link')
    expect(linkDispatchKeyOf('https://site.test/')).toBe('somesite-link')
  })
  it('没人认领 → null', () => {
    setLinkDeclarationSource(() => [SITE])
    expect(linkDispatchKeyOf('https://other.test/')).toBeNull()
  })
})

describe('legacyHostKeysOf（兼容层）', () => {
  it('完整主机在前，apex 在后', () => {
    expect(legacyHostKeysOf('https://www.site.test/a/b?c=1')).toEqual(['www.site.test', 'site.test'])
  })
  it('本来就是 apex → 只有一个键，不重复', () => {
    expect(legacyHostKeysOf('https://site.test/x')).toEqual(['site.test'])
  })
  it('多级子域也只退到 apex（两段）', () => {
    expect(legacyHostKeysOf('https://a.b.site.test/x')).toEqual(['a.b.site.test', 'site.test'])
  })
  it('不是 URL → 空', () => {
    expect(legacyHostKeysOf('not a url')).toEqual([])
  })
})

describe('fetchUrl 先派发', () => {
  it('具名行命中 → 整件事交给它，宿主分支不跑', async () => {
    const resolveByLink = vi.fn().mockResolvedValue({ platform: 'somesite', media: [{ kind: 'video', url: '/api/media/play?platform=somesite&vid=X' }] })
    const r = await fetchUrl('https://www.site.test/video/X', { resolveByLink })
    expect(resolveByLink).toHaveBeenCalledWith('https://www.site.test/video/X')
    expect(r.platform).toBe('somesite')
  })
  it('没命中 → 落宿主分支（图片直链照旧）', async () => {
    const r = await fetchUrl('https://cdn.test/a.jpg', { resolveByLink: async () => null })
    expect(r.platform).toBe('image')
  })
  it('没有 resolveByLink（兜底行那一档）→ 直接落宿主分支，不递归', async () => {
    const r = await fetchUrl('https://cdn.test/a.mp4', {})
    expect(r.platform).toBe('video')
  })
  it('没人认领、也不是直链 → unknown + 那句提示（宿主自己不认识任何站，不发任何请求）', async () => {
    const fm = vi.fn()
    vi.stubGlobal('fetch', fm)
    try {
      const r = await fetchUrl('https://www.some-video-site.test/video/123', { resolveByLink: async () => null })
      expect(r.platform).toBe('unknown')
      expect(r.media).toEqual([])
      expect(r.error).toMatch(/read_url/)
      expect(fm).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('具名行自己抛 → 不吞成 unknown，如实带出错误', async () => {
    const r = await fetchUrl('https://www.site.test/x', { resolveByLink: async () => { throw new Error('boom') } })
    expect(r.error).toContain('boom')
  })
  it('槽位坏了（SlotBrokenError）→ 原样上抛，不变成 {error}，门面才能映 422', async () => {
    const broken = new SlotBrokenError('ch1', 'content.enrich', ['dead-row'])
    await expect(fetchUrl('https://www.site.test/x', { resolveByLink: async () => { throw broken } })).rejects.toBe(broken)
  })
})

const envelope = (value: unknown) => ({ strategy: 'sequential', provider: 'row', value, via: 'm', misses: [], timings: [] })

describe('makeResolveByLink：content.enrich 按 <platform>-link 派发', () => {
  it('认领到平台 → 只问 <platform>-link（fallback:false），命中就 invoke 并取 value[0]', async () => {
    setLinkDeclarationSource(() => [SITE])
    const dispatch = vi.fn((_c: string, key: string, _ctx: unknown, _opts: { fallback: boolean }) => (key === 'somesite-link' ? 'row-site' : null))
    const invoke = vi.fn(async () => envelope([{ platform: 'somesite', media: [] }]))
    const resolve = makeResolveByLink({ dispatch } as never, { invoke } as never, undefined)
    const hit = await resolve('https://www.site.test/x')
    expect(dispatch.mock.calls.map((c) => [c[0], c[1], c[3]])).toEqual([['content.enrich', 'somesite-link', { fallback: false }]])
    expect(invoke).toHaveBeenCalledWith('row-site', { url: 'https://www.site.test/x' })
    expect(hit?.platform).toBe('somesite')
  })

  it('老包（serveKeys 还写域名、没声明 links）→ 按老主机键再试一次，命中照用并在 debug 留痕', async () => {
    const debug: LinkDebug[] = []
    setLinkDebugSink((e) => debug.push(e))
    const dispatch = vi.fn((_c: string, key: string) => (key === 'site.test' ? 'old-row' : null))
    const invoke = vi.fn(async () => envelope([{ platform: 'somesite', media: [] }]))
    const resolve = makeResolveByLink({ dispatch } as never, { invoke } as never, undefined)
    expect((await resolve('https://www.site.test/x'))?.platform).toBe('somesite')
    expect(dispatch.mock.calls.map((c) => c[1])).toEqual(['www.site.test', 'site.test'])
    expect(debug).toEqual([expect.objectContaining({ key: 'old-row', summary: expect.stringContaining('site.test') })])
  })

  it('认领到了但 <platform>-link 没有行、老键有 → 仍走老键（新宿主 + 旧版包的组合）', async () => {
    setLinkDeclarationSource(() => [SITE])
    const dispatch = vi.fn((_c: string, key: string) => (key === 'site.test' ? 'old-row' : null))
    const invoke = vi.fn(async () => envelope([{ platform: 'somesite', media: [] }]))
    const resolve = makeResolveByLink({ dispatch } as never, { invoke } as never, undefined)
    expect((await resolve('https://site.test/x'))?.platform).toBe('somesite')
    expect(dispatch.mock.calls.map((c) => c[1])).toEqual(['somesite-link', 'site.test'])
  })

  it('并发行（items 信封）也能解出结果，不被当成没命中', async () => {
    setLinkDeclarationSource(() => [SITE])
    const invoke = vi.fn(async () => ({ strategy: 'concurrent', provider: 'row', items: [{ platform: 'somesite', media: [] }], sources: ['s'], misses: [], timings: [] }))
    const resolve = makeResolveByLink({ dispatch: () => 'row' } as never, { invoke } as never, undefined)
    expect((await resolve('https://site.test/x'))?.platform).toBe('somesite')
  })

  it('认领了但成员全 miss（超时之类）→ 抛成员原话，不当成没人认领', async () => {
    setLinkDeclarationSource(() => [SITE])
    const invoke = vi.fn(async () => ({ strategy: 'sequential', provider: 'row', value: null, via: null, misses: [{ member: 'm', reason: 'member "m" timed out after 25000ms' }], timings: [] }))
    const resolve = makeResolveByLink({ dispatch: () => 'row' } as never, { invoke } as never, undefined)
    await expect(resolve('https://site.test/x')).rejects.toThrow(/timed out/)
    const r = await fetchUrl('https://site.test/x', { resolveByLink: resolve })
    expect(r.error).toMatch(/timed out/)
  })

  it('没有任何行认领 → null，不 invoke', async () => {
    const invoke = vi.fn()
    const resolve = makeResolveByLink({ dispatch: () => null } as never, { invoke } as never, undefined)
    expect(await resolve('https://a.test/')).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })
})
