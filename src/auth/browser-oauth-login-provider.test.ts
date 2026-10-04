import { describe, expect, it } from 'vitest'
import { BrowserOAuthLoginProvider } from './browser-oauth-login-provider.ts'
import type { OAuthLoginPage } from './browser-oauth-login-provider.ts'
import type { LoginEvent } from './login-provider.ts'
import type { LoginState } from '../replay/recipe.ts'

const SPEC = {
  type: 'session', facility: 'groq', login: 'oauth',
  loginUrl: 'https://console.groq.com/login',
  oauthButton: '#oauth-google',
  accountSelector: '[data-identifier="{email}"]',
  account: 'me@example.com',
} as never

const CTX = { loginCheck: { loggedIn: '.ok', wall: '.wall' } } as never

/** `states` 是 loginState 的逐次应答脚本——一轮取一个，取完了重复最后一个。 */
function fakePage(states: LoginState[]) {
  const calls: string[] = []
  let i = 0
  const page: OAuthLoginPage = {
    goto: async (u) => { calls.push(`goto ${u}`) },
    click: async (s) => { calls.push(`click ${s}`); return true },
    bringToFront: async () => { calls.push('front') },
    loginState: async () => states[Math.min(i++, states.length - 1)]!,
    qrDataUrl: async () => null,
    close: async () => { calls.push('close') },
  }
  return { page, calls }
}

function run(states: LoginState[], opts: Record<string, unknown> = {}) {
  const { page, calls } = fakePage(states)
  const events: LoginEvent[] = []
  const provider = new BrowserOAuthLoginProvider({
    browser: { openProfile: async () => page },
    lock: { acquire: async () => ({ release: async () => {} }) },
    pollMs: 0,
    ...opts,
  })
  return { provider, events, calls, emit: (e: LoginEvent) => events.push(e) }
}

describe('BrowserOAuthLoginProvider', () => {
  it('一次过：点 OAuth 按钮、选账号、直接 LOGGED_IN', async () => {
    const t = run(['LOGGED_IN'])
    await t.provider.begin(SPEC, CTX, t.emit, new AbortController().signal)
    expect(t.calls).toContain('click #oauth-google')
    expect(t.calls).toContain('click [data-identifier="me@example.com"]')
    expect(t.events.at(-1)).toEqual({ kind: 'success', facility: 'groq' })
  })

  // 承重墙：provider 不认识 passkey / 条款屏 / 2FA。它们全长成"还没 LOGGED_IN"，
  // 而唯一正确的反应就是继续等。这条测试如果被改成"识别某个选择器"，说明设计被推翻了。
  it('中途需要人：WALLED 若干轮后 LOGGED_IN，仍然成功', async () => {
    const t = run(['WALLED', 'UNKNOWN', 'WALLED', 'LOGGED_IN'])
    await t.provider.begin(SPEC, CTX, t.emit, new AbortController().signal)
    expect(t.events.at(-1)).toEqual({ kind: 'success', facility: 'groq' })
  })

  it('需要人时把 tab 掀到前台，且只掀一次', async () => {
    // 显式传 nudgeAfterMs: 0——这条测试要验的是「掀屏逻辑本身对不对」，
    // 不是生产默认值该是多少（那由下面「正常登录不该抢屏」那条守）。
    const t = run(['WALLED', 'WALLED', 'LOGGED_IN'], { nudgeAfterMs: 0 })
    await t.provider.begin(SPEC, CTX, t.emit, new AbortController().signal)
    expect(t.calls.filter((c) => c === 'front')).toHaveLength(1)
    expect(t.events.some((e) => e.kind === 'needsHuman')).toBe(true)
  })

  // 反过来的性质，也是这条门槛存在的真正理由：正常登录不该抢屏、绝不该喊「该你了」。
  // 不显式传 nudgeAfterMs——这条要锁的正是"生产默认不能是 0"；改成 0 这条测试必须变红
  // （0 意味着第一轮非 LOGGED_IN 就会抢屏），所以脚本必须给至少一轮非 LOGGED_IN，让提示
  // 分支真的被求值，不能像之前那样一轮 LOGGED_IN 就 break、提示分支从没跑过。
  // 用注入的 now 表达"时间还没到"，不依赖真实时钟流逝。
  it('正常登录（很快 LOGGED_IN）：nudgeAfterMs 未到，不抢屏、不提示', async () => {
    let clock = 0
    const t = run(['WALLED', 'LOGGED_IN'], { now: () => (clock += 1) })
    await t.provider.begin(SPEC, CTX, t.emit, new AbortController().signal)
    expect(t.calls.filter((c) => c === 'front')).toHaveLength(0)
    expect(t.events.some((e) => e.kind === 'needsHuman')).toBe(false)
    expect(t.events.at(-1)).toEqual({ kind: 'success', facility: 'groq' })
  })

  it('登录页找不到 OAuth 入口按钮：直接 failed，不往下走', async () => {
    const { page, calls } = fakePage(['LOGGED_IN'])
    page.click = async (s) => { calls.push(`click ${s}`); return false }
    const events: LoginEvent[] = []
    const provider = new BrowserOAuthLoginProvider({
      browser: { openProfile: async () => page },
      lock: { acquire: async () => ({ release: async () => {} }) },
      pollMs: 0,
    })
    await provider.begin(SPEC, CTX, (e) => events.push(e), new AbortController().signal)
    expect(events.at(-1)).toMatchObject({ kind: 'failed', reason: expect.stringContaining('#oauth-google') })
    // 没往下走：账号选择器那步不该被调用
    expect(calls.some((c) => c.startsWith('click [data-identifier'))).toBe(false)
  })

  it('超时：emit failed，不抛', async () => {
    let clock = 0
    const t = run(['WALLED'], { timeoutMs: 10, now: () => (clock += 6) })
    await t.provider.begin(SPEC, CTX, t.emit, new AbortController().signal)
    expect(t.events.at(-1)).toMatchObject({ kind: 'failed' })
  })

  it('取消：emit failed(cancelled)', async () => {
    const ac = new AbortController()
    ac.abort()
    const t = run(['WALLED'])
    await t.provider.begin(SPEC, CTX, t.emit, ac.signal)
    expect(t.events.at(-1)).toMatchObject({ kind: 'failed', reason: 'cancelled' })
  })

  // account 是用户各自的邮箱，manifest/recipe 里没有它是合法的常态（见 types.ts 头注）。
  // 缺席时必须整段跳过选账号，不能拿 undefined 去 replace——那会拼出一个永不命中的选择器，
  // 把正常的降级伪装成一次失败的点击。
  it('spec.account 未设时不点账号选择器，流程照常等到 LOGGED_IN', async () => {
    const { account: _account, ...specWithoutAccount } = SPEC as unknown as { account: string }
    const t = run(['LOGGED_IN'])
    await t.provider.begin(specWithoutAccount as never, CTX, t.emit, new AbortController().signal)
    expect(t.calls).toContain('click #oauth-google')
    expect(t.calls.some((c) => c.startsWith('click [data-identifier'))).toBe(false)
    expect(t.events.at(-1)).toEqual({ kind: 'success', facility: 'groq' })
  })

  it('非 oauth 的 spec 直接拒绝，不开页', async () => {
    const t = run(['LOGGED_IN'])
    await t.provider.begin({ ...(SPEC as object), login: 'qr' } as never, CTX, t.emit, new AbortController().signal)
    expect(t.events.at(-1)).toMatchObject({ kind: 'failed' })
    expect(t.calls).toEqual([])
  })
})
