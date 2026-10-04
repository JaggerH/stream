// src/http/audio-archive.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AudioArchive } from '../audio/archive.ts'
import { DownloadQueue } from '../audio/queue.ts'
import type { AudioResolver } from '../audio/index.ts'
import type { TrackRef } from '../audio/resolver.ts'
import { createHttpApp } from './app.ts'
import { UserStore } from '../store/user-store.ts'
import { Registry } from '../registry/registry.ts'
import { ProviderStatsStore } from '../providers/stats-store.ts'
import { ProviderExecutor } from '../providers/executor.ts'
import { ProviderDirectory } from '../providers/directory.ts'
import { SYSTEM_IDENTITIES } from '../providers/system/index.ts'

/** 生产同构 executor：一个 netease-track 行（播放/下载/订阅共用的取歌 Provider）。测试的取歌实现
 *  以 AudioResolver 形状给出（{name, supports, resolve} → {url|enclosure_url, headers?}）。 */
function makeProviders(dir: string, opts: { play?: AudioResolver[] }) {
  const store = new UserStore(join(dir, `prov-${Math.random()}.db`))
  const stats = new ProviderStatsStore(join(dir, `stats-${Math.random()}.db`))
  const attempts = new Map<string, (input: unknown) => Promise<unknown[]>>()
  for (const r of opts.play ?? []) {
    attempts.set(`src:${r.name}`, async (input) => {
      const ref = { platform: 'netease', id: String(input) } as TrackRef
      if (!r.supports(ref)) return []
      const v = await r.resolve(ref)
      return v == null ? [] : [v]
    })
  }
  if (opts.play?.length) {
    store.putProvider({
      id: 'netease-track', label: '', description: '', category: 'resolve', serves: ['netease', 'music.163.com', 'netease-track'],
      strategy: 'sequential', members: opts.play.map((r) => ({ source: `src:${r.name}` })),
      contract: null, options: {},
    })
  }
  const executor = new ProviderExecutor({
    directory: new ProviderDirectory(store, SYSTEM_IDENTITIES), registry: new Registry([]), stats,
    fetchSource: async (sourceId, input) => {
      const attempt = attempts.get(sourceId)
      if (!attempt) throw new Error(`no source ${sourceId}`)
      return attempt(input)
    },
  })
  return { executor, stats }
}

let dir: string, archive: AudioArchive, queue: DownloadQueue, app: any
let sync: Map<string, boolean>
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/**
 * 等到队列里**确实**没有在跑的活为止。下载是 `void queue.drain()` 打出去的（http/app.ts 的
 * 下载路由），拿不到那个 promise，只能轮询状态。
 *
 * **超时必须抛，不许静默返回。** 原来的写法是「最多 20×10ms，到点就 return」——预算一到就
 * 悄悄放行，后面那条 `expect(archive.status(...))` 于是在一个**还没下完**的状态上断言。
 * 症状是一条只在机器忙的时候才红的用例（实测：单文件循环 6 轮全绿、整目录循环 3 轮全绿，
 * 只有全量负载下才翻红），而红的样子是 `expected false to be true`——完全看不出是"没等到"。
 * 预算给到 5s 是因为这里的"下载"是一条 mock 的内存流，正常是毫秒级；真花到 5s 说明是别的
 * 问题，那时候要的是一条说得出话的失败，不是一次安静的放行。
 */
async function waitForDownloads(): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const jobs = queue.jobs()
    if (jobs.length > 0 && jobs.every((j) => j.state !== 'queued' && j.state !== 'running')) return
    await sleep(10)
  }
  const seen = queue.jobs().map((j) => ({ id: j.id, state: j.state, last_error: j.last_error }))
  throw new Error(`waitForDownloads 超时（5s）——队列没跑完：${JSON.stringify(seen)}`)
}
const itemStore = {
  get: (id: string) => (id === 'i1'
    ? { id: 'i1', title: 'S', author: 'A', content: { media: [{ kind: 'audio', url: '/x', platform: 'netease', track_id: '1' }] } }
    : undefined),
  recent: () => [{ id: 'i1', title: 'S', author: 'A', content: { media: [{ kind: 'audio', url: '/x', platform: 'netease', track_id: '1' }] } }],
} as any

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'http-'))
  sync = new Map()
  archive = new AudioArchive(join(dir, 'a.db'), join(dir, 'files'))
  // queue is a pure consumer: resolveDownload → a url; the queue fetches it. Mock fetch to stream bytes.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(Readable.toWeb(Readable.from([Buffer.from('z')])) as ReadableStream, { status: 200 }))
  queue = new DownloadQueue(join(dir, 'q.db'), {
    archive,
    resolveDownload: async () => ({ audio: { url: 'https://dl.test/song.flac', format: 'flac' } }),
    syncEnabled: (streamId) => !!sync.get(streamId),
    setSyncEnabled: (streamId, enabled) => {
      if (enabled) sync.set(streamId, true)
      else sync.delete(streamId)
    },
  })
  app = createHttpApp({ itemStore, audioArchive: archive, downloadQueue: queue, /* ...other deps as required, can be stubbed */ } as any)
})
// 关停顺序照抄生产那一条（storage 域的 effect）：**先 `stop()` 等在飞的那轮落账，再 `close()`**。
// 少了 `stop()` 这一步，用例之间就会留下一轮还在跑的下载，然后库在它脚下被关掉。
// 队列本身已经扛得住这件事（`close()` 之后落账是空操作），但测试没有理由去演一个坏的关停顺序。
afterEach(async () => {
  vi.restoreAllMocks()
  await queue.stop()
  archive.close()
  queue.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('audio archive HTTP', () => {
  it('enqueues a single item download', async () => {
    const res = await app.request('/api/downloads', { method: 'POST', body: JSON.stringify({ itemId: 'i1' }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(200)
    expect((await res.json()).enqueued).toBe(1)
    await waitForDownloads()
    expect(queue.jobs().length).toBe(1)
  })
  it('enqueues a direct track ref download', async () => {
    const res = await app.request('/api/downloads', {
      method: 'POST',
      body: JSON.stringify({ track: { platform: 'netease', trackId: '2', title: 'T', artist: 'B' } }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).enqueued).toBe(1)
    await waitForDownloads()
    expect(archive.status([{ platform: 'netease', id: '2' }])).toEqual({ 'netease:2': true })
  })
  it('lists jobs and validates filters', async () => {
    queue.enqueue({ platform: 'netease', id: '1' })
    queue.enqueue({ platform: 'bilibili', id: '2' })
    const res = await app.request('/api/downloads')
    const data = await res.json()
    expect(data.items.length).toBe(2)

    const resFilter = await app.request('/api/downloads?platform=netease')
    const dataFilter = await resFilter.json()
    expect(dataFilter.items.length).toBe(1)
    expect(dataFilter.items[0].platform).toBe('netease')
  })
  // 批量入队(下载整单 / 多选下载)必须跳过已经下载好的——队列自己只对"还在排队/在跑"的任务去重
  // (queue.enqueue 的 single-flight),对**已下载完**的毫无判断,所以一份大半已归档的「我喜欢的」
  // 会被整份重下。跳过要显式请求:行内菜单的「重新下载」是用户的明确意图,不能被一刀切掉。
  describe('skipArchived', () => {
    const dl = (body: unknown) => app.request('/api/downloads', {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    })

    it('已下载的曲目带 skipArchived 时不再入队,并计进 skipped', async () => {
      await dl({ track: { platform: 'netease', trackId: '2', title: 'T', artist: 'B' } })
      await waitForDownloads()
      expect(archive.status([{ platform: 'netease', id: '2' }])).toEqual({ 'netease:2': true })
      const before = queue.jobs().length

      const res = await dl({ track: { platform: 'netease', trackId: '2' }, skipArchived: true })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ enqueued: 0, skipped: 1 })
      expect(queue.jobs().length).toBe(before)
    })

    it('不带 skipArchived 时照旧入队——行内「重新下载」靠的就是这条', async () => {
      await dl({ track: { platform: 'netease', trackId: '2', title: 'T', artist: 'B' } })
      await waitForDownloads()
      const res = await dl({ track: { platform: 'netease', trackId: '2' } })
      expect(await res.json()).toEqual({ enqueued: 1, skipped: 0 })
      await waitForDownloads() // 别把在跑的下载留到 afterEach 关库,那会炸成 unhandled rejection
    })

    it('没下载过的曲目带 skipArchived 照常入队', async () => {
      const res = await dl({ track: { platform: 'netease', trackId: '9' }, skipArchived: true })
      expect(await res.json()).toEqual({ enqueued: 1, skipped: 0 })
      await waitForDownloads()
    })

    it('itemId 分支同样受 skipArchived 管', async () => {
      await dl({ itemId: 'i1' })
      await waitForDownloads()
      const res = await dl({ itemId: 'i1', skipArchived: true })
      expect(await res.json()).toEqual({ enqueued: 0, skipped: 1 })
    })

    it('整单分支:已下载的那首不计进 enqueued', async () => {
      await dl({ itemId: 'i1' })
      await waitForDownloads()
      const res = await dl({ stream: 's1', skipArchived: true })
      expect(await res.json()).toEqual({ enqueued: 0, skipped: 1 })
    })

    // 两个开关意思正相反（"已下的别再下" vs "就是要再下一遍"）。同时给的时候必须有一个赢，
    // 而赢的只能是 force：它是用户点了菜单的**明确意图**，skipArchived 是批量路径的默认防护。
    it('force 压过 skipArchived——同时给时照样入队', async () => {
      await dl({ track: { platform: 'netease', trackId: '2', title: 'T', artist: 'B' } })
      await waitForDownloads()
      const res = await dl({ track: { platform: 'netease', trackId: '2' }, skipArchived: true, force: true })
      expect(await res.json()).toEqual({ enqueued: 1, skipped: 0 })
      await waitForDownloads()
    })
  })

  /** 专辑名只有调用方手里有（下载 provider 只解析播放地址）。在这个边界丢掉，
   *  写进文件的 ID3 里专辑就永远是空的——2026-08-04 活体：新下载的 87 条全是 NULL。 */
  it('track.album 一路带到归档快照里，不在 API 边界被丢掉', async () => {
    const res = await app.request('/api/downloads', {
      method: 'POST',
      body: JSON.stringify({ track: { platform: 'netease', trackId: '77', title: 'T', artist: 'B', album: '青春的喝彩' } }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    await waitForDownloads()
    expect(archive.recentlyDownloaded(0).find((t) => t.trackId === '77')?.album).toBe('青春的喝彩')
  })

  it('fails with validation error if invalid body is sent', async () => {
    const res = await app.request('/api/downloads', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: { code: 'validation_error', message: 'itemId, stream, or track required' }
    })
  })
  it('returns 404 for item not found', async () => {
    const res = await app.request('/api/downloads', {
      method: 'POST',
      body: JSON.stringify({ itemId: 'i-missing' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: 'Item not found' }
    })
  })
  it('returns 404 for deleted endpoints', async () => {
    const res1 = await app.request('/api/audio/download', {
      method: 'POST',
      body: JSON.stringify({ itemId: 'i1' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res1.status).toBe(404)
    const res2 = await app.request('/api/audio/download/jobs')
    expect(res2.status).toBe(404)
    const res3 = await app.request('/api/audio/archive/status', { method: 'POST' })
    expect(res3.status).toBe(404)
    const res4 = await app.request('/api/audio/archive/netease/1', { method: 'DELETE' })
    expect(res4.status).toBe(404)
    const res5 = await app.request('/api/audio/resolve?platform=netease&id=1')
    expect(res5.status).toBe(404)
  })
  it('returns archive status for a batch of tracks', async () => {
    await archive.put({ platform: 'netease', id: '1' }, { stream: Readable.from([Buffer.from('z')]), format: 'flac', sampleRate: 96000, bitDepth: 24, title: 'S' })
    const res = await app.request('/api/media/assets?refs=netease:1,netease:2')
    expect(await res.json()).toEqual({ archived: { 'netease:1': true, 'netease:2': false } })
  })
  it('rejects missing or malformed archive status refs', async () => {
    const missing = await app.request('/api/media/assets')
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({
      error: { code: 'validation_error', message: 'refs required' },
    })

    const malformed = await app.request('/api/media/assets?refs=netease')
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({
      error: { code: 'validation_error', message: 'refs must be platform:trackId pairs' },
    })
  })
  it('resolve redirects to the local file when archived', async () => {
    await archive.put({ platform: 'netease', id: '1' }, { stream: Readable.from([Buffer.from('z')]), format: 'flac', sampleRate: 96000, bitDepth: 24, title: 'S' })
    const res = await app.request('/api/media/tracks/resolve?platform=netease&id=1')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/api/media/assets/')

    const oldFile = await app.request('/api/audio/file/1')
    expect(oldFile.status).toBe(404)
  })
  it('proxies resolver URLs that require provider headers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('audio-bytes', {
      status: 206,
      headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-10/11' },
    }))
    const play = makeProviders(dir, {
      play: [{
        name: 'needs-headers',
        supports: () => true,
        resolve: async () => ({ url: 'https://provider.test/song.mp3', headers: { Referer: 'https://provider.test/' } }),
      }],
    })
    const proxyApp = createHttpApp({
      itemStore,
      audioArchive: archive,
      downloadQueue: queue,
      providers: { executor: play.executor, stats: play.stats },
    } as any)
    try {
      const res = await proxyApp.request('/api/media/tracks/resolve?platform=netease&id=2', { headers: { Range: 'bytes=0-10' } })
      expect(res.status).toBe(206)
      expect(await res.text()).toBe('audio-bytes')
      expect(fetchSpy).toHaveBeenCalledWith('https://provider.test/song.mp3', {
        headers: { Referer: 'https://provider.test/', Range: 'bytes=0-10' },
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })
  it('redirects (302) to a catalog download item enclosure_url', async () => {
    // track-play now resolves via catalog download routes, whose items carry enclosure_url
    // (a signed CDN link, no headers) — the endpoint 302s straight to it.
    const cat = makeProviders(dir, {
      play: [{
        name: 'catalog',
        supports: () => true,
        resolve: async () => ({ enclosure_url: 'https://cdn.test/song.mp3' } as unknown as { url: string }),
      }],
    })
    const catApp = createHttpApp({
      itemStore,
      audioArchive: archive,
      downloadQueue: queue,
      providers: { executor: cat.executor, stats: cat.stats },
    } as any)
    const res = await catApp.request('/api/media/tracks/resolve?platform=netease&id=9')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://cdn.test/song.mp3')
  })
  it('deletes archived assets by track ref', async () => {
    await archive.put({ platform: 'netease', id: '1' }, { stream: Readable.from([Buffer.from('z')]), format: 'flac', sampleRate: 96000, bitDepth: 24, title: 'S' })
    const res = await app.request('/api/media/assets/netease/1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(archive.has({ platform: 'netease', id: '1' })).toBe(false)
  })
  it('POST /api/audio/sync is gone — sync toggling is a stream-options PATCH now', async () => {
    const res = await app.request('/api/audio/sync', { method: 'POST', body: JSON.stringify({ stream: 's1', enabled: true }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(404)
  })
})

describe('AudioArchive.recentlyDownloaded', () => {
  it('returns only assets downloaded at or after the given timestamp', async () => {
    await archive.put({ platform: 'netease', id: 'old' }, {
      stream: Readable.from([Buffer.from('bytes')]), format: 'flac', title: '旧歌', artist: '甲',
    })
    // 留出真实间隔再取 cutoff——如果 cutoff 和上面这次 put() 落在同一毫秒，downloaded_at >= cutoff
    // 会把"旧歌"也算进来（这条测试在全量套件的负载下就撞过一次，单独跑因为够快从不触发）。
    await new Promise((r) => setTimeout(r, 5))
    const cutoff = Date.now()
    await new Promise((r) => setTimeout(r, 5))
    await archive.put({ platform: 'netease', id: 'new' }, {
      stream: Readable.from([Buffer.from('bytes2')]), format: 'mp3', title: '新歌', artist: '乙', album: '专辑乙',
    })
    const recent = archive.recentlyDownloaded(cutoff)
    expect(recent).toHaveLength(1)
    expect(recent[0]).toMatchObject({ platform: 'netease', trackId: 'new', title: '新歌', artist: '乙', album: '专辑乙', format: 'mp3' })
    expect(recent[0].absPath).toContain('新歌') // relPathFlat 命名约定：<艺人> - <标题>.<格式>
  })

  it('returns an empty array when nothing matches', () => {
    expect(archive.recentlyDownloaded(Date.now() + 100000)).toEqual([])
  })
})

describe('AudioArchive.put — 探测真实格式', () => {
  it('用真实字节的探测结果决定扩展名和入库 format，不信任声明的 r.format', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { readFileSync } = await import('node:fs')
    const execFileP = promisify(execFile)
    // 真实字节是 flac 编码，但 put() 的调用方（模拟坏 recipe）声明成 mp3。
    // 落到一个可寻址的真实文件而不是 pipe:1——FLAC muxer 要在写完后 seek 回文件头回填
    // STREAMINFO 的总采样数，写到不可寻址的 pipe 时 ffprobe 读出的 duration 是 N/A，
    // 会被 probeFormat 误判成"探测失败"而不是测的这条真实探测路径（本地 ffmpeg 6.1.1 实测）。
    const srcPath = join(dir, 'mislabeled-src.flac')
    await execFileP('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', '-c:a', 'flac', '-f', 'flac', srcPath,
    ], { maxBuffer: 10 * 1024 * 1024 })
    const chunks: Buffer[] = [readFileSync(srcPath)]

    const result = await archive.put({ platform: 'netease', id: 'mislabeled' }, {
      stream: Readable.from(chunks), format: 'mp3', title: '假装是MP3', artist: '测试',
    })

    expect(result.asset.format).toBe('flac')
    expect(result.asset.relPath.endsWith('.flac')).toBe(true)
    expect(result.asset.absPath.endsWith('.flac')).toBe(true)
  })

  it('探测失败时静默退回接口声明的 format，不阻断归档', async () => {
    // 声明是 flac，但实际字节根本不是合法音频——探测会失败，退回声明值
    const result = await archive.put({ platform: 'netease', id: 'garbage' }, {
      stream: Readable.from([Buffer.from('this is not audio at all')]), format: 'flac', title: '损坏文件', artist: '测试',
    })
    expect(result.asset.format).toBe('flac')
    expect(result.outcome).toBe('stored')
  })
})
