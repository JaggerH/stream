import { describe, it, expect } from 'vitest'
import { authCookieDomain, requiredCookieDomains } from './required-domains.ts'

describe('authCookieDomain', () => {
  it('reads cookie auth directly', () => {
    expect(authCookieDomain({ type: 'cookie', domain: 'xueqiu.com', inject: { kind: 'env', name: 'X' } })).toBe(
      'xueqiu.com'
    )
  })

  it('reads session:login=cookie — the shape quark uses', () => {
    expect(authCookieDomain({ type: 'session', facility: 'quark', login: 'cookie', cookieDomain: 'quark.cn' })).toBe(
      'quark.cn'
    )
  })

  it('reads the qr session probe domain too (we read those cookies to detect logout)', () => {
    expect(
      authCookieDomain({
        type: 'session',
        facility: 'xhs',
        login: 'qr',
        loginUrl: 'https://x',
        qrSelector: '.q',
        cookieDomain: 'xiaohongshu.com',
      })
    ).toBe('xiaohongshu.com')
  })

  it('yields nothing for auth that needs no cookie', () => {
    expect(authCookieDomain({ type: 'none' })).toBeUndefined()
    expect(authCookieDomain({ type: 'token', name: 'K' })).toBeUndefined()
    expect(authCookieDomain(undefined)).toBeUndefined()
  })
})

describe('requiredCookieDomains', () => {
  it('collects, normalizes and dedupes across manifests', () => {
    const domains = requiredCookieDomains([
      { auth: { type: 'session', facility: 'quark', login: 'cookie', cookieDomain: '.Quark.CN' } },
      { auth: { type: 'session', facility: 'quark', login: 'cookie', cookieDomain: 'quark.cn' } },
      { auth: { type: 'cookie', domain: 'bilibili.com', inject: { kind: 'env', name: 'B' } } },
      { auth: { type: 'none' } },
      undefined,
    ])
    expect(domains).toEqual(['bilibili.com', 'quark.cn'])
  })

  it('is empty when nothing needs a cookie', () => {
    expect(requiredCookieDomains([{ auth: { type: 'none' } }])).toEqual([])
  })

  it('并上 manifest 之外的域（session_exports）——不并进去就是静默取不到那个域', () => {
    expect(requiredCookieDomains([{ auth: { type: 'none' } }], ['EastmoneySec.com', ''])).toEqual([
      'eastmoneysec.com',
    ])
  })

  it('extra 与 manifest 的域去重、同样归一', () => {
    const domains = requiredCookieDomains(
      [{ auth: { type: 'cookie', domain: 'quark.cn', inject: { kind: 'env', name: 'Q' } } }],
      ['.Quark.CN', 'other.example'],
    )
    expect(domains).toEqual(['other.example', 'quark.cn'])
  })
})
