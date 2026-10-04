import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import type { TrackRef } from './resolver.ts'
import type { AudioArchive } from './archive.ts'
import { songTitle } from './music-search.ts'
import { adoptLegacyDb } from '../store/import-legacy.ts'
import type { DebugEntry, DebugField } from '../debug.ts'
import type { TrackTags } from './tag-writer.ts'

/** A resolved media location for one track: a directly-fetchable url plus any request headers
 *  (Referer etc.) a fetch/proxy must send. The queue is a pure consumer — it asks a Provider for
 *  this, then fetches the bytes. It names no Source. */
export interface ResolvedDownload {
  url: string
  headers?: Record<string, string>
  format?: string
  title?: string
  artist?: string
  album?: string
  coverUrl?: string
}

/** One rung of the download's own resolve ladder — surfaced for the debug box. */
export interface DownloadRung {
  member: string
  ms: number
  outcome: 'win' | 'miss' | 'error'
  reason?: string
}

/** resolveDownload result + the resolve diagnostics (so the debug box can show the ladder even
 *  when nothing resolved). `audio` is null when no source produced a downloadable url. */
export interface DownloadResolve {
  audio: ResolvedDownload | null
  via?: string
  tier?: number
  rungs?: DownloadRung[]
}

export interface JobView {
  id: number; platform: string; track_id: string; state: string; attempts: number; last_error?: string
  downloaded_bytes?: number; total_bytes?: number
  archived?: boolean
}

export interface QueueDeps {
  archive: AudioArchive
  /** 解析一首歌的可下载地址：业务层只调按平台派发选出的取歌 Provider 行，拿回 {audio:{url,headers?}, 诊断}，
   *  队列自己 fetch。梯子/音质/源都在 Provider 侧，队列不认识具体 Source。audio=null = 无源可解析。 */
  resolveDownload: (ref: TrackRef) => Promise<DownloadResolve>
  syncEnabled: (streamId: string) => boolean
  setSyncEnabled: (streamId: string, enabled: boolean) => void
  /** title/artist/album for the archive file path/snapshot, looked up from the item store */
  refMeta?: (ref: TrackRef) => { title?: string; artist?: string; album?: string }
  /** push a debug entry (resolve + put outcome + job state) to the frontend DebugBox over the WS */
  emitDebug?: (entry: DebugEntry) => void
  /** Task-boundary attribution (op-track): wraps each job as `download:<jobId>` so loop-lag
   *  stall reports can name the download overlapping the stall window. Absent → no-op. */
  track?: <T>(name: string, fn: () => Promise<T>) => Promise<T>
  /** 归档成功后可选地给文件写 ID3/元数据标签+封面（ffmpeg 实现见 src/audio/tag-writer.ts）。
   *  失败不影响下载成功判定，见 runOne() 的调用点。缺省（测试里常见）= 完全跳过这一步。 */
  writeTags?: (absPath: string, format: string, tags: TrackTags) => Promise<void>
}

const MAX_ATTEMPTS = 3

/** download_job queue (manual / batch / auto share one machine) + per-playlist sync toggle.
 *  better-sqlite3 is synchronous; the worker is an async loop driven by drain() or an
 *  interval pump in bootstrap. Single-flight: one queued/running job per (platform, track). */
export class DownloadQueue {
  private db: Database.Database
  private running = false
  private pending = false
  private stopping = false
  /** 库已经关了。见 `close()` 头注：**关停撞上在飞的下载是设计内会发生的事**，所以关掉之后
   *  这个队列必须是**惰性的**（碰它什么也不发生），而不是**带雷的**（碰它就抛）。 */
  private closed = false
  private readonly listeners = new Set<(job: JobView) => void>()
  private readonly progressByJob = new Map<number, { downloaded_bytes?: number; total_bytes?: number }>()
  constructor(dbPath: string, private readonly deps: QueueDeps, legacyPath?: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS download_job (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL, track_id TEXT NOT NULL,
        ref_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        downloaded_bytes INTEGER, total_bytes INTEGER,
        requested_at INTEGER, updated_at INTEGER,
        force INTEGER NOT NULL DEFAULT 0
      );
    `)
    if (legacyPath) adoptLegacyDb(this.db, legacyPath, [{ from: 'download_job', to: 'download_job' }])
    this.migrate()
  }

  private migrate(): void {
    const cols = new Set((this.db.prepare('PRAGMA table_info(download_job)').all() as Array<{ name: string }>).map((c) => c.name))
    if (!cols.has('downloaded_bytes')) this.db.prepare('ALTER TABLE download_job ADD COLUMN downloaded_bytes INTEGER').run()
    if (!cols.has('total_bytes')) this.db.prepare('ALTER TABLE download_job ADD COLUMN total_bytes INTEGER').run()
    if (!cols.has('force')) this.db.prepare('ALTER TABLE download_job ADD COLUMN force INTEGER NOT NULL DEFAULT 0').run()
    const playlistSync = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'playlist_sync'`)
      .get()
    if (playlistSync) {
      const rows = this.db.prepare('SELECT stream_id FROM playlist_sync WHERE enabled = 1').all() as Array<{ stream_id: string }>
      for (const row of rows) this.deps.setSyncEnabled(row.stream_id, true)
      this.db.prepare('DROP TABLE playlist_sync').run()
    }
  }

  onJob(listener: (job: JobView) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 在飞的那一轮下载碰库的**唯一入口**——关掉之后是空操作。
   *
   * 为什么要有这么一个choke point：`runOne` 是异步的，它的每一次落账都可能落在 `close()`
   * 之后（`stop()` 带宽限期，超时照关，见 `close()` 头注）。散落着写就意味着"每加一条 UPDATE
   * 都要记得判一次"，而漏判**不报错**——它抛在一个已关的连接上，且 drain 的调用方多是
   * `void drain()`，于是变成一条没人接的 unhandled rejection。有了这一个入口，漏判这件事
   * 在结构上就不存在了。
   *
   * 只圈住**下载循环**这条路：`enqueue` / `jobs` / `syncPlaylist` 这些同步的调用者面
   * 不走这里——它们在 `close()` 之后被调用属于调用方的 bug，该响亮地抛，不该被咽掉。
   */
  private writeJob(sql: string, ...params: unknown[]): void {
    if (this.closed) return
    this.db.prepare(sql).run(...params)
  }

  private jobView(jobId: number): JobView | null {
    if (this.closed) return null
    const r = this.db.prepare('SELECT * FROM download_job WHERE id = ?').get(jobId) as any
    return r ? this.mapJob(r) : null
  }

  private emitJob(jobId: number): void {
    const job = this.jobView(jobId)
    if (!job) return
    for (const listener of this.listeners) listener(job)
  }

  private mapJob(r: any): JobView {
    const ref = { platform: r.platform, id: r.track_id }
    const progress = this.progressByJob.get(r.id)
    return {
      id: r.id,
      platform: r.platform,
      track_id: r.track_id,
      state: r.state,
      attempts: r.attempts,
      last_error: r.last_error ?? undefined,
      downloaded_bytes: progress?.downloaded_bytes,
      total_bytes: progress?.total_bytes,
      archived: this.deps.archive.status([ref])[`${ref.platform}:${ref.id}`] ?? false,
    }
  }

  /**
   * `force` = 用户点了行内菜单的「重新下载」——**已经归档的也要真的重下一遍**，
   * 而不是撞上 `AudioArchive.put` 那道"文件在盘且质量不更差就跳过"的闸静默变成空操作
   * （2026-08-04 活体：点重新下载，debug 里是 `下载完成：skipped`，字节一个没动、标签也没重写，
   * 因为 skipped 不走 writeTags）。它跟着 job 行走而不是塞进 `ref_json`：ref 描述的是"哪一首歌"，
   * 这一位说的是"这一次要怎么下"，混进去下次别人读 ref 就会以为这是歌的属性。
   *
   * 已在排队/在跑的那一条**照旧直接复用**（single-flight），但如果这次是 force 而它不是，
   * 就把这一位补上去——否则先点了普通下载、再点重新下载，用户看到的是"已经在下了"，
   * 而实际上跑完仍然是 skipped。
   */
  enqueue(ref: TrackRef, opts: { priority?: number; force?: boolean } = {}): number {
    if (!ref.id) throw new Error('enqueue requires ref.id')
    const active = this.db
      .prepare(`SELECT id, force FROM download_job WHERE platform = ? AND track_id = ? AND state IN ('queued','running')`)
      .get(ref.platform, ref.id) as { id: number; force: number } | undefined
    if (active) {
      if (opts.force && !active.force) this.db.prepare('UPDATE download_job SET force = 1 WHERE id = ?').run(active.id)
      return active.id
    }
    const now = Date.now()
    return this.db.prepare(
      `INSERT INTO download_job (platform, track_id, ref_json, priority, requested_at, updated_at, force)
       VALUES (?,?,?,?,?,?,?)`
    ).run(ref.platform, ref.id, JSON.stringify(ref), opts.priority ?? 0, now, now, opts.force ? 1 : 0).lastInsertRowid as number
  }

  jobs(filter: { platform?: string } = {}): JobView[] {
    const rows = filter.platform
      ? this.db.prepare('SELECT * FROM download_job WHERE platform = ? ORDER BY id').all(filter.platform)
      : this.db.prepare('SELECT * FROM download_job ORDER BY id').all()
    return (rows as any[]).map((r) => this.mapJob(r))
  }

  private nextJob(): any {
    return this.db
      .prepare(`SELECT * FROM download_job WHERE state = 'queued' ORDER BY priority DESC, id ASC LIMIT 1`)
      .get()
  }

  /** Process all queued jobs to completion.
   *  Re-entrant-safe: a concurrent call while a drain is running sets `pending`
   *  so the running drain does at least one more full sweep after the caller's
   *  enqueue — no job can be stranded in the window between nextJob()===null and
   *  running=false. */
  async drain(): Promise<void> {
    if (this.stopping) return
    if (this.running) { this.pending = true; return }
    this.running = true
    try {
      do {
        this.pending = false
        let job = this.stopping ? undefined : this.nextJob()
        while (job) {
          const j = job
          const run = () => this.runOne(j)
          await (this.deps.track ? this.deps.track(`download:${j.id}`, run) : run())
          job = this.stopping ? undefined : this.nextJob()
        }
      } while (this.pending && !this.stopping)
    } finally {
      this.running = false
    }
  }

  private async runOne(job: any): Promise<void> {
    const now = Date.now()
    this.progressByJob.set(job.id, { downloaded_bytes: 0 })
    this.writeJob(`UPDATE download_job SET state='running', attempts=attempts+1, updated_at=? WHERE id=?`, now, job.id)
    this.emitJob(job.id)
    const ref = JSON.parse(job.ref_json) as TrackRef
    let resolve: DownloadResolve | undefined
    try {
      // 业务层只调 Provider 拿网址，然后通用地把字节拷到盘——不认识 Source。
      resolve = await this.deps.resolveDownload(ref)
      if (!resolve.audio?.url) throw new Error('no provider resolved a download url')
      const resolved = resolve.audio
      const upstream = await fetch(resolved.url, resolved.headers ? { headers: resolved.headers } : undefined)
      if (!upstream.ok || !upstream.body) throw new Error(`download fetch failed: ${upstream.status}`)
      const totalBytes = Number(upstream.headers.get('content-length') ?? '')
      // The song's name may live only in the ref (from download_job.ref_json) when neither the
      // provider (a pure url resolver, e.g. a per-platform track-resolve Provider row) nor refMeta supplies it — use it as the
      // fallback so the archive never degrades to `unknown - <id>`. The ref carries the feed's raw
      // "曲名 - 歌手" title, so strip the trailing " - 歌手" the same way music search does.
      // **剥后缀这一步对两边都要做**：以前只剥 ref 兜底那一路，provider 给的 title 原样就用了——
      // 而 provider 那条（zuna download recipe）的 title 同样是 RSSHub 的「曲名 - 歌手」形状。
      // 活体 2026-08-04：`alone (unplugged) - sayk_`，于是文件名成了
      // `sayk_ - alone (unplugged) - sayk_.flac`，ID3 的 title 也拖着歌手名。
      const artist = resolved.artist ?? ref.artist
      const rawTitle = resolved.title ?? ref.title
      const r = {
        stream: Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream),
        format: resolved.format ?? 'flac',
        totalBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : undefined,
        // 专辑：provider 解析不出来（那条 recipe 只解析播放地址），唯一的来源是随 ref 带下来的
        // 那一份——搜索/歌单侧早就解析好了。两边都空才是真没有。
        title: rawTitle ? songTitle(rawTitle, artist, ref.id ?? '') : undefined,
        artist, album: resolved.album ?? ref.album,
      }
      this.progressByJob.set(job.id, { downloaded_bytes: 0, total_bytes: r.totalBytes })
      this.emitJob(job.id)
      const meta = this.deps.refMeta?.(ref) ?? {}
      const mergedTags = { ...r, ...meta }
      let lastProgressEmitAt = 0
      let lastProgressBytes = 0
      let latestProgressBytes = 0
      const putRes = await this.deps.archive.put(ref, mergedTags, {
        // 「重新下载」是用户的明确意图：字节照下、标签照写，不许被质量闸挡回去。
        force: !!job.force,
        onProgress: (downloadedBytes) => {
          latestProgressBytes = downloadedBytes
          const progressStep = r.totalBytes ? Math.max(256 * 1024, Math.floor(r.totalBytes / 100)) : 256 * 1024
          const elapsed = Date.now() - lastProgressEmitAt
          if (downloadedBytes - lastProgressBytes < progressStep && elapsed < 120) return
          this.progressByJob.set(job.id, { downloaded_bytes: downloadedBytes, total_bytes: r.totalBytes })
          this.emitJob(job.id)
          lastProgressEmitAt = Date.now()
          lastProgressBytes = downloadedBytes
        },
      })
      this.progressByJob.set(job.id, { downloaded_bytes: latestProgressBytes, total_bytes: r.totalBytes ?? latestProgressBytes })
      this.writeJob(`UPDATE download_job SET state='done', updated_at=? WHERE id=?`, Date.now(), job.id)
      this.emitJob(job.id)
      const tagWrite =
        putRes.outcome === 'stored' ? await this.writeTagsBestEffort(resolved, mergedTags, putRes.asset) : undefined
      this.emitDebug(ref, 'done', { resolve, put: putRes, tagWrite })
      this.progressByJob.delete(job.id)
    } catch (e) {
      const msg = (e as Error).message
      const state = job.attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'queued'
      this.writeJob(`UPDATE download_job SET state=?, last_error=?, updated_at=? WHERE id=?`, state, msg, Date.now(), job.id)
      this.emitJob(job.id)
      this.emitDebug(ref, state === 'failed' ? 'failed' : 'retry', { resolve, error: msg, attempts: job.attempts + 1 })
      this.progressByJob.delete(job.id)
      if (state === 'failed') return
      // re-queued: bump so nextJob doesn't immediately re-pick the same row forever
      this.writeJob(`UPDATE download_job SET priority = priority - 1 WHERE id=?`, job.id)
    }
  }

  /** 归档成功后尽力写标签+封面；失败只记原因，从不向上抛出（下载本身已经成功，不该因为
   *  标签写不进去就被判定为失败）。封面下载和 writeTags 各自独立失败，互不牵连。 */
  private async writeTagsBestEffort(
    resolved: ResolvedDownload,
    tags: { title?: string; artist?: string; album?: string },
    asset: { absPath: string; format: string },
  ): Promise<{ ok: boolean; error?: string } | undefined> {
    if (!this.deps.writeTags) return undefined
    let coverBytes: Buffer | undefined
    if (resolved.coverUrl) {
      try {
        const res = await fetch(resolved.coverUrl, { signal: AbortSignal.timeout(10_000) })
        if (res.ok) coverBytes = Buffer.from(await res.arrayBuffer())
      } catch {
        // 封面拿不到不影响文字标签——继续往下走，coverBytes 保持 undefined。
      }
    }
    try {
      await this.deps.writeTags(asset.absPath, asset.format, { title: tags.title, artist: tags.artist, album: tags.album, coverBytes })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  /** Emit a download DebugEntry (resolve ladder + put outcome + on-disk truth + job state).
   *  The "文件在盘: 否" line is the smoking gun for "下载完成却还走 CDN" — a stored/deduped row
   *  whose file isn't actually present. */
  private emitDebug(
    ref: TrackRef,
    outcome: 'done' | 'failed' | 'retry',
    d: {
      resolve?: DownloadResolve
      put?: { asset: { absPath: string; relPath: string; qualityTier: number }; outcome: 'stored' | 'skipped' | 'deduped' }
      error?: string
      attempts?: number
      tagWrite?: { ok: boolean; error?: string }
    },
  ): void {
    if (!this.deps.emitDebug) return
    const at = Date.now()
    const key = `${ref.platform}:${ref.id}`
    const fileExists = d.put ? existsSync(d.put.asset.absPath) : undefined
    const fields: DebugField[] = []
    fields.push({ label: '状态', value: outcome, tone: outcome === 'done' ? 'ok' : outcome === 'failed' ? 'bad' : 'warn' })
    if (d.resolve?.via) fields.push({ label: '来源', value: d.resolve.via })
    if (d.resolve?.tier != null) fields.push({ label: '音质档', value: `T${d.resolve.tier}`, tone: d.resolve.tier >= 4 ? 'ok' : 'muted' })
    if (d.put) {
      fields.push({ label: '归档', value: `${d.put.outcome} → ${d.put.asset.relPath}`, tone: d.put.outcome === 'stored' ? 'ok' : 'muted' })
      fields.push({ label: '文件在盘', value: fileExists ? '是' : '否（有记录但文件缺失 → 不会命中本地）', tone: fileExists ? 'ok' : 'bad' })
    }
    if (d.attempts) fields.push({ label: '重试', value: String(d.attempts) })
    if (d.tagWrite) {
      fields.push({
        label: '标签写入',
        value: d.tagWrite.ok ? '成功' : `失败：${d.tagWrite.error ?? '未知'}`,
        tone: d.tagWrite.ok ? 'ok' : 'warn',
      })
    }
    if (d.error) fields.push({ label: '错误', value: d.error, tone: 'bad' })
    for (const r of d.resolve?.rungs ?? []) {
      fields.push({ label: r.member, value: `${r.ms}ms · ${r.outcome}${r.reason ? ' · ' + r.reason : ''}`, tone: r.outcome === 'win' ? 'ok' : r.outcome === 'error' ? 'bad' : 'warn' })
    }
    const summary =
      outcome === 'done'
        ? `下载完成：${d.put?.outcome ?? '已存'}${d.put && !fileExists ? '，但文件缺失(不会命中本地)' : ''}`
        : outcome === 'failed'
          ? `下载失败：${d.error ?? '未知'}`
          : `下载重试：${d.error ?? '未知'}`
    this.deps.emitDebug({
      id: `download:${key}@${at}`,
      at,
      channel: 'download',
      key,
      title: key,
      summary,
      ok: outcome === 'done' && fileExists !== false,
      fields,
    })
  }

  setSync(streamId: string, enabled: boolean): void {
    this.deps.setSyncEnabled(streamId, enabled)
  }

  isSync(streamId: string): boolean {
    return this.deps.syncEnabled(streamId)
  }

  /** 这首是不是已经下载好了。`enqueue` 的 single-flight 只挡住"还在排队/在跑"的同一首,挡不住
   *  **已经下完**的——批量入队的调用方要自己问这一句,否则整份已归档的列表会被重下一遍。 */
  isArchived(ref: TrackRef): boolean {
    return this.deps.archive.has(ref)
  }

  /** Enqueue any ref that is not already archived and has no active job. Returns count enqueued. */
  syncPlaylist(streamId: string, refs: TrackRef[]): number {
    let n = 0
    for (const ref of refs) {
      if (!ref.id) continue
      if (this.isArchived(ref)) continue
      const before = this.jobsActive(ref)
      const id = this.enqueue(ref)
      if (!before) n++
      void id
    }
    return n
  }

  private jobsActive(ref: TrackRef): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM download_job WHERE platform=? AND track_id=? AND state IN ('queued','running')`)
      .get(ref.platform, ref.id!)
  }

  /**
   * 停机闸：置旗（此后 `drain` 不再取下一条、也不再被重新拉起），等**当前这条**落账。
   *
   * 存在的理由是关停顺序：`close()` 只关 sqlite，而下载循环是异步的——SIGTERM 正撞上在途下载时，
   * 循环下一次碰库就抛在一个已经关掉的连接上（紧随 process.exit，无实害，但脏日志会把人指向
   * 一个不存在的数据库故障）。所以 storage 域的 effect 里是先 `stop()` 再 `close()`。
   *
   * 返回值是**确认**不是安慰：`true` = 循环真的停了；`false` = 宽限期内没停（一条卡住的
   * fetch 能挂很久），调用方该照实说，别把没停当成停了。
   */
  async stop(graceMs = 10_000): Promise<boolean> {
    this.stopping = true
    const deadline = Date.now() + graceMs
    while (this.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    return !this.running
  }

  /**
   * 关库。**允许撞上在飞的那一轮下载**——`stop()` 带宽限期，超时就返回 false，而调用方
   * （storage 域的 effect）明说「没停也照关」。所以这里同时置 `stopping`（循环不再取下一条）
   * 和 `closed`（在飞那一轮此后的落账变成空操作，见 `writeJob`）。
   *
   * 不这么做的样子：在飞那轮的下一次 `db.prepare` 抛在一个已关的连接上，而 `drain` 的调用方
   * 多是 `void drain()`，于是它成为一条**没人接的 unhandled rejection**——不属于任何请求、
   * 只在进程级冒出来，把人指向一个根本不存在的数据库故障。
   *
   * 幂等：重复 close 只是重复置旗（better-sqlite3 的 close 本身也幂等）。
   */
  close(): void {
    this.stopping = true
    this.closed = true
    this.db.close()
  }
}
