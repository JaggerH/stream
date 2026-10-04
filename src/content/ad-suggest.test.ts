import { describe, it, expect } from 'vitest'
import { suggestRules } from './ad-suggest.ts'
import type { AdFields, AdRules } from './ad-filter.ts'

const noRules: AdRules = { keywords: [], domains: [] }

describe('suggestRules — candidates', () => {
  it('suggests the registrable domain of an item url', () => {
    const fields: AdFields = { title: 'x', urls: ['https://shop.taobao.com/item?ref=1'] }
    const out = suggestRules(fields, noRules, [])
    expect(out).toContainEqual({ kind: 'domain', value: 'taobao.com', basis: 'domain' })
  })

  it('suggests a source category tag verbatim as a keyword', () => {
    const fields: AdFields = { title: '低佣开户', categories: ['推广'] }
    const out = suggestRules(fields, noRules, [])
    expect(out).toContainEqual({ kind: 'keyword', value: '推广', basis: 'category' })
  })

  it('suggests a promo-lexicon token found in the title', () => {
    const fields: AdFields = { title: '交易永续合约，瓜分 100000 USDT 奖池' }
    const out = suggestRules(fields, noRules, [])
    expect(out).toContainEqual({ kind: 'keyword', value: '瓜分', basis: 'token' })
  })
})

describe('suggestRules — dedupe vs existing rules', () => {
  it('does not re-suggest a domain already in the rules', () => {
    const fields: AdFields = { title: 'x', urls: ['https://jd.com/p'] }
    const out = suggestRules(fields, { keywords: [], domains: ['jd.com'] }, [])
    expect(out.find((c) => c.value === 'jd.com')).toBeUndefined()
  })

  it('does not re-suggest a keyword already in the rules', () => {
    const fields: AdFields = { title: '本周抽奖福利', categories: ['抽奖'] }
    const out = suggestRules(fields, { keywords: ['抽奖'], domains: [] }, [])
    expect(out.find((c) => c.value === '抽奖')).toBeUndefined()
  })
})

describe('suggestRules — precision guard against negatives', () => {
  const fields: AdFields = { title: 'AI 中转站送福利$15' }

  it('excludes a token candidate that would mute a known negative', () => {
    const negatives: AdFields[] = [{ title: '公司员工福利政策解读' }] // legit post containing 福利
    const out = suggestRules(fields, noRules, negatives)
    expect(out.find((c) => c.value === '福利')).toBeUndefined()
  })

  it('keeps the token candidate when no negative would be hit', () => {
    const out = suggestRules(fields, noRules, [])
    expect(out.find((c) => c.value === '福利')).toBeTruthy()
  })
})

describe('suggestRules — ranking category > domain > token', () => {
  it('orders candidates by basis precision', () => {
    const fields: AdFields = {
      title: '限时秒杀',
      categories: ['推广'],
      urls: ['https://taobao.com/x'],
    }
    const out = suggestRules(fields, noRules, [])
    const bases = out.map((c) => c.basis)
    expect(bases.indexOf('category')).toBeLessThan(bases.indexOf('domain'))
    expect(bases.indexOf('domain')).toBeLessThan(bases.indexOf('token'))
  })
})
