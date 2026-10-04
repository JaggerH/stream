// src/audio/tag-writer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeTags } from './tag-writer.ts'

const execFileP = promisify(execFile)

let dir: string
let flacPath: string
let mp3Path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tag-writer-test-'))
  flacPath = join(dir, 'a.flac')
  mp3Path = join(dir, 'b.mp3')
  // 静音测试音频，1 秒——不关心内容，只关心元数据帧
  await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', '-c:a', 'flac', flacPath])
  await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', '-c:a', 'libmp3lame', mp3Path])
}, 20000)

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function readTags(path: string): Promise<Record<string, string>> {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-show_entries', 'format_tags', '-of', 'json', path,
  ])
  const parsed = JSON.parse(stdout) as { format?: { tags?: Record<string, string> } }
  return parsed.format?.tags ?? {}
}

async function hasAttachedPic(path: string): Promise<boolean> {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type:disposition=attached_pic', '-of', 'json', path,
  ])
  const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type: string; disposition?: { attached_pic?: number } }> }
  return (parsed.streams ?? []).some((s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1)
}

async function countAttachedPicStreams(path: string): Promise<number> {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type:disposition=attached_pic', '-of', 'json', path,
  ])
  const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type: string; disposition?: { attached_pic?: number } }> }
  return (parsed.streams ?? []).filter((s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1).length
}

describe('writeTags', () => {
  it('writes title/artist/album into a flac file, readable back via ffprobe', async () => {
    await writeTags(flacPath, 'flac', { title: '晴天', artist: '周杰伦', album: '叶惠美' })
    const tags = await readTags(flacPath)
    expect(tags.title ?? tags.TITLE).toBe('晴天')
    expect(tags.artist ?? tags.ARTIST).toBe('周杰伦')
    expect(tags.album ?? tags.ALBUM).toBe('叶惠美')
  })

  it('writes title/artist/album into an mp3 file, readable back via ffprobe', async () => {
    await writeTags(mp3Path, 'mp3', { title: 'Hold me', artist: 'Figgy' })
    const tags = await readTags(mp3Path)
    expect(tags.title ?? tags.TITLE).toBe('Hold me')
    expect(tags.artist ?? tags.ARTIST).toBe('Figgy')
  })

  it('embeds cover art as an attached picture stream', async () => {
    // 1x1 红色像素 JPEG（够小，够真实——ffmpeg 只关心它是不是一张合法的图）
    const tinyJpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=',
      'base64',
    )
    await writeTags(flacPath, 'flac', { title: 'x', coverBytes: tinyJpeg })
    expect(await hasAttachedPic(flacPath)).toBe(true)
  })

  it('replaces (not accumulates) a pre-existing attached picture when writing a new cover', async () => {
    // 1x1 红色像素 JPEG
    const redJpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=',
      'base64',
    )
    // 1x1 蓝色像素 JPEG——不同字节，模拟"换一张新封面"
    const blueJpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCcABmT/9k=',
      'base64',
    )
    await writeTags(flacPath, 'flac', { title: 'x', coverBytes: redJpeg })
    expect(await countAttachedPicStreams(flacPath)).toBe(1)
    await writeTags(flacPath, 'flac', { title: 'y', coverBytes: blueJpeg })
    expect(await countAttachedPicStreams(flacPath)).toBe(1)
  })

  it('does nothing when no tags and no cover are given', async () => {
    const before = await readFile(flacPath)
    await writeTags(flacPath, 'flac', {})
    const after = await readFile(flacPath)
    expect(after.equals(before)).toBe(true)
  })

  it('rejects when ffmpeg fails on an unreadable input', async () => {
    await expect(writeTags(join(dir, 'nope.flac'), 'flac', { title: 'x' })).rejects.toThrow()
  })
})
