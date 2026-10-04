// src/audio/playlist-export.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { AudioArchive } from './archive.ts'
import { exportPlaylistM3u, m3uFilename } from './playlist-export.ts'

let dir: string
let archive: AudioArchive

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stream-playlist-export-'))
  archive = new AudioArchive(join(dir, 'a.db'), join(dir, 'files'))
})

afterEach(() => {
  archive.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('exportPlaylistM3u', () => {
  it('writes archived tracks and skips ones without a local file', async () => {
    await archive.put({ platform: 'netease', id: '1' }, {
      stream: Readable.from([Buffer.from('bytes')]), format: 'flac', title: '晴天', artist: '周杰伦',
    })
    const result = exportPlaylistM3u(archive, '我的歌单', [
      { platform: 'netease', id: '1', title: '晴天', artist: '周杰伦' },
      { platform: 'netease', id: '2', title: '还没下载的歌' },
    ])
    expect(result.written).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.path).toBe(join(dir, 'files', 'playlists', '我的歌单.m3u'))
    const content = readFileSync(result.path!, 'utf8')
    expect(content).toContain('#EXTM3U')
    expect(content).toContain('#EXTINF:-1,周杰伦 - 晴天')
    expect(content).toContain('../netease/')
  })

  it('does not write a file when nothing is archived', () => {
    const result = exportPlaylistM3u(archive, '空歌单', [{ platform: 'netease', id: 'x' }])
    expect(result).toEqual({ written: 0, skipped: 1 })
    expect(existsSync(join(dir, 'files', 'playlists'))).toBe(false)
  })

  it('sanitizes unsafe filename characters from the label', () => {
    expect(m3uFilename('a/b:c*d?e"f<g>h|i')).toBe('a b c d e f g h i.m3u')
  })

  it('computes the relative path correctly for a different platform subfolder', async () => {
    await archive.put({ platform: 'lizhi', id: '9' }, {
      stream: Readable.from([Buffer.from('bytes')]), format: 'mp3', title: 'Ep9',
    })
    const result = exportPlaylistM3u(archive, 'podcast', [{ platform: 'lizhi', id: '9', title: 'Ep9' }])
    const lines = readFileSync(result.path!, 'utf8').split('\n')
    expect(lines).toContain('../lizhi/unknown - Ep9.mp3')
  })

  it('strips embedded newlines from the #EXTINF display text so the line is not split', async () => {
    await archive.put({ platform: 'netease', id: '2' }, {
      stream: Readable.from([Buffer.from('bytes')]), format: 'flac', title: '晴天\r\n注入行', artist: '周杰伦\n也注入',
    })
    const result = exportPlaylistM3u(archive, '换行歌单', [
      { platform: 'netease', id: '2', title: '晴天\r\n注入行', artist: '周杰伦\n也注入' },
    ])
    const lines = readFileSync(result.path!, 'utf8').split('\n')
    const extinfLines = lines.filter((l) => l.startsWith('#EXTINF'))
    expect(extinfLines).toHaveLength(1)
    expect(extinfLines[0]).toBe('#EXTINF:-1,周杰伦 也注入 - 晴天 注入行')
  })

  it('caps the filename at a safe byte budget for very long CJK labels', () => {
    const longLabel = '很长的歌单名字'.repeat(40) // well over 200 bytes in UTF-8
    const filename = m3uFilename(longLabel)
    expect(filename.endsWith('.m3u')).toBe(true)
    const stem = filename.slice(0, -'.m3u'.length)
    expect(Buffer.byteLength(stem, 'utf8')).toBeLessThanOrEqual(200)
  })
})
