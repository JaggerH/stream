import { describe, it, expect } from 'vitest'
import { DEFAULT_AD_RULES, mergeAdRules } from './ad-rules.default.ts'

describe('DEFAULT_AD_RULES', () => {
  it('ships canonical keywords and domains but not the false-positive 广告', () => {
    expect(DEFAULT_AD_RULES.keywords).toContain('推广')
    expect(DEFAULT_AD_RULES.domains).toContain('taobao.com')
    expect(DEFAULT_AD_RULES.keywords).not.toContain('广告') // matches news ABOUT advertising
  })
})

describe('mergeAdRules', () => {
  it('returns the defaults when no user config is given', () => {
    const merged = mergeAdRules(DEFAULT_AD_RULES, undefined)
    expect(merged.keywords).toEqual(expect.arrayContaining(DEFAULT_AD_RULES.keywords ?? []))
    expect(merged.domains).toEqual(expect.arrayContaining(DEFAULT_AD_RULES.domains ?? []))
  })

  it('extends defaults with user keywords/domains', () => {
    const merged = mergeAdRules(DEFAULT_AD_RULES, { keywords: ['内部专属'], domains: ['weidian.com'] })
    expect(merged.keywords).toContain('内部专属')
    expect(merged.keywords).toContain('推广') // default still present
    expect(merged.domains).toContain('weidian.com')
  })

  it('dedupes when user repeats a default', () => {
    const merged = mergeAdRules(DEFAULT_AD_RULES, { keywords: ['推广'], domains: ['taobao.com'] })
    expect(merged.keywords!.filter((k) => k === '推广')).toHaveLength(1)
    expect(merged.domains!.filter((d) => d === 'taobao.com')).toHaveLength(1)
  })
})
