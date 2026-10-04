import { describe, it, expect } from 'vitest'
import {
  matchesSyncedDomain,
  mergeDomains,
  parseDomainInput,
  syncableDomains,
  PROBE_CANDIDATES,
} from './config.ts'

describe('PROBE_CANDIDATES', () => {
  it('同时列出 Stream 后端与独立插件两个口', () => {
    expect(PROBE_CANDIDATES).toContain('http://127.0.0.1:8900')
    expect(PROBE_CANDIDATES).toContain('http://127.0.0.1:8907')
  })

  it('【核心】Stream 那个口排在前面', () => {
    // 不是因为它更可信——两个都要各自证明。是因为绝大多数机器上它就是答案，
    // 让常见情形少一次注定失败的往返。
    expect(PROBE_CANDIDATES.indexOf('http://127.0.0.1:8900'))
      .toBeLessThan(PROBE_CANDIDATES.indexOf('http://127.0.0.1:8907'))
  })

  it('没有重复项——重复只会让失败日志翻倍', () => {
    expect(new Set(PROBE_CANDIDATES).size).toBe(PROBE_CANDIDATES.length)
  })
})

describe('mergeDomains', () => {
  it('unions, normalizes and dedupes; configured order first', () => {
    expect(mergeDomains(['bilibili.com'], ['.Quark.CN', 'https://xhs.com/x', 'bilibili.com'])).toEqual([
      'bilibili.com',
      'quark.cn',
      'xhs.com',
    ])
  })

  it('drops blanks and tolerates a missing second list', () => {
    expect(mergeDomains(['a.com', '', '  '])).toEqual(['a.com'])
  })
})

describe('matchesSyncedDomain', () => {
  it('matches the domain itself and its subdomains (with or without the cookie leading dot)', () => {
    expect(matchesSyncedDomain('.quark.cn', ['quark.cn'])).toBe(true)
    expect(matchesSyncedDomain('pan.quark.cn', ['quark.cn'])).toBe(true)
    expect(matchesSyncedDomain('.drive-pc.quark.cn', ['quark.cn'])).toBe(true)
    expect(matchesSyncedDomain('quark.cn', ['quark.cn'])).toBe(true)
  })

  it('rejects unrelated domains — including suffix look-alikes', () => {
    expect(matchesSyncedDomain('.bilibili.com', ['quark.cn'])).toBe(false)
    expect(matchesSyncedDomain('notquark.cn', ['quark.cn'])).toBe(false) // suffix字符串相同但不是子域
    expect(matchesSyncedDomain('.quark.cn.evil.com', ['quark.cn'])).toBe(false)
  })

  it('returns false for an empty synced list', () => {
    expect(matchesSyncedDomain('.quark.cn', [])).toBe(false)
  })
})

describe('syncableDomains', () => {
  it('unions configured domains with the page candidates auth domains (deduped, order-stable)', () => {
    const out = syncableDomains(['bilibili.com'], [
      { authDomain: 'xueqiu.com' },
      { authDomain: 'bilibili.com' }, // already configured — no dup
      {}, // public candidate — no authDomain
    ])
    expect(out).toEqual(['bilibili.com', 'xueqiu.com'])
  })

  it('returns the configured domains unchanged when no candidate needs login', () => {
    expect(syncableDomains(['bilibili.com'], [{}, {}])).toEqual(['bilibili.com'])
  })
})

describe('parseDomainInput', () => {
  it('strips scheme, path, leading dots and lowercases', () => {
    expect(parseDomainInput('https://Weibo.com/u/123')).toBe('weibo.com')
    expect(parseDomainInput('  .Bilibili.com  ')).toBe('bilibili.com')
    expect(parseDomainInput('xueqiu.com')).toBe('xueqiu.com')
  })

  it('returns empty string for blank input', () => {
    expect(parseDomainInput('   ')).toBe('')
    expect(parseDomainInput('')).toBe('')
  })
})

// 这里曾经有一组 `SYNC_INTERVALS`（周期同步的间隔预设）的测试。周期同步撤掉之后
// 那个常量没有消费方了，测试跟着删——登录态现在由 Stream 自己来取，见 lib/sync.direct.test.ts。
