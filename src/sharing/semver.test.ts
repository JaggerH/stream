import { describe, it, expect } from 'vitest'
import { parseSemver, compareSemver, sameMajor } from './semver.ts'

describe('semver', () => {
  it('parses / rejects', () => {
    expect(parseSemver('2.1.3')).toEqual({ major: 2, minor: 1, patch: 3 })
    expect(parseSemver('v2.0.0')).toEqual({ major: 2, minor: 0, patch: 0 })
    expect(parseSemver('not-a-version')).toBeNull()
  })
  it('compares', () => {
    expect(compareSemver('2.1.3', '2.0.0')).toBe(1)
    expect(compareSemver('2.0.0', '2.1.3')).toBe(-1)
    expect(compareSemver('2.0.0', '2.0.0')).toBe(0)
    expect(compareSemver('1.9.9', '2.0.0')).toBe(-1)
  })
  it('sameMajor', () => {
    expect(sameMajor('2.1.3', '2.0.0')).toBe(true)
    expect(sameMajor('3.0.0', '2.9.9')).toBe(false)
  })
})
