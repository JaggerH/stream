import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExtBindingStore } from './ext-binding-store.ts'
import { MAX_PAIR_FAILURES, PAIRING_TTL_MS } from './device-store.ts'

const fresh = (now = () => 1_000) => new ExtBindingStore(join(mkdtempSync(join(tmpdir(), 'extb-')), 'ext-bindings.json'), { now })

describe('ExtBindingStore', () => {
  it('pairs a code onto the device it was minted for', () => {
    const s = fresh()
    const { code } = s.createPairingCode('linux:nas')
    const r = s.pair(code, { name: 'NAS Chrome', browser: 'chrome', platform: 'linux' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.bindingId).toMatch(/^ext:[0-9a-f-]{36}$/)
    expect(r.deviceId).toBe('linux:nas')
    expect(s.bindingForToken(r.token)?.bindingId).toBe(r.bindingId)
    expect(s.list()).toEqual([expect.objectContaining({ bindingId: r.bindingId, deviceId: 'linux:nas', name: 'NAS Chrome' })])
  })

  it('stores only a hash of the token, 0600', () => {
    const s = fresh()
    const r = s.pair(s.createPairingCode('linux:nas').code, {})
    if (!r.ok) throw new Error('pair failed')
    const file = (s as unknown as { file: string }).file
    expect(readFileSync(file, 'utf8')).not.toContain(r.token)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(s.tokenHashOf(r.bindingId)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a code is single-use and expires', () => {
    let t = 1_000
    const s = fresh(() => t)
    const { code } = s.createPairingCode('linux:nas')
    expect(s.pair(code, {}).ok).toBe(true)
    expect(s.pair(code, {}).ok).toBe(false)
    const second = s.createPairingCode('linux:nas').code
    t += PAIRING_TTL_MS + 1
    expect(s.pair(second, {}).ok).toBe(false)
  })

  it('too many wrong codes burn the live one', () => {
    const s = fresh()
    const { code } = s.createPairingCode('linux:nas')
    for (let i = 0; i < MAX_PAIR_FAILURES; i++) s.pair('000000' === code ? '111111' : '000000', {})
    expect(s.pair(code, {}).ok).toBe(false)
  })

  it('a device holds several bindings; revoking the device drops them all', () => {
    const s = fresh()
    const a = s.pair(s.createPairingCode('linux:nas').code, {})
    const b = s.pair(s.createPairingCode('linux:nas').code, {})
    const c = s.pair(s.createPairingCode('linux:pc').code, {})
    if (!a.ok || !b.ok || !c.ok) throw new Error('pair failed')
    expect(s.forDevice('linux:nas').map((x) => x.bindingId).sort()).toEqual([a.bindingId, b.bindingId].sort())
    expect(s.revokeDevice('linux:nas').sort()).toEqual([a.bindingId, b.bindingId].sort())
    expect(s.list().map((x) => x.bindingId)).toEqual([c.bindingId])
    expect(s.bindingForToken(a.token)).toBeUndefined()
  })

  it('one default per device: setting another moves it, clearing drops it', () => {
    const s = fresh()
    const a = s.pair(s.createPairingCode('linux:nas').code, {})
    const b = s.pair(s.createPairingCode('linux:nas').code, {})
    const c = s.pair(s.createPairingCode('linux:pc').code, {})
    if (!a.ok || !b.ok || !c.ok) throw new Error('pair failed')
    expect(s.defaultOf('linux:nas')).toBeUndefined()
    expect(s.setDefault(c.bindingId)).toBe(true)
    expect(s.setDefault(b.bindingId)).toBe(true)
    expect(s.defaultOf('linux:nas')).toBe(b.bindingId)
    expect(s.setDefault(a.bindingId)).toBe(true)
    expect(s.defaultOf('linux:nas')).toBe(a.bindingId)
    expect(s.get(b.bindingId)?.default).toBeUndefined()
    // 另一台设备的默认不受影响
    expect(s.defaultOf('linux:pc')).toBe(c.bindingId)
    expect(s.clearDefault(a.bindingId)).toBe(true)
    expect(s.defaultOf('linux:nas')).toBeUndefined()
    expect(s.setDefault('ext:nope')).toBe(false)
    expect(s.clearDefault('ext:nope')).toBe(false)
  })

  it('the default survives a reload and goes away with its row', () => {
    const s = fresh()
    const a = s.pair(s.createPairingCode('linux:nas').code, {})
    if (!a.ok) throw new Error('pair failed')
    s.setDefault(a.bindingId)
    const file = (s as unknown as { file: string }).file
    expect(new ExtBindingStore(file).defaultOf('linux:nas')).toBe(a.bindingId)
    s.revoke(a.bindingId)
    expect(new ExtBindingStore(file).defaultOf('linux:nas')).toBeUndefined()
  })

  it('a file written before defaults existed reads as no default', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'extb-')), 'ext-bindings.json')
    writeFileSync(file, JSON.stringify({ bindings: [{ bindingId: 'ext:a', deviceId: 'linux:nas', name: 'Chrome', pairedAt: 1, tokenHash: '00' }] }))
    const s = new ExtBindingStore(file)
    expect(s.defaultOf('linux:nas')).toBeUndefined()
    expect(s.list()[0].default).toBeUndefined()
  })

  it('refuses to start on an unreadable file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'extb-')), 'ext-bindings.json')
    writeFileSync(file, '{oops')
    expect(() => new ExtBindingStore(file)).toThrow(/ext-bindings\.json/)
  })
})
