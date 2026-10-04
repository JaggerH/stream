import { describe, it, expect, vi } from 'vitest'
import { sessionPrecheck } from './session-precheck.ts'
import type { SessionAuthSpec } from '../manifest/types.ts'

const declared: SessionAuthSpec = {
  type: 'session', facility: 'xhs', login: 'qr',
  loginUrl: 'https://x/explore', qrSelector: '.qr',
  cookieDomain: 'xiaohongshu.com', sessionCookies: ['web_session'],
}
const undeclared: SessionAuthSpec = {
  type: 'session', facility: 'xhs', login: 'qr', loginUrl: 'https://x/explore', qrSelector: '.qr',
}

describe('sessionPrecheck', () => {
  it('says GONE when none of the declared session cookies exist', async () => {
    // 这是它存在的唯一理由：一个都不在 ⇒ 一定没登录，调用方直接 decline，连 tab 都不用开。
    const cookieNames = vi.fn(async () => ['a1', 'webId', 'gid'])
    expect(await sessionPrecheck(declared, cookieNames)).toBe('GONE')
    expect(cookieNames).toHaveBeenCalledWith('xiaohongshu.com')
  })

  it('says PRESENT when a declared cookie is present — NOT "logged in"', async () => {
    // cookie 在只说明浏览器还揣着凭证，不代表服务端还认（可能已被踢）。所以这里只能是"也许"，
    // 权威判断留给页面上的 loginCheck。把它当成 LOGGED_IN 会让采集在墙前面自信地空手而归。
    const cookieNames = vi.fn(async () => ['web_session', 'a1'])
    expect(await sessionPrecheck(declared, cookieNames)).toBe('PRESENT')
  })

  it('says UNKNOWN when the facility declares nothing — the fast path is optional', async () => {
    // 没声明 cookieDomain/sessionCookies 的 facility 不该因此被判死，它只是用不上快路。
    const cookieNames = vi.fn(async () => [])
    expect(await sessionPrecheck(undeclared, cookieNames)).toBe('UNKNOWN')
    expect(cookieNames).not.toHaveBeenCalled()
  })

  it('says UNKNOWN when the cookie lookup itself fails — never turns an outage into "logged out"', async () => {
    // 扩展没连/超时的时候答案是"不知道"，不是"没登录"。判成 GONE 会在用户关了一晚电脑之后，
    // 把一堆好好的 facility 报成掉线——那正是 scheduler 里 isEnvironmentUnavailable 一直在守的东西。
    const cookieNames = vi.fn(async () => { throw new Error('ext relay disconnected') })
    expect(await sessionPrecheck(declared, cookieNames)).toBe('UNKNOWN')
  })

  it('any ONE of several declared cookies is enough', async () => {
    const spec = { ...declared, sessionCookies: ['web_session', 'customer_sso_sid'] }
    expect(await sessionPrecheck(spec, async () => ['customer_sso_sid'])).toBe('PRESENT')
    expect(await sessionPrecheck(spec, async () => ['unrelated'])).toBe('GONE')
  })

  it('an empty sessionCookies list means the fast path is not configured', async () => {
    // 空数组不等于"一个都不在"——它等于"没告诉我要看哪个"。判成 GONE 会让这个 facility 永远
    // 采不了，而且错得毫无线索。
    const spec = { ...declared, sessionCookies: [] }
    const cookieNames = vi.fn(async () => [])
    expect(await sessionPrecheck(spec, cookieNames)).toBe('UNKNOWN')
    expect(cookieNames).not.toHaveBeenCalled()
  })
})
