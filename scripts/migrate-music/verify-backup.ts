/** 核实 _migrated_backup 里每个 DROP(重复)文件，其同曲保留版是否已在 netease/ 库里。
 *  全在 → 备份可安全删。用法: pnpm exec tsx scripts/migrate-music/verify-backup.ts */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ROOT = join(homedir(), 'nas-music')
const san = (s: string) => (s || 'unknown').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').trim().slice(0, 120) || 'unknown'
const norm = (s: string) => s.replace(/\.(mp3|flac)$/i, '').toLowerCase().replace(/\s+/g, ' ').trim()

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split('\n'); const header = lines[0].split(','); const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]; if (!line) continue
    const f: string[] = []; let cur = ''; let q = false
    for (let j = 0; j < line.length; j++) { const ch = line[j]; if (q) { if (ch === '"') { if (line[j + 1] === '"') { cur += '"'; j++ } else q = false } else cur += ch } else { if (ch === '"') q = true; else if (ch === ',') { f.push(cur); cur = '' } else cur += ch } }
    f.push(cur); const o: Record<string, string> = {}; header.forEach((h, k) => (o[h] = f[k] ?? '')); rows.push(o)
  }
  return rows
}

const rows = parseCsv(readFileSync(join(homedir(), 'music-migration', 'plan.csv'), 'utf-8'))
const groups = new Map<string, Record<string, string>[]>()
for (const r of rows) { const key = r.id ? 'id:' + r.id : 'nm:' + norm(r.name); let g = groups.get(key); if (!g) { g = []; groups.set(key, g) } g.push(r) }

let allSafe = true
for (const r of rows.filter((r) => r.action === 'DROP')) {
  const key = r.id ? 'id:' + r.id : 'nm:' + norm(r.name)
  const keep = (groups.get(key) ?? []).find((x) => x.keep === 'KEEP')
  const keptRel = keep ? `netease/${san(keep.artist)} - ${san(keep.title)}.${keep.action === 'UPGRADE' ? 'flac' : keep.ext}` : ''
  const inLib = keep && existsSync(join(ROOT, keptRel))
  if (!inLib) allSafe = false
  console.log(`${inLib ? '✓' : '✗ 缺!'}  备份: ${r.name} (t${r.tier})  →  库里保留版: ${keep ? `${keep.name} (t${keep.tier})` : '无!'} ${inLib ? '在库' : ''}`)
}
console.log('\n结论:', allSafe ? '14 个备份的保留版全部在库 → _migrated_backup 可安全删除' : '⚠️ 有保留版不在库,先别删')
