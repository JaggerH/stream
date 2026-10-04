import { describe, it, expect } from 'vitest'
import { classifyError, isEnvironmentUnavailable, EnvironmentUnavailableError } from './failure.ts'
import { ExtRelayDisconnected, ExtRelayTimeout } from './http/ext-relay.ts'
import { sessionOutcomeToItems, SiteChallengeError } from './adapters/replay/adapter.ts'
import { CoolingDownError } from './replay/facility-cooldown.ts'
import { ReplayDriftError } from './replay/interpret.ts'

describe('classifyError', () => {
  it('classifies ReplayDriftError as drift and keeps message + stack', () => {
    const r = classifyError(new ReplayDriftError('no items array', 0))
    expect(r.category).toBe('drift')
    expect(r.message).toMatch(/no items array/)
    expect(r.stack).toBeTruthy()
  })
  it('classifies timeouts, network, blocked, auth', () => {
    expect(classifyError(new Error('page.goto: Timeout 30000ms exceeded')).category).toBe('timeout')
    expect(classifyError(new Error('net::ERR_CONNECTION_REFUSED')).category).toBe('network')
    expect(classifyError(new Error('HTTP 412')).category).toBe('blocked')
    expect(classifyError(new Error('in-page fetch returned non-JSON — login-wall')).category).toBe('auth')
  })
  it('falls back to unknown and coerces non-Error throws', () => {
    expect(classifyError('boom').category).toBe('unknown')
    expect(classifyError('boom').message).toBe('boom')
  })
  it('unwraps the .cause chain so a bare "fetch failed" surfaces the real reason', () => {
    // Node's fetch throws TypeError('fetch failed') with the syscall error in .cause.
    const cause = Object.assign(new Error('connect ECONNREFUSED 172.20.0.3:80'), { code: 'ECONNREFUSED' })
    const err = Object.assign(new TypeError('fetch failed'), { cause })
    const r = classifyError(err)
    expect(r.category).toBe('network')
    expect(r.message).toMatch(/fetch failed/)
    expect(r.message).toMatch(/ECONNREFUSED/)
  })
  it('classifies DNS and connect-timeout causes', () => {
    const dns = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND gateway'), { code: 'ENOTFOUND' }) })
    expect(classifyError(dns).category).toBe('network')
    const to = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) })
    expect(classifyError(to).category).toBe('timeout')
  })
  it('treats a cookie/login upstream error as auth, not blocked', () => {
    expect(classifyError(new Error('上游错误 code=401（登录态失效）')).category).toBe('auth')
    expect(classifyError(new Error('/fetch_follow_feed → HTTP 422（登录态失效或缺少 cookie）')).category).toBe('auth')
  })

  it('站方挑战归 blocked —— 而且不被自己文案里的「登录」二字抢进 auth', () => {
    // 这条钉的是一个真实的陷阱：下面那串是**文本嗅探**，`auth` 那条正则含 `登录`/`login`，
    // 排在 `blocked` 前面。而一句诚实的挑战文案必然要说"不是登录失效、无需重新登录"——
    // 于是只要靠文本判，它就会被 auth 抢走，落进重登面板（收人的判据正是 category==='auth'），
    // 请用户去扫一个根本没问题的码。所以这一档必须按**类型**判，且排在所有正则前面。
    const e = new SiteChallengeError('replay:douyin-search', 'douyin', '抖音', 120_000)
    expect(e.message).toMatch(/登录/)          // 文案确实含"登录"二字（陷阱还在）
    expect(classifyError(e).category).toBe('blocked')
  })

  it('冷却也归 blocked —— 别让"上一次被拦的原因"决定这次的分类', () => {
    // CoolingDownError 的消息里嵌着上一次被拦的 `because`，而那句话说什么不由我们控制：
    // needsLogin 那一档的默认理由就是「撞上登录墙/拦截页」，含"登录"二字 → 靠文本判会落进
    // auth → 一个"我们自己在等"的状态被送进重登面板。
    const e = new CoolingDownError('douyin', 39_000, '撞上登录墙/拦截页')
    expect(e.message).toMatch(/登录/)            // 陷阱确实在消息里
    expect(classifyError(e).category).toBe('blocked')
  })

  it('挑战文案说得出「不用你动手」和「大概多久」', () => {
    expect(new SiteChallengeError('s', 'douyin', '抖音', 120_000).message).toMatch(/无需重新登录/)
    expect(new SiteChallengeError('s', 'douyin', '抖音', 120_000).message).toMatch(/约 2 分钟后自动重试/)
    // 冷却最短一档是 60s：**别显示成"约 0 分钟"**（一句自我否定的话）。
    expect(new SiteChallengeError('s', 'douyin', '抖音', 60_000).message).toMatch(/1 分钟内/)
    expect(new SiteChallengeError('s', 'douyin', '抖音', 1_800_000).message).toMatch(/约 30 分钟后/)
    // 不知道多久也要说人话，不能露出 undefined
    expect(new SiteChallengeError('s', 'douyin', '抖音').message).toMatch(/稍后自动重试/)
  })
})

/**
 * 「环境没就绪 ≠ 源坏了」这条链路的守卫。
 *
 * 病灶：ExtRelayDisconnected 在全仓没有任何 catch 点，于是"用户关了 Chrome"会一路走成
 * blocked → 记 health → 掉档告警。等于关一晚电脑，第二天所有 ext-cdp 的源全红，而它们一个
 * 毛病都没有。
 */
describe('环境没就绪：跳过本轮，不判源故障', () => {
  const envErr = () => new EnvironmentUnavailableError('ext-relay socket disconnected')

  it('ExtRelayDisconnected 就是"环境没就绪" —— 判据靠类型不靠字符串匹配', () => {
    expect(isEnvironmentUnavailable(new ExtRelayDisconnected())).toBe(true)
  })

  it('ExtRelayTimeout 不算 —— 那是连着的、某条命令挂了,可能是真故障,吞掉会藏 bug', () => {
    expect(isEnvironmentUnavailable(new ExtRelayTimeout('Input.dispatchMouseEvent'))).toBe(false)
  })

  it('普通错误不算', () => {
    expect(isEnvironmentUnavailable(new Error('HTTP 412'))).toBe(false)
  })

  it('unavailable 出口抛的是带标记的错误,不是空数组', () => {
    // 空数组会被上游读成"采到了 0 条"（进而 blocked / 记 health），而真相是"没采"
    expect(() => sessionOutcomeToItems({ outcome: 'unavailable', items: [], trace: [], reason: 'r' }, 's'))
      .toThrow(EnvironmentUnavailableError)
  })

  it('blocked 仍然照旧抛 —— 别把这次修改扩大成"所有失败都跳过"', () => {
    expect(() => sessionOutcomeToItems({ outcome: 'blocked', items: [], trace: [], reason: 'r' }, 's'))
      .not.toThrow(EnvironmentUnavailableError)
  })
})
