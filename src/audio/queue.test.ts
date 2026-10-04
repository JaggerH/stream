// src/audio/queue.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { AudioArchive } from './archive.ts'
import { DownloadQueue, type DownloadResolve } from './queue.ts'
import type { TrackRef } from './resolver.ts'
import type { TrackTags } from './tag-writer.ts'

let dir: string, archive: AudioArchive, q: DownloadQueue
const syncDeps = (sync = new Map<string, boolean>()) => ({
  syncEnabled: (streamId: string) => !!sync.get(streamId),
  setSyncEnabled: (streamId: string, enabled: boolean) => {
    if (enabled) sync.set(streamId, true)
    else sync.delete(streamId)
  },
})

/** The queue is a pure consumer: resolveDownload yields a url, the queue fetches it. Tests mock
 *  global fetch to stream the bytes. `okResolve` returns a per-id url so a fetch mock can gate one. */
const okResolve = async (ref: TrackRef): Promise<DownloadResolve> => ({ audio: { url: `https://x/${ref.id}.flac`, format: 'flac' } })

/** Mock global fetch to stream `bytes` (a string). `totalBytes` sets content-length; `gate`, when
 *  given, splits the stream mid-way and waits on the promise before emitting the tail. `only` gates
 *  just the urls containing that substring. */
function mockFetch(opts: { bytes?: string; totalBytes?: number; gate?: Promise<void>; only?: string } = {}) {
  const bytes = opts.bytes ?? 'bytes'
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    const gated = opts.gate && (!opts.only || url.includes(opts.only))
    const stream = gated
      ? Readable.from((async function* () {
          const half = Math.max(1, Math.floor(bytes.length / 2))
          yield Buffer.from(bytes.slice(0, half))
          await opts.gate
          yield Buffer.from(bytes.slice(half))
        })())
      : Readable.from([Buffer.from(bytes)])
    const headers: Record<string, string> = opts.totalBytes ? { 'content-length': String(opts.totalBytes) } : {}
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers })
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'q-'))
  archive = new AudioArchive(join(dir, 'a.db'), join(dir, 'files'))
  mockFetch()
  q = new DownloadQueue(join(dir, 'q.db'), { archive, resolveDownload: okResolve, ...syncDeps(), refMeta: () => ({ title: 't', artist: 'a', album: 'al' }) })
})
afterEach(() => { vi.restoreAllMocks(); archive.close(); q.close(); rmSync(dir, { recursive: true, force: true }) })

describe('DownloadQueue', () => {
  it('enqueues and drains to done, archiving the track', async () => {
    q.enqueue({ platform: 'netease', id: '1' })
    await q.drain()
    expect(q.jobs()[0].state).toBe('done')
    expect(archive.has({ platform: 'netease', id: '1' })).toBe(true)
  })
  it('archives using the ref title/artist when neither provider nor refMeta supply them', async () => {
    // Production shape: the netease provider resolves only a url (no title/artist) and refMeta is
    // the empty stub. The song's name lives only in the ref (from download_job.ref_json), carrying
    // the feed's raw "曲名 - 歌手" title — the archive must use it (and strip the " - 歌手" suffix)
    // instead of falling back to `unknown - <id>`.
    const qRef = new DownloadQueue(join(dir, 'q-ref.db'), {
      archive,
      resolveDownload: async (ref: TrackRef) => ({ audio: { url: `https://x/${ref.id}.flac`, format: 'flac' } }),
      ...syncDeps(),
      refMeta: () => ({}),
    })
    try {
      qRef.enqueue({ platform: 'netease', id: '2041026502', title: '愿与愁 - 林俊杰', artist: '林俊杰' })
      await qRef.drain()
      expect(archive.lookup({ platform: 'netease', id: '2041026502' })?.relPath).toBe('netease/林俊杰 - 愿与愁.flac')
    } finally {
      qRef.close()
    }
  })
  it('marks failed when no source resolves a url', async () => {
    const q2 = new DownloadQueue(join(dir, 'q2.db'), { archive, resolveDownload: async () => ({ audio: null }), ...syncDeps() })
    q2.enqueue({ platform: 'netease', id: '9' })
    await q2.drain()
    expect(q2.jobs()[0].state).toBe('failed')
    q2.close()
  })
  it('is single-flight per track (no duplicate queued job)', () => {
    const a = q.enqueue({ platform: 'netease', id: '1' })
    const b = q.enqueue({ platform: 'netease', id: '1' })
    expect(a).toBe(b)
    expect(q.jobs().length).toBe(1)
  })
  it('syncPlaylist enqueues only new, unarchived tracks', async () => {
    q.enqueue({ platform: 'netease', id: '1' }); await q.drain() // 1 now archived
    const n = q.syncPlaylist('s1', [{ platform: 'netease', id: '1' }, { platform: 'netease', id: '2' }])
    expect(n).toBe(1) // only id 2 enqueued
  })
  it('tracks the per-playlist sync toggle', () => {
    expect(q.isSync('s1')).toBe(false)
    q.setSync('s1', true)
    expect(q.isSync('s1')).toBe(true)
  })
  it('migrates legacy playlist_sync rows through setSyncEnabled and drops the table', () => {
    const dbPath = join(dir, 'legacy.db')
    const legacy = new Database(dbPath)
    legacy.exec(`
      CREATE TABLE playlist_sync (
        stream_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER
      );
      INSERT INTO playlist_sync (stream_id, enabled, updated_at) VALUES ('on', 1, 1), ('off', 0, 1);
    `)
    legacy.close()
    const migrated = new Map<string, boolean>()
    const qLegacy = new DownloadQueue(dbPath, { archive, resolveDownload: okResolve, ...syncDeps(migrated) })
    try {
      expect(migrated.get('on')).toBe(true)
      expect(migrated.has('off')).toBe(false)
      const check = new Database(dbPath)
      try {
        expect(check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'playlist_sync'`).get()).toBeUndefined()
      } finally {
        check.close()
      }
    } finally {
      qLegacy.close()
    }
  })

  it('reports byte progress while a download is running', async () => {
    let releaseTail!: () => void
    const tailGate = new Promise<void>((res) => { releaseTail = res })
    vi.restoreAllMocks()
    mockFetch({ bytes: 'abcdefg', totalBytes: 7, gate: tailGate })
    const qProgress = new DownloadQueue(join(dir, 'q-progress.db'), {
      archive,
      resolveDownload: okResolve,
      ...syncDeps(),
      refMeta: () => ({ title: 't', artist: 'a', album: 'al' }),
    })

    try {
      qProgress.enqueue({ platform: 'netease', id: 'P' })
      const drainPromise = qProgress.drain()
      await new Promise((res) => setTimeout(res, 0))

      const running = qProgress.jobs()[0]
      expect(running.state).toBe('running')
      expect(running.downloaded_bytes).toBe(3)
      expect(running.total_bytes).toBe(7)

      releaseTail()
      await drainPromise
      const done = qProgress.jobs()[0]
      expect(done.state).toBe('done')
      expect(done.downloaded_bytes).toBeUndefined()
      expect(done.total_bytes).toBeUndefined()
    } finally {
      releaseTail()
      qProgress.close()
    }
  })

  it('emits live job updates for running, progress, and done', async () => {
    const events: string[] = []
    const off = q.onJob((job) => {
      events.push(`${job.state}:${job.downloaded_bytes ?? 0}:${job.total_bytes ?? 0}:${job.archived ? 'archived' : 'open'}`)
    })
    try {
      q.enqueue({ platform: 'netease', id: 'live' })
      await q.drain()
    } finally {
      off()
    }

    expect(events).toContain('running:0:0:open')
    expect(events.some((e) => e.startsWith('running:5:'))).toBe(true)
    expect(events.at(-1)).toBe('done:5:5:archived')
  })

  it('drain re-run guard: job B enqueued mid-drain is not stranded', async () => {
    // Deferred that controls when job A's fetch completes.
    let resolveA!: () => void
    const gateA = new Promise<void>((res) => { resolveA = res })
    vi.restoreAllMocks()
    mockFetch({ gate: gateA, only: '/A.flac' })
    const qRace = new DownloadQueue(join(dir, 'q-race.db'), {
      archive,
      resolveDownload: okResolve,
      ...syncDeps(),
      refMeta: () => ({ title: 't', artist: 'a', album: 'al' }),
    })

    try {
      // Enqueue A and start draining (it will block inside gateA).
      qRace.enqueue({ platform: 'netease', id: 'A' })
      const drainPromise = qRace.drain() // fire — currently in-flight on A

      // While A is in-flight, enqueue B and call drain() (hits the no-op path).
      qRace.enqueue({ platform: 'netease', id: 'B' })
      void qRace.drain() // concurrent call: sets pending=true, returns immediately

      // Now unblock A.
      resolveA()
      await drainPromise

      // Both A and B must be done — B must not be stranded.
      const jobs = qRace.jobs()
      const stateOf = (id: string) => jobs.find((j) => j.track_id === id)?.state
      expect(stateOf('A')).toBe('done')
      expect(stateOf('B')).toBe('done')
    } finally {
      resolveA()
      qRace.close()
    }
  })

  it('adopts legacy download-jobs.db into stream.db once and renames the legacy file', () => {
    const streamDb = join(dir, 'stream.db')
    const legacyDb = join(dir, 'download-jobs.db')
    const legacy = new Database(legacyDb)
    legacy.exec(`
      CREATE TABLE download_job (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL, track_id TEXT NOT NULL,
        ref_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        downloaded_bytes INTEGER, total_bytes INTEGER,
        requested_at INTEGER, updated_at INTEGER
      );
      INSERT INTO download_job (platform, track_id, ref_json, state, priority, attempts, requested_at, updated_at)
      VALUES ('netease', 'legacy-1', '{"platform":"netease","id":"legacy-1"}', 'done', 1, 1, 1000, 1000);
    `)
    legacy.close()

    const first = new DownloadQueue(streamDb, { archive, resolveDownload: okResolve, ...syncDeps(), refMeta: () => ({}) }, legacyDb)
    expect(first.jobs()[0]).toMatchObject({
      platform: 'netease',
      track_id: 'legacy-1',
      state: 'done',
    })
    expect(existsSync(`${legacyDb}.imported`)).toBe(true)
    first.close()

    const second = new DownloadQueue(streamDb, { archive, resolveDownload: okResolve, ...syncDeps(), refMeta: () => ({}) }, legacyDb)
    expect(second.jobs()).toHaveLength(1)
    expect(second.jobs()[0].track_id).toBe('legacy-1')
    second.close()
  })

  it('每个 job 经 track 包裹为 download:<jobId>(op-track 埋点)', async () => {
    const tracked: string[] = []
    const q2 = new DownloadQueue(join(dir, 'q-track.db'), {
      archive,
      resolveDownload: okResolve,
      ...syncDeps(),
      refMeta: () => ({ title: 't', artist: 'a', album: 'al' }),
      track: async (name, fn) => {
        tracked.push(name)
        return fn()
      },
    })
    try {
      const id = q2.enqueue({ platform: 'p', id: 'track-1' })
      await q2.drain()
      expect(tracked).toEqual([`download:${id}`])
    } finally {
      q2.close()
    }
  })
})

describe('DownloadQueue — 关停', () => {
  /** 起一条「A 卡在半途、B 还排着」的队列，返回放行 A 的开关。 */
  function gatedQueue(name: string) {
    let releaseA!: () => void
    const gateA = new Promise<void>((res) => { releaseA = res })
    vi.restoreAllMocks()
    mockFetch({ gate: gateA, only: '/A.flac' })
    const qs = new DownloadQueue(join(dir, name), {
      archive,
      resolveDownload: okResolve,
      ...syncDeps(),
      refMeta: () => ({ title: 't', artist: 'a', album: 'al' }),
    })
    qs.enqueue({ platform: 'netease', id: 'A' })
    qs.enqueue({ platform: 'netease', id: 'B' })
    return { qs, releaseA, drain: qs.drain() }
  }

  it('stop 等在途的那条落账，且不再取下一条', async () => {
    const { qs, releaseA, drain } = gatedQueue('q-stop.db')
    try {
      const stopped = qs.stop()
      releaseA()
      expect(await stopped).toBe(true)
      await drain
      const stateOf = (id: string) => qs.jobs().find((j) => j.track_id === id)?.state
      expect(stateOf('A')).toBe('done') // 在途的那条落了账，不是被砍在半路
      expect(stateOf('B')).toBe('queued') // 停机旗之后不再取下一条
      // 这才是这条测试真正在防的：stop 之后关库不再有异步循环回来碰它。
      expect(() => qs.close()).not.toThrow()
    } finally {
      releaseA()
    }
  })

  it('宽限期内没停就如实回 false，不假装停了', async () => {
    const { qs, releaseA, drain } = gatedQueue('q-stop-timeout.db')
    try {
      expect(await qs.stop(50)).toBe(false) // A 还卡着
      releaseA()
      await drain
    } finally {
      releaseA()
      qs.close()
    }
  })
})

describe('DownloadQueue — 写标签接线', () => {
  it('调用 writeTags，用归档结果的 absPath/format + 曲目元数据 + 封面字节', async () => {
    const calls: Array<{ absPath: string; format: string; tags: TrackTags }> = []
    const q2 = new DownloadQueue(join(dir, 'q-tags.db'), {
      archive,
      resolveDownload: async (ref: TrackRef) => ({
        audio: { url: `https://x/${ref.id}.flac`, format: 'flac', title: 't', artist: 'a', album: 'al', coverUrl: 'https://x/cover.jpg' },
      }),
      ...syncDeps(),
      writeTags: async (absPath, format, tags) => { calls.push({ absPath, format, tags }) },
    })
    // 一个 fetch mock 同时应对音频字节请求和封面图请求——按 URL 分支，不叠加调用 mockFetch()
    // （mockFetch() 自己也会 vi.spyOn(globalThis,'fetch')，两次 spy 会互相覆盖，只有后一次生效）。
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('cover.jpg')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      return new Response(Readable.toWeb(Readable.from([Buffer.from('bytes')])) as ReadableStream, { status: 200 })
    })
    q2.enqueue({ platform: 'netease', id: 'tag1' })
    await q2.drain()
    expect(calls).toHaveLength(1)
    expect(calls[0].format).toBe('flac')
    expect(calls[0].tags.title).toBe('t')
    expect(calls[0].tags.artist).toBe('a')
    expect(calls[0].tags.album).toBe('al')
    expect(calls[0].tags.coverBytes).toBeInstanceOf(Buffer)
    q2.close()
  })

  it('writeTags 失败不影响下载判定为 done，且不重新抛出', async () => {
    const q2 = new DownloadQueue(join(dir, 'q-tags-fail.db'), {
      archive, resolveDownload: okResolve, ...syncDeps(),
      writeTags: async () => { throw new Error('ffmpeg exploded') },
    })
    q2.enqueue({ platform: 'netease', id: 'tag2' })
    await q2.drain()
    const jobs = q2.jobs()
    expect(jobs.find((j) => j.track_id === 'tag2')?.state).toBe('done')
    q2.close()
  })

  it('没有配置 writeTags 时（deps 里不传）下载照常成功，不报错', async () => {
    q.enqueue({ platform: 'netease', id: 'tag3' })
    await q.drain()
    const jobs = q.jobs()
    expect(jobs.find((j) => j.track_id === 'tag3')?.state).toBe('done')
  })

  it('archive.put 返回 skipped（同曲重复下载、已有等/高音质文件在盘）时不调用 writeTags', async () => {
    const calls: Array<{ absPath: string; format: string }> = []
    const q2 = new DownloadQueue(join(dir, 'q-tags-skip.db'), {
      archive,
      resolveDownload: async (ref: TrackRef) => ({ audio: { url: `https://x/${ref.id}.flac`, format: 'flac' } }),
      ...syncDeps(),
      refMeta: () => ({ title: 't', artist: 'a', album: 'al' }),
      writeTags: async (absPath, format) => { calls.push({ absPath, format }) },
    })
    // 第一次入队：archive.put 是 stored，应该写一次标签。
    q2.enqueue({ platform: 'netease', id: 'tag-skip-1' })
    await q2.drain()
    expect(calls).toHaveLength(1)
    // 同一首曲子再入一次队：runOne 重新走一遍下载→put，这次已有等同音质的文件在盘，
    // archive.put 返回 'skipped'——不该再触发一次 ffmpeg 重新封装。
    q2.enqueue({ platform: 'netease', id: 'tag-skip-1' })
    await q2.drain()
    const jobs = q2.jobs().filter((j) => j.track_id === 'tag-skip-1')
    expect(jobs.every((j) => j.state === 'done')).toBe(true)
    expect(calls).toHaveLength(1) // 仍然只有第一次那一次调用
    q2.close()
  })
})

/**
 * 标签取值的三条来路。活体 2026-08-04 一次性暴露了两个洞：写进 ID3 的 title 拖着「 - 歌手」，
 * 专辑一栏全空（新下载的 87 条 `track_asset.album` 全是 NULL）。
 */
describe('DownloadQueue — 标签取值', () => {
  const tagCalls = (calls: Array<{ tags: TrackTags }>) => calls[0]?.tags
  const makeQ = (name: string, resolveDownload: (ref: TrackRef) => Promise<DownloadResolve>) => {
    const calls: Array<{ tags: TrackTags }> = []
    const q2 = new DownloadQueue(join(dir, name), {
      archive, resolveDownload, ...syncDeps(),
      writeTags: async (_absPath, _format, tags) => { calls.push({ tags }) },
    })
    return { q2, calls }
  }

  it('provider 给的 title 也要剥掉「 - 歌手」——它同样是 RSSHub 的「曲名 - 歌手」形状', async () => {
    const { q2, calls } = makeQ('q-title.db', async (ref) => ({
      audio: { url: `https://x/${ref.id}.flac`, format: 'flac', title: 'alone (unplugged) - sayk_', artist: 'sayk_' },
    }))
    try {
      q2.enqueue({ platform: 'netease', id: 'title-1' })
      await q2.drain()
      expect(tagCalls(calls)?.title).toBe('alone (unplugged)')
      // 文件名跟着标题走，所以歌手不该出现两次（活体：`sayk_ - alone (unplugged) - sayk_.flac`）。
      expect(archive.lookup({ platform: 'netease', id: 'title-1' })!.relPath).toContain('sayk_ - alone (unplugged).flac')
    } finally { q2.close() }
  })

  it('专辑名从 ref 带下来——下载 provider 解析不出它，不带就永远是空的', async () => {
    const { q2, calls } = makeQ('q-album.db', async (ref) => ({
      audio: { url: `https://x/${ref.id}.flac`, format: 'flac', title: 'Melody', artist: 'Ultrasound' },
    }))
    try {
      q2.enqueue({ platform: 'netease', id: 'album-1', album: 'Ultrasound 乐之路 1997-2003' })
      await q2.drain()
      expect(tagCalls(calls)?.album).toBe('Ultrasound 乐之路 1997-2003')
    } finally { q2.close() }
  })

  it('provider 自己给得出专辑时以它为准，ref 那份只是兜底', async () => {
    const { q2, calls } = makeQ('q-album2.db', async (ref) => ({
      audio: { url: `https://x/${ref.id}.flac`, format: 'flac', title: 'Melody', artist: 'U', album: 'from-provider' },
    }))
    try {
      q2.enqueue({ platform: 'netease', id: 'album-2', album: 'from-ref' })
      await q2.drain()
      expect(tagCalls(calls)?.album).toBe('from-provider')
    } finally { q2.close() }
  })
})

/** 「重新下载」：入队这一位要一路带到 archive.put，否则跑完是 skipped、标签也不重写。 */
describe('DownloadQueue — force 重新下载', () => {
  it('force 的第二次入队真的重写文件并重写标签（不带 force 的对照见「写标签接线」那一组）', async () => {
    const calls: string[] = []
    const q2 = new DownloadQueue(join(dir, 'q-force.db'), {
      archive,
      resolveDownload: async (ref: TrackRef) => ({ audio: { url: `https://x/${ref.id}.flac`, format: 'flac', title: 't', artist: 'a' } }),
      ...syncDeps(),
      writeTags: async (absPath) => { calls.push(absPath) },
    })
    try {
      q2.enqueue({ platform: 'netease', id: 'force-1' })
      await q2.drain()
      expect(calls).toHaveLength(1)
      q2.enqueue({ platform: 'netease', id: 'force-1' }, { force: true })
      await q2.drain()
      expect(calls).toHaveLength(2)
    } finally { q2.close() }
  })

  // 关停竞态：`stop()` 是**尽力**不是保证——它带宽限期，超时就返回 false，而 storage 域那条
  // effect 明说「宽限期内没停就照实说，closing anyway」。也就是说 `close()` 撞上一轮在飞的
  // 下载是**设计内会发生**的事，队列必须扛得住。扛不住的样子是：在飞那轮的下一次 `db.prepare`
  // 抛在一个已经关掉的连接上（`TypeError: The database connection is not open`），而 drain 的
  // 调用方多是 fire-and-forget（`void queue.drain()`，见 http/app.ts 的下载路由与 scheduling），
  // 于是它变成一条**没人接的 unhandled rejection**——进程级的，不属于任何一个请求。
  it('close() 撞上在飞的那一轮：不再碰库，也不抛「database connection is not open」', async () => {
    let releaseGate!: () => void
    const gate = new Promise<void>((r) => { releaseGate = r })
    mockFetch({ gate })
    const q2 = new DownloadQueue(join(dir, 'q-close-race.db'), { archive, resolveDownload: okResolve, ...syncDeps() })
    q2.enqueue({ platform: 'netease', id: 'close-race' })
    const drainPromise = q2.drain() // 在飞，卡在 gate 上（字节流只发了一半）
    await new Promise((r) => setTimeout(r, 20)) // 让它真的进到 fetch 里
    q2.close() // 关停顺序被打破 / stop() 宽限期到点——两种都走到这里
    releaseGate()
    // 判据是**这一轮安静地收尾**：既不抛、也不留下一条没人接的 rejection。
    await expect(drainPromise).resolves.toBeUndefined()
  })

  it('已经排着的那一条再点一次「重新下载」→ 把 force 补上去，不然复用的那条跑完仍是空操作', async () => {
    const q2 = new DownloadQueue(join(dir, 'q-force2.db'), { archive, resolveDownload: okResolve, ...syncDeps() })
    try {
      const first = q2.enqueue({ platform: 'netease', id: 'force-2' })
      const second = q2.enqueue({ platform: 'netease', id: 'force-2' }, { force: true })
      expect(second).toBe(first) // single-flight：复用同一条
      const db = new Database(join(dir, 'q-force2.db'))
      const row = db.prepare('SELECT force FROM download_job WHERE id=?').get(first) as { force: number }
      db.close()
      expect(row.force).toBe(1)
    } finally { q2.close() }
  })
})
