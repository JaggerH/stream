import { describe, it, expect } from 'vitest'
import { loadFixtures } from './ad-fixtures.ts'
import { classifyAd } from './ad-filter.ts'
import { DEFAULT_AD_RULES } from './ad-rules.default.ts'
import { makeStreamItem } from '../stream-pipeline.ts'

const fixtures = loadFixtures()

describe('ad regression gate (golden corpus vs DEFAULT_AD_RULES)', () => {
  if (fixtures.length === 0) {
    it('no fixtures yet', () => expect(fixtures).toEqual([]))
  } else {
    it.each(fixtures)('$label · $meta.itemId', (fx) => {
      const muted = classifyAd(fx.fields, DEFAULT_AD_RULES)
      if (fx.label === 'positive') {
        // a miss here is the RED light: add/confirm a rule (see gen suggestions)
        expect(muted, `positive fixture "${fx.meta.itemId}" not caught by DEFAULT_AD_RULES`).toBeTruthy()
      } else {
        // a hit here is a false positive (e.g. news about advertising) — tighten the rule
        expect(muted, `negative fixture "${fx.meta.itemId}" wrongly muted`).toBeUndefined()
      }
    })
  }
})

describe('classification is non-destructive', () => {
  it('makeStreamItem with rules vs without differ only by muted', () => {
    const raw = { title: '【推广】低佣开户', link: 'https://taobao.com/x', category: ['推广'], pubDate: '2026-06-14T00:00:00.000Z' }
    const withRules = makeStreamItem('s', '/r', raw, DEFAULT_AD_RULES)
    const without = makeStreamItem('s', '/r', raw)
    expect(withRules.muted).toBeTruthy()
    // strip muted (the intended difference) and fetched_at (wall-clock, set per call)
    const norm = (it: typeof withRules) => ({ ...it, muted: undefined, fetched_at: '' })
    expect(norm(withRules)).toEqual(norm(without))
  })
})
