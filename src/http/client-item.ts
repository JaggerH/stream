/** 列表接口的唯一序列化出口（Design D1）：剥掉 raw 存档、把 enrich 依赖的源站 ID 提升为
 *  正式字段。提升发生在出口而非归一化入口——归一化只对新采集生效，出口对存量/新增一视同仁。
 *  未来任何"列表里想用 raw 里的字段"的需求，唯一正道是在这里提升为正式字段。
 *  后端内部读取（ItemStore.get / replay / 重新归一化）不走这里，raw 照常可用。 */
import type { StoredItem } from '../item-store.ts'
import type { PresentedItem } from '../content/presented-item.ts'
import { projectItem, type ItemProjection, type ItemProjectionSource } from '../packages/item-projection.ts'

/** 出线形状：既不是库存也不是投影，`__shape` 品牌到这里就剥掉——它只在后端内部划闸门。 */
export type ClientItem = Omit<StoredItem, 'raw' | '__shape'> & { note_id?: string; source_guid?: string } & ItemProjection

/**
 * 包声明的条目投影（`stream.item` + 源目录 → `author_enrich` / `actions` / `source_label` /
 * `source_site`）的数据源，由 sources 域在 registry 建好后挂进来。**thunk，每次序列化现取**：
 * 热装 / 升级的包下一次读列表就生效；存结果 = 新装的包永远没有按钮，且不报错。
 * 没挂（单测、sources 域没起）→ 不投影，原样出线。
 */
let projectionSource: (() => ItemProjectionSource) | null = null
export function setItemProjectionSource(source: (() => ItemProjectionSource) | null): void {
  projectionSource = source
}

/** 收存储条目或播放投影的产物都行——序列化对两者一视同仁；判断"库里存了什么"不在这一层。 */
export function toClientItem(it: StoredItem | PresentedItem): ClientItem {
  const { raw, ...rest } = it
  let out: ClientItem = rest
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    if (typeof r.noteId === 'string' && r.noteId) out.note_id = r.noteId // 笔记类源的原生 id
    if (typeof r.guid === 'string' && r.guid) out.source_guid = r.guid // 讨论站 "<storyId>[-<count>]"
  }
  if (projectionSource) out = projectItem(out, projectionSource())
  return out
}

/** keyset 游标（Design D2）：排序键 = timestamp || fetched_at（与路由排序的字节/byte 比较
 *  语义一致，与 SQL BINARY 谓词对齐），id 做 tie-breaker 保证严格全序。编码为 base64url 的 "sortKey|id" 不透明串；
 *  sortKey 是 ISO 时间戳不含 '|'，故按第一个 '|' 切分，id 可含任意字符。 */
export const sortKeyOf = (it: { timestamp?: string; fetched_at?: string }): string =>
  it.timestamp || it.fetched_at || ''

export function encodeCursor(sortKey: string, id: string): string {
  return Buffer.from(`${sortKey}|${id}`, 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): { sortKey: string; id: string } | null {
  let s: string
  try {
    s = Buffer.from(cursor, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const i = s.indexOf('|')
  if (i < 0) return null
  return { sortKey: s.slice(0, i), id: s.slice(i + 1) }
}

/** it 在"新在前"全序中是否严格排在游标之后（= 下一页成员）。过滤与排序必须用同一把
 *  比较函数（byte comparison），与 SQL 层 BINARY 谓词对齐，两边语义不一致会造成翻页跳/重。 */
export function isAfterCursor(it: { sortKey: string; id: string }, cur: { sortKey: string; id: string }): boolean {
  if (cur.sortKey !== it.sortKey) return cur.sortKey > it.sortKey
  return cur.id > it.id
}
