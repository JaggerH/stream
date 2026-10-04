import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type RepairStatus = 'ok' | 'quarantined' | 'failed'

export interface RepairState {
  consecutiveDrift: number
  status: RepairStatus
  /** re-authoring attempts spent (bounded by maxAttempts) */
  attempts: number
  /** recipe version at which the source was quarantined (a higher version clears it) */
  recipeVersion: number
  lastReason?: string
  lastAt?: string
  /**
   * 这次失败连累了哪些 Source（全名，含记账的这一个本身）——`Registry.affectedSources` 在漂移
   * 那一刻算出来的快照。
   *
   * **为什么写进账里、而不是读账时现算**：账是给"事后"看的。一份被共用的 recipe 漂了、隔天有人
   * 来看这条隔离记录时，包可能已经装卸过、`uses` 可能已经改过——现算给出的是"今天谁在用它"，
   * 而这条记录要回答的是"当时谁跟着哑了"。两个问题不一样，答错了不报错。
   *
   * 缺席 = **没算过**（接线方没提供解析器，或这条记录是旧版本写下的），不是"没人受连累"。
   */
  affectedSources?: string[]
}

export interface PendingRepair {
  sourceId: string
  reason: string
  attempts: number
  /** 见 `RepairState.affectedSources`；缺席 = 没算过，不是「没人受连累」。 */
  affectedSources?: string[]
}

const DEFAULT_DRIFT_K = 3 // consecutive drifts → quarantine (avoids flapping on a blip)
const DEFAULT_MAX_ATTEMPTS = 3 // re-authoring attempts before giving up → failed

function fresh(): RepairState {
  return { consecutiveDrift: 0, status: 'ok', attempts: 0, recipeVersion: 0 }
}

/**
 * Per-replay-source repair state (JSON-persisted). Deterministic half of the repair
 * loop: counts drift, quarantines after K consecutive drifts, tracks re-authoring
 * attempts, and lets a new recipe version release a quarantine. The AI re-authoring
 * itself is out-of-band behind RepairRunner (repair-runner.ts).
 */
export class RepairLedger {
  private readonly map: Record<string, RepairState>
  private readonly driftK: number
  private readonly maxAttempts: number

  constructor(private readonly path: string, opts?: { driftK?: number; maxAttempts?: number }) {
    this.driftK = opts?.driftK ?? DEFAULT_DRIFT_K
    this.maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.map = this.load()
  }

  private load(): Record<string, RepairState> {
    if (!existsSync(this.path)) return {}
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, RepairState>
    } catch {
      return {}
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = join(dirname(this.path), `.repair-ledger.${process.pid}.tmp`)
    writeFileSync(tmp, JSON.stringify(this.map, null, 2))
    renameSync(tmp, this.path)
  }

  get(sourceId: string): RepairState | undefined {
    return this.map[sourceId]
  }

  /** 整本账的只读拷贝（源健康视图合账用）。浅拷贝一层即可：读者不改 RepairState。 */
  snapshot(): Record<string, RepairState> {
    return { ...this.map }
  }

  /** A drift on this source (recipe/site broke). Quarantines after driftK in a row.
   *  `affected`：这次失败连累的全部 Source（见 `RepairState.affectedSources`）——**给了才写**，
   *  没给就保留上一次算出来的那份，别用一个空数组把"没算"写成"没人"。 */
  recordDrift(sourceId: string, reason: string, recipeVersion: number, affected?: readonly string[]): RepairState {
    const s = this.map[sourceId] ?? fresh()
    // a fresh recipe version resets the drift streak
    if (recipeVersion > s.recipeVersion) s.consecutiveDrift = 0
    s.recipeVersion = recipeVersion
    if (affected?.length) s.affectedSources = [...affected]
    s.consecutiveDrift += 1
    s.lastReason = reason
    s.lastAt = new Date().toISOString()
    if (s.status !== 'failed' && s.consecutiveDrift >= this.driftK) s.status = 'quarantined'
    this.map[sourceId] = s
    this.persist()
    return s
  }

  /** A good run — clear the drift streak and any quarantine. */
  recordSuccess(sourceId: string): void {
    const s = this.map[sourceId]
    if (!s) return
    s.consecutiveDrift = 0
    s.attempts = 0
    if (s.status !== 'failed') s.status = 'ok'
    this.map[sourceId] = s
    this.persist()
  }

  /** Should the adapter run this source? A higher recipe version releases a quarantine. */
  shouldRun(sourceId: string, recipeVersion: number): boolean {
    const s = this.map[sourceId]
    if (!s || (s.status !== 'quarantined' && s.status !== 'failed')) return true
    if (recipeVersion > s.recipeVersion) {
      s.status = 'ok'
      s.consecutiveDrift = 0
      s.attempts = 0
      s.recipeVersion = recipeVersion
      this.map[sourceId] = s
      this.persist()
      return true
    }
    return false
  }

  /** Sources currently needing repair (quarantined, not yet exhausted). */
  pending(): PendingRepair[] {
    return Object.entries(this.map)
      .filter(([, s]) => s.status === 'quarantined')
      .map(([sourceId, s]) => ({
        sourceId,
        reason: s.lastReason ?? 'drift',
        attempts: s.attempts,
        affectedSources: s.affectedSources,
      }))
  }

  /** Record a re-authoring attempt outcome; maxAttempts failures → status 'failed'. */
  recordRepairAttempt(sourceId: string, ok: boolean): RepairState {
    const s = this.map[sourceId] ?? fresh()
    if (ok) {
      s.status = 'ok'
      s.consecutiveDrift = 0
      s.attempts = 0
    } else {
      s.attempts += 1
      if (s.attempts >= this.maxAttempts) s.status = 'failed'
    }
    this.map[sourceId] = s
    this.persist()
    return s
  }
}
