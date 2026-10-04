import type Database from 'better-sqlite3'
import type { MappingLeft, MappingSet, PlayableHit } from './types.ts'

/** 查询/识别用的左侧投影列（完整真相在 json 列）。 */
const leftRef = (l: MappingLeft): string => (l.kind === 'stream' ? l.streamId : `${l.media}:${l.id}`)

/**
 * netdisk.db 的 bindings/binding_entries 两张表（spec 2026-07-31-netdisk-unified-reconcile §4）。
 * 头部（MappingSet 去掉 entries）整体存 json 列 + 少量查询投影列；entries 逐行落表、`ord` 保数组
 * 顺序、`left_key` 建索引。启动全量加载建内存反查索引（量级百×百，无需增量）；save() 事务重写
 * 该 set 的行并重建索引。leftKey 撞键（同条目被多个绑定收录）取 lastSyncAt 最新者——内容相同，
 * 任一直链都对。只索引 status ∈ {auto, confirmed} 的 entry——pending/rejected/unmatched 不参与播放。
 */
export class MappingStore {
  private sets = new Map<string, MappingSet>()
  private index = new Map<string, PlayableHit>()
  private readonly saveTx: (set: MappingSet) => void
  private readonly removeTx: (id: string) => void

  constructor(db: Database.Database) {
    const upsertBinding = db.prepare(
      'INSERT OR REPLACE INTO bindings (id, left_kind, left_ref, title, right_path, last_sync_at, json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const clearEntries = db.prepare('DELETE FROM binding_entries WHERE binding_id = ?')
    const insertEntry = db.prepare(
      'INSERT INTO binding_entries (binding_id, ord, left_key, left_title, right_file, size, duration_s, status, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const deleteBinding = db.prepare('DELETE FROM bindings WHERE id = ?')
    this.saveTx = db.transaction((set: MappingSet) => {
      const { entries, ...head } = set
      upsertBinding.run(set.id, set.left.kind, leftRef(set.left), set.left.title, set.right.path, set.lastSyncAt ?? null, JSON.stringify(head))
      clearEntries.run(set.id)
      entries.forEach((e, i) =>
        insertEntry.run(set.id, i, e.leftKey, e.leftTitle, e.rightFile, e.fingerprint?.size ?? null, e.fingerprint?.duration ?? null, e.status, JSON.stringify(e)),
      )
    })
    this.removeTx = db.transaction((id: string) => {
      deleteBinding.run(id)
      clearEntries.run(id)
    })

    // 启动全量加载：头部 + entries 按 ord 还原数组
    const entriesByBinding = new Map<string, MappingSet['entries']>()
    for (const row of db.prepare('SELECT binding_id, json FROM binding_entries ORDER BY binding_id, ord').iterate() as Iterable<{ binding_id: string; json: string }>) {
      const arr = entriesByBinding.get(row.binding_id) ?? []
      arr.push(JSON.parse(row.json))
      entriesByBinding.set(row.binding_id, arr)
    }
    for (const row of db.prepare('SELECT id, json FROM bindings').iterate() as Iterable<{ id: string; json: string }>) {
      const set = { ...(JSON.parse(row.json) as Omit<MappingSet, 'entries'>), entries: entriesByBinding.get(row.id) ?? [] } as MappingSet
      this.sets.set(set.id, set)
    }
    this.rebuildIndex()
  }

  list(): MappingSet[] {
    return Array.from(this.sets.values())
  }

  get(id: string): MappingSet | undefined {
    return this.sets.get(id)
  }

  /** 落库 + 重建索引。整库索引重建是 O(绑定数×entry 数)，量级百×百，无需增量。 */
  save(set: MappingSet): void {
    this.sets.set(set.id, set)
    this.saveTx(set)
    this.rebuildIndex()
  }

  remove(id: string): void {
    this.sets.delete(id)
    this.removeTx(id)
    this.rebuildIndex()
  }

  /** 播放路径的唯一入口：leftKey → 可播命中（无命中 = 回落官方源） */
  findByLeftKey(leftKey: string): PlayableHit | undefined {
    return this.index.get(leftKey)
  }

  private rebuildIndex(): void {
    this.index.clear()
    for (const set of this.sets.values()) {
      for (const e of set.entries) {
        if (!e.rightFile || (e.status !== 'auto' && e.status !== 'confirmed')) continue
        const prev = this.index.get(e.leftKey)
        // 撞键：lastSyncAt 新者赢
        if (prev && (prev.lastSyncAt ?? '') > (set.lastSyncAt ?? '')) continue
        this.index.set(e.leftKey, {
          setId: set.id,
          dirPath: set.right.path,
          rightFile: e.rightFile,
          lastSyncAt: set.lastSyncAt,
        })
      }
    }
  }
}

/** 绑定 id：map_ + 6 位随机十六进制（规格示例 map_8f3a2c 的形状） */
export function newMappingId(): string {
  return `map_${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`
}
