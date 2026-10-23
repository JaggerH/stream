import { describe, expect, it } from 'vitest'
import { parseClaimHash } from './hash.ts'

describe('parseClaimHash', () => {
  it('读出后端签的 nonce（base64url）', () => {
    expect(parseClaimHash('#n=Qm9vT3k2X1hZWl9hYmNkZWZnaGlqa2xtbm9w')).toBe('Qm9vT3k2X1hZWl9hYmNkZWZnaGlqa2xtbm9w')
  })
  it('缺、空、形状不对都当没有', () => {
    expect(parseClaimHash('')).toBeUndefined()
    expect(parseClaimHash('#n=')).toBeUndefined()
    expect(parseClaimHash('#x=abcdefghij')).toBeUndefined()
    expect(parseClaimHash('#n=<script>alert(1)</script>')).toBeUndefined()
  })
})
