import { describe, it, expect } from 'vitest'
import { splitSourceId, memberKey, candidateKey } from './memberKey.ts'

describe('splitSourceId', () => {
  it('splits a composite manifest id at the first colon', () => {
    expect(splitSourceId('rsshub:xiaohongshu/user')).toEqual({ pluginId: 'rsshub', templateId: 'xiaohongshu/user' })
  })
  it('treats a colonless id as a custom-plugin template', () => {
    expect(splitSourceId('bilibili-user')).toEqual({ pluginId: 'custom', templateId: 'bilibili-user' })
  })
})

describe('memberKey', () => {
  it('is independent of param insertion order', () => {
    const a = memberKey('rsshub', 'xiaohongshu/user', { id: '42', category: 'notes' })
    const b = memberKey('rsshub', 'xiaohongshu/user', { category: 'notes', id: '42' })
    expect(a).toBe(b)
  })
  it('differs when any param value differs', () => {
    const a = memberKey('rsshub', 'xiaohongshu/user', { id: '42' })
    const b = memberKey('rsshub', 'xiaohongshu/user', { id: '43' })
    expect(a).not.toBe(b)
  })
  it('does not truncate long values but stays within the budget via a stable hash tail', () => {
    const long = 'x'.repeat(500)
    const k = memberKey('rsshub', 'xiaohongshu/user', { id: long })
    expect(k.length).toBeLessThanOrEqual(200)
    expect(memberKey('rsshub', 'xiaohongshu/user', { id: long })).toBe(k)
    expect(memberKey('rsshub', 'xiaohongshu/user', { id: long + 'y' })).not.toBe(k)
  })
})

describe('candidateKey aligns candidate and member', () => {
  it('a radar candidate id and a channel member id produce the same key', () => {
    const fromCandidate = candidateKey('rsshub:xiaohongshu/user', { id: '42' })
    const fromMember = candidateKey('rsshub:xiaohongshu/user', { id: '42' })
    expect(fromCandidate).toBe(fromMember)
  })
})
