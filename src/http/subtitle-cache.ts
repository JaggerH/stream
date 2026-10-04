import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 抽取/转换出来的字幕内容按 key 落盘缓存 10 天——内嵌轨抽取是网络 I/O 密集操作(~20s,见
 *  docs/superpowers/specs/2026-07-22-netdisk-subtitle-audio-extraction-design.md §1.1 实测)，命中
 *  缓存跳过这个等待。key 由调用方组：内嵌轨 `<视频path>:<streamIndex>`（与 track 契约改字符串前
 *  就是这个形状，存量缓存继续命中）；外挂文件 `<字幕path>:vtt`。过期按 mtime 判断,过期视为未命中,
 *  调用方重新抽取后覆盖写入。 */
const CACHE_TTL_MS = 10 * 24 * 60 * 60 * 1000

function cacheFile(cacheDir: string, key: string): string {
  return join(cacheDir, `${createHash('sha256').update(key).digest('hex')}.vtt`)
}

export async function readCachedSubtitle(cacheDir: string, key: string): Promise<Buffer | null> {
  const file = cacheFile(cacheDir, key)
  try {
    const st = await stat(file)
    if (Date.now() - st.mtimeMs > CACHE_TTL_MS) return null
    return await readFile(file)
  } catch {
    return null
  }
}

export async function writeCachedSubtitle(cacheDir: string, key: string, bytes: Buffer): Promise<void> {
  await mkdir(cacheDir, { recursive: true })
  await writeFile(cacheFile(cacheDir, key), bytes)
}
