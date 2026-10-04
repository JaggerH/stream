// src/http/playlist-export.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { AudioArchive } from '../audio/archive.ts'
import { CollectionsStore } from '../collections/store.ts'
import { ItemStore } from '../item-store.ts'
import { UserStore } from '../store/user-store.ts'
import { createHttpApp } from './app.ts'

let dir: string
let archive: AudioArchive
let collections: CollectionsStore
let itemStore: ItemStore
let channelStore: UserStore
let app: any

/** 歌单当前的顺序，由测试逐条摆好——导出必须原样照抄它。 */
let liveSnapshot: { items: any[]; errors: any[] }
const track = (trackId: string, title: string) => ({
  id: `i-${trackId}`, title, author: 'A', published_at: new Date().toISOString(),
  content: { media: [{ kind: 'audio', platform: 'netease', track_id: trackId }] },
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stream-playlist-export-http-'))
  archive = new AudioArchive(join(dir, 'a.db'), join(dir, 'files'))
  collections = new CollectionsStore(join(dir, 'collections.db'))
  itemStore = new ItemStore(join(dir, 'cache.db'))
  channelStore = new UserStore(join(dir, 'stream.db'))
  liveSnapshot = { items: [], errors: [] }
  const service = { readStreamInSourceOrder: async () => liveSnapshot }
  app = createHttpApp({ itemStore, audioArchive: archive, collections, channelStore, service } as any)
})

afterEach(() => {
  archive.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('POST /api/streams/:id/playlist-export', () => {
  it('404s for an unknown stream', async () => {
    const res = await app.request('/api/streams/nope/playlist-export', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('exports archived tracks from the stream\'s items', async () => {
    channelStore.putStream({
      id: 's1', label: '民谣电台', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {},
    } as any)
    await archive.put({ platform: 'netease', id: '1' }, {
      stream: Readable.from([Buffer.from('bytes')]), format: 'flac', title: '晴天', artist: '周杰伦',
    })
    liveSnapshot.items = [track('1', '晴天')]
    const res = await app.request('/api/streams/s1/playlist-export', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ written: 1, skipped: 0, path: expect.stringContaining('民谣电台.m3u') })
  })

  /**
   * 这条是本文件的要害：**顺序照歌单，不照库**。
   *
   * 入库顺序只有在"整份一次性回填"时才碰巧等于歌单顺序；一份靠增量轮次攒起来的歌单
   * （每轮只取最新 N 条），入库顺序和歌单顺序再无关系。活体两份歌单同代码一正一反，
   * 正是这个原因。所以库里这里故意摆成**相反**的顺序——导出仍必须跟歌单走。
   */
  it('顺序照歌单本身，不照库里的入库顺序', async () => {
    channelStore.putStream({
      id: 'ord', label: '顺序', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {},
    } as any)
    for (const [id, title] of [['a', '第一首'], ['b', '第二首'], ['c', '第三首']]) {
      await archive.put({ platform: 'netease', id }, {
        stream: Readable.from([Buffer.from(`bytes-${id}`)]), format: 'mp3', bitrate: 320, title, artist: 'A',
      })
    }
    // 库里是反的
    itemStore.replaceStream('ord', [track('c', '第三首'), track('b', '第二首'), track('a', '第一首')].map(
      (t) => ({ ...t, stream_id: 'ord' }) as any), 'post', 'ord')
    // 歌单自己说的顺序
    liveSnapshot.items = [track('a', '第一首'), track('b', '第二首'), track('c', '第三首')]

    const res = await app.request('/api/streams/ord/playlist-export', { method: 'POST' })
    const body = await res.json()
    expect(body.written).toBe(3)
    const lines = readFileSync(body.path, 'utf8').split('\n').filter((l) => l.startsWith('#EXTINF'))
    expect(lines).toEqual(['#EXTINF:-1,A - 第一首', '#EXTINF:-1,A - 第二首', '#EXTINF:-1,A - 第三首'])
  })

  /** 取不到就别写。写一份顺序不对的 m3u 会当场覆盖上一份好的，而用户在播放器里看不出
   *  它是错的——静默失真比一次响亮的失败贵得多。 */
  it('歌单取不到时报错并且不写文件，不拿库里的顺序凑合', async () => {
    channelStore.putStream({
      id: 'down', label: '取不到', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {},
    } as any)
    await archive.put({ platform: 'netease', id: 'd1' }, {
      stream: Readable.from([Buffer.from('bytes')]), format: 'mp3', bitrate: 320, title: '有货', artist: 'A',
    })
    itemStore.replaceStream('down', [{ ...track('d1', '有货'), stream_id: 'down' } as any], 'post', 'down')
    liveSnapshot = { items: [], errors: [{ source: 's', category: 'network', reason: '连不上' }] }

    const res = await app.request('/api/streams/down/playlist-export', { method: 'POST' })
    expect(res.status).toBe(502)
    expect((await res.json()).error?.message).toContain('连不上')
    expect(existsSync(join(archive.info().root, 'playlists', '取不到.m3u'))).toBe(false)
  })

  it('omits `path` entirely (not path: undefined) when nothing is archived', async () => {
    channelStore.putStream({
      id: 's2', label: '空歌单', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {},
    } as any)
    liveSnapshot.items = [track('not-archived', '还没下载的歌')]
    const res = await app.request('/api/streams/s2/playlist-export', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ written: 0, skipped: 1 })
    expect('path' in body).toBe(false)
  })

  it('503s when audioArchive is not configured', async () => {
    const noArchiveApp = createHttpApp({ itemStore, collections, channelStore } as any)
    const res = await noArchiveApp.request('/api/streams/s1/playlist-export', { method: 'POST' })
    expect(res.status).toBe(503)
  })

  it('500s with a diagnostic message when the playlists dir cannot be created', async () => {
    channelStore.putStream({
      id: 's3', label: '写不进去的歌单', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {},
    } as any)
    await archive.put({ platform: 'netease', id: '3' }, {
      stream: Readable.from([Buffer.from('bytes')]), format: 'flac', title: '写盘失败', artist: '测试',
    })
    liveSnapshot.items = [track('3', '写盘失败')]
    // Put a plain FILE where the `playlists` directory needs to go, so mkdirSync throws.
    writeFileSync(join(archive.info().root, 'playlists'), 'not a directory')
    const res = await app.request('/api/streams/s3/playlist-export', { method: 'POST' })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error?.message).toBeTruthy()
  })
})

describe('POST /api/collections/:id/playlist-export', () => {
  it('404s for an unknown collection', async () => {
    const res = await app.request('/api/collections/nope/playlist-export', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('exports archived track-kind members, silently omits non-track members from the count', async () => {
    const created = collections.createCollection('audio', '深夜民谣')
    await archive.put({ platform: 'netease', id: '2' }, {
      stream: Readable.from([Buffer.from('bytes')]), format: 'mp3', title: '告白气球', artist: '周杰伦',
    })
    collections.addItem(created.id, { kind: 'track', platform: 'netease', trackId: '2' }, { title: '告白气球', artist: '周杰伦' })
    collections.addItem(created.id, { kind: 'episode', streamId: 's1', itemId: 'ep1' }, { title: '一集播客' })
    const res = await app.request(`/api/collections/${created.id}/playlist-export`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ written: 1, skipped: 0, path: expect.stringContaining('深夜民谣.m3u') })
  })
})
