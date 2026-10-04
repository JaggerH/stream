// src/audio/playlist-export.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { AudioArchive } from './archive.ts'
import type { TrackRef } from './resolver.ts'

export interface PlaylistExportResult {
  written: number
  skipped: number
  path?: string
}

const UNSAFE_FILENAME = /[\\/:*?"<>|\r\n\t]+/g

/** ext4/SMB 常见文件名字节上限 255——留出 `.m3u` 及多字节截断的安全余量。 */
const MAX_LABEL_BYTES = 200

/** 按 UTF-8 字节数截断,不按字符数——CJK 每字符 3 字节,截断点可能落在多字节字符中间,
 *  须逐字符回退到不超预算为止,不能直接 Buffer.slice(截断多字节序列会产生非法 UTF-8)。 */
function truncateToByteBudget(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
  let out = s
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1)
  return out
}

/** 歌单 label → 文件系统安全的文件名。不去重、不记历史文件名——同 label 重复生成必覆盖同一个
 *  文件;歌单改名后旧文件不会被清理(设计文档已定案,见 2026-08-03-music-m3u-export-design.md)。 */
export function m3uFilename(label: string): string {
  const cleaned = truncateToByteBudget(label.replace(UNSAFE_FILENAME, ' ').trim(), MAX_LABEL_BYTES)
  return `${cleaned || 'playlist'}.m3u`
}

/** 绝对路径 → 相对 playlists 目录的路径,统一用 `/` 分隔——目标播放器(VLC / Synology Audio
 *  Station / 手机播放器)都认正斜杠,而生成 m3u 的这台机器不会是 Windows,不需要处理反斜杠。 */
function toPlaylistRelative(playlistsDir: string, absPath: string): string {
  return relative(playlistsDir, absPath).split(sep).join('/')
}

/**
 * 生成一份 Extended M3U(.m3u —— 群晖 Audio Station 只认 .m3u,不认 .m3u8):只认「已经在
 * AudioArchive 里落地」的曲目——不下载、不等下载,
 * 查不到本地文件就跳过并计数。0 首可写 → 不落盘(不会因为一次空生成在 playlists/ 下多出一个空
 * 文件)。相对路径固定相对 `<archive.info().root>/playlists/` 计算,和音频文件天生同一棵挂载树,
 * 不管这棵树在哪台设备上挂载成什么路径,相对关系永远成立。
 */
export function exportPlaylistM3u(archive: AudioArchive, label: string, refs: TrackRef[]): PlaylistExportResult {
  const root = archive.info().root
  const playlistsDir = join(root, 'playlists')
  const lines: string[] = ['#EXTM3U']
  let written = 0
  let skipped = 0
  for (const ref of refs) {
    const asset = archive.lookup(ref)
    if (!asset) { skipped++; continue }
    const display = ([ref.artist, ref.title].filter(Boolean).join(' - ') || ref.title || ref.id || 'unknown').replace(/[\r\n]+/g, ' ')
    lines.push(`#EXTINF:-1,${display}`)
    lines.push(toPlaylistRelative(playlistsDir, asset.absPath))
    written++
  }
  if (written === 0) return { written: 0, skipped }
  mkdirSync(playlistsDir, { recursive: true })
  const path = join(playlistsDir, m3uFilename(label))
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
  return { written, skipped, path }
}
