// src/audio/archive.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { AudioArchive } from './archive.ts'

let dir: string
let arc: AudioArchive
const ref = { platform: 'netease', id: '1' } as const
const res = (bytes: string, q: Partial<{ format: string; bitrate: number; sampleRate: number; bitDepth: number }> = {}) => ({
  stream: Readable.from([Buffer.from(bytes)]),
  format: q.format ?? 'mp3',
  bitrate: q.bitrate ?? 320,
  sampleRate: q.sampleRate,
  bitDepth: q.bitDepth,
  title: 'Song', artist: 'Artist', album: 'Album',
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arc-'))
  arc = new AudioArchive(join(dir, 'a.db'), join(dir, 'files'))
})
afterEach(() => { arc.close(); rmSync(dir, { recursive: true, force: true }) })

describe('AudioArchive', () => {
  it('stores bytes, writes a file, and looks up', async () => {
    const { asset, outcome } = await arc.put(ref, res('hello'))
    expect(outcome).toBe('stored')
    expect(existsSync(asset.absPath)).toBe(true)
    expect(readFileSync(asset.absPath).toString()).toBe('hello')
    const found = arc.lookup(ref)
    expect(found?.assetId).toBe(asset.assetId)
    expect(arc.has(ref)).toBe(true)
  })
  it('skips a download that is not better quality', async () => {
    await arc.put(ref, res('hi', { format: 'flac', sampleRate: 44100, bitDepth: 16 })) // tier 4
    const { outcome } = await arc.put(ref, res('lo', { format: 'mp3', bitrate: 320 })) // tier 3
    expect(outcome).toBe('skipped')
    expect(arc.lookup(ref)?.format).toBe('flac')
  })
  it('re-downloads when the existing archive row points at a missing file', async () => {
    const first = await arc.put(ref, res('old', { format: 'flac', sampleRate: 44100, bitDepth: 16 }))
    rmSync(first.asset.absPath, { force: true })

    const { outcome, asset } = await arc.put(ref, res('new', { format: 'mp3', bitrate: 320 }))

    expect(outcome).toBe('stored')
    expect(existsSync(asset.absPath)).toBe(true)
    expect(readFileSync(asset.absPath).toString()).toBe('new')
    expect(arc.status([ref])).toEqual({ 'netease:1': true })
  })
  it('replaces with a strictly higher tier', async () => {
    await arc.put(ref, res('lo', { format: 'mp3', bitrate: 320 })) // tier 3
    const { outcome, asset } = await arc.put(ref, res('hi', { format: 'flac', sampleRate: 96000, bitDepth: 24 })) // tier 5
    expect(outcome).toBe('stored')
    expect(asset.qualityTier).toBe(5)
    expect(arc.lookup(ref)?.format).toBe('flac')
  })
  it('dedups identical bytes by sha256', async () => {
    await arc.put(ref, res('same', { format: 'flac', sampleRate: 96000, bitDepth: 24 }))
    const { outcome } = await arc.put({ platform: 'netease', id: '2' }, res('same', { format: 'flac', sampleRate: 96000, bitDepth: 24 }))
    expect(outcome).toBe('deduped')
    expect(arc.lookup({ platform: 'netease', id: '2' })?.sha256).toBe(arc.lookup(ref)?.sha256)
  })
  it('re-materializes a deduped file when the asset row survived but the file was deleted', async () => {
    // regression: identical bytes hit the dedup branch; if the deduped asset's file is gone
    // (archive root wiped / never persisted), a re-download must restore the file, not just
    // point the row at a phantom — otherwise the track can never re-archive and replay stays on CDN.
    const q = { format: 'flac', sampleRate: 96000, bitDepth: 24 }
    const first = await arc.put(ref, res('bytes', q))
    rmSync(first.asset.absPath, { force: true })
    expect(arc.status([ref])).toEqual({ 'netease:1': false })

    const { outcome } = await arc.put(ref, res('bytes', q)) // identical bytes → dedup path
    expect(outcome).toBe('deduped')
    expect(arc.status([ref])).toEqual({ 'netease:1': true })
    expect(readFileSync(arc.lookup(ref)!.absPath).toString()).toBe('bytes')
  })
  it('delete removes the mapping', async () => {
    await arc.put(ref, res('x'))
    arc.delete(ref)
    expect(arc.has(ref)).toBe(false)
  })
  it('delete with unlinkFile removes the file from disk', async () => {
    const { asset } = await arc.put(ref, res('bytes'))
    expect(existsSync(asset.absPath)).toBe(true)
    arc.delete(ref, { unlinkFile: true })
    expect(existsSync(asset.absPath)).toBe(false)
  })
  it('keeps a shared (deduped) file when another track still references it', async () => {
    const refB = { platform: 'netease', id: '2' } as const
    const { asset: a } = await arc.put(ref, res('shared', { format: 'flac', sampleRate: 96000, bitDepth: 24 }))
    const { outcome } = await arc.put(refB, res('shared', { format: 'flac', sampleRate: 96000, bitDepth: 24 }))
    expect(outcome).toBe('deduped')
    arc.delete(ref, { unlinkFile: true })
    expect(existsSync(a.absPath)).toBe(true)
    expect(arc.lookup(refB)).not.toBeNull()
  })

  it('cleans up the .part temp file when the stream errors mid-pipeline', async () => {
    const errorStream = new Readable({ read() { this.destroy(new Error('boom')) } })
    const failRef = { platform: 'netease', id: 'fail' }
    await expect(
      arc.put(failRef, { stream: errorStream, format: 'mp3', bitrate: 320, title: 'T', artist: 'A', album: 'B' })
    ).rejects.toThrow('boom')
    // No .part file should remain anywhere under the archive root
    const filesRoot = join(dir, 'files')
    const findParts = (dirPath: string): string[] => {
      if (!existsSync(dirPath)) return []
      const entries = readdirSync(dirPath, { withFileTypes: true })
      return entries.flatMap((e) =>
        e.isDirectory()
          ? findParts(join(dirPath, e.name))
          : e.name.endsWith('.part') ? [join(dirPath, e.name)] : []
      )
    }
    expect(findParts(filesRoot)).toEqual([])
  })

  it('put uses the flat layout: <platform>/<artist> - <title>.<ext>', async () => {
    const { asset } = await arc.put(ref, res('x', { format: 'flac', sampleRate: 44100, bitDepth: 16 }))
    expect(asset.relPath).toBe('netease/Artist - Song.flac')
  })

  it('importExisting moves a pre-existing file into the flat layout and registers it', () => {
    const src = join(dir, 'src-song.flac')
    writeFileSync(src, 'audiobytes')
    const { asset, outcome } = arc.importExisting(
      { platform: 'netease', id: '42' }, src,
      { format: 'flac', qualityTier: 4, title: 'Song', artist: 'Artist', album: 'Al' },
      { move: true }
    )
    expect(outcome).toBe('imported')
    expect(asset.relPath).toBe('netease/Artist - Song.flac')
    expect(existsSync(asset.absPath)).toBe(true)
    expect(readFileSync(asset.absPath).toString()).toBe('audiobytes')
    expect(existsSync(src)).toBe(false) // moved, not copied
    expect(arc.lookup({ platform: 'netease', id: '42' })?.qualityTier).toBe(4)
  })

  it('importExisting skips when an equal-or-higher tier already exists', () => {
    const src1 = join(dir, 's1.flac'); writeFileSync(src1, 'a')
    arc.importExisting(ref, src1, { format: 'flac', qualityTier: 5, title: 'Song', artist: 'Artist' }, { move: true })
    const src2 = join(dir, 's2.mp3'); writeFileSync(src2, 'b')
    const { outcome } = arc.importExisting(ref, src2, { format: 'mp3', qualityTier: 3, title: 'Song', artist: 'Artist' }, { move: true })
    expect(outcome).toBe('skipped')
    expect(arc.lookup(ref)?.qualityTier).toBe(5)
  })

  it('adopts a legacy archive database into stream.db once', () => {
    arc.close()
    const streamDb = join(dir, 'stream.db')
    const legacyDb = join(dir, 'audio-archive.db')
    const files = join(dir, 'files')
    const relPath = 'netease/Artist - Legacy.flac'
    mkdirSync(join(files, 'netease'), { recursive: true })
    writeFileSync(join(files, relPath), 'legacy-audio')

    const legacy = new Database(legacyDb)
    legacy.exec(`
      CREATE TABLE asset (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256 TEXT UNIQUE,
        rel_path TEXT NOT NULL,
        format TEXT, bitrate INTEGER, sample_rate INTEGER, bit_depth INTEGER,
        quality_tier INTEGER NOT NULL,
        size_bytes INTEGER, duration_s REAL,
        provider TEXT, source_url TEXT, downloaded_at INTEGER
      );
      CREATE TABLE track_asset (
        platform TEXT NOT NULL, track_id TEXT NOT NULL,
        asset_id INTEGER REFERENCES asset(id),
        title TEXT, artist TEXT, album TEXT, added_at INTEGER,
        PRIMARY KEY (platform, track_id)
      );
    `)
    legacy.prepare(`
      INSERT INTO asset (id, sha256, rel_path, format, quality_tier, size_bytes, provider, downloaded_at)
      VALUES (1, 'abc', ?, 'flac', 5, 12, 'legacy', 1)
    `).run(relPath)
    legacy.prepare(`
      INSERT INTO track_asset (platform, track_id, asset_id, title, artist, album, added_at)
      VALUES ('netease', 'legacy-track', 1, 'Legacy', 'Artist', 'Album', 1)
    `).run()
    legacy.close()

    arc = new AudioArchive(streamDb, files, legacyDb)
    expect(existsSync(`${legacyDb}.imported`)).toBe(true)
    expect(arc.status([{ platform: 'netease', id: 'legacy-track' }])).toEqual({ 'netease:legacy-track': true })
    expect(arc.lookup({ platform: 'netease', id: 'legacy-track' })?.assetId).toBe(1)

    arc.close()
    arc = new AudioArchive(streamDb, files, legacyDb)
    expect(arc.lookup({ platform: 'netease', id: 'legacy-track' })?.assetId).toBe(1)
  })
})

describe('AudioArchive lyrics cache', () => {
  it('stores and looks up a match by key', () => {
    arc.putLyricsCache('netease:1', { matched: true, songId: '1', lrc: '[00:00.00]hi' })
    expect(arc.getLyricsCache('netease:1')).toEqual({ matched: true, songId: '1', lrc: '[00:00.00]hi' })
  })

  it('a miss is stored as matched:false with no songId/lrc', () => {
    arc.putLyricsCache('nosong::noartist', { matched: false })
    expect(arc.getLyricsCache('nosong::noartist')).toEqual({ matched: false, songId: undefined, lrc: undefined })
  })

  it('returns null for an unknown key', () => {
    expect(arc.getLyricsCache('never-written')).toBeNull()
  })

  it('a later put overwrites an earlier one for the same key', () => {
    arc.putLyricsCache('netease:2', { matched: false })
    arc.putLyricsCache('netease:2', { matched: true, songId: '2', lrc: 'x' })
    expect(arc.getLyricsCache('netease:2')).toEqual({ matched: true, songId: '2', lrc: 'x' })
  })

  it('an unmatched entry older than 7 days is treated as expired (null)', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      arc.putLyricsCache('stale::miss', { matched: false })
      vi.setSystemTime(8 * 24 * 60 * 60 * 1000) // 8 days later
      expect(arc.getLyricsCache('stale::miss')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a matched entry never expires, even after 8 days', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      arc.putLyricsCache('stale::hit', { matched: true, songId: '9', lrc: 'x' })
      vi.setSystemTime(8 * 24 * 60 * 60 * 1000)
      expect(arc.getLyricsCache('stale::hit')).toEqual({ matched: true, songId: '9', lrc: 'x' })
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * 「重新下载」（force）。用户点这个菜单项时文件多半已经在盘上，而归档层有两道闸会把它变成空操作：
 * 质量闸（文件在盘且不更差就 skipped）和字节去重（重下回来的是同一批字节 → deduped）。
 * 两道都跳过 writeTags，于是"想靠重下修标签/文件名"永远修不动——这正是 2026-08-04 的活体现象。
 */
describe('AudioArchive.put — force 重下', () => {
  it('不带 force：同一批字节重下 → 不落成 stored（既有行为，作为对照）', async () => {
    await arc.put(ref, res('hello'))
    const again = await arc.put(ref, res('hello'))
    expect(again.outcome).toBe('skipped')
  })

  it('force：同样的字节也真的重写文件，outcome=stored（这样调用方才会去写标签）', async () => {
    await arc.put(ref, res('hello'))
    const again = await arc.put(ref, res('hello'), { force: true })
    expect(again.outcome).toBe('stored')
    expect(existsSync(again.asset.absPath)).toBe(true)
  })

  it('force + 标题修正 → 文件搬到新名字，旧名字那份删掉（不留同内容的垃圾）', async () => {
    const first = await arc.put(ref, { ...res('hello'), title: 'Song - Artist' })
    expect(first.asset.absPath).toContain('Song - Artist')
    // 同一首歌、同样的字节，这次标题剥掉了尾巴——新路径要出现，旧路径必须消失。
    const fixed = await arc.put(ref, { ...res('hello'), title: 'Song' }, { force: true })
    expect(fixed.outcome).toBe('stored')
    expect(existsSync(fixed.asset.absPath)).toBe(true)
    expect(fixed.asset.absPath).not.toBe(first.asset.absPath)
    expect(existsSync(first.asset.absPath)).toBe(false)
    // asset 行是就地更新的，不是插了一条新的：sha256 是 UNIQUE，插新行会直接约束冲突。
    const db = new Database(join(dir, 'a.db'))
    expect((db.prepare('SELECT COUNT(*) n FROM asset').get() as { n: number }).n).toBe(1)
    db.close()
  })

  it('force 把专辑名写进 track_asset —— ID3 那一栏的来源就是它', async () => {
    await arc.put(ref, { ...res('hello'), album: '' })
    await arc.put(ref, { ...res('hello'), album: '青春的喝彩' }, { force: true })
    const db = new Database(join(dir, 'a.db'))
    const row = db.prepare('SELECT album FROM track_asset WHERE platform=? AND track_id=?').get(ref.platform, ref.id) as { album: string }
    db.close()
    expect(row.album).toBe('青春的喝彩')
  })
})
