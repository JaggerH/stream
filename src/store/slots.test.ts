import { describe, expect, it } from 'vitest'
import { readSlots } from './slots.ts'

describe('readSlots', () => {
  it('keeps only non-empty all-string arrays', () => {
    expect(
      readSlots({
        slots: {
          ok: ['a', 'b'],
          empty: [],
          mixed: ['a', 1],
          notArray: 'a',
        },
      })
    ).toEqual({ ok: ['a', 'b'] })
  })
  it('treats missing/non-object slots as unset', () => {
    expect(readSlots(undefined)).toEqual({})
    expect(readSlots({})).toEqual({})
    expect(readSlots({ slots: null })).toEqual({})
    expect(readSlots({ slots: ['a'] })).toEqual({})
  })
})
