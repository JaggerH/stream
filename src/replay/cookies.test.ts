import { describe, it, expect } from 'vitest'
import { parseCookieHeader } from './cookies.ts'

describe('parseCookieHeader', () => {
  it('splits a Cookie header into domain-scoped cookie objects', () => {
    expect(parseCookieHeader('a=1; b=two', 'example.com')).toEqual([
      { name: 'a', value: '1', domain: '.example.com', path: '/' },
      { name: 'b', value: 'two', domain: '.example.com', path: '/' },
    ])
  })
  it('preserves = inside values and trims whitespace', () => {
    expect(parseCookieHeader('  token = ab=cd ', 'x.com')).toEqual([
      { name: 'token', value: 'ab=cd', domain: '.x.com', path: '/' },
    ])
  })
  it('skips empty or malformed pairs', () => {
    expect(parseCookieHeader('a=1;; =nope; b=2', 'x.com')).toEqual([
      { name: 'a', value: '1', domain: '.x.com', path: '/' },
      { name: 'b', value: '2', domain: '.x.com', path: '/' },
    ])
  })

  // Without the dot Chromium stores a HOST-ONLY cookie: pan.quark.cn never receives it and
  // every page loads as a guest (drive API: 401 require login). The dot is what makes a
  // facility's broker cookie reach the subdomain the site actually runs on.
  it('scopes cookies to the whole domain tree, not host-only', () => {
    const [cookie] = parseCookieHeader('__puus=tok', 'quark.cn')
    expect(cookie.domain).toBe('.quark.cn')
  })
  it('does not double the dot when the caller already scoped the domain', () => {
    const [cookie] = parseCookieHeader('__puus=tok', '.quark.cn')
    expect(cookie.domain).toBe('.quark.cn')
  })
})
