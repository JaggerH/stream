/**
 * 一次性核对：把**真实的** stream.db 复制一份，跑迁移，逐个列表比对迁移前后的成员顺序。
 *
 * 为什么要单独跑一遍而不是只信单测：单测里的库是我自己造的，造的时候就带着我对"旧顺序"的理解；
 * 真库里有我没设想过的东西（added_at 撞车、跨域列表、老迁移留下的行）。顺序变了用户会立刻察觉，
 * 所以这一条要拿真数据说话。
 *
 *   node --experimental-strip-types scripts/verify-collection-order-migration.mts <path-to-stream.db>
 */
import Database from 'better-sqlite3'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CollectionsStore } from '../src/collections/store.ts'

const src = process.argv[2]
if (!src) throw new Error('usage: verify-collection-order-migration.mts <stream.db>')

const dir = mkdtempSync(join(tmpdir(), 'col-order-verify-'))
const copy = join(dir, 'stream.db')
copyFileSync(src, copy)

// 迁移前：用**从前那条 ORDER BY** 自己算一遍每个列表的顺序
const raw = new Database(copy, { readonly: true })
const cols = raw.prepare('SELECT id, label, domain FROM collection').all() as Array<{ id: string; label: string; domain: string }>
const before = new Map<string, string[]>()
for (const c of cols) {
  before.set(
    c.id,
    raw.prepare(`SELECT i.key FROM collection_item ci JOIN collected_item i ON i.key = ci.item_key
                 WHERE ci.collection_id = ? ORDER BY ci.added_at DESC, i.key DESC`).all(c.id).map((r: any) => r.key as string),
  )
}
raw.close()

// 迁移（开一次 CollectionsStore 就会跑）
const store = new CollectionsStore(copy)
let bad = 0
for (const c of cols) {
  const was = before.get(c.id)!
  const now = store.itemsOf(c.id).map((i) => i.key)
  const same = was.length === now.length && was.every((k, i) => k === now[i])
  console.log(`${same ? 'OK  ' : 'DIFF'}  ${c.domain}  ${c.label}  (${was.length} 条)`)
  if (!same) {
    bad += 1
    console.log('   before:', was.join(' | '))
    console.log('   after :', now.join(' | '))
  }
}
// 幂等：再开一次不该动任何东西
store.close()
const again = new CollectionsStore(copy)
for (const c of cols) {
  const was = before.get(c.id)!
  const now = again.itemsOf(c.id).map((i) => i.key)
  if (!(was.length === now.length && was.every((k, i) => k === now[i]))) { bad += 1; console.log(`DIFF(第二次开库)  ${c.label}`) }
}
again.close()
rmSync(dir, { recursive: true, force: true })

console.log(bad === 0 ? `\n全部 ${cols.length} 个列表顺序一致，二次开库也一致。` : `\n${bad} 处不一致。`)
process.exit(bad === 0 ? 0 : 1)
