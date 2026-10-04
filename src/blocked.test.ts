import { describe, it, expect } from 'vitest'
import { LaneBusyForLoginError } from './replay/session-manager.ts'
import { blockedOf } from './blocked.ts'
import { NeedsLoginError, SiteChallengeError } from './adapters/replay/adapter.ts'
import { CoolingDownError } from './replay/facility-cooldown.ts'
import { EnvironmentUnavailableError } from './failure.ts'

describe('blockedOf', () => {
  it('reads a login block off NeedsLoginError, carrying facility + label', () => {
    expect(blockedOf(new NeedsLoginError('replay:xhs-search', 'xhs', '小红书'))).toEqual({
      kind: 'login', facility: 'xhs', label: '小红书',
    })
  })

  it('falls back to the facility key when no label was supplied', () => {
    expect(blockedOf(new NeedsLoginError('replay:xhs-search', 'xhs'))).toEqual({
      kind: 'login', facility: 'xhs', label: 'xhs',
    })
  })

  it('reads an extension block off EnvironmentUnavailableError', () => {
    expect(blockedOf(new EnvironmentUnavailableError('ext relay disconnected'))).toEqual({ kind: 'extension' })
  })

  it('is undefined for an ordinary failure', () => {
    expect(blockedOf(new Error('upstream returned 500'))).toBeUndefined()
    expect(blockedOf(undefined)).toBeUndefined()
    expect(blockedOf('a string')).toBeUndefined()
  })

  it('does NOT sniff message text — only the typed markers count', () => {
    // 这是这个函数存在的理由。分类靠 message 匹配（classifyError 那种）在这里会把一条讲登录的
    // 普通报错升级成「点这里去登录」的按钮，而按下去后面根本没有可跑的登录流程。
    expect(blockedOf(new Error('login rate limited, try again later'))).toBeUndefined()
    expect(blockedOf(new Error('needs re-login'))).toBeUndefined()
  })

  it('a NeedsLoginError with no facility declared yields no actionable block', () => {
    // 没有 facility 就没有能发起的登录流程（startLogin 按 facility 找 source）。宁可让它当作
    // 普通失败显示，也不要给一个按下去什么都不会发生的按钮。
    expect(blockedOf(new NeedsLoginError('some-source'))).toBeUndefined()
  })

it('登录面板占着这个 facility → 也是「需要登录」，画按钮而不是红字', () => {
  // 同一个按钮就能解决：用户点「重新登录」，扫完这条 lane 就放开了。
  expect(blockedOf(new LaneBusyForLoginError('xhs'))).toEqual({ kind: 'login', facility: 'xhs', label: 'xhs' })
})

  it('站方在挑战 → cooldown，**不是 login**（登录态好好的，别给登录按钮）', () => {
    expect(blockedOf(new SiteChallengeError('replay:douyin-search', 'douyin', '抖音', 90_000))).toEqual({
      kind: 'cooldown', facility: 'douyin', label: '抖音', retryAfterMs: 90_000,
    })
  })

  it('冷却中 → cooldown 且带上它自己算好的剩余时间，**不是 extension**', () => {
    // 这一格曾经是错的：CoolingDownError 继承 EnvironmentUnavailableError，于是冷却期
    // （60s–30min）界面一直说"扩展没连接"，把用户支去查一个完全正常的扩展——而真相是
    // 我们自己的闸门在等。判据必须排在 isEnvironmentUnavailable 前面。
    const got = blockedOf(new CoolingDownError('douyin', 120_000, '站方风控挑战'))
    expect(got).toEqual({ kind: 'cooldown', facility: 'douyin', label: 'douyin', retryAfterMs: 120_000 })
  })

  it('冷却那一档没有可点的动作——按钮的缺席是类型层面的事实，不是渲染处的一个 if', () => {
    const got = blockedOf(new CoolingDownError('douyin', 60_000, 'x'))
    expect(got?.kind).toBe('cooldown')
    // login 那一档才有 facility→登录流程的语义；cooldown 只是拿它把话说具体。
    expect(got).not.toHaveProperty('action')
  })
})
