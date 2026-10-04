import { describe, it, expect } from 'vitest'
import { buildDoctorReport } from './report.ts'
import type { SourceHealth } from '../source-health-store.ts'

function h(partial: Partial<SourceHealth>): SourceHealth {
  return {
    state: 'healthy',
    lifetimeItemCount: 0,
    consecutiveEmpty: 0,
    consecutiveError: 0,
    lastOutcome: 'ok',
    lastAt: '2026-06-29T00:00:00.000Z',
    ...partial,
  }
}

describe('buildDoctorReport', () => {
  it('renders a degraded-from-empties reason with the count', () => {
    const rows = buildDoctorReport({
      snapshot: { zuna: h({ state: 'degraded', lifetimeItemCount: 10, consecutiveEmpty: 4, lastOutcome: 'empty' }) },
      authOf: () => ({ type: 'none' }),
      availableDomains: [],
    })
    expect(rows[0].state).toBe('degraded')
    expect(rows[0].reason).toMatch(/empty/)
    expect(rows[0].reason).toMatch(/4/)
  })

  it('renders an error reason with the category + message for a dead source', () => {
    const rows = buildDoctorReport({
      snapshot: {
        a: h({ state: 'dead', consecutiveError: 2, lastOutcome: 'error', lastError: 'HTTP 412', lastErrorCategory: 'blocked', lastErrorStack: 'STACK' }),
      },
      authOf: () => undefined,
      availableDomains: [],
    })
    expect(rows[0].reason).toMatch(/error/)
    expect(rows[0].reason).toMatch(/412/)
    expect(rows[0].reason).toMatch(/blocked/) // category surfaced
    expect(rows[0].trace).toBe('STACK') // stack available for --trace
  })

  it('prescribes a missing cookie credential', () => {
    const rows = buildDoctorReport({
      snapshot: { x: h({ state: 'healthy' }) },
      authOf: () => ({ type: 'cookie', domain: 'xueqiu.com', inject: { kind: 'env', name: 'XUEQIU_COOKIES' } }),
      availableDomains: ['douyin.com'],
    })
    expect(rows[0].missingCredential).toMatch(/xueqiu\.com/)
    expect(rows[0].missingCredential).toMatch(/log in to/)
  })

  it('no prescription when the cookie domain is available', () => {
    const rows = buildDoctorReport({
      snapshot: { x: h({ state: 'healthy' }) },
      authOf: () => ({ type: 'cookie', domain: 'douyin.com', inject: { kind: 'env', name: 'DOUYIN_COOKIE' } }),
      availableDomains: ['douyin.com'],
    })
    expect(rows[0].missingCredential).toBeUndefined()
  })

  it('healthy source has an empty reason and rows are sorted by id', () => {
    const rows = buildDoctorReport({
      snapshot: { b: h({ state: 'healthy' }), a: h({ state: 'healthy' }) },
      authOf: () => ({ type: 'none' }),
      availableDomains: [],
    })
    expect(rows.map((r) => r.sourceId)).toEqual(['a', 'b'])
    expect(rows[0].reason).toBe('')
  })
})
