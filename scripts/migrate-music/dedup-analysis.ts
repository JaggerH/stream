/** 对 music_sync 与现有库的"重复候选"做严谨比对：用时长确认是否同一段录音，
 *  再比音质(有损/无损)+ 是否有 id，给出保留建议。只读，不删任何文件。
 *  用法: pnpm exec tsx scripts/migrate-music/dedup-analysis.ts <plan-csv> */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import Database from 'better-sqlite3'

const ROOT = join(homedir(), 'nas-music')
const DB = process.env.AUDIO_ARCHIVE_DB ?? join(process.cwd(), 'data', 'audio-archive.db')
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const isRealId = (s: string) => /^\d+$/.test(s)

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split('\n'); const header = lines[0].split(','); const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) { const line = lines[i]; if (!line) continue; const f: string[] = []; let cur = ''; let q = false
    for (let j = 0; j < line.length; j++) { const ch = line[j]; if (q) { if (ch === '"') { if (line[j + 1] === '"') { cur += '"'; j++ } else q = false } else cur += ch } else { if (ch === '"') q = true; else if (ch === ',') { f.push(cur); cur = '' } else cur += ch } }
    f.push(cur); const o: Record<string, string> = {}; header.forEach((h, k) => (o[h] = f[k] ?? '')); rows.push(o) }
  return rows
}
function dur(abs: string): number | null {
  try { return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', abs], { encoding: 'utf8', timeout: 30000 }).trim()) || null } catch { return null }
}

const rows = parseCsv(readFileSync(join(homedir(), 'music-migration', process.argv[2]), 'utf-8'))
const db = new Database(DB, { readonly: true })
const lib = db.prepare('SELECT t.track_id, t.title, t.artist, a.rel_path, a.quality_tier, a.format FROM track_asset t JOIN asset a ON a.id=t.asset_id').all() as Array<{ track_id: string; title: string; artist: string; rel_path: string; quality_tier: number; format: string }>
const libIds = new Set(lib.map((r) => r.track_id))
const byTitle = new Map<string, typeof lib>()
for (const r of lib) { const k = norm(r.title || ''); let g = byTitle.get(k); if (!g) { g = []; byTitle.set(k, g) } g.push(r) }

const candidates = rows.filter((r) => (r.id && libIds.has(String(r.id))) || byTitle.has(norm(r.title)))
console.log(`重复候选 ${candidates.length} 首（逐个时长比对中…）\n`)
const libDurCache = new Map<string, number | null>()
let same = 0, diff = 0, keepMs = 0, keepLib = 0
const out: string[] = ['verdict,keep,artist,title,ms_fmt,ms_tier,ms_id,lib_fmt,lib_tier,lib_id,ms_dur,lib_dur,lib_track_id']
for (const r of candidates) {
  const msDur = dur(join(ROOT, r.folder, r.name))
  const cands = byTitle.get(norm(r.title)) ?? []
  let best: (typeof lib)[number] | null = null; let bestDiff = Infinity; let bestDur: number | null = null
  for (const c of cands) {
    let d = libDurCache.get(c.rel_path); if (d === undefined) { d = dur(join(ROOT, c.rel_path)); libDurCache.set(c.rel_path, d) }
    if (msDur != null && d != null) { const diffs = Math.abs(msDur - d); if (diffs < bestDiff) { bestDiff = diffs; best = c; bestDur = d } }
    else if (!best) { best = c; bestDur = d ?? null }
  }
  const msId = r.id && isRealId(String(r.id)) ? 'Y' : 'N'
  const libId = best ? (isRealId(best.track_id) ? 'Y' : 'N') : '-'
  const q = (s: string) => `"${(s || '').replace(/"/g, '""')}"`
  if (best && msDur != null && bestDur != null && bestDiff <= 2) {
    same++
    const msT = Number(r.tier), libT = best.quality_tier
    const keepCode = msT > libT ? 'ms' : msT < libT ? 'lib' : (msId === 'Y' && libId === 'N' ? 'ms' : 'lib')
    keepCode === 'ms' ? keepMs++ : keepLib++
    out.push(`SAME,${keepCode},${q(r.artist)},${q(r.title)},${r.ext},${msT},${msId},${best.format},${libT},${libId},${msDur.toFixed(0)},${bestDur.toFixed(0)},${best.track_id}`)
  } else {
    diff++
    out.push(`DIFF,both,${q(r.artist)},${q(r.title)},${r.ext},${r.tier},${msId},${best?.format ?? ''},${best?.quality_tier ?? ''},${libId},${msDur?.toFixed(0) ?? ''},${bestDur?.toFixed(0) ?? ''},${best?.track_id ?? ''}`)
  }
}
writeFileSync(join(homedir(), 'music-migration', 'music_sync-dedup.csv'), out.join('\n'))
console.log(`重复候选 ${candidates.length}:`)
console.log(`  同曲(时长一致) ${same}  → 保留 music_sync(更优) ${keepMs} / 保留库里 ${keepLib}`)
console.log(`  疑似不同版本(时长不符, 都保留) ${diff}`)
console.log('决策清单 CSV: ~/music-migration/music_sync-dedup.csv')
