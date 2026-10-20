/**
 * 扩展绑定（design D7）：哪个 Chrome 扩展、挂在哪台设备上、凭哪把 token 连进来。
 *
 * 与 `DeviceStore` 同一套规矩，理由也相同：token 能驱动用户登录态浏览器，所以**只存哈希**、
 * 定长比较；配对码只在内存里，5 分钟一次性，连错 5 次全部作废。不同的是配对码**记着目标设备**——
 * 扩展自己说不清它和哪个 agent 在同一台机器上，这件事只有站在两台机器前的用户知道，签码那一刻说清楚。
 *
 * 本机绑定（`local`）不在这张表里：它的 token 是 `data/ext-relay-token`，经 native host 交给扩展。
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MAX_PAIR_FAILURES, PAIRING_TTL_MS, TOUCH_INTERVAL_MS } from './device-store.ts'

const MAX_FIELD = 64

export interface ExtBinding {
  bindingId: string
  deviceId: string
  name: string
  browser?: string
  platform?: string
  pairedAt: number
  lastSeenAt?: number
}

export type ExtPairResult =
  | { ok: true; bindingId: string; token: string; deviceId: string }
  | { ok: false; reason: 'invalid-code' }

interface Row extends ExtBinding {
  tokenHash: string
}

const sha256 = (s: string) => createHash('sha256').update(s).digest()
const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_FIELD) : undefined)

export class ExtBindingStore {
  private rows: Row[]
  private readonly codes = new Map<string, { expiresAt: number; deviceId: string }>()
  private failures = 0
  private readonly now: () => number
  private readonly log?: (line: string) => void

  constructor(
    private readonly file: string,
    opts: { now?: () => number; log?: (line: string) => void } = {},
  ) {
    this.now = opts.now ?? Date.now
    this.log = opts.log
    this.rows = existsSync(file) ? ExtBindingStore.load(file) : []
  }

  private static load(file: string): Row[] {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { bindings?: unknown } | null
      if (!parsed || !Array.isArray(parsed.bindings)) throw new Error('"bindings" is not an array')
      return parsed.bindings as Row[]
    } catch (e) {
      throw new Error(`ext-bindings.json at ${file} is not readable: ${(e as Error).message}`, { cause: e })
    }
  }

  /** 每台设备各自一个码不够用——同一时刻只留一个活码，与设备配对同理：签码要人在机器前，不会并发。 */
  createPairingCode(deviceId: string): { code: string; expiresAt: number } {
    this.codes.clear()
    this.failures = 0
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = this.now() + PAIRING_TTL_MS
    this.codes.set(code, { expiresAt, deviceId })
    return { code, expiresAt }
  }

  pair(code: string, info: { name?: unknown; browser?: unknown; platform?: unknown }): ExtPairResult {
    const t = this.now()
    for (const [c, v] of this.codes) if (v.expiresAt <= t) this.codes.delete(c)
    const hit = this.codes.get(code)
    if (!hit) {
      if (++this.failures >= MAX_PAIR_FAILURES) {
        this.codes.clear()
        this.failures = 0
        this.log?.(`[ext-bindings] ${MAX_PAIR_FAILURES} failed pairing attempts — the live code was invalidated`)
      }
      return { ok: false, reason: 'invalid-code' }
    }
    this.codes.delete(code)
    this.failures = 0
    const bindingId = `ext:${randomUUID()}`
    const token = randomBytes(32).toString('hex')
    const browser = clean(info.browser)
    const platform = clean(info.platform)
    this.rows.push({
      bindingId,
      deviceId: hit.deviceId,
      name: clean(info.name) ?? 'Chrome',
      ...(browser ? { browser } : {}),
      ...(platform ? { platform } : {}),
      pairedAt: t,
      tokenHash: sha256(token).toString('hex'),
    })
    this.save()
    return { ok: true, bindingId, token, deviceId: hit.deviceId }
  }

  bindingForToken(token: string): ExtBinding | undefined {
    const h = sha256(token)
    let hit: Row | undefined
    // 走完每一行：耗时不随命中位置变
    for (const r of this.rows) {
      const stored = Buffer.from(r.tokenHash, 'hex')
      if (stored.length === h.length && timingSafeEqual(stored, h)) hit = r
    }
    return hit ? strip(hit) : undefined
  }

  /** verify 用它当 HMAC key（实例没有 token 明文，见计划 Global Constraints）。 */
  tokenHashOf(bindingId: string): string | undefined {
    return this.rows.find((r) => r.bindingId === bindingId)?.tokenHash
  }

  get(bindingId: string): ExtBinding | undefined {
    const r = this.rows.find((x) => x.bindingId === bindingId)
    return r ? strip(r) : undefined
  }

  list(): ExtBinding[] {
    return this.rows.map(strip)
  }

  forDevice(deviceId: string): ExtBinding[] {
    return this.rows.filter((r) => r.deviceId === deviceId).map(strip)
  }

  revoke(bindingId: string): boolean {
    const before = this.rows.length
    this.rows = this.rows.filter((r) => r.bindingId !== bindingId)
    if (this.rows.length === before) return false
    this.save()
    return true
  }

  /** 设备被撤销，挂在它上面的绑定一并撤销；返回被撤的 id，调用方据此断开连接。 */
  revokeDevice(deviceId: string): string[] {
    const gone = this.rows.filter((r) => r.deviceId === deviceId).map((r) => r.bindingId)
    if (!gone.length) return []
    this.rows = this.rows.filter((r) => r.deviceId !== deviceId)
    this.save()
    return gone
  }

  touch(bindingId: string): void {
    const r = this.rows.find((x) => x.bindingId === bindingId)
    if (!r) return
    const t = this.now()
    if (r.lastSeenAt !== undefined && t - r.lastSeenAt < TOUCH_INTERVAL_MS) return
    r.lastSeenAt = t
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ bindings: this.rows }, null, 2) + '\n', { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }
}

function strip({ tokenHash: _h, ...b }: Row): ExtBinding {
  return b
}
