/**
 * facility（账号）的默认执行设备。住 data/stream.db 用户侧，与 scheduled_tasks 同库。
 *
 * 为什么挂在 facility 而不是配置 row：facility 把登录 recipe（`session.facility`）、凭据域
 * （`stream.credentials`）和动作串在一起；配置 row 的 schema 归包所有，宿主不往里加字段。
 * 缺席 = `local`。见 openspec/changes/device-execution/design.md D2。
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { LOCAL_DEVICE } from './run-context.ts'

export class FacilityDeviceStore {
  private db: Database.Database
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facility_devices (
        facility TEXT PRIMARY KEY,
        device_id TEXT NOT NULL
      );
    `)
  }

  list(): { facility: string; deviceId: string }[] {
    return (this.db.prepare('SELECT facility, device_id FROM facility_devices ORDER BY facility').all() as { facility: string; device_id: string }[])
      .map((r) => ({ facility: r.facility, deviceId: r.device_id }))
  }

  get(facility: string): string | undefined {
    const r = this.db.prepare('SELECT device_id FROM facility_devices WHERE facility = ?').get(facility) as { device_id: string } | undefined
    return r?.device_id
  }

  /** 绑到 `local` 就是清除：本机本来就是缺省，存一行 `local` 只会多一个和「没绑」长得不一样的同义状态。 */
  set(facility: string, deviceId: string): void {
    if (deviceId === LOCAL_DEVICE) { this.clear(facility); return }
    this.db.prepare(`
      INSERT INTO facility_devices (facility, device_id) VALUES (?, ?)
      ON CONFLICT(facility) DO UPDATE SET device_id = excluded.device_id
    `).run(facility, deviceId)
  }

  clear(facility: string): boolean {
    return this.db.prepare('DELETE FROM facility_devices WHERE facility = ?').run(facility).changes > 0
  }

  close(): void { this.db.close() }
}
