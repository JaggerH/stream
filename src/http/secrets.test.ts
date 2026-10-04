import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreateExtToken, tokenEqual } from './secrets.ts'

describe('loadOrCreateExtToken', () => {
  it('creates a 64-hex token with 0600, and is stable across calls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-token-'))
    try {
      const t1 = loadOrCreateExtToken(dir)
      expect(t1).toMatch(/^[0-9a-f]{64}$/)
      expect(statSync(join(dir, 'ext-relay-token')).mode & 0o777).toBe(0o600)
      expect(loadOrCreateExtToken(dir)).toBe(t1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('regenerates when the file exists but is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-token-'))
    try {
      writeFileSync(join(dir, 'ext-relay-token'), '')
      const t = loadOrCreateExtToken(dir)
      expect(t).toMatch(/^[0-9a-f]{64}$/)
      expect(readFileSync(join(dir, 'ext-relay-token'), 'utf8').trim()).toBe(t)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('tokenEqual', () => {
  it('equal strings compare true; different or different-length compare false', () => {
    expect(tokenEqual('abc', 'abc')).toBe(true)
    expect(tokenEqual('abc', 'abd')).toBe(false)
    expect(tokenEqual('abc', 'abcd')).toBe(false)
    expect(tokenEqual('', '')).toBe(true)
  })
})
