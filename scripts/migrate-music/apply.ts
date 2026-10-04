/**
 * 阶段1 迁移执行：把 plan.csv 里的存量文件整理进统一库（纯本地 move，零下载、零 znnu）。
 *   KEEP(IMPORT/UPGRADE/IMPORT_ASIS) → importExisting(move) 进 netease/歌手 - 曲名.ext + 登记 audio-archive.db
 *   DROP(重复)                        → move 进 ~/nas-music/_migrated_backup/
 * 升级（试听时发现更高音质再下载替换）不在本脚本范围。
 *
 * 用法:
 *   pnpm exec tsx scripts/migrate-music/apply.ts --dry            # 只打印计划，不动文件
 *   pnpm exec tsx scripts/migrate-music/apply.ts --limit 10       # 真跑前 10 行
 *   pnpm exec tsx scripts/migrate-music/apply.ts                  # 真跑全部
 */
import { readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { AudioArchive } from '../../src/audio/archive.ts'

const ROOT = join(homedir(), 'nas-music')
const DB = process.env.AUDIO_ARCHIVE_DB ?? join(process.cwd(), 'data', 'audio-archive.db')
const PLAN = join(homedir(), 'music-migration', 'plan.csv')
const BACKUP = join(ROOT, '_migrated_backup')

const dry = process.argv.includes('--dry')
const li = process.argv.indexOf('--limit')
const limit = li >= 0 ? Number(process.argv[li + 1]) : Infinity

const san = (s: string) => (s || 'unknown').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').trim().slice(0, 120) || 'unknown'

// quote-aware CSV
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split('\n')
  const header = lines[0].split(',')
  const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]; if (!line) continue
    const f: string[] = []; let cur = ''; let q = false
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]
      if (q) { if (ch === '"') { if (line[j + 1] === '"') { cur += '"'; j++ } else q = false } else cur += ch } else { if (ch === '"') q = true; else if (ch === ',') { f.push(cur); cur = '' } else cur += ch }
    }
    f.push(cur)
    const o: Record<string, string> = {}; header.forEach((h, k) => (o[h] = f[k] ?? '')); rows.push(o)
  }
  return rows
}

const rows = parseCsv(readFileSync(PLAN, 'utf-8'))
const archive = dry ? null : new AudioArchive(DB, ROOT)
const seen = new Set<string>()
const st = { imported: 0, skipped: 0, backup: 0, conflict: 0, missing: 0, error: 0 }
let done = 0

for (const r of rows) {
  if (done >= limit) break
  const src = join(ROOT, r.folder, r.name)
  if (!existsSync(src)) { st.missing++; continue }
  done++

  if (r.action === 'DROP') {
    const dest = join(BACKUP, `${r.folder}__${r.name}`)
    if (dry) { console.log(`DROP   ${r.name}  →  _migrated_backup/`); st.backup++; continue }
    mkdirSync(BACKUP, { recursive: true }); renameSync(src, dest); st.backup++; continue
  }

  // KEEP → importExisting(move)
  const id = r.id || `local:${san(r.artist)}-${san(r.title)}`
  let title = r.title
  let rel = `netease/${san(r.artist)} - ${san(title)}.${r.ext}`.toLowerCase()
  if (seen.has(rel) || existsSync(join(ROOT, 'netease', `${san(r.artist)} - ${san(title)}.${r.ext}`))) {
    title = `${r.title} [${r.id || r.folder}]`           // 同名不同曲 → 加后缀避免覆盖
    rel = `netease/${san(r.artist)} - ${san(title)}.${r.ext}`.toLowerCase()
    st.conflict++
  }
  seen.add(rel)

  if (dry) { console.log(`IMPORT ${r.name}  →  netease/${san(r.artist)} - ${san(title)}.${r.ext}  (t${r.tier}${r.id ? '' : ' no-id'})`); st.imported++; continue }
  try {
    const { outcome } = archive!.importExisting(
      { platform: 'netease', id }, src,
      { format: r.ext, qualityTier: Number(r.tier) || 0, title, artist: r.artist, album: r.album },
      { move: true }
    )
    outcome === 'imported' ? st.imported++ : st.skipped++
  } catch (e) { st.error++; console.error('ERR', r.name, (e as Error).message) }
}

if (archive) archive.close()
console.log('\n=== 结果 ===', dry ? '(dry-run, 未动文件)' : '')
console.log(`处理: ${done}  | IMPORT(进库): ${st.imported}  跳过(已有更高): ${st.skipped}  DROP(进备份): ${st.backup}`)
console.log(`命名冲突加后缀: ${st.conflict}  | 源文件已不在: ${st.missing}  | 错误: ${st.error}`)
