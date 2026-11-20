/**
 * 身份表（browser-identity D6）：每个（facility，节点）至多一条——这个 profile 里这个站登着哪个账号。
 * 住 data/stream.db 用户侧，与 browser_nodes 同库。
 *
 * 身份 = （facility，account_id），可以出现在好几个节点上（同一个号登在家里电脑和笔记本上）。
 *
 * 写入规则就是三态的语义：
 * - `signed-in`：覆盖账号与显示名。
 * - `signed-out`：只改状态与核对时间，**保留上次的账号 id**——界面显示「某某（已登出）」，路由不再把它当候选。
 * - `unknown`：不写。问不出来不是答案。
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ProbeResult } from './whoami.ts'

export type IdentityState = 'signed-in' | 'signed-out'

export interface SiteIdentity {
  facility: string
  nodeId: string
  /** 登出且从没见过账号时为空。 */
  accountId?: string
  displayName?: string
  state: IdentityState
  verifiedAt: number
}

/** 探测节流（D15）要的旁证：上次核对时间与会话 cookie 指纹（哈希）。没有记录 = 从没核对过。 */
export interface ProbeState {
  verifiedAt: number
  cookieFingerprint: string | null
}

interface Row {
  facility: string
  node_id: string
  account_id: string | null
  display_name: string | null
  state: string
  verified_at: number
  cookie_fingerprint: string | null
}

const toIdentity = (r: Row): SiteIdentity => ({
  facility: r.facility,
  nodeId: r.node_id,
  ...(r.account_id ? { accountId: r.account_id } : {}),
  ...(r.display_name ? { displayName: r.display_name } : {}),
  state: r.state === 'signed-in' ? 'signed-in' : 'signed-out',
  verifiedAt: r.verified_at,
})

export class SiteIdentityStore {
  private readonly db: Database.Database
  private readonly now: () => number

  constructor(dbPath: string, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS site_identities (
        facility TEXT NOT NULL,
        node_id TEXT NOT NULL,
        account_id TEXT,
        display_name TEXT,
        state TEXT NOT NULL,
        verified_at INTEGER NOT NULL,
        cookie_fingerprint TEXT,
        PRIMARY KEY (facility, node_id)
      );
    `)
    // 旧库补列（D15）：页面探测的节流旁证。指纹只存哈希，不存 cookie 原值。
    const cols = this.db.prepare('PRAGMA table_info(site_identities)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'cookie_fingerprint')) {
      this.db.exec('ALTER TABLE site_identities ADD COLUMN cookie_fingerprint TEXT')
    }
  }

  get(facility: string, nodeId: string): SiteIdentity | undefined {
    const r = this.db.prepare('SELECT * FROM site_identities WHERE facility = ? AND node_id = ?').get(facility, nodeId) as Row | undefined
    return r ? toIdentity(r) : undefined
  }

  /**
   * 探测节流要的旁证：上次核对时间与会话 cookie 指纹（哈希，D15）。没有记录 = 没核对过。
   * 与 `get` 分开：指纹是内部账，不跟着身份表发给面板。
   */
  probeState(facility: string, nodeId: string): ProbeState | null {
    const r = this.row(facility, nodeId)
    return r ? { verifiedAt: r.verified_at, cookieFingerprint: r.cookie_fingerprint ?? null } : null
  }

  private row(facility: string, nodeId: string): Row | null {
    return this.db.prepare('SELECT * FROM site_identities WHERE facility = ? AND node_id = ?').get(facility, nodeId) as Row | null
  }

  list(filter: { facility?: string; nodeId?: string } = {}): SiteIdentity[] {
    const rows = this.db.prepare('SELECT * FROM site_identities ORDER BY facility, node_id').all() as Row[]
    return rows.map(toIdentity).filter((i) =>
      (filter.facility === undefined || i.facility === filter.facility) && (filter.nodeId === undefined || i.nodeId === filter.nodeId))
  }

  /**
   * 记一次探测结果。返回写之前那一条（没有则 undefined）与是否写了——调用方据此判「换号了」。
   * `signed-in` 没带昵称时显示名用账号 id，免得界面上一格空着。
   */
  record(
    facility: string,
    nodeId: string,
    result: ProbeResult,
    opts: { cookieFingerprint?: string | null } = {},
  ): { written: boolean; before?: SiteIdentity } {
    const row = this.row(facility, nodeId)
    const before = row ? toIdentity(row) : undefined
    if (result.state === 'unknown') return { written: false, ...(before ? { before } : {}) }
    const t = this.now()
    // 指纹与这次结果一起落盘（D15）：不给 = 保留原值（核对这类不重算指纹的调用），
    // 显式 `null` = 清掉（登出）。`unknown` 在上面已经返回，指纹不动。
    const fingerprint = 'cookieFingerprint' in opts ? (opts.cookieFingerprint ?? null) : (row?.cookie_fingerprint ?? null)
    if (result.state === 'signed-in') {
      this.db.prepare(`
        INSERT INTO site_identities (facility, node_id, account_id, display_name, state, verified_at, cookie_fingerprint)
        VALUES (?, ?, ?, ?, 'signed-in', ?, ?)
        ON CONFLICT(facility, node_id) DO UPDATE SET
          account_id = excluded.account_id, display_name = excluded.display_name,
          state = excluded.state, verified_at = excluded.verified_at,
          cookie_fingerprint = excluded.cookie_fingerprint
      `).run(facility, nodeId, result.accountId, result.name ?? result.accountId, t, fingerprint)
    } else {
      this.db.prepare(`
        INSERT INTO site_identities (facility, node_id, account_id, display_name, state, verified_at, cookie_fingerprint)
        VALUES (?, ?, NULL, NULL, 'signed-out', ?, ?)
        ON CONFLICT(facility, node_id) DO UPDATE SET
          state = excluded.state, verified_at = excluded.verified_at,
          cookie_fingerprint = excluded.cookie_fingerprint
      `).run(facility, nodeId, t, fingerprint)
    }
    return { written: true, ...(before ? { before } : {}) }
  }

  close(): void { this.db.close() }
}
