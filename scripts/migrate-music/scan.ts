/**
 * 网易云存量音乐 → audio-archive 迁移：阶段1 只读扫描（含 163key 解 id）。
 * 每个 mp3/flac 一次 ffprobe 同时拿：音质(→computeTier) + comment(→163key 解 netease_id)。
 * id 来源优先级：163key(本地解，准) → music_sync.db(basename) → 无。全程只读，不动文件、不连网。
 *
 * 用法: pnpm exec tsx scripts/migrate-music/scan.ts <文件夹名>...
 */
import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { homedir } from 'node:os'
import crypto from 'node:crypto'
import { computeTier } from '../../src/audio/quality.ts'

const ROOT = join(homedir(), 'nas-music')
const folders = process.argv.slice(2)
if (!folders.length) { console.error('usage: tsx scan.ts <folder>...'); process.exit(1) }

const AES_KEY = Buffer.from("#14ljk_!\\]&0U<'(") // 网易云公开固定 key
interface Meta163 { id: number; name?: string; artist?: string; album?: string }
function meta163(c?: string): Meta163 | null {
  if (!c) return null
  const m = c.match(/163 key\(Don't modify\):(.+)$/s)
  if (!m) return null
  try {
    const dc = crypto.createDecipheriv('aes-128-ecb', AES_KEY, null)
    const dec = Buffer.concat([dc.update(Buffer.from(m[1].trim(), 'base64')), dc.final()])
      .toString('utf8').replace(/^music:/, '')
    const j = JSON.parse(dec)
    const artist = Array.isArray(j.artist) ? j.artist.map((a: unknown[]) => a[0]).join('/') : undefined
    return { id: j.musicId as number, name: j.musicName, artist, album: j.album }
  } catch { return null }
}
const san = (s: string) => (s || 'unknown').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').trim().slice(0, 120) || 'unknown'

// db basename → netease_id（补充来源）
const localDb = '/tmp/music_sync_scan.db'
execFileSync('cp', [join(ROOT, 'music_sync.db'), localDb])
const db = new Database(localDb, { readonly: true })
const byBase = new Map<string, number>()
for (const r of db.prepare('SELECT netease_id,file_path FROM tracks WHERE file_exists=1').all() as Array<{ netease_id: number; file_path: string }>) {
  const b = String(r.file_path).split(/[\\/]/).pop()?.toLowerCase()
  if (b) byBase.set(b, r.netease_id)
}

interface Probe { codec: string; sr?: number; bits?: number; brate?: number; tags: Record<string, string> }
function probe(f: string): Probe | null {
  try {
    const out = execFileSync('ffprobe',
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
       'stream=codec_name,sample_rate,bits_per_raw_sample,bit_rate:format_tags', '-of', 'json', f],
      { encoding: 'utf8', timeout: 30000 })
    const j = JSON.parse(out)
    const s = j.streams?.[0]
    const tags: Record<string, string> = {}
    for (const [k, v] of Object.entries(j.format?.tags ?? {})) tags[k.toLowerCase()] = String(v)
    return {
      codec: String(s?.codec_name ?? ''), sr: Number(s?.sample_rate) || undefined,
      bits: Number(s?.bits_per_raw_sample) || undefined, brate: Number(s?.bit_rate) || undefined, tags,
    }
  } catch { return null }
}
// 文件名 "歌手 - 曲名.ext" 兜底解析
function fromName(name: string): { artist: string; title: string } {
  const base = name.replace(/\.(mp3|flac)$/i, '')
  const i = base.indexOf(' - ')
  return i > 0 ? { artist: base.slice(0, i), title: base.slice(i + 3) } : { artist: 'unknown', title: base }
}

interface Rec {
  folder: string; name: string; ext: string; tier: number
  id: number | ''; id_src: string; artist: string; album: string; title: string
  keep?: string; action?: string; target?: string
}
const recs: Rec[] = []
let n = 0
for (const folder of folders) {
  let names: string[]
  try { names = readdirSync(join(ROOT, folder)) } catch { console.error('skip:', folder); continue }
  for (const name of names) {
    const ext = extname(name).toLowerCase()
    if (!['.mp3', '.flac', '.m4a'].includes(ext)) continue
    const p = probe(join(ROOT, folder, name))
    // 按真实 codec 判音质（m4a 可能是 alac 无损或 aac 有损），fallback 到扩展名
    const tier = p ? computeTier({ format: p.codec || ext.slice(1), bitrate: p.brate ? p.brate / 1000 : undefined, sampleRate: p.sr, bitDepth: p.bits }) : 0
    const k = meta163(p?.tags.comment)
    const dbid = byBase.get(name.toLowerCase())
    const id = k?.id ?? dbid ?? ''
    const nm = fromName(name)
    // 元数据优先级: 163key > 文件 tag > 文件名
    const artist = k?.artist || p?.tags.artist || nm.artist
    const album = k?.album || p?.tags.album || ''
    const title = k?.name || p?.tags.title || nm.title
    recs.push({ folder, name, ext: ext.slice(1), tier, id, id_src: k ? '163' : dbid ? 'db' : '', artist, album, title })
    if (++n % 100 === 0) console.error(`  probed ${n}...`)
  }
}

const norm = (s: string) => s.replace(/\.(mp3|flac)$/i, '').toLowerCase().replace(/\s+/g, ' ').trim()
const groups = new Map<string, Rec[]>()
for (const r of recs) {
  const key = r.id ? 'id:' + r.id : 'nm:' + norm(r.name)
  let g = groups.get(key); if (!g) { g = []; groups.set(key, g) }
  g.push(r)
}
for (const g of groups.values()) { g.sort((a, b) => b.tier - a.tier); g.forEach((r, i) => (r.keep = i === 0 ? 'KEEP' : 'DUP')) }

// 计算每首的 action + 统一库目标路径
for (const r of recs) {
  if (r.keep === 'DUP') { r.action = 'DROP' }                                  // 重复 → 移备份
  else if (r.tier >= 4) { r.action = 'IMPORT' }                                // 无损以上 → move 进库
  else if (r.id) { r.action = 'UPGRADE' }                                      // 有损+id → znnu 下载替换
  else { r.action = 'IMPORT_ASIS' }                                            // 有损无id → 原样进库(标记未升级)
  const ext = r.action === 'UPGRADE' ? 'flac' : r.ext                          // 升级后统一 flac
  r.target = `netease/${san(r.artist)}/${san(r.album)}/${san(r.title)}.${ext}`
}

const c = (f: (r: Rec) => boolean) => recs.filter(f).length
console.log('=== 迁移计划汇总 ===')
console.log('文件夹:', folders.join(', '), '| 总(mp3/flac):', recs.length, '| 去重后唯一:', groups.size)
console.log('tier 分布:', [0, 1, 2, 3, 4, 5].map((t) => `t${t}:${c((r) => r.tier === t)}`).join('  '))
console.log('id 来源:', `163key:${c((r) => r.id_src === '163')}  db:${c((r) => r.id_src === 'db')}  无:${c((r) => !r.id_src)}`)
console.log('--- action 分布 ---')
console.log('IMPORT     (无损以上, move 进库):', c((r) => r.action === 'IMPORT'))
console.log('UPGRADE    (有损+id, znnu 下载替换):', c((r) => r.action === 'UPGRADE'))
console.log('IMPORT_ASIS(有损无id, 原样进库):', c((r) => r.action === 'IMPORT_ASIS'))
console.log('DROP       (重复, 移备份):', c((r) => r.action === 'DROP'))
console.log('--- 抽样目标路径 ---')
for (const r of recs.filter((r) => r.action === 'UPGRADE').slice(0, 3)) console.log('  UPGRADE:', r.name, '→', r.target)
for (const r of recs.filter((r) => r.action === 'IMPORT').slice(0, 3)) console.log('  IMPORT :', r.name, '→', r.target)

const outDir = join(homedir(), 'music-migration'); mkdirSync(outDir, { recursive: true })
const csv = ['folder,name,ext,tier,id,id_src,artist,album,title,keep,action,target']
  .concat(recs.map((r) => [r.folder, `"${r.name.replace(/"/g, '""')}"`, r.ext, r.tier, r.id, r.id_src,
    `"${r.artist.replace(/"/g, '""')}"`, `"${r.album.replace(/"/g, '""')}"`, `"${r.title.replace(/"/g, '""')}"`,
    r.keep, r.action, `"${(r.target ?? '').replace(/"/g, '""')}"`].join(',')))
  .join('\n')
const outFile = join(outDir, 'plan-' + folders.map((f) => f.slice(0, 4)).join('_') + '.csv')
writeFileSync(outFile, csv)
console.log('完整计划 CSV:', outFile)
