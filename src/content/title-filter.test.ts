import { describe, it, expect } from 'vitest'
import { includeFold } from './title-filter.ts'

describe('includeFold (只看包含)', () => {
  it('keeps a title that contains a keyword', () => {
    expect(includeFold('第1期纯享上集', ['纯享'])).toBeUndefined()
  })
  it('folds a title that matches no keyword', () => {
    expect(includeFold('先导片 抢金赛', ['纯享'])).toEqual({ reason: 'filtered', rule: '纯享' })
  })
  it('is case-insensitive', () => {
    expect(includeFold('FULL version', ['full'])).toBeUndefined()
  })
  it('empty / absent list never folds', () => {
    expect(includeFold('anything', [])).toBeUndefined()
    expect(includeFold('anything', undefined)).toBeUndefined()
  })
  it('joins multiple keywords into the rule label', () => {
    expect(includeFold('无关标题', ['纯享', '加更'])).toEqual({ reason: 'filtered', rule: '纯享|加更' })
  })
})
