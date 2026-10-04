import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { AudioArchive } from './archive.ts'

/**
 * 全库对账（`reconcileFormats`）。
 *
 * 用**真实音频字节**验，不用替身：这件事的全部内容就是"字节到底是什么格式"，
 * 换成 mock 就只剩下自己验自己。
 */

const execFileP = promisify(execFile)

let dir: string
let arc: AudioArchive
let dbPath: string
let root: string

const encode = async (path: string, codec: string, fmt?: string) => {
  await execFileP('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1',
    '-c:a', codec, ...(fmt ? ['-f', fmt] : []), path,
  ])
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arc-reconcile-'))
  dbPath = join(dir, 'a.db')
  root = join(dir, 'files')
  arc = new AudioArchive(dbPath, root)
}, 30000)

afterEach(() => {
  arc.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 造一条**探测能力上线之前**留下的记录：文件是 flac 字节，但库里记成 mp3、等级按 mp3 打的 3 分。
 *  只能这么造——现在的 `put()` 会当场探测，正常入库根本产不出这种行。 */
const legacyMislabeledRow = async (): Promise<{ relPath: string; absPath: string }> => {
  const src = join(dir, 'src.flac')
  await encode(src, 'flac', 'flac')
  const bytes = readFileSync(src)
  const { asset } = await arc.put({ platform: 'netease', id: '1' }, {
    stream: Readable.from([bytes]), format: 'flac', title: 'Song', artist: 'Artist',
  })
  // 退回成旧代码会留下的样子：扩展名和库里的 format/tier 都说它是 mp3
  const relPath = 'netease/Artist - Song.mp3'
  renameSync(asset.absPath, join(root, relPath))
  const db = new Database(dbPath)
  db.prepare("UPDATE asset SET rel_path=?, format='mp3', bitrate=320, sample_rate=NULL, bit_depth=NULL, quality_tier=3 WHERE id=?")
    .run(relPath, asset.assetId)
  db.close()
  return { relPath, absPath: join(root, relPath) }
}

describe('put 入库时的等级', () => {
  /** 探测改的是 format 列，等级必须跟着改。只改一半会存出自相矛盾的一行
   *  （format='flac' 却按 mp3 打 3 分），而这个等级驱动"算不算升级"的闸。 */
  it('接口自称 mp3、字节其实是 flac → 存的是 flac 且等级按无损打', async () => {
    const src = join(dir, 'lying.flac')
    await encode(src, 'flac', 'flac')
    const { asset } = await arc.put({ platform: 'netease', id: '9' }, {
      // 接口这么说的：mp3 320k。字节不是。
      stream: Readable.from([readFileSync(src)]), format: 'mp3', bitrate: 320,
      title: 'Lying', artist: 'A',
    })
    expect(asset.format).toBe('flac')
    expect(asset.qualityTier).toBe(4)
    expect(asset.absPath.endsWith('.flac')).toBe(true)
  })

  /** 探测不出来（不是合法音频 / ffprobe 挂了）就整条退回接口声明值——不阻断归档。 */
  it('探测不出来时退回接口声明的格式与等级', async () => {
    const { asset } = await arc.put({ platform: 'netease', id: '8' }, {
      stream: Readable.from([Buffer.from('junk')]), format: 'flac', sampleRate: 44100, bitDepth: 16,
      title: 'Junk', artist: 'A',
    })
    expect(asset.format).toBe('flac')
    expect(asset.qualityTier).toBe(4)
  })
})

describe('reconcileFormats', () => {
  it('默认只报不改——它要重命名文件，先看清楚再动', async () => {
    const { absPath } = await legacyMislabeledRow()
    const r = await arc.reconcileFormats()
    expect(r.applied).toBe(false)
    expect(r.changed).toBe(1)
    expect(r.entries[0]).toMatchObject({
      storedFormat: 'mp3', probedFormat: 'flac',
      storedTier: 3, computedTier: 4,
      newRelPath: 'netease/Artist - Song.flac',
      outcome: 'would-fix',
    })
    expect(existsSync(absPath)).toBe(true) // 文件一动没动
    expect(arc.lookup({ platform: 'netease', id: '1' })?.format).toBe('mp3')
  })

  it('apply 后扩展名、format、等级三处一起纠正', async () => {
    const { absPath } = await legacyMislabeledRow()
    const r = await arc.reconcileFormats({ apply: true })
    expect(r.entries[0].outcome).toBe('fixed')
    expect(existsSync(absPath)).toBe(false)
    const a = arc.lookup({ platform: 'netease', id: '1' })!
    expect(a.relPath).toBe('netease/Artist - Song.flac')
    expect(a.format).toBe('flac')
    // 等级是这件事的要害：它驱动"这次下载算不算升级"，错的等级会让真无损重下载被跳过
    expect(a.qualityTier).toBe(4)
    expect(existsSync(a.absPath)).toBe(true)
  })

  it('对得上的记录不进报告——一份全库报告不该全是噪音', async () => {
    const src = join(dir, 'ok.mp3')
    await encode(src, 'libmp3lame')
    await arc.put({ platform: 'netease', id: '2' }, {
      stream: Readable.from([readFileSync(src)]), format: 'mp3', bitrate: 320, title: 'Fine', artist: 'A',
    })
    const r = await arc.reconcileFormats({ apply: true })
    expect(r.scanned).toBe(1)
    expect(r.changed).toBe(0)
    expect(r.entries).toEqual([])
  })

  /** "文件不在"和"验过是对的"必须分得开。混成一个数，一份"0 处不一致"的报告
   *  就会同时意味着"全对"和"根本没读到"。 */
  it('文件不在盘上单独计数，不算验过', async () => {
    const { absPath } = await legacyMislabeledRow()
    rmSync(absPath)
    const r = await arc.reconcileFormats({ apply: true })
    expect(r.missing).toBe(1)
    expect(r.changed).toBe(0)
    expect(r.entries).toEqual([])
  })

  it('探测不出来的也单独计数，不当作通过', async () => {
    await arc.put({ platform: 'netease', id: '3' }, {
      stream: Readable.from([Buffer.from('not audio at all')]), format: 'mp3', bitrate: 320, title: 'Junk', artist: 'A',
    })
    const r = await arc.reconcileFormats({ apply: true })
    expect(r.unprobed).toBe(1)
    expect(r.changed).toBe(0)
  })

  /** 目标名被占了宁可留一条报告让人来看，也不覆盖另一个文件——覆盖掉的那份没有第二份。 */
  it('目标文件名已被占用就整条跳过，不覆盖', async () => {
    const { absPath } = await legacyMislabeledRow()
    const occupied = join(root, 'netease/Artist - Song.flac')
    mkdirSync(join(root, 'netease'), { recursive: true })
    writeFileSync(occupied, 'someone else')
    const r = await arc.reconcileFormats({ apply: true })
    expect(r.entries[0].outcome).toBe('target-exists')
    expect(r.changed).toBe(0)
    expect(readFileSync(occupied).toString()).toBe('someone else')
    expect(existsSync(absPath)).toBe(true)
    expect(arc.lookup({ platform: 'netease', id: '1' })?.format).toBe('mp3') // 库也没动
  })
})
