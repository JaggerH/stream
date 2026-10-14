import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore, PAIRING_TTL_MS, MAX_PAIR_FAILURES } from './device-store.ts'

let file: string
let now: number
const make = () => new DeviceStore(file, { now: () => now })

beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'devices-')), 'devices.json')
  now = 1_000_000
})

describe('DeviceStore', () => {
  it('pairing codes are six digits and expire after the TTL', () => {
    const s = make()
    const { code, expiresAt } = s.createPairingCode()
    expect(code).toMatch(/^\d{6}$/)
    expect(expiresAt).toBe(now + PAIRING_TTL_MS)
    now += PAIRING_TTL_MS + 1
    expect(s.pair(code, 'K80')).toEqual({ ok: false, reason: 'invalid-code' })
  })

  it('a code pairs exactly once and yields an android device id and a token', () => {
    const s = make()
    const { code } = s.createPairingCode()
    const r = s.pair(code, 'K80')
    if (!r.ok) throw new Error('expected ok')
    expect(r.deviceId).toMatch(/^android:[0-9a-f-]{36}$/)
    expect(r.deviceToken).toMatch(/^[0-9a-f]{64}$/)
    expect(s.pair(code, 'again')).toEqual({ ok: false, reason: 'invalid-code' })
    expect(s.deviceForToken(r.deviceToken)).toBe(r.deviceId)
    expect(s.deviceForToken('0'.repeat(64))).toBeUndefined()
  })

  it('stores only a hash of the token, in a 0600 file, and survives a reload', () => {
    const s = make()
    const r = s.pair(s.createPairingCode().code, 'K80')
    if (!r.ok) throw new Error('expected ok')
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain(r.deviceToken)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const reloaded = make()
    expect(reloaded.deviceForToken(r.deviceToken)).toBe(r.deviceId)
    expect(reloaded.list()).toEqual([{ deviceId: r.deviceId, name: 'K80', platform: 'android', pairedAt: now }])
  })

  it(`${MAX_PAIR_FAILURES} wrong codes invalidate every outstanding code`, () => {
    const s = make()
    const { code } = s.createPairingCode()
    const wrong = code === '000000' ? '111111' : '000000'
    for (let i = 0; i < MAX_PAIR_FAILURES; i++) s.pair(wrong, 'x')
    expect(s.pair(code, 'K80')).toEqual({ ok: false, reason: 'invalid-code' })
    const fresh = s.createPairingCode()
    expect(s.pair(fresh.code, 'K80').ok).toBe(true)
  })

  it('revoke removes the device and its token stops resolving', () => {
    const s = make()
    const r = s.pair(s.createPairingCode().code, 'K80')
    if (!r.ok) throw new Error('expected ok')
    expect(s.revoke(r.deviceId)).toBe(true)
    expect(s.revoke(r.deviceId)).toBe(false)
    expect(s.deviceForToken(r.deviceToken)).toBeUndefined()
    expect(make().list()).toEqual([])
  })

  it('touch records lastSeenAt', () => {
    const s = make()
    const r = s.pair(s.createPairingCode().code, 'K80')
    if (!r.ok) throw new Error('expected ok')
    now += 5000
    s.touch(r.deviceId)
    expect(s.list()[0].lastSeenAt).toBe(now)
  })

  it('a blank name becomes "Android" and a long name is capped at 64 characters', () => {
    const s = make()
    const r = s.pair(s.createPairingCode().code, '   ')
    if (!r.ok) throw new Error('expected ok')
    expect(s.list()[0].name).toBe('Android')
    const r2 = s.pair(s.createPairingCode().code, 'x'.repeat(200))
    if (!r2.ok) throw new Error('expected ok')
    expect(s.list()[1].name).toHaveLength(64)
  })
})
