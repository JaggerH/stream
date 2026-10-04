import { describe, it, expect } from 'vitest'
import { facilityAuthView, authInputs } from './facility-auth-view.ts'

const sessionAuth = { type: 'session', facility: 'xhs', login: 'qr', loginUrl: 'u', qrSelector: 'q' } as const
const authErr = { lastOutcome: 'error', lastErrorCategory: 'auth', lastAt: 't', lastError: 'needs re-login' } as const

describe('facilityAuthView', () => {
  it('flags a facility whose session source last failed with auth', () => {
    const out = facilityAuthView([
      { manifest: { id: 'xhs-home', facility: { key: 'xhs', label: '小红书' }, auth: sessionAuth },
        health: { lastOutcome: 'error', lastErrorCategory: 'auth', lastAt: '2026-07-12T00:00:00Z', lastError: 'needs re-login' } },
    ])
    expect(out).toEqual([{ facility: 'xhs', label: '小红书', login: 'qr', since: '2026-07-12T00:00:00Z', lastReason: 'needs re-login' }])
  })
  /**
   * `login:'oauth'` 也要露面，理由和 qr 一样：**Stream 出面替他登**的那几支，用户没有别的
   * 入口。这条不是补全枚举——不放它进来，`BrowserOAuthLoginProvider` 注册了、能跑，但横幅
   * 永不点亮、面板里没有这一行，整条能力静默地是死代码，而且一个字都不报错。
   */
  it('login:oauth 的 facility 照样进面板（否则那条 provider 没有任何入口）', () => {
    const oauthAuth = {
      type: 'session', facility: 'groq', login: 'oauth', loginUrl: 'u',
      oauthButton: '#oauth-google', accountSelector: '[data-identifier="{email}"]',
    } as const
    const out = facilityAuthView([
      { manifest: { id: 'groq-create-key', facility: { key: 'groq', label: 'Groq' }, auth: oauthAuth }, health: authErr },
    ])
    expect(out).toEqual([{ facility: 'groq', label: 'Groq', login: 'oauth', since: 't', lastReason: 'needs re-login' }])
  })

  // 反向：cookie 那支的会话住在用户自己的 Chrome 里，过期了他自己重登就行——弹面板没有意义，
  // 用户会对着一个点了没用的按钮。
  it('login:cookie 的 facility 不进面板', () => {
    const cookieAuth = { type: 'session', facility: 'eastmoney', login: 'cookie', cookieDomain: 'eastmoneysec.com' } as const
    expect(facilityAuthView([
      { manifest: { id: 'eastmoney-login', facility: { key: 'eastmoney', label: '东方财富' }, auth: cookieAuth }, health: authErr },
    ])).toEqual([])
  })

  it('does not flag when the last outcome was ok (signal cleared)', () => {
    const out = facilityAuthView([
      { manifest: { id: 'xhs-home', facility: { key: 'xhs', label: '小红书' }, auth: sessionAuth },
        health: { lastOutcome: 'ok', lastAt: '2026-07-12T01:00:00Z' } },
    ])
    expect(out).toEqual([])
  })
  it('does not flag a facility with no recent run (blind spot per I2)', () => {
    expect(facilityAuthView([{ manifest: { id: 'xhs-home', facility: { key: 'xhs', label: '小红书' }, auth: sessionAuth } }])).toEqual([])
  })
  it('风控挑战（category=blocked）不进重登面板 —— 别请用户去扫一个没问题的码', () => {
    // 这一格是 SiteChallengeError 归 `blocked` 之后**自动**成立的：收人的判据是
    // category==='auth'。在此之前挑战被判成 auth，任何 QR 登录的 facility 撞一次验证码
    // 就会被请进这个面板。这条测试把"顺带修好了"钉成事实，而不是一个推断。
    const out = facilityAuthView([
      { manifest: { id: 'xhs-home', facility: { key: 'xhs', label: '小红书' }, auth: sessionAuth },
        health: { lastOutcome: 'error', lastErrorCategory: 'blocked', lastAt: 't', lastError: '小红书 站方在限流/挑战（不是登录失效，无需重新登录）' } },
    ])
    expect(out).toEqual([])
  })

  it('ignores non-session sources and dedupes one facility to one entry', () => {
    const out = facilityAuthView([
      { manifest: { id: 'rss-x', facility: { key: 'xhs', label: '小红书' }, auth: { type: 'none' } },
        health: { lastOutcome: 'error', lastErrorCategory: 'auth', lastAt: 't', lastError: 'x' } },
      { manifest: { id: 'xhs-home', facility: { key: 'xhs', label: '小红书' }, auth: sessionAuth },
        health: { lastOutcome: 'error', lastErrorCategory: 'auth', lastAt: 't1', lastError: 'a' } },
      { manifest: { id: 'xhs-detail', facility: { key: 'xhs', label: '小红书' }, auth: sessionAuth },
        health: { lastOutcome: 'error', lastErrorCategory: 'auth', lastAt: 't2', lastError: 'b' } },
    ])
    expect(out.length).toBe(1)
    expect(out[0].facility).toBe('xhs')
  })
})

describe('authInputs', () => {
  it('looks health up by the canonical <pluginId:id> key the scheduler records under, not the bare id', () => {
    // The scheduler keys health by canonicalSourceId(plugin_id, template_id) — e.g.
    // a replay plugin source lands under "replay:xhs-home", never "xhs-home".
    const store = new Map<string, typeof authErr>([['replay:xhs-home', authErr]])
    const inputs = authInputs(
      [{ id: 'xhs-home', pluginId: 'replay', facility: { key: 'xhs', label: '小红书' }, auth: sessionAuth }],
      (k) => store.get(k),
    )
    expect(inputs[0].health).toBe(authErr)
    expect(facilityAuthView(inputs)).toHaveLength(1)
  })

  it('resolves a bare-id (custom, unprefixed) source too', () => {
    const store = new Map<string, typeof authErr>([['xhs-home', authErr]])
    const inputs = authInputs(
      [{ id: 'xhs-home', pluginId: 'custom', facility: { key: 'xhs', label: '小红书' }, auth: sessionAuth }],
      (k) => store.get(k),
    )
    expect(inputs[0].health).toBe(authErr)
  })

  it('leaves health undefined when no key matches (auth blind spot preserved)', () => {
    const inputs = authInputs(
      [{ id: 'xhs-home', pluginId: 'replay', facility: { key: 'xhs', label: '小红书' }, auth: sessionAuth }],
      () => undefined,
    )
    expect(inputs[0].health).toBeUndefined()
    expect(facilityAuthView(inputs)).toEqual([])
  })
})
