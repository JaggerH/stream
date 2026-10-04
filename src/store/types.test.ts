import { describe, it, expect } from 'vitest'
import type { ProviderCategory } from './types.ts'

describe('ProviderCategory', () => {
  it('includes transcribe', () => {
    const v: ProviderCategory = 'transcribe'
    expect(v).toBe('transcribe')
  })
})
