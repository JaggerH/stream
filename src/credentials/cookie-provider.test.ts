import { describe, it, expect, afterEach, vi } from 'vitest'
import { CookieProvider, setPackageCookieEnvSource, type CookieSource } from './cookie-provider.ts'
import type { BrowserCookie } from '../types.ts'

function source(byDomain: Record<string, BrowserCookie[]>): CookieSource {
  return { fetch: async () => byDomain }
}

const bili: BrowserCookie[] = [
  { name: 'DedeUserID', value: '42' } as BrowserCookie,
  { name: 'SESSDATA', value: 'xyz' } as BrowserCookie,
]

describe('CookieProvider', () => {
  it('resolves a transform-kind cookie domain via the registry', async () => {
    const p = new CookieProvider(source({ 'github.com': [{ name: 'user_session', value: 'tok' } as BrowserCookie] }))
    const r = await p.resolve({
      type: 'cookie',
      domain: 'github.com',
      inject: { kind: 'transform', ref: 'github' },
    })
    expect(r).not.toBeNull()
    expect(r!.envOverrides).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'tok' })
  })

  it('resolves an env-kind cookie domain to the declared env var name', async () => {
    const cookies = [{ name: 'XQ', value: 's' } as BrowserCookie]
    const p = new CookieProvider(source({ 'xueqiu.com': cookies }))
    const r = await p.resolve({
      type: 'cookie',
      domain: 'xueqiu.com',
      inject: { kind: 'env', name: 'XUEQIU_COOKIES' },
    })
    expect(r!.envOverrides).toEqual({ XUEQIU_COOKIES: 'XQ=s' })
  })

  it('throws loudly when a transform ref has no registry entry', async () => {
    const p = new CookieProvider(source({ 'bilibili.com': bili }))
    await expect(
      p.resolve({ type: 'cookie', domain: 'bilibili.com', inject: { kind: 'transform', ref: 'nope' } })
    ).rejects.toThrow(/nope/)
  })

  it('returns null for a domain it has no cookies for', async () => {
    const p = new CookieProvider(source({ 'bilibili.com': bili }))
    expect(
      await p.resolve({ type: 'cookie', domain: 'weibo.com', inject: { kind: 'env', name: 'WEIBO_COOKIES' } })
    ).toBeNull()
  })

  it('returns null for non-cookie auth', async () => {
    const p = new CookieProvider(source({ 'bilibili.com': bili }))
    expect(await p.resolve({ type: 'none' })).toBeNull()
    expect(await p.resolve({ type: 'token', name: 'X' })).toBeNull()
  })

  describe('cookieString', () => {
    it('builds a raw Cookie header for a domain (suffix-matched)', async () => {
      const p = new CookieProvider(source({ '.bilibili.com': bili }))
      expect(await p.cookieString('bilibili.com')).toBe('DedeUserID=42; SESSDATA=xyz')
    })

    it('returns null when no cookies match the domain', async () => {
      const p = new CookieProvider(source({ 'bilibili.com': bili }))
      expect(await p.cookieString('douyin.com')).toBeNull()
    })

    it('drops empty-name entries instead of emitting a bare `=value` pair', async () => {
      const p = new CookieProvider(source({ 'bilibili.com': [{ name: '', value: 'bilibili.com', domain: 'bilibili.com' }, ...bili] }))
      expect(await p.cookieString('bilibili.com')).toBe('DedeUserID=42; SESSDATA=xyz')
    })

    // 调用方按小写比对域名，这边不跟着归一，快照里存了个大写域键就再也取不到，且不报错。
    it('matches a domain key stored with uppercase', async () => {
      const p = new CookieProvider(source({ '.BiliBili.com': bili }))
      expect(await p.cookieString('bilibili.com')).toBe('DedeUserID=42; SESSDATA=xyz')
    })
  })

  it('resolve() 也认大写域键', async () => {
    const p = new CookieProvider(source({ 'GitHub.COM': [{ name: 'user_session', value: 'tok' } as BrowserCookie] }))
    const r = await p.resolve({
      type: 'cookie',
      domain: 'github.com',
      inject: { kind: 'transform', ref: 'github' },
    })
    expect(r!.envOverrides).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'tok' })
  })

  it('availableDomains() 报小写域（health/readiness 与 broker 同一套写法）', async () => {
    const p = new CookieProvider(source({ '.BiliBili.com': bili }))
    expect(await p.availableDomains()).toEqual(['bilibili.com'])
  })

  describe('cache TTL', () => {
    it('refetches after ttlMs so a domain added on the server appears without reconfigure', async () => {
      let payload: Record<string, BrowserCookie[]> = { 'bilibili.com': bili }
      let calls = 0
      const src: CookieSource = {
        fetch: async () => {
          calls++
          return payload
        },
      }
      const p = new CookieProvider(src, 50)

      expect(await p.availableDomains()).toEqual(['bilibili.com'])
      expect(calls).toBe(1)

      // quark.cn shows up in the snapshot; within the TTL Stream still serves the cache
      payload = { 'bilibili.com': bili, 'quark.cn': [{ name: 'x', value: '1' } as BrowserCookie] }
      expect(await p.availableDomains()).toEqual(['bilibili.com'])
      expect(calls).toBe(1)

      // past the TTL the next read refetches and sees the new domain
      await new Promise((r) => setTimeout(r, 60))
      expect(await p.availableDomains()).toEqual(['bilibili.com', 'quark.cn'])
      expect(calls).toBe(2)
    })

    it('keeps a warm cache when a refetch throws, but surfaces a cold-start failure', async () => {
      let mode: 'ok' | 'boom' = 'ok'
      const src: CookieSource = {
        fetch: async () => {
          if (mode === 'boom') throw new Error('blip')
          return { 'quark.cn': [{ name: 'x', value: '1' } as BrowserCookie] }
        },
      }
      const p = new CookieProvider(src, -1) // always-stale → every read attempts a refetch
      expect(await p.cookieString('quark.cn')).toBe('x=1')

      mode = 'boom'
      expect(await p.cookieString('quark.cn')).toBe('x=1') // warm cache retained through the blip

      const cold = new CookieProvider({ fetch: async () => { throw new Error('down') } }, -1)
      await expect(cold.availableDomains()).rejects.toThrow(/down/)
    })
  })
})

describe('transform 注入先查包声明的模板', () => {
  afterEach(() => setPackageCookieEnvSource(() => new Map()))

  const provider = (cookies: Record<string, BrowserCookie[]>) =>
    new CookieProvider({ fetch: async () => cookies })

  it('占位符换成该 cookie 的值，变量值是整份 cookie 串', async () => {
    setPackageCookieEnvSource(() => new Map([['site', 'SITE_COOKIE_{Uid}']]))
    const p = provider({ 'site.test': [
      { name: 'Uid', value: '42' } as BrowserCookie,
      { name: 'SESS', value: 'abc' } as BrowserCookie,
    ] })
    const r = await p.resolve({ type: 'cookie', domain: 'site.test', inject: { kind: 'transform', ref: 'site' } })
    expect(r?.envOverrides).toEqual({ SITE_COOKIE_42: 'Uid=42; SESS=abc' })
  })

  it('占位的那个 cookie 缺席 → 不写变量（等价于没解析出来），并出声', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setPackageCookieEnvSource(() => new Map([['site', 'SITE_COOKIE_{Uid}']]))
    const p = provider({ 'site.test': [{ name: 'SESS', value: 'abc' } as BrowserCookie] })
    expect(await p.resolve({ type: 'cookie', domain: 'site.test', inject: { kind: 'transform', ref: 'site' } })).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('包没声明 → 落回宿主 transformRegistry（github 仍然走老路）', async () => {
    const p = provider({ 'github.com': [{ name: 'user_session', value: 'tok' } as BrowserCookie] })
    const r = await p.resolve({ type: 'cookie', domain: 'github.com', inject: { kind: 'transform', ref: 'github' } })
    expect(r?.envOverrides).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'tok' })
  })
})
