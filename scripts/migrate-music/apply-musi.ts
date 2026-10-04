/**
 * music_sync → 统一库 迁移执行（纯本地 move，零下载）。读 plan-musi.csv + music_sync-dedup.csv：
 *   全新(不在dedup)        → importExisting 迁入
 *   SAME keep=ms (更优)    → 库里旧版 move 进 _migrated_backup + 删 db 记录，再迁入 music_sync 版（升级）
 *   SAME keep=lib (库更优) → 跳过（music_sync 那份留原处）
 *   DIFF (不同版本)        → 迁入；若与库里同名则加后缀 (ms) 避免覆盖
 * 用法: apply-musi.ts --dry | --limit N | (全量)
 */
import { readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { AudioArchive } from '../../src/audio/archive.ts'

const ROOT = join(homedir(), 'nas-music')
const DB = process.env.AUDIO_ARCHIVE_DB ?? join(process.cwd(), 'data', 'audio-archive.db')
const BACKUP = join(ROOT, '_migrated_backup')
const MIG = join(homedir(), 'music-migration')
const dry = process.argv.includes('--dry')
const li = process.argv.indexOf('--limit'); const limit = li >= 0 ? Number(process.argv[li + 1]) : Infinity
const san = (s: string) => (s || 'unknown').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').trim().slice(0, 120) || 'unknown'

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split('\n'); const header = lines[0].split(','); const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) { const line = lines[i]; if (!line) continue; const f: string[] = []; let cur = ''; let q = false
    for (let j = 0; j < line.length; j++) { const ch = line[j]; if (q) { if (ch === '"') { if (line[j + 1] === '"') { cur += '"'; j++ } else q = false } else cur += ch } else { if (ch === '"') q = true; else if (ch === ',') { f.push(cur); cur = '' } else cur += ch } }
    f.push(cur); const o: Record<string, string> = {}; header.forEach((h, k) => (o[h] = f[k] ?? '')); rows.push(o) }
  return rows
}

const plan = parseCsv(readFileSync(join(MIG, 'plan-musi.csv'), 'utf-8'))
const dedup = parseCsv(readFileSync(join(MIG, 'music_sync-dedup.csv'), 'utf-8'))
const dmap = new Map(dedup.map((d) => [`${d.artist}|||${d.title}`, d]))
const archive = dry ? null : new AudioArchive(DB, ROOT)
const st = { new: 0, replace: 0, diff: 0, skipLib: 0, conflict: 0, missing: 0, error: 0 }
let done = 0

for (const r of plan) {
  if (done >= limit) break
  const src = join(ROOT, r.folder, r.name)
  if (!existsSync(src)) { st.missing++; continue }
  const d = dmap.get(`${r.artist}|||${r.title}`)

  if (d && d.verdict === 'SAME' && d.keep === 'lib') { st.skipLib++; continue }  // 库里最优, music_sync 不迁
  done++

  // SAME keep=ms → 先把库里旧版移备份 + 删 db 记录
  if (d && d.verdict === 'SAME' && d.keep === 'ms') {
    const libRef = { platform: 'netease', id: d.lib_track_id }
    const libAsset = archive?.lookup(libRef) ?? (dry ? null : null)
    if (dry) { console.log(`REPLACE ${r.name}  ↩ 库里旧版(${d.lib_track_id}) 进备份`); st.replace++ }
    else {
      const la = archive!.lookup(libRef)
      if (la && existsSync(la.absPath)) { mkdirSync(BACKUP, { recursive: true }); renameSync(la.absPath, join(BACKUP, `replaced__${basename(la.relPath)}`)) }
      archive!.delete(libRef, { unlinkFile: false })   // 文件已移走, 仅删 db 记录
      st.replace++
    }
    void libAsset
  } else if (d && d.verdict === 'DIFF') { st.diff++ } else if (!d) { st.new++ }

  // 迁入 music_sync 版（撞名加后缀, 保护库里同名不同曲）
  const id = r.id || `local:${san(r.artist)}-${san(r.title)}`
  let title = r.title
  const tgt = (t: string) => join(ROOT, 'netease', `${san(r.artist)} - ${san(t)}.${r.ext}`)
  if (existsSync(tgt(title))) { title = `${r.title} (ms)`; st.conflict++ }
  if (dry) { console.log(`${d ? (d.keep === 'ms' ? 'REPLACE' : 'DIFF   ') : 'NEW    '} ${r.name} → netease/${san(r.artist)} - ${san(title)}.${r.ext}`); continue }
  try {
    archive!.importExisting({ platform: 'netease', id }, src, { format: r.ext, qualityTier: Number(r.tier) || 0, title, artist: r.artist, album: r.album }, { move: true })
  } catch (e) { st.error++; console.error('ERR', r.name, (e as Error).message) }
}

if (archive) archive.close()
console.log('\n=== 结果 ===', dry ? '(dry-run, 未动文件)' : '')
console.log(`全新迁入: ${st.new}  替换升级: ${st.replace}  不同版本迁入: ${st.diff}  库里最优跳过: ${st.skipLib}`)
console.log(`撞名加后缀: ${st.conflict}  源已不在: ${st.missing}  错误: ${st.error}`)
