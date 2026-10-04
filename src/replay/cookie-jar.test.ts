import { describe, expect, it } from 'vitest'
import { HostCookieJar } from './cookie-jar.ts'

describe('HostCookieJar', () => {
  it('host-only cookie 只回原 host', () => {
    const jar = new HostCookieJar()
    jar.absorb('pan.baidu.com', ['BDCLND=abc; Path=/'])
    expect(jar.cookiesFor('pan.baidu.com').get('BDCLND')).toBe('abc')
    expect(jar.cookiesFor('baidu.com').size).toBe(0)
    expect(jar.cookiesFor('evil.com').size).toBe(0)
  })

  it('Domain 属性只在覆盖响应 host 时生效，且覆盖子域', () => {
    const jar = new HostCookieJar()
    jar.absorb('pan.baidu.com', ['SEID=x; Domain=.baidu.com; Path=/'])
    expect(jar.cookiesFor('www.baidu.com').get('SEID')).toBe('x')
    expect(jar.cookiesFor('pan.baidu.com').get('SEID')).toBe('x')
    expect(jar.cookiesFor('notbaidu.com').size).toBe(0)
    // 后缀撞脸不算子域
    expect(jar.cookiesFor('evil-baidu.com').size).toBe(0)
  })

  it('伪造 Domain（不覆盖响应 host）降级为 host-only——跨站种 cookie 在结构上不成立', () => {
    const jar = new HostCookieJar()
    jar.absorb('evil.com', ['steal=1; Domain=quark.cn'])
    expect(jar.cookiesFor('quark.cn').size).toBe(0)
    expect(jar.cookiesFor('evil.com').get('steal')).toBe('1')
  })

  it('同名后写胜（会话刷新）', () => {
    const jar = new HostCookieJar()
    jar.absorb('a.com', ['s=1'])
    jar.absorb('a.com', ['s=2; Path=/'])
    expect(jar.cookiesFor('a.com').get('s')).toBe('2')
  })

  it('畸形 Set-Cookie（无 = 或空名）安静跳过', () => {
    const jar = new HostCookieJar()
    jar.absorb('a.com', ['garbage', '=orphan; Path=/', 'ok=1'])
    expect(jar.cookiesFor('a.com').size).toBe(1)
    expect(jar.cookiesFor('a.com').get('ok')).toBe('1')
  })
})
