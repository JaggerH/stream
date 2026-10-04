/** 检查一个待迁移文件夹(plan-*.csv)与现有 audio-archive 库的重叠。只读。
 *  用法: pnpm exec tsx scripts/migrate-music/check-overlap.ts <plan-csv文件名> */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import Database from 'better-sqlite3'

const DB = process.env.AUDIO_ARCHIVE_DB ?? join(process.cwd(), 'data', 'audio-archive.db')
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split('\n'); const header = lines[0].split(','); const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) { const line = lines[i]; if (!line) continue; const f: string[] = []; let cur = ''; let q = false
    for (let j = 0; j < line.length; j++) { const ch = line[j]; if (q) { if (ch === '"') { if (line[j + 1] === '"') { cur += '"'; j++ } else q = false } else cur += ch } else { if (ch === '"') q = true; else if (ch === ',') { f.push(cur); cur = '' } else cur += ch } }
    f.push(cur); const o: Record<string, string> = {}; header.forEach((h, k) => (o[h] = f[k] ?? '')); rows.push(o) }
  return rows
}

const rows = parseCsv(readFileSync(join(homedir(), 'music-migration', process.argv[2]), 'utf-8'))
const db = new Database(DB, { readonly: true })
const libIds = new Set((db.prepare('SELECT track_id FROM track_asset').all() as { track_id: string }[]).map((r) => r.track_id))
const libTitles = new Set((db.prepare('SELECT title FROM track_asset').all() as { title: string }[]).map((r) => norm(r.title || '')))

let idDup = 0, titleDup = 0, brandNew = 0
const newSamples: string[] = []
for (const r of rows) {
  if (r.id && libIds.has(String(r.id))) idDup++
  else if (libTitles.has(norm(r.title))) titleDup++
  else { brandNew++; if (newSamples.length < 8) newSamples.push(`${r.artist} - ${r.title} (t${r.tier})`) }
}
console.log(`待迁移 ${rows.length} 首 vs 现有库 ${libIds.size} 首:`)
console.log(`  id 精确重复(已在库): ${idDup}`)
console.log(`  标题疑似重复(id不同/对方无id): ${titleDup}`)
console.log(`  全新(库里没有): ${brandNew}`)
console.log('  全新抽样:'); newSamples.forEach((s) => console.log('   ', s))
