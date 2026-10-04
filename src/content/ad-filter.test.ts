import { describe, it, expect } from 'vitest'
import { classifyAd, type AdRules } from './ad-filter.ts'

const rules: AdRules = {
  keywords: ['广告', '推广', '赞助', 'sponsored'],
  domains: ['ad.example.com', 'taobao.com'],
}

describe('classifyAd — keyword matching', () => {
  it('matches a keyword in the title and reports the matched rule', () => {
    const flag = classifyAd({ title: '【推广】限时优惠', text: '正文' }, rules)
    expect(flag).toEqual({ reason: 'ad', rule: '推广' })
  })

  it('matches a keyword in the body text', () => {
    const flag = classifyAd({ title: '日常分享', text: '本文由赞助商提供 sponsored 内容' }, rules)
    expect(flag).toEqual({ reason: 'ad', rule: '赞助' })
  })

  it('is case-insensitive for latin keywords', () => {
    const flag = classifyAd({ title: 'A SPONSORED post', text: '' }, rules)
    expect(flag).toEqual({ reason: 'ad', rule: 'sponsored' })
  })
})

describe('classifyAd — domain matching', () => {
  it('matches a domain in the item url', () => {
    const flag = classifyAd({ title: 'clean', text: 'clean', urls: ['https://ad.example.com/x?ref=1'] }, rules)
    expect(flag).toEqual({ reason: 'ad', rule: 'ad.example.com' })
  })

  it('matches a domain on a subdomain of a rule domain', () => {
    const flag = classifyAd({ title: 'clean', text: 'clean', urls: ['https://shop.taobao.com/item'] }, rules)
    expect(flag).toEqual({ reason: 'ad', rule: 'taobao.com' })
  })

  it('does not match a domain that merely contains the rule as a substring', () => {
    // nottaobao.com must NOT match taobao.com
    const flag = classifyAd({ title: 'clean', text: 'clean', urls: ['https://nottaobao.com.evil/x'] }, rules)
    expect(flag).toBeUndefined()
  })
})

describe('classifyAd — category matching', () => {
  it('matches a keyword that appears only in the item category (not title/text)', () => {
    // real case: v2ex 推广-node items whose title is a plain ad with no "推广" word
    const flag = classifyAd(
      { title: '低佣开户抽 JBL 音箱', text: '', categories: ['推广'] },
      rules
    )
    expect(flag).toEqual({ reason: 'ad', rule: '推广' })
  })

  it('does not let a domain-like category false-match a specific keyword', () => {
    // HN stuffs the link host into category (e.g. adafruit.com); specific keywords
    // must not substring-match it.
    const flag = classifyAd(
      { title: 'A library release', text: 'notes', categories: ['adafruit.com'] },
      rules
    )
    expect(flag).toBeUndefined()
  })
})

describe('classifyAd — non-matches', () => {
  it('returns undefined for a clean item', () => {
    const flag = classifyAd({ title: '一篇正常文章', text: '普通内容', urls: ['https://news.ycombinator.com/x'] }, rules)
    expect(flag).toBeUndefined()
  })

  it('returns undefined when rules are empty', () => {
    const flag = classifyAd({ title: '推广', text: '赞助', urls: ['https://taobao.com'] }, {})
    expect(flag).toBeUndefined()
  })
})
