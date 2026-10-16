/**
 * Paired devices (phones, headless Linux agents) and their tokens.
 *
 * **Only a hash of each token is stored.** The token is a credential that drives the phone, so a
 * copy of this file must not be enough to impersonate a device. Comparison is constant-time.
 *
 * Pairing codes live **in memory only**. A code is a five-minute, single-use secret, so having a
 * backend restart invalidate every open code is the safe direction. Five wrong attempts
 * invalidate every outstanding code, so nobody can walk the 10^6 code space within one TTL.
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const PAIRING_TTL_MS = 5 * 60_000
export const MAX_PAIR_FAILURES = 5
export const TOUCH_INTERVAL_MS = 60_000
const MAX_NAME = 64

export type PairedPlatform = 'android' | 'linux'
export const PAIRED_PLATFORMS: ReadonlySet<string> = new Set<PairedPlatform>(['android', 'linux'])

export interface PairedDevice {
  deviceId: string
  name: string
  platform: PairedPlatform
  pairedAt: number
  lastSeenAt?: number
}

export type PairResult =
  | { ok: true; deviceId: string; deviceToken: string }
  | { ok: false; reason: 'invalid-code' }

interface Row extends PairedDevice {
  tokenHash: string
}

const sha256 = (s: string) => createHash('sha256').update(s).digest()

export class DeviceStore {
  private rows: Row[]
  private readonly codes = new Map<string, number>()
  private failures = 0
  private readonly now: () => number
  private readonly random: (bytes: number) => Buffer
  private readonly log?: (line: string) => void

  constructor(
    private readonly file: string,
    opts: { now?: () => number; random?: (bytes: number) => Buffer; log?: (line: string) => void } = {},
  ) {
    this.log = opts.log
    this.now = opts.now ?? Date.now
    this.random = opts.random ?? randomBytes
    this.rows = existsSync(file) ? DeviceStore.load(file) : []
  }

  /** Refuse to start on an unreadable file: silently resetting it would erase every pairing on the next save. */
  private static load(file: string): Row[] {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { devices?: unknown } | null
      if (!parsed || !Array.isArray(parsed.devices)) throw new Error('"devices" is not an array')
      return parsed.devices as Row[]
    } catch (e) {
      throw new Error(`devices.json at ${file} is not readable: ${(e as Error).message}`, { cause: e })
    }
  }

  /** Only one code is live at a time; minting is local-only, so it may reset the failure counter. */
  createPairingCode(): { code: string; expiresAt: number } {
    this.codes.clear()
    this.failures = 0
    let code: string
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    while (this.codes.has(code))
    const expiresAt = this.now() + PAIRING_TTL_MS
    this.codes.set(code, expiresAt)
    return { code, expiresAt }
  }

  pair(code: string, name: string, platform: PairedPlatform = 'android'): PairResult {
    this.dropExpired()
    if (!this.codes.has(code)) {
      this.failures++
      if (this.failures >= MAX_PAIR_FAILURES) {
        this.codes.clear()
        this.failures = 0
        this.log?.(`[devices] ${MAX_PAIR_FAILURES} failed pairing attempts — the live code was invalidated; mint a new one`)
      }
      return { ok: false, reason: 'invalid-code' }
    }
    this.codes.delete(code)
    this.failures = 0
    const deviceId = `${platform}:${randomUUID()}`
    const deviceToken = this.random(32).toString('hex')
    const clean = name.trim().slice(0, MAX_NAME) || (platform === 'linux' ? 'Linux' : 'Android')
    this.rows.push({
      deviceId, name: clean, platform, pairedAt: this.now(),
      tokenHash: sha256(deviceToken).toString('hex'),
    })
    this.save()
    return { ok: true, deviceId, deviceToken }
  }

  deviceForToken(token: string): string | undefined {
    const h = sha256(token)
    let hit: string | undefined
    // Walk every row so the time taken does not reveal which row matched.
    for (const r of this.rows) {
      const stored = Buffer.from(r.tokenHash, 'hex')
      if (stored.length === h.length && timingSafeEqual(stored, h)) hit = r.deviceId
    }
    return hit
  }

  list(): PairedDevice[] {
    return this.rows.map(({ tokenHash: _h, ...d }) => d)
  }

  revoke(deviceId: string): boolean {
    const before = this.rows.length
    this.rows = this.rows.filter((r) => r.deviceId !== deviceId)
    if (this.rows.length === before) return false
    this.save()
    return true
  }

  touch(deviceId: string): void {
    const r = this.rows.find((x) => x.deviceId === deviceId)
    if (!r) return
    const t = this.now()
    if (r.lastSeenAt !== undefined && t - r.lastSeenAt < TOUCH_INTERVAL_MS) return
    r.lastSeenAt = t
    this.save()
  }

  private dropExpired(): void {
    const t = this.now()
    for (const [c, exp] of this.codes) if (exp <= t) this.codes.delete(c)
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ devices: this.rows }, null, 2) + '\n', { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }
}
