/**
 * 浏览器节点（browser-identity D1）：一个 Chrome profile 里的一个扩展实例。住 data/stream.db 用户侧，
 * 与 facility_devices 同库。
 *
 * `nodeId` 由扩展生成（存在那个 profile 自己的 `chrome.storage.local` 里），后端只记它在哪台设备、
 * 经哪条绑定连进来、认领过的 profile 名、用户标的环境。节点第一次连上时建行，之后每次连上刷新
 * `last_seen_at` 与绑定——绑定会变（同一个 profile 重新配对），节点不变。
 *
 * 「设备的默认浏览器」也住这里（`is_default`）：用户选的本来就是一个 profile。以前它在
 * `ExtBindingStore.default` 上，节点连上时迁过来（`seen` 的 `legacyDefault`）。
 *
 * `woken_at` 是计划 4 的（Stream 静默唤起这个 profile 的时刻），这里只建列。
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface BrowserNode {
  nodeId: string
  deviceId: string
  bindingId: string
  profileDir?: string
  profileName?: string
  label?: string
  environment?: string
  isDefault: boolean
  firstSeenAt: number
  lastSeenAt: number
  wokenAt?: number
}

export interface NodeSeen {
  nodeId: string
  deviceId: string
  bindingId: string
  profileDir?: string
  profileName?: string
  /** 这条绑定是升级前设备的默认浏览器：把默认迁到这个节点（同设备已有默认节点时不抢）。 */
  legacyDefault?: boolean
}

interface Row {
  node_id: string
  device_id: string
  binding_id: string
  profile_dir: string | null
  profile_name: string | null
  label: string | null
  environment: string | null
  is_default: number | null
  first_seen_at: number
  last_seen_at: number
  woken_at: number | null
}

function toNode(r: Row): BrowserNode {
  return {
    nodeId: r.node_id,
    deviceId: r.device_id,
    bindingId: r.binding_id,
    ...(r.profile_dir ? { profileDir: r.profile_dir } : {}),
    ...(r.profile_name ? { profileName: r.profile_name } : {}),
    ...(r.label ? { label: r.label } : {}),
    ...(r.environment ? { environment: r.environment } : {}),
    isDefault: r.is_default === 1,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    ...(r.woken_at != null ? { wokenAt: r.woken_at } : {}),
  }
}

export class NodeStore {
  private readonly db: Database.Database
  private readonly now: () => number
  /**
   * 整表的内存副本。登录态的槽位解析（`cookie-slot.ts`）在热路径上（媒体代理每个请求都读 cookie），
   * 节点表又只有个位数行——读内存，写的时候整份重读。
   */
  private rows: BrowserNode[] = []

  constructor(dbPath: string, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS browser_nodes (
        node_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        profile_dir TEXT,
        profile_name TEXT,
        label TEXT,
        environment TEXT,
        is_default INTEGER,
        first_seen_at INTEGER,
        last_seen_at INTEGER,
        woken_at INTEGER
      );
    `)
    this.reload()
  }

  private reload(): void {
    this.rows = (this.db.prepare('SELECT * FROM browser_nodes ORDER BY first_seen_at, node_id').all() as Row[]).map(toNode)
  }

  /**
   * 节点连上了。新节点建行；老节点刷新设备、绑定与 `last_seen_at`。profile 两格只在这次带了时覆盖——
   * 没带不等于没有（认领记下的名字不能因为一次没带它的握手就被清掉）。
   */
  seen(n: NodeSeen): BrowserNode {
    const t = this.now()
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO browser_nodes (node_id, device_id, binding_id, profile_dir, profile_name, first_seen_at, last_seen_at)
        VALUES (@nodeId, @deviceId, @bindingId, @profileDir, @profileName, @t, @t)
        ON CONFLICT(node_id) DO UPDATE SET
          device_id = excluded.device_id,
          binding_id = excluded.binding_id,
          profile_dir = COALESCE(excluded.profile_dir, profile_dir),
          profile_name = COALESCE(excluded.profile_name, profile_name),
          last_seen_at = excluded.last_seen_at
      `).run({ nodeId: n.nodeId, deviceId: n.deviceId, bindingId: n.bindingId, profileDir: n.profileDir ?? null, profileName: n.profileName ?? null, t })
      if (n.legacyDefault) {
        const taken = this.db.prepare('SELECT 1 FROM browser_nodes WHERE device_id = ? AND is_default = 1 AND node_id != ?').get(n.deviceId, n.nodeId)
        if (!taken) this.db.prepare('UPDATE browser_nodes SET is_default = 1 WHERE node_id = ?').run(n.nodeId)
      }
    })()
    this.reload()
    return this.get(n.nodeId)!
  }

  get(nodeId: string): BrowserNode | undefined {
    return this.rows.find((r) => r.nodeId === nodeId)
  }

  list(): BrowserNode[] {
    return [...this.rows]
  }

  forDevice(deviceId: string): BrowserNode[] {
    return this.rows.filter((r) => r.deviceId === deviceId)
  }

  byBinding(bindingId: string): BrowserNode | undefined {
    return this.rows.find((r) => r.bindingId === bindingId)
  }

  /** 设为所在设备的默认：同设备其余节点的标记一并清掉（每台设备至多一个默认）。 */
  setDefault(nodeId: string): boolean {
    const hit = this.get(nodeId)
    if (!hit) return false
    this.db.transaction(() => {
      this.db.prepare('UPDATE browser_nodes SET is_default = NULL WHERE device_id = ?').run(hit.deviceId)
      this.db.prepare('UPDATE browser_nodes SET is_default = 1 WHERE node_id = ?').run(nodeId)
    })()
    this.reload()
    return true
  }

  clearDefault(nodeId: string): boolean {
    const changed = this.db.prepare('UPDATE browser_nodes SET is_default = NULL WHERE node_id = ?').run(nodeId).changes > 0
    this.reload()
    return changed
  }

  defaultOf(deviceId: string): BrowserNode | undefined {
    return this.rows.find((r) => r.deviceId === deviceId && r.isDefault)
  }

  close(): void { this.db.close() }
}
