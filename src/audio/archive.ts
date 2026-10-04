// src/audio/archive.ts
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, existsSync, copyFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import type { TrackRef } from './resolver.ts'
import { computeTier } from './quality.ts'
import { adoptLegacyDb } from '../store/import-legacy.ts'
import { probeAudio } from './format-probe.ts'

/** Fetched audio bytes + quality/metadata, ready to archive. Produced by the download queue
 *  (a plain fetch of the url the Provider resolved), consumed by AudioArchive.put. This is a
 *  business-layer contract — it names no Source. */
export interface DownloadResult {
  stream: NodeJS.ReadableStream
  format: string
  totalBytes?: number
  bitrate?: number
  sampleRate?: number
  bitDepth?: number
  sourceUrl?: string
  title?: string
  artist?: string
  album?: string
}

export interface ArchivedAsset {
  assetId: number
  relPath: string
  absPath: string
  format: string
  qualityTier: number
  sizeBytes: number
  sha256: string
}

/** A cached lyrics lookup result, keyed by the same string a lyrics resolve source takes as
 *  input (`<platform>:<id>` or `<title>::<artist>`, 文法见 docs/API.md). A match caches forever
 *  (lyrics don't change); a miss is re-tried after 7 days (LYRICS_NEGATIVE_TTL_MS below) in case
 *  the song gets indexed later. */
export interface LyricsCacheEntry {
  matched: boolean
  songId?: string
  lrc?: string
}

type PutInput = DownloadResult & { title?: string; artist?: string; album?: string }

/** 一条对不上的记录：库里怎么写的、字节其实是什么、处置结果。`reconcileFormats` 只报**对不上**
 *  的那些，对得上的不进列表（否则一份全库报告全是噪音）。 */
export interface FormatReconcileEntry {
  assetId: number
  relPath: string
  storedFormat: string | null
  probedFormat: string
  storedTier: number
  computedTier: number
  /** 扩展名要改成什么；格式本来就对（只是等级算错）时缺席 */
  newRelPath?: string
  outcome: 'pending' | 'would-fix' | 'fixed' | 'target-exists'
}

/** `missing`/`unprobed` 单独计数而不混进 `entries`：**"没验到"和"验过是对的"必须分得开**，
 *  混成一个数就会让一份"0 处不一致"的报告同时意味着"全对"和"全都没读到"。 */
export interface FormatReconcileReport {
  scanned: number
  applied: boolean
  changed: number
  /** 库里有记录、文件不在盘上 */
  missing: number
  /** 文件在，但 ffprobe 认不出（不是合法音频 / 探测超时）——**没验到，不算通过** */
  unprobed: number
  entries: FormatReconcileEntry[]
}

/** 一个盘上有、库里查无此行的文件。 */
export interface OrphanEntry {
  relPath: string
  sizeBytes: number
  outcome: 'would-delete' | 'deleted' | 'failed'
}

/** `ignored` 单独报而不是悄悄跳过：白名单跳了什么必须说出口，否则一份"3 个孤儿"的报告
 *  和"3 个孤儿 + 200 个被我私自跳过的"长得一模一样。 */
export interface OrphanReport {
  /** 盘上过了一遍的文件总数（含被库认领的、含孤儿，不含白名单跳过的） */
  scanned: number
  applied: boolean
  deleted: number
  /** 白名单跳过的数量（人为目录 / 在途临时文件 / 系统垃圾） */
  ignored: number
  entries: OrphanEntry[]
}

/** 系统自己生成的垃圾。不是孤儿——把它们算进去，报告就永远不为零。 */
const JUNK_BASENAMES = new Set(['thumbs.db', 'desktop.ini', '.ds_store'])

/**
 * 点开头的路径段整棵跳过。吃掉三类：
 * - `.dupes-removed-*` / `.orphans-*` 这类**人为**放在归档根下的目录（用户自己的东西）
 * - `.put-*.part`——`put()` 正在往里写的在途下载；**删它等于打断一次下载**
 * - `.DS_Store` 之类
 */
const isHiddenPath = (rel: string) => rel.split('/').some((seg) => seg.startsWith('.'))

const sanitize = (s: string) => (s || 'unknown').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').trim().slice(0, 120) || 'unknown'

/** Flat archive layout: `<platform>/<artist> - <title>.<ext>` (one level, no artist/album dirs). */
const relPathFlat = (platform: string, artist: string | undefined, title: string, format: string) =>
  join(platform, `${sanitize(artist ?? 'unknown')} - ${sanitize(title)}.${format}`)

/** Permanent best-quality archive: SQLite mapping on the host, audio files under `root`
 *  (the NAS). `rel_path` is relative to `root` so the mount can move. Never evicts. */
export class AudioArchive {
  private db: Database.Database
  constructor(dbPath: string, private readonly root: string, legacyPath?: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS asset (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256 TEXT UNIQUE,
        rel_path TEXT NOT NULL,
        format TEXT, bitrate INTEGER, sample_rate INTEGER, bit_depth INTEGER,
        quality_tier INTEGER NOT NULL,
        size_bytes INTEGER, duration_s REAL,
        provider TEXT, source_url TEXT, downloaded_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS track_asset (
        platform TEXT NOT NULL, track_id TEXT NOT NULL,
        asset_id INTEGER REFERENCES asset(id),
        title TEXT, artist TEXT, album TEXT, added_at INTEGER,
        PRIMARY KEY (platform, track_id)
      );
      CREATE TABLE IF NOT EXISTS lyrics_cache (
        key TEXT PRIMARY KEY,
        matched INTEGER NOT NULL,
        song_id TEXT,
        lrc TEXT,
        fetched_at INTEGER NOT NULL
      );
    `)
    if (legacyPath) {
      adoptLegacyDb(this.db, legacyPath, [
        { from: 'asset', to: 'asset' },
        { from: 'track_asset', to: 'track_asset' },
      ])
    }
  }

  private rowToAsset(r: any): ArchivedAsset {
    return {
      assetId: r.id, relPath: r.rel_path, absPath: join(this.root, r.rel_path),
      format: r.format, qualityTier: r.quality_tier, sizeBytes: r.size_bytes, sha256: r.sha256,
    }
  }

  /** Archive config/status for the settings UI: the configured files root + how many tracks
   *  the DB knows about (file presence is checked per-request in the route). */
  info(): { root: string; tracks: number } {
    const tracks = (this.db.prepare('SELECT COUNT(*) AS n FROM track_asset').get() as { n: number }).n
    return { root: this.root, tracks }
  }

  /** 给"补标签"这类一次性存量任务用的只读查询——按下载时间过滤，不建缓存、不建索引，
   *  调用方自己控制调用频率（这不是热路径）。 */
  recentlyDownloaded(sinceMs: number): Array<{
    platform: string; trackId: string; title?: string; artist?: string; album?: string
    absPath: string; format: string
  }> {
    const rows = this.db
      .prepare(
        `SELECT t.platform, t.track_id, t.title, t.artist, t.album, a.rel_path, a.format
         FROM track_asset t JOIN asset a ON a.id = t.asset_id
         WHERE a.downloaded_at >= ?`
      )
      .all(sinceMs) as Array<{ platform: string; track_id: string; title: string | null; artist: string | null; album: string | null; rel_path: string; format: string }>
    return rows.map((r) => ({
      platform: r.platform, trackId: r.track_id,
      title: r.title ?? undefined, artist: r.artist ?? undefined, album: r.album ?? undefined,
      absPath: join(this.root, r.rel_path), format: r.format,
    }))
  }

  /**
   * 全库对账：逐个资产用真实字节重新认一遍格式与质量等级，纠正对不上的那些。
   *
   * **为什么需要它**：`put()` 的探测是 2026-08-04 才加的，在那之前入库的文件，格式和等级
   * 都记的是接口自称的值。等级又驱动"这次下载算不算升级"的判断（`put()` 开头那道闸），
   * 所以一行错的等级会一直影响将来——真正的无损重下载被判成"不算升级"跳过。
   *
   * **不限时间窗**：等级算错和"什么时候下载的"无关。只扫近期等于故意留一半错的。
   *
   * `apply:false`（默认）只报不改——它要重命名文件，先看清楚再动。
   */
  async reconcileFormats(opts: { apply?: boolean } = {}): Promise<FormatReconcileReport> {
    const rows = this.db
      .prepare('SELECT id, rel_path, format, bitrate, sample_rate, bit_depth, quality_tier FROM asset ORDER BY id')
      .all() as Array<{
        id: number; rel_path: string; format: string | null
        bitrate: number | null; sample_rate: number | null; bit_depth: number | null; quality_tier: number
      }>
    const report: FormatReconcileReport = { scanned: rows.length, applied: !!opts.apply, changed: 0, missing: 0, unprobed: 0, entries: [] }

    for (const row of rows) {
      const absPath = join(this.root, row.rel_path)
      if (!existsSync(absPath)) { report.missing++; continue }
      const probed = await probeAudio(absPath)
      if (!probed) { report.unprobed++; continue }

      const quality = {
        format: probed.format,
        bitrate: probed.bitrate ?? row.bitrate ?? undefined,
        sampleRate: probed.sampleRate ?? row.sample_rate ?? undefined,
        bitDepth: probed.bitDepth ?? row.bit_depth ?? undefined,
      }
      const tier = computeTier(quality)
      const formatWrong = row.format !== probed.format
      const tierWrong = row.quality_tier !== tier
      if (!formatWrong && !tierWrong) continue

      // 扩展名跟着真实格式走。只换末尾那一段——文件名的其余部分是用户看得见的东西，不重新生成。
      const newRelPath = formatWrong ? row.rel_path.replace(/\.[^./\\]*$/, `.${probed.format}`) : row.rel_path
      const entry: FormatReconcileEntry = {
        assetId: row.id, relPath: row.rel_path,
        storedFormat: row.format, probedFormat: probed.format,
        storedTier: row.quality_tier, computedTier: tier,
        newRelPath: newRelPath === row.rel_path ? undefined : newRelPath,
        outcome: 'pending',
      }

      if (!opts.apply) { entry.outcome = 'would-fix'; report.entries.push(entry); report.changed++; continue }

      // 目标名已被占用就整条跳过——宁可留一条报告让人来看，也不覆盖另一个文件。
      if (entry.newRelPath && existsSync(join(this.root, entry.newRelPath))) {
        entry.outcome = 'target-exists'
        report.entries.push(entry)
        continue
      }
      if (entry.newRelPath) renameSync(absPath, join(this.root, entry.newRelPath))
      this.db
        .prepare('UPDATE asset SET rel_path=@rel_path, format=@format, bitrate=@bitrate, sample_rate=@sample_rate, bit_depth=@bit_depth, quality_tier=@quality_tier WHERE id=@id')
        .run({
          id: row.id, rel_path: newRelPath, format: probed.format,
          bitrate: quality.bitrate ?? null, sample_rate: quality.sampleRate ?? null,
          bit_depth: quality.bitDepth ?? null, quality_tier: tier,
        })
      entry.outcome = 'fixed'
      report.entries.push(entry)
      report.changed++
    }
    return report
  }

  /**
   * 归档目录 ↔ `asset.rel_path` 的差集：盘上有、库里查无此行的文件。
   *
   * **为什么需要它**：归档层只管"我记下的那些"——`gcAsset` 删的是有行的，`put` 的
   * `forceRestore` 删的是自己刚换掉的那份。改过命名规则、换过格式重下的年代留下的旧副本
   * 没有任何一条路会回头看，只占盘。
   *
   * **只看 Stream 自己写过的顶层目录**（`asset.rel_path` 的第一段集合）。归档根不一定归它
   * 独占——活体那份底下还住着用户自己的音乐库和群晖回收站。用"整个 root 的差集"当判据，
   * 一次实测报出 1221 个孤儿 / 约 15GB，其中真属于 Stream 的只有 8 个（2026-08-04）。
   * 归档布局是 `<platform>/…`，它从没往别的顶层目录写过东西，那里面的一切就不是它的账。
   * 推论：库里一行都没有时，一个孤儿都不报——而不是把整个 root 判成孤儿。
   *
   * `apply:false`（默认）只报不删。
   */
  orphans(opts: { apply?: boolean } = {}): OrphanReport {
    const report: OrphanReport = { scanned: 0, applied: !!opts.apply, deleted: 0, ignored: 0, entries: [] }
    if (!existsSync(this.root)) return report

    const rows = this.db.prepare('SELECT rel_path FROM asset').all() as Array<{ rel_path: string }>
    const known = new Set(rows.map((r) => r.rel_path))
    const ownedTopDirs = new Set(rows.map((r) => r.rel_path.split('/')[0]!).filter((s) => s && !s.includes('\\')))

    const walk = (relDir: string): void => {
      for (const e of readdirSync(join(this.root, relDir || '.'), { withFileTypes: true })) {
        // 顶层：Stream 没往里写过的一律不看——不下钻、也不计入 ignored（它整个不在讨论范围内）。
        if (!relDir && !ownedTopDirs.has(e.name)) continue
        const rel = relDir ? `${relDir}/${e.name}` : e.name
        if (isHiddenPath(rel) || JUNK_BASENAMES.has(e.name.toLowerCase())) {
          // 目录整棵算一个跳过——不下钻去数它里面有多少个文件（那是用户的东西，不该被清点）。
          report.ignored++
          continue
        }
        if (e.isDirectory()) { walk(rel); continue }
        if (!e.isFile()) continue
        report.scanned++
        if (known.has(rel)) continue

        const abs = join(this.root, rel)
        const entry: OrphanEntry = { relPath: rel, sizeBytes: statSync(abs).size, outcome: 'would-delete' }
        if (opts.apply) {
          try {
            rmSync(abs, { force: true })
            entry.outcome = 'deleted'
            report.deleted++
          } catch {
            entry.outcome = 'failed'
          }
        }
        report.entries.push(entry)
      }
    }
    walk('')
    return report
  }

  lookup(ref: TrackRef): ArchivedAsset | null {
    if (!ref.id) return null
    const r = this.db
      .prepare(`SELECT a.* FROM asset a JOIN track_asset t ON t.asset_id = a.id
                WHERE t.platform = ? AND t.track_id = ?`)
      .get(ref.platform, ref.id) as any
    return r ? this.rowToAsset(r) : null
  }

  has(ref: TrackRef): boolean {
    return this.lookup(ref) !== null
  }

  status(refs: TrackRef[]): Record<string, boolean> {
    const out: Record<string, boolean> = {}
    const stmt = this.db.prepare(`SELECT a.rel_path FROM asset a JOIN track_asset t ON t.asset_id = a.id
      WHERE t.platform = ? AND t.track_id = ?`)
    for (const ref of refs) {
      if (!ref.id) continue
      const key = `${ref.platform}:${ref.id}`
      const row = stmt.get(ref.platform, ref.id) as { rel_path: string } | undefined
      out[key] = !!(row && existsSync(join(this.root, row.rel_path)))
    }
    return out
  }

  async put(
    ref: TrackRef,
    r: PutInput,
    opts: { onProgress?: (downloadedBytes: number) => void; force?: boolean } = {}
  ): Promise<{ asset: ArchivedAsset; outcome: 'stored' | 'skipped' | 'deduped' }> {
    if (!ref.id) throw new Error('put requires ref.id')
    // 下载**前**只能拿接口自称的质量来判"这次值不值得下"——字节还没到，探测无从谈起。
    // 所以这个闸用声明值，入库时存的是实测值（见下方 storedTier）。两者名字不同不是笔误：
    // 一个是决策依据（当时能拿到的最好信息），一个是事实（字节说的）。
    //
    // `force`（用户点了「重新下载」）两道闸都不受：**这道**不受，否则整件事是空操作；
    // 下面那道字节去重也不受（同一条 track 自己那份），否则重下回来的仍是同一批字节、
    // 落回 `deduped`，而 deduped 不写标签——想靠重下修标签/改文件名的人会一直修不动。
    const declaredTier = computeTier(r)
    const existing = this.lookup(ref)
    const existingFilePresent = !!(existing && existsSync(existing.absPath))
    if (!opts.force && existing && existingFilePresent && existing.qualityTier >= declaredTier) {
      return { asset: existing, outcome: 'skipped' }
    }

    // stream to a temp file while hashing; atomic rename on success. 临时文件名不依赖最终扩展名——
    // 真实格式要等字节全部落盘后探测才知道（见下方 probeFormat），此时还没法算 relPath/absPath。
    const tmpDir = join(this.root, ref.platform)
    mkdirSync(tmpDir, { recursive: true })
    const tmp = join(tmpDir, `.put-${process.hrtime.bigint().toString(36)}.part`)
    const hash = createHash('sha256')
    let size = 0
    const hashThrough = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk)
        size += chunk.length
        opts.onProgress?.(size)
        cb(null, chunk)
      },
    })
    try {
      await pipeline(r.stream, hashThrough, createWriteStream(tmp))
    } catch (e) {
      rmSync(tmp, { force: true })
      throw e
    }
    const sha = hash.digest('hex')

    // 探测优先：不信任接口自称的 r.format，用刚写完的真实字节决定最终扩展名/入库格式；
    // 探测失败（极少见）静默退回接口声明值，不阻断归档（2026-08-04 修，见 design doc）。
    const probed = await probeAudio(tmp)
    // 入库的质量事实：能实测到的一律以实测为准，实测不到的那一项才退回接口声明值。
    // 只把 format 换成实测、其余仍按声明存，会存出一行自相矛盾的记录（format='flac' 却按
    // mp3 打 3 分）；而这个等级又驱动上面那道"算不算升级"的闸——错的等级会让真正的无损
    // 重下载被判成"不算升级"直接跳过。
    const quality = {
      format: probed?.format ?? r.format,
      bitrate: probed?.bitrate ?? r.bitrate,
      sampleRate: probed?.sampleRate ?? r.sampleRate,
      bitDepth: probed?.bitDepth ?? r.bitDepth,
    }
    const detectedFormat = quality.format
    const storedTier = computeTier(quality)
    const relPath = relPathFlat(ref.platform, r.artist, r.title ?? ref.id, detectedFormat)
    const absPath = join(this.root, relPath)
    mkdirSync(dirname(absPath), { recursive: true })

    const now = Date.now()
    // dedup: identical bytes already stored under a different track → reuse that asset row
    const dup = this.db.prepare('SELECT * FROM asset WHERE sha256 = ?').get(sha) as any
    let assetId: number
    let outcome: 'stored' | 'deduped'
    /**
     * force 重下、而且回来的字节和**这条 track 自己已有的那份**一模一样（重下同一首歌的常态）。
     * 走不得上面那条去重路：那条会把临时文件丢掉、outcome 记成 `deduped`，于是标签不重写、
     * 文件名也不会跟着修正后的标题变——用户点了「重新下载」却什么都没变。
     *
     * 这里改成"把新字节落到（可能已经修正过的）路径上，就地更新这一行"。**不能插一条新 asset**：
     * `sha256` 是 UNIQUE，插进去就是约束冲突。路径变了要把旧文件删掉，否则 NAS 上留下一份
     * 用旧名字命名的同内容文件——正是这次要清掉的那种垃圾。
     */
    const forceRestore = opts.force && dup && existing && dup.id === existing.assetId
    if (forceRestore) {
      const oldAbs = join(this.root, dup.rel_path)
      renameSync(tmp, absPath)
      if (oldAbs !== absPath) rmSync(oldAbs, { force: true })
      this.db.prepare(
        `UPDATE asset SET rel_path=@rel_path, format=@format, bitrate=@bitrate, sample_rate=@sample_rate,
                          bit_depth=@bit_depth, quality_tier=@quality_tier, size_bytes=@size_bytes, downloaded_at=@downloaded_at
         WHERE id=@id`
      ).run({
        id: dup.id, rel_path: relPath, format: detectedFormat, bitrate: quality.bitrate ?? null,
        sample_rate: quality.sampleRate ?? null, bit_depth: quality.bitDepth ?? null, quality_tier: storedTier,
        size_bytes: size, downloaded_at: now,
      })
      assetId = dup.id
      outcome = 'stored'
    } else if (dup) {
      // identical bytes already have an asset row — but the file may be gone (archive root was
      // wiped / never persisted / NAS unmounted at download time). Only drop the temp when the
      // deduped file is actually on disk; otherwise re-materialize it, so a re-download of a lost
      // track heals the phantom row instead of dedup-ing to a file that isn't there.
      const dupAbs = join(this.root, dup.rel_path)
      if (existsSync(dupAbs)) {
        rmSync(tmp, { force: true })
      } else {
        mkdirSync(dirname(dupAbs), { recursive: true })
        renameSync(tmp, dupAbs)
      }
      assetId = dup.id
      outcome = 'deduped'
    } else {
      renameSync(tmp, absPath)
      assetId = this.db.prepare(
        `INSERT INTO asset (sha256, rel_path, format, bitrate, sample_rate, bit_depth, quality_tier, size_bytes, provider, source_url, downloaded_at)
         VALUES (@sha256,@rel_path,@format,@bitrate,@sample_rate,@bit_depth,@quality_tier,@size_bytes,@provider,@source_url,@downloaded_at)`
      ).run({
        sha256: sha, rel_path: relPath, format: detectedFormat, bitrate: quality.bitrate ?? null,
        sample_rate: quality.sampleRate ?? null, bit_depth: quality.bitDepth ?? null, quality_tier: storedTier,
        size_bytes: size, provider: (r as any).via ?? null, source_url: r.sourceUrl ?? null, downloaded_at: now,
      }).lastInsertRowid as number
      outcome = 'stored'
    }

    const oldAssetId = existing?.assetId
    this.db.prepare(
      `INSERT INTO track_asset (platform, track_id, asset_id, title, artist, album, added_at)
       VALUES (@platform,@track_id,@asset_id,@title,@artist,@album,@added_at)
       ON CONFLICT(platform, track_id) DO UPDATE SET asset_id=@asset_id, title=@title, artist=@artist, album=@album, added_at=@added_at`
    ).run({ platform: ref.platform, track_id: ref.id, asset_id: assetId, title: r.title ?? null, artist: r.artist ?? null, album: r.album ?? null, added_at: now })

    // garbage-collect a strictly-lower replaced asset if nothing else references it
    if (oldAssetId && oldAssetId !== assetId) this.gcAsset(oldAssetId)

    return { asset: this.lookup(ref)!, outcome }
  }

  delete(ref: TrackRef, opts: { unlinkFile?: boolean } = {}): void {
    if (!ref.id) return
    const a = this.lookup(ref)
    this.db.prepare('DELETE FROM track_asset WHERE platform = ? AND track_id = ?').run(ref.platform, ref.id)
    if (a) this.gcAsset(a.assetId, opts.unlinkFile)
  }

  private gcAsset(assetId: number, unlinkFile = true): void {
    const refs = this.db.prepare('SELECT COUNT(*) n FROM track_asset WHERE asset_id = ?').get(assetId) as { n: number }
    if (refs.n > 0) return
    const row = this.db.prepare('SELECT rel_path FROM asset WHERE id = ?').get(assetId) as { rel_path: string } | undefined
    this.db.prepare('DELETE FROM asset WHERE id = ?').run(assetId)
    if (unlinkFile && row) {
      const p = join(this.root, row.rel_path)
      if (existsSync(p)) rmSync(p, { force: true })
    }
  }

  /** Import an already-existing local file into the archive (migration of a pre-existing
   *  library): move/copy it into the flat layout and register it. Does NOT recompute sha256
   *  (left null — avoids reading every file over a network mount); `qualityTier` is supplied
   *  by the caller (already probed). Replaces an existing asset only if strictly higher tier. */
  importExisting(
    ref: TrackRef,
    srcAbsPath: string,
    meta: { format: string; qualityTier: number; title?: string; artist?: string; album?: string; sizeBytes?: number },
    opts: { move?: boolean } = {}
  ): { asset: ArchivedAsset; outcome: 'imported' | 'skipped' } {
    if (!ref.id) throw new Error('importExisting requires ref.id')
    const existing = this.lookup(ref)
    if (existing && existing.qualityTier >= meta.qualityTier) return { asset: existing, outcome: 'skipped' }

    const relPath = relPathFlat(ref.platform, meta.artist, meta.title ?? ref.id, meta.format)
    const absPath = join(this.root, relPath)
    mkdirSync(dirname(absPath), { recursive: true })
    if (opts.move) renameSync(srcAbsPath, absPath)
    else copyFileSync(srcAbsPath, absPath)
    const size = meta.sizeBytes ?? statSync(absPath).size

    const now = Date.now()
    // sha256 left NULL (SQLite treats multiple NULLs as distinct → no UNIQUE conflict)
    const assetId = this.db.prepare(
      `INSERT INTO asset (sha256, rel_path, format, quality_tier, size_bytes, provider, downloaded_at)
       VALUES (NULL,@rel_path,@format,@quality_tier,@size_bytes,'migrate',@now)`
    ).run({ rel_path: relPath, format: meta.format, quality_tier: meta.qualityTier, size_bytes: size, now }).lastInsertRowid as number

    const oldAssetId = existing?.assetId
    this.db.prepare(
      `INSERT INTO track_asset (platform, track_id, asset_id, title, artist, album, added_at)
       VALUES (@platform,@track_id,@asset_id,@title,@artist,@album,@now)
       ON CONFLICT(platform, track_id) DO UPDATE SET asset_id=@asset_id, title=@title, artist=@artist, album=@album, added_at=@now`
    ).run({ platform: ref.platform, track_id: ref.id, asset_id: assetId, title: meta.title ?? null, artist: meta.artist ?? null, album: meta.album ?? null, now })
    if (oldAssetId && oldAssetId !== assetId) this.gcAsset(oldAssetId)
    return { asset: this.lookup(ref)!, outcome: 'imported' }
  }

  /** Look up an asset directly by its numeric id (for the file-serving route). */
  assetById(id: number): ArchivedAsset | null {
    const r = this.db.prepare('SELECT * FROM asset WHERE id = ?').get(id) as any
    return r ? this.rowToAsset(r) : null
  }

  private static readonly LYRICS_NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000

  /** null = no cache entry, OR an expired negative (matched:false) entry — both mean "go look it
   *  up again". A positive (matched:true) entry never expires. */
  getLyricsCache(key: string): LyricsCacheEntry | null {
    const r = this.db.prepare('SELECT matched, song_id, lrc, fetched_at FROM lyrics_cache WHERE key = ?').get(key) as
      | { matched: number; song_id: string | null; lrc: string | null; fetched_at: number }
      | undefined
    if (!r) return null
    if (!r.matched && Date.now() - r.fetched_at > AudioArchive.LYRICS_NEGATIVE_TTL_MS) return null
    return { matched: !!r.matched, songId: r.song_id ?? undefined, lrc: r.lrc ?? undefined }
  }

  putLyricsCache(key: string, entry: LyricsCacheEntry): void {
    this.db.prepare(
      `INSERT INTO lyrics_cache (key, matched, song_id, lrc, fetched_at) VALUES (@key,@matched,@song_id,@lrc,@fetched_at)
       ON CONFLICT(key) DO UPDATE SET matched=@matched, song_id=@song_id, lrc=@lrc, fetched_at=@fetched_at`
    ).run({ key, matched: entry.matched ? 1 : 0, song_id: entry.songId ?? null, lrc: entry.lrc ?? null, fetched_at: Date.now() })
  }

  close(): void {
    this.db.close()
  }
}
