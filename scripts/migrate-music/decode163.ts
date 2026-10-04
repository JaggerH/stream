/**
 * 解网易云文件内嵌的 "163 key"（comment tag），本地拿到 netease_id + 元数据。
 * 算法公开：去前缀 → base64 → AES-128-ECB(固定 key) → "music:"+JSON。纯本地、不连网。
 * 用法: pnpm exec tsx scripts/migrate-music/decode163.ts <音频文件绝对路径>
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'

const AES_KEY = Buffer.from("#14ljk_!\\]&0U<'(") // 网易云公开固定 key, 16 bytes

export function decode163(comment: string): Record<string, unknown> | null {
  const m = comment.match(/163 key\(Don't modify\):(.+)$/s)
  if (!m) return null
  const data = Buffer.from(m[1].trim(), 'base64')
  const dc = crypto.createDecipheriv('aes-128-ecb', AES_KEY, null)
  let dec = Buffer.concat([dc.update(data), dc.final()]).toString('utf8')
  dec = dec.replace(/^music:/, '')
  try { return JSON.parse(dec) } catch { return null }
}

const f = process.argv[2]
const comment = execFileSync(
  'ffprobe',
  ['-v', 'error', '-show_entries', 'format_tags=comment', '-of', 'default=nokey=1:noprint_wrappers=1', f],
  { encoding: 'utf8' }
).trim()
console.log('file:', f)
if (!comment) { console.log('（无 comment tag）'); process.exit(0) }
const j = decode163(comment)
if (!j) { console.log('（comment 非 163key 或解密失败）:', comment.slice(0, 60)); process.exit(0) }
console.log('musicId:', j.musicId)
console.log('musicName:', j.musicName)
console.log('artist:', JSON.stringify(j.artist))
console.log('album:', j.album, '| bitrate:', j.bitrate, '| format:', j.format)
