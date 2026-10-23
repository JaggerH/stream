import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import {
  classifyHttp, classifyPage, cookieDomainFor, loginAccountId, maskAccount, pagePaths, pageReadExpr, readPath, unwrapRef,
} from './whoami.ts'
import type { WhoamiSpec } from '../manifest/types.ts'

const BILI: Extract<WhoamiSpec, { kind: 'http' }> = {
  kind: 'http', url: 'https://api.bilibili.com/x/web-interface/nav', id: 'data.mid', name: 'data.uname', signedIn: 'data.isLogin',
}
const XHS: Extract<WhoamiSpec, { kind: 'page' }> = {
  kind: 'page', url: 'https://www.xiaohongshu.com/explore',
  id: '__INITIAL_STATE__.user.userInfo.userId', name: '__INITIAL_STATE__.user.userInfo.nickname', signedIn: '__INITIAL_STATE__.user.loggedIn',
}
/** Vue RefImpl 经 JSON.stringify 之后的样子。 */
const ref = (v: unknown) => ({ __v_isRef: true, __v_isShallow: false, dep: {}, _rawValue: v, _value: v })

describe('readPath', () => {
  it('每一步自动解 Vue ref', () => {
    const state = { user: ref({ userInfo: ref({ userId: ref('abc') }), loggedIn: ref(true) }) }
    expect(readPath(state, 'user.userInfo.userId')).toBe('abc')
    expect(readPath(state, 'user.loggedIn')).toBe(true)
    expect(readPath(state, 'user.nope.x')).toBeUndefined()
    expect(unwrapRef({ _rawValue: 3 })).toBe(3)
  })
})

describe('classifyHttp', () => {
  const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) })
  it('B 站 nav 回 mid=123、uname=某某 → signed-in', () => {
    expect(classifyHttp(BILI, ok({ code: 0, data: { isLogin: true, mid: 123, uname: '某某' } })))
      .toEqual({ state: 'signed-in', accountId: '123', name: '某某' })
  })
  it('未登录（code -101、isLogin false、无 mid）→ signed-out', () => {
    expect(classifyHttp(BILI, ok({ code: -101, data: { isLogin: false } }))).toEqual({ state: 'signed-out' })
  })
  it('signedIn 为假时哪怕带着 id 也是 signed-out', () => {
    expect(classifyHttp(BILI, ok({ data: { isLogin: false, mid: 9 } }))).toEqual({ state: 'signed-out' })
  })
  it('非 2xx、不是 JSON → unknown', () => {
    expect(classifyHttp(BILI, { status: 502, body: '' }).state).toBe('unknown')
    expect(classifyHttp(BILI, { status: 200, body: '<html>' }).state).toBe('unknown')
  })
  it('HTML 形状：捕获组取 id；没找到且没有登录标志 → unknown', () => {
    const w = { kind: 'http', format: 'html', url: 'https://a.com/', id: 'uid=(\\d+)', signedIn: 'logout' } as const
    expect(classifyHttp(w, { status: 200, body: 'uid=42 <a>logout</a>' })).toEqual({ state: 'signed-in', accountId: '42' })
    expect(classifyHttp(w, { status: 200, body: '<a>login</a>' })).toEqual({ state: 'signed-out' })
    expect(classifyHttp({ ...w, signedIn: undefined }, { status: 200, body: '<a>login</a>' }).state).toBe('unknown')
  })
})

describe('page 形状', () => {
  const run = (window: unknown) => runInNewContext(pageReadExpr(pagePaths(XHS)), { window, JSON })

  it('页内表达式读出 Vue ref 包着的值', () => {
    const window = { __INITIAL_STATE__: { user: ref({ loggedIn: ref(true), userInfo: ref({ userId: ref('5f0e'), nickname: ref('小明') }) }) } }
    expect(classifyPage(XHS, run(window))).toEqual({ state: 'signed-in', accountId: '5f0e', name: '小明' })
  })

  it('游客：userId 有值但 loggedIn 为 false → signed-out', () => {
    const window = { __INITIAL_STATE__: { user: { loggedIn: ref(false), userInfo: ref({ userId: 'guest-1', guest: true }) } } }
    expect(classifyPage(XHS, run(window))).toEqual({ state: 'signed-out' })
  })

  it('页面上没有 __INITIAL_STATE__（风控页 / 没水合）→ unknown，不是登出', () => {
    expect(classifyPage(XHS, run({})).state).toBe('unknown')
    expect(classifyPage(XHS, undefined).state).toBe('unknown')
  })
})

describe('login 形状与 cookie 域', () => {
  it('账号存哈希前 16 位、显示打码', () => {
    expect(loginAccountId('540123456789')).toMatch(/^[0-9a-f]{16}$/)
    expect(loginAccountId('540123456789')).toBe(loginAccountId(' 540123456789 '))
    expect(maskAccount('12345678')).toBe('12****78')
    expect(maskAccount('123')).toBe('1****')
  })

  it('cookie 按命中的允许主机取（快照按注册域存）', () => {
    expect(cookieDomainFor('https://api.bilibili.com/x', ['b23.tv', '.bilibili.com'])).toBe('bilibili.com')
    expect(cookieDomainFor('https://evil.com/x', ['bilibili.com'])).toBeUndefined()
  })
})
