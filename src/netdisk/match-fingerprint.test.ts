import { describe, it, expect } from 'vitest'
import { matchByFingerprint } from './match-fingerprint.ts'
import type { MappingEntry } from './types.ts'
import type { AlistFile } from './alist-client.ts'

function file(name: string, size: number): AlistFile {
  return { name, size, isDir: false }
}
function entry(over: Partial<MappingEntry> & Pick<MappingEntry, 'leftKey' | 'status'>): MappingEntry {
  return { leftTitle: over.leftKey, rightFile: null, ...over }
}

describe('matchByFingerprint', () => {
  it('confirmed entry with fingerprint matches new file by size', () => {
    const out = matchByFingerprint(
      [entry({ leftKey: 'k:1', status: 'confirmed', fingerprint: { size: 100 } })],
      [file('new-01.m4a', 100), file('new-02.m4a', 200)],
    )
    expect(out.get('k:1')).toBe('new-01.m4a')
    expect(out.size).toBe(1)
  })

  it('non-confirmed status is not inherited', () => {
    const out = matchByFingerprint(
      [entry({ leftKey: 'k:1', status: 'auto', fingerprint: { size: 100 } })],
      [file('new-01.m4a', 100)],
    )
    expect(out.size).toBe(0)
  })

  it('size collision on new side → both fingerprints abandoned', () => {
    const out = matchByFingerprint(
      [entry({ leftKey: 'k:1', status: 'confirmed', fingerprint: { size: 100 } })],
      [file('a.m4a', 100), file('b.m4a', 100)],
    )
    expect(out.size).toBe(0)
  })

  it('confirmed entry without fingerprint is skipped', () => {
    const out = matchByFingerprint(
      [entry({ leftKey: 'k:1', status: 'confirmed' })],
      [file('a.m4a', 100)],
    )
    expect(out.size).toBe(0)
  })
})
