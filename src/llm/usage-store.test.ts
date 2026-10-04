import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { LlmUsageStore } from './usage-store.ts'

describe('LlmUsageStore', () => {
  it('aggregates calls, token sums, and un* counts per callsite×day', () => {
    const db = new DatabaseSync(':memory:')
    const store = new LlmUsageStore(db, () => Date.UTC(2026, 7, 17, 3, 0, 0)) // 2026-08-17 UTC

    // two metered calls for the same callsite on the same day — tokens must sum
    store.record({
      callsiteId: 'search-agent.pick',
      member: 'deepseek',
      promptTokens: 100,
      completionTokens: 20,
      kind: 'metered',
    })
    store.record({
      callsiteId: 'search-agent.pick',
      member: 'deepseek',
      promptTokens: 50,
      completionTokens: 10,
      kind: 'metered',
    })

    // usage_unreported: provider didn't report tokens — must NOT count toward token sums,
    // but must still be visible as its own count (not silently dropped, not counted as spend)
    store.record({
      callsiteId: 'search-agent.pick',
      member: 'deepseek',
      promptTokens: null,
      completionTokens: null,
      kind: 'usage_unreported',
    })

    // streamed_unmetered: streaming path never got usage at all — separately visible count
    store.record({
      callsiteId: 'search-agent.pick',
      member: 'deepseek',
      promptTokens: null,
      completionTokens: null,
      kind: 'streamed_unmetered',
    })

    // rejected_unmetered: an escalation-retry rung that won but got vetoed by validate() —
    // visible in the ledger, but not counted as spend (token columns null, same as the other un*)
    store.record({
      callsiteId: 'search-agent.pick',
      member: 'deepseek',
      promptTokens: null,
      completionTokens: null,
      kind: 'rejected_unmetered',
    })

    // different callsite — must not merge into the row above
    store.record({
      callsiteId: 'chat.respond',
      member: 'deepseek',
      promptTokens: 5,
      completionTokens: 5,
      kind: 'metered',
    })

    const rows = store.aggregate()
    const pick = rows.find((r) => r.callsiteId === 'search-agent.pick')
    const chat = rows.find((r) => r.callsiteId === 'chat.respond')

    expect(pick).toBeDefined()
    expect(pick!.calls).toBe(5)
    expect(pick!.promptTokens).toBe(150)
    expect(pick!.completionTokens).toBe(30)
    expect(pick!.usageUnreported).toBe(1)
    expect(pick!.streamedUnmetered).toBe(1)
    expect(pick!.rejectedUnmetered).toBe(1)

    expect(chat).toBeDefined()
    expect(chat!.calls).toBe(1)
    expect(chat!.promptTokens).toBe(5)
    expect(chat!.completionTokens).toBe(5)
    expect(chat!.usageUnreported).toBe(0)
    expect(chat!.streamedUnmetered).toBe(0)
    expect(chat!.rejectedUnmetered).toBe(0)
  })

  it('does not merge the same callsite across different days', () => {
    const db = new DatabaseSync(':memory:')
    let now = Date.UTC(2026, 7, 17, 3, 0, 0) // 2026-08-17 UTC
    const store = new LlmUsageStore(db, () => now)

    store.record({
      callsiteId: 'search-agent.pick',
      member: 'deepseek',
      promptTokens: 100,
      completionTokens: 20,
      kind: 'metered',
    })

    now = Date.UTC(2026, 7, 18, 3, 0, 0) // 2026-08-18 UTC
    store.record({
      callsiteId: 'search-agent.pick',
      member: 'deepseek',
      promptTokens: 7,
      completionTokens: 3,
      kind: 'metered',
    })

    const rows = store.aggregate().filter((r) => r.callsiteId === 'search-agent.pick')
    expect(rows).toHaveLength(2)

    const day1 = rows.find((r) => r.day === '2026-08-17')
    const day2 = rows.find((r) => r.day === '2026-08-18')
    expect(day1).toBeDefined()
    expect(day1!.calls).toBe(1)
    expect(day1!.promptTokens).toBe(100)
    expect(day1!.completionTokens).toBe(20)
    expect(day2).toBeDefined()
    expect(day2!.calls).toBe(1)
    expect(day2!.promptTokens).toBe(7)
    expect(day2!.completionTokens).toBe(3)
  })

  it('buckets by day using date(at/1000, unixepoch)', () => {
    const db = new DatabaseSync(':memory:')
    const store = new LlmUsageStore(db, () => Date.UTC(2026, 0, 1, 12, 0, 0))
    store.record({
      callsiteId: 'x',
      member: null,
      promptTokens: 1,
      completionTokens: 1,
      kind: 'metered',
    })
    const rows = store.aggregate()
    expect(rows).toHaveLength(1)
    expect(rows[0].day).toBe('2026-01-01')
  })
})
