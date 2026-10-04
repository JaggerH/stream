import { describe, it, expect } from 'vitest'
import { buildAuthFacilities } from '../auth/facility-auth-view.ts'

const sessionAuth = { type: 'session', facility: 'xhs', login: 'qr', loginUrl: 'u', qrSelector: 'q' } as const

describe('buildAuthFacilities', () => {
  it('returns the current projection each call (live, not cached)', () => {
    let health: any = { lastOutcome: 'error', lastErrorCategory: 'auth', lastAt: 't', lastError: 'x' }
    const fn = buildAuthFacilities(() => [{ manifest: { id: 'xhs-home', facility: { key: 'xhs', label: '小红书' }, auth: sessionAuth }, health }])
    expect(fn().length).toBe(1)
    health = { lastOutcome: 'ok', lastAt: 't2' }   // a later ok clears it
    expect(fn()).toEqual([])
  })
})
