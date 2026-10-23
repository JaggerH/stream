/**
 * facility（账号）的默认执行目标。住 data/stream.db 用户侧，与 scheduled_tasks 同库。
 *
 * 为什么挂在 facility 而不是配置 row：facility 把登录 recipe（`session.facility`）、凭据域
 * （`stream.credentials`）和动作串在一起；配置 row 的 schema 归包所有，宿主不往里加字段。
 * 缺席 = `local`。见 openspec/changes/device-execution/design.md D2。
 *
 * 目标有三种（browser-identity D7）：设备（`device_id`）、身份（`account_id`）、环境（`environment`），
 * 一行恰好一格有值，由表上的 CHECK 守——手改库写出两格的行会被 SQLite 当场拒，而不是在某一次执行里
 * 被某个读法悄悄挑一个。
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { LOCAL_DEVICE } from './run-context.ts'
import type { Target } from './target.ts'

const CREATE = `
  CREATE TABLE IF NOT EXISTS facility_devices (
    facility TEXT PRIMARY KEY,
    device_id TEXT,
    account_id TEXT,
    environment TEXT,
    CHECK ((device_id IS NOT NULL) + (account_id IS NOT NULL) + (environment IS NOT NULL) = 1)
  );
`

interface Row { facility: string; device_id: string | null; account_id: string | null; environment: string | null }

function toTarget(r: Row): Target {
  if (r.account_id !== null) return { kind: 'identity', accountId: r.account_id }
  if (r.environment !== null) return { kind: 'environment', environment: r.environment }
  return { kind: 'device', deviceId: r.device_id ?? LOCAL_DEVICE }
}

export class FacilityDeviceStore {
  private db: Database.Database
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
    this.db.exec(CREATE)
  }

  /**
   * 老表是 `device_id TEXT NOT NULL`、没有另两列。SQLite 改不了列约束，只能整表重建——身份目标那一行的
   * `device_id` 就是 NULL，不重建就写不进去。只在缺列时走一次。
   */
  private migrate(): void {
    const cols = this.db.prepare('PRAGMA table_info(facility_devices)').all() as { name: string }[]
    if (cols.length === 0 || cols.some((c) => c.name === 'account_id')) return
    this.db.transaction(() => {
      this.db.exec('ALTER TABLE facility_devices RENAME TO facility_devices_old')
      this.db.exec(CREATE)
      this.db.exec('INSERT INTO facility_devices (facility, device_id) SELECT facility, device_id FROM facility_devices_old')
      this.db.exec('DROP TABLE facility_devices_old')
    })()
  }

  private rows(): Row[] {
    return this.db.prepare('SELECT facility, device_id, account_id, environment FROM facility_devices ORDER BY facility').all() as Row[]
  }

  /** 设备目标的那些（远程设备的 cookie 域反查、面板的设备下拉）。身份 / 环境目标不在里面。 */
  list(): { facility: string; deviceId: string }[] {
    return this.rows().filter((r) => r.device_id !== null).map((r) => ({ facility: r.facility, deviceId: r.device_id! }))
  }

  /** 全部目标。 */
  targets(): { facility: string; target: Target }[] {
    return this.rows().map((r) => ({ facility: r.facility, target: toTarget(r) }))
  }

  /** 只回设备目标的设备。**执行位置不读它**——读 `target`，否则身份目标的 facility 会被当成「没绑 = 本机」。 */
  get(facility: string): string | undefined {
    const t = this.target(facility)
    return t?.kind === 'device' ? t.deviceId : undefined
  }

  target(facility: string): Target | undefined {
    const r = this.db.prepare('SELECT facility, device_id, account_id, environment FROM facility_devices WHERE facility = ?').get(facility) as Row | undefined
    return r ? toTarget(r) : undefined
  }

  /** 绑到 `local` 就是清除：本机本来就是缺省，存一行 `local` 只会多一个和「没绑」长得不一样的同义状态。 */
  set(facility: string, deviceId: string): void {
    this.setTarget(facility, { kind: 'device', deviceId })
  }

  /** 换目标种类时整行替换：另两格清成 NULL，恰好一格。 */
  setTarget(facility: string, t: Target): void {
    if (t.kind === 'device' && t.deviceId === LOCAL_DEVICE) { this.clear(facility); return }
    this.db.prepare(`
      INSERT INTO facility_devices (facility, device_id, account_id, environment) VALUES (@facility, @d, @a, @e)
      ON CONFLICT(facility) DO UPDATE SET device_id = excluded.device_id, account_id = excluded.account_id, environment = excluded.environment
    `).run({
      facility,
      d: t.kind === 'device' ? t.deviceId : null,
      a: t.kind === 'identity' ? t.accountId : null,
      e: t.kind === 'environment' ? t.environment : null,
    })
  }

  clear(facility: string): boolean {
    return this.db.prepare('DELETE FROM facility_devices WHERE facility = ?').run(facility).changes > 0
  }

  close(): void { this.db.close() }
}
