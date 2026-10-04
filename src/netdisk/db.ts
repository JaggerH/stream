// 网盘域的库（spec 2026-07-31-netdisk-unified-reconcile §4）：一域一库（同 items.db/jobs.db 惯例），
// 绑定、整理配置、人工裁决、运行账本、动作审计、时长缓存全在这一个文件里。
// 各 Store 不各自开连接——bootstrap 开一次，实例传下去（多 Store 共享同一文件，分开开只会多出
// 「谁先建表」的顺序问题）。
import Database from 'better-sqlite3'
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MappingStore } from './mapping-store.ts'
import type { MappingSet } from './types.ts'

export type NetdiskDb = Database.Database

export function openNetdiskDb(dbPath: string): NetdiskDb {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS bindings (
      id TEXT PRIMARY KEY,
      left_kind TEXT NOT NULL,
      left_ref TEXT NOT NULL,
      title TEXT NOT NULL,
      right_path TEXT NOT NULL,
      last_sync_at TEXT,
      -- MappingSet 去掉 entries 的整体（可选字段多且还在演化，逐列拆平只会让每次加字段都变 DDL；
      -- 拆出来的列是查询/识别用的投影，json 才是完整真相）
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS binding_entries (
      binding_id TEXT NOT NULL,
      ord INTEGER NOT NULL, -- entries 数组顺序 = 清单顺序，展示顺序靠它还原
      left_key TEXT NOT NULL,
      left_title TEXT NOT NULL,
      right_file TEXT,
      size INTEGER,
      duration_s REAL,
      status TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (binding_id, ord)
    );
    CREATE INDEX IF NOT EXISTS idx_binding_entries_left_key ON binding_entries(left_key);
    CREATE TABLE IF NOT EXISTS reconcile_shows (
      id TEXT PRIMARY KEY,
      ord INTEGER NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decisions (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN (${DECISION_KIND_CHECK})),
      note TEXT,
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reconcile_runs (
      run_id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      show TEXT NOT NULL,
      mode TEXT NOT NULL,
      conservation INTEGER NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_actions (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      action TEXT NOT NULL,
      src TEXT NOT NULL,
      dst TEXT,
      size INTEGER NOT NULL,
      basis TEXT NOT NULL,
      undone INTEGER NOT NULL DEFAULT 0,
      run_id TEXT
    );
    -- 「AI 建议 vs 人最终选择」的对照账本（见 reconcile/suggestions.ts）。判读一出结论就落一行，
    -- 人后来答了再回填后半截——**建议先落**，不然"AI 建议了、人压根没采纳"这一类会消失。
    CREATE TABLE IF NOT EXISTS ai_suggestions (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      path TEXT NOT NULL,
      verdict TEXT NOT NULL,        -- is-episode | none-of-these | unsure | failed
      left_key TEXT,                -- is-episode 时 AI 指的是哪一集
      quotes INTEGER NOT NULL,      -- 引文条数；0 = 整条作废，不进分母
      candidates TEXT NOT NULL,     -- JSON：当时摆出来的候选 leftKey
      answered_at INTEGER,          -- 以下三列人没答就是 NULL
      human_verdict TEXT,           -- is-episode | not-episode
      human_left_key TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ai_suggestions_path ON ai_suggestions(path);
    CREATE TABLE IF NOT EXISTS durations (
      key TEXT PRIMARY KEY,      -- '字节数:绝对路径'（同 DurationCache.cacheKey）
      duration_s REAL            -- NULL = 探过但失败（负缓存），行不存在才是「没探过」
    );
    -- 头尾采样转写的缓存（见 reconcile/sample-cache.ts）。转写**要花钱**：同一份文件被听第二遍
    -- 就是白付一次。key 首选 AList 的 driver 侧对象 id（夸克即 fid，跟着文件走，整理把它搬上货架
    -- 之后照样命中），取不到才退成「字节数:路径」那一档。size_bytes 是命中时的复核项，不是 key。
    CREATE TABLE IF NOT EXISTS audio_samples (
      key TEXT PRIMARY KEY,      -- 'fid:<对象id>:w<窗口秒>' 或 'path:<字节数>:<绝对路径>:w<窗口秒>'
      at INTEGER NOT NULL,
      path TEXT NOT NULL,        -- 只为排查留着（key 是 fid 那一档时，路径会随整理搬家而变）
      size_bytes INTEGER NOT NULL,
      probe TEXT NOT NULL        -- JSON：IdentityProbe（两段窗口的原文 + 位置 + 分阶段耗时）
    );
    -- 追更（spec 2026-09-03-work-follow-loop §3.2）：一条绑定吃过哪些分享。转存成功那一刻分享链接
    -- 不再扔掉——「这条分享会不会继续更新」是回访的全部依据。not-usable 的行不删，只记 validity。
    CREATE TABLE IF NOT EXISTS binding_shares (
      set_id TEXT NOT NULL,
      netdisk TEXT NOT NULL,
      pwd_id TEXT NOT NULL,
      passcode TEXT,
      origin TEXT NOT NULL,
      added_at TEXT NOT NULL,
      last_check TEXT,
      validity TEXT,
      seen_files TEXT NOT NULL DEFAULT '[]',
      saved_fids TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (set_id, netdisk, pwd_id)
    );
    -- 转存成功、但那一刻还没有绑定可挂的分享（见 follow/pending-shares.ts）。用户常常先转存、
    -- 过后才把落点建成一条绑定；不暂存这一条，那条分享就再也进不了 binding_shares，追更永远
    -- 不会回访它。认领判据 = dir_path 命中某条绑定的 right.path；领走即删，领不走的到期清掉。
    CREATE TABLE IF NOT EXISTS pending_shares (
      netdisk TEXT NOT NULL,
      pwd_id TEXT NOT NULL,
      dir_path TEXT NOT NULL,   -- AList 绝对落点（normalizeLandingDir 归一化过）
      passcode TEXT,
      saved_at TEXT NOT NULL,
      PRIMARY KEY (netdisk, pwd_id, dir_path)
    );
    CREATE INDEX IF NOT EXISTS idx_pending_shares_dir ON pending_shares(dir_path);
    -- 追更每轮一行（spec §3.3）。错误是行，不是日志。
    CREATE TABLE IF NOT EXISTS follow_runs (
      id TEXT PRIMARY KEY,
      set_id TEXT NOT NULL,
      at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_follow_runs_set ON follow_runs(set_id, at);
  `)
  widenDecisionKinds(db)
  // run_actions.run_id：整轮撤销按它找行（spec 2026-09-03-tv-season-archive §4/§5）。老库没有这一列，
  // 建表语句里加了对存量库不生效，所以按 table_info 探一次再 ALTER——幂等，重启多少次都只加一次。
  const runActionsCols = (db.prepare('PRAGMA table_info(run_actions)').all() as { name: string }[]).map((c) => c.name)
  if (!runActionsCols.includes('run_id')) db.exec('ALTER TABLE run_actions ADD COLUMN run_id TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_run_actions_run ON run_actions(run_id)')
  return db
}

/**
 * `decisions.kind` 的闭集。人裁的两种组合键（`not-episode` 否、`is-episode` 是）是后加的，
 * 而**存量库里那条 CHECK 是建表时写死的**：`CREATE TABLE IF NOT EXISTS` 一个字都改不动它——
 * 不重建的话，老库上写这一类决定会被 SQLite 直接拒（`CHECK constraint failed`），而那正是
 * 活体那些库。往下加新 kind 只需要往这个数组里加一项，下面那趟迁移会自己发现口径变了。
 */
const DECISION_KINDS = ['exempt', 'tombstone', 'not-episode', 'is-episode', 'prefer'] as const
const DECISION_KIND_CHECK = DECISION_KINDS.map((k) => `'${k}'`).join(',')

/** SQLite 改不了 CHECK，只能建新表 → 搬数据 → 换名；整段一个事务，中途断电不会留半张表。 */
function widenDecisionKinds(db: NetdiskDb): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'decisions'").get() as { sql?: string } | undefined
  if (!row?.sql || DECISION_KINDS.every((k) => row.sql!.includes(k))) return
  db.transaction(() => {
    db.exec(`
      CREATE TABLE decisions_new (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN (${DECISION_KIND_CHECK})),
        note TEXT,
        at INTEGER NOT NULL
      );
      INSERT INTO decisions_new (key, kind, note, at) SELECT key, kind, note, at FROM decisions;
      DROP TABLE decisions;
      ALTER TABLE decisions_new RENAME TO decisions;
    `)
  })()
}

/** Back-compat：`left.kind` 曾叫 `'playlist'`（词来自音频歌单，它实际就是「一个订阅流」）。
 *  存量 JSON 里全是旧名——导入时归一，库里只有新名。改名不得丢掉任何存量绑定。 */
function normalizeLeft(set: MappingSet): MappingSet {
  const left = set?.left as { kind?: string } | undefined
  if (left?.kind === 'playlist') left.kind = 'stream'
  return set
}

export interface LegacyNetdiskPaths {
  /** 旧 per-binding JSON 目录（data/mappings/）。 */
  mappingsDir: string
  /** 旧整理数据目录（data/reconcile/：config.json / decisions.json / runs.jsonl / provenance.jsonl / durations.json）。 */
  reconcileDir: string
}

/**
 * 启动时一次性迁移：对每一块，**表为空且旧文件在**才导入；导入成功后旧文件/目录改名加
 * `.migrated` 后缀留作备份（不删）。表已非空 = 迁过了，旧文件即便还在也不再读。
 * 单块损坏只跳过那一块并留下原文件（证据别毁），不掀翻启动。
 */
export function migrateLegacyNetdiskData(db: NetdiskDb, legacy: LegacyNetdiskPaths, log: (m: string) => void): void {
  const empty = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n === 0
  const retire = (path: string) => {
    try {
      renameSync(path, `${path}.migrated`)
    } catch (e) {
      log(`[netdisk-db] 迁移完成但改名失败（数据已入库，下次启动不会重导）：${path}: ${String(e)}`)
    }
  }

  // 绑定：经 MappingStore.save 写入——与运行时同一条写路径，形状不可能分家。
  if (empty('bindings') && existsSync(legacy.mappingsDir)) {
    try {
      const store = new MappingStore(db)
      let n = 0
      for (const f of readdirSync(legacy.mappingsDir)) {
        if (!f.endsWith('.json')) continue
        try {
          const set = normalizeLeft(JSON.parse(readFileSync(join(legacy.mappingsDir, f), 'utf8')) as MappingSet)
          if (set?.id) {
            store.save(set)
            n++
          }
        } catch {
          log(`[netdisk-db] 迁移跳过损坏的绑定文件：${f}`)
        }
      }
      log(`[netdisk-db] 迁入 ${n} 条绑定 ← ${legacy.mappingsDir}`)
      retire(legacy.mappingsDir)
    } catch (e) {
      log(`[netdisk-db] 绑定迁移失败（原文件保留）：${String(e)}`)
    }
  }

  const jsonPiece = (table: string, file: string, insert: (parsed: unknown) => number) => {
    const path = join(legacy.reconcileDir, file)
    if (!empty(table) || !existsSync(path)) return
    try {
      const n = insert(JSON.parse(readFileSync(path, 'utf8')))
      log(`[netdisk-db] 迁入 ${n} 行 → ${table} ← ${file}`)
      retire(path)
    } catch (e) {
      log(`[netdisk-db] ${file} 迁移失败（原文件保留）：${String(e)}`)
    }
  }

  const jsonlPiece = (table: string, file: string, insertLine: (parsed: unknown) => void) => {
    const path = join(legacy.reconcileDir, file)
    if (!empty(table) || !existsSync(path)) return
    try {
      let n = 0
      const run = db.transaction(() => {
        for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
          try {
            insertLine(JSON.parse(line))
            n++
          } catch {
            // 碎尾行只丢那一行，不丢整本（同旧 jsonl 读取语义）
          }
        }
      })
      run()
      log(`[netdisk-db] 迁入 ${n} 行 → ${table} ← ${file}`)
      retire(path)
    } catch (e) {
      log(`[netdisk-db] ${file} 迁移失败（原文件保留）：${String(e)}`)
    }
  }

  jsonPiece('reconcile_shows', 'config.json', (parsed) => {
    const shows = (parsed as { shows?: { id: string }[] })?.shows ?? []
    const ins = db.prepare('INSERT OR REPLACE INTO reconcile_shows (id, ord, json) VALUES (?, ?, ?)')
    const run = db.transaction(() => shows.forEach((s, i) => ins.run(s.id, i, JSON.stringify(s))))
    run()
    return shows.length
  })

  jsonPiece('decisions', 'decisions.json', (parsed) => {
    const d = parsed as { exemptions?: Record<string, { note: string; at: number }>; tombstones?: Record<string, { at: number }> }
    const ins = db.prepare('INSERT OR REPLACE INTO decisions (key, kind, note, at) VALUES (?, ?, ?, ?)')
    let n = 0
    const run = db.transaction(() => {
      for (const [key, v] of Object.entries(d?.exemptions ?? {})) {
        ins.run(key, 'exempt', v.note, v.at)
        n++
      }
      for (const [key, v] of Object.entries(d?.tombstones ?? {})) {
        ins.run(key, 'tombstone', null, v.at)
        n++
      }
    })
    run()
    return n
  })

  {
    const ins = db.prepare(
      'INSERT OR REPLACE INTO reconcile_runs (run_id, at, show, mode, conservation, json) VALUES (?, ?, ?, ?, ?, ?)',
    )
    jsonlPiece('reconcile_runs', 'runs.jsonl', (parsed) => {
      const r = parsed as { runId: string; at: string; show: string; mode: string; conservation: boolean }
      if (!r?.runId) return
      ins.run(r.runId, r.at, r.show, r.mode, r.conservation ? 1 : 0, JSON.stringify(r))
    })
  }

  {
    // 旧 jsonl 的 markUndone 是「追加一条同 id 全量行」——按行序 INSERT OR REPLACE，后写的自然覆盖。
    const ins = db.prepare(
      'INSERT OR REPLACE INTO run_actions (id, at, action, src, dst, size, basis, undone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    jsonlPiece('run_actions', 'provenance.jsonl', (parsed) => {
      const e = parsed as { id: string; at: number; action: string; src: string; dst?: string; size: number; basis: string; undone?: true }
      if (!e?.id) return
      ins.run(e.id, e.at, e.action, e.src, e.dst ?? null, e.size, e.basis, e.undone ? 1 : 0)
    })
  }

  jsonPiece('durations', 'durations.json', (parsed) => {
    const data = parsed as Record<string, number | null>
    const ins = db.prepare('INSERT OR REPLACE INTO durations (key, duration_s) VALUES (?, ?)')
    const keys = Object.keys(data ?? {})
    const run = db.transaction(() => {
      for (const k of keys) ins.run(k, data[k])
    })
    run()
    return keys.length
  })
}
