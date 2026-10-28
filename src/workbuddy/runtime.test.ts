import { describe, expect, it, vi } from 'vitest'
import { makeDailyCheckin } from './runtime.ts'

describe('Stream WorkBuddy task action', () => {
  it('turns off the Helper schedule before requesting a batch', async () => {
    const calls: string[] = []
    const run = makeDailyCheckin({
      disableOwnSchedule: async () => { calls.push('disable') },
      runAll: async () => { calls.push('checkin'); return { accounts: [{
        id: 'one', displayName: 'one', version: 'cn', enabled: true, status: 'confirmed',
        lastCheckin: 'confirmed', lastCheckinDate: '2026-10-29', balance: 100,
      }] } },
    }, () => new Date('2026-10-29T02:00:00Z'))
    expect((await run()).summary).toContain('1 个账号')
    expect(calls).toEqual(['disable', 'checkin'])
  })
})
