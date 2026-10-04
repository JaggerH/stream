// src/audio/tag-writer.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { requireMediaTool } from '../media/ffmpeg-bin.ts'

const execFileP = promisify(execFile)

export interface TrackTags {
  title?: string
  artist?: string
  album?: string
  /** 封面图片的原始字节（已经下载好，调用方负责拿到）；无则不嵌封面。 */
  coverBytes?: Buffer
}

/**
 * 用 ffmpeg 给一个已经在盘上的音频文件写入元数据标签（+ 可选封面），`-c copy` 无损重新封装，
 * 不重新编码音频。写到临时文件再原子改名覆盖回原路径，避免中途失败损坏原文件。全部字段皆空
 * （包括封面）→ 直接返回，不做无意义的重新封装。ffmpeg 失败（非零退出码/spawn 失败）→ reject，
 * 调用方负责决定这算不算致命错误（本项目里：不算，见 src/audio/queue.ts 的接线）。
 */
export async function writeTags(absPath: string, format: string, tags: TrackTags): Promise<void> {
  const hasTextTag = !!(tags.title || tags.artist || tags.album)
  if (!hasTextTag && !tags.coverBytes) return

  const tmpOut = join(dirname(absPath), `.tagwrite-${process.hrtime.bigint().toString(36)}.${format}`)
  let coverPath: string | undefined
  try {
    const args = ['-y', '-i', absPath]
    if (tags.coverBytes) {
      coverPath = join(dirname(absPath), `.tagwrite-cover-${process.hrtime.bigint().toString(36)}.jpg`)
      await writeFile(coverPath, tags.coverBytes)
      args.push('-i', coverPath, '-map', '0:a', '-map', '1', '-disposition:v:0', 'attached_pic')
    } else {
      args.push('-map', '0')
    }
    args.push('-c', 'copy')
    if (tags.title) args.push('-metadata', `title=${tags.title}`)
    if (tags.artist) args.push('-metadata', `artist=${tags.artist}`)
    if (tags.album) args.push('-metadata', `album=${tags.album}`)
    args.push(tmpOut)
    await execFileP(requireMediaTool('ffmpeg'), args, { timeout: 120_000, killSignal: 'SIGKILL' })
    await rename(tmpOut, absPath)
  } finally {
    await rm(tmpOut, { force: true })
    if (coverPath) await rm(coverPath, { force: true })
  }
}
