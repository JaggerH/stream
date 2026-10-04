// 从 app.test.ts 拆出(2026-07-22):按路由域分文件,理由见 __fixtures__/app-harness.ts 头注。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHttpApp, type HealthInfo } from './app.ts'
import { Registry } from '../registry/registry.ts'
import { UserStore } from '../store/user-store.ts'
import { ProviderStatsStore } from '../providers/stats-store.ts'
import { ContentUnavailableError } from '../providers/unavailable.ts'
import { ProviderExecutor, sourceOf } from '../providers/executor.ts'
import { ProviderDirectory } from '../providers/directory.ts'
import { allIdentities, setPackageIdentities } from '../providers/identities.ts'
import { ensureSystemRows } from '../providers/seed.ts'
import { fake, health, manifests } from './__fixtures__/app-harness.ts'
import { isAllowedSegHost, segHeadersFor } from '../video/dash.ts'

// Task 6: playback routes resolve through the per-platform video-* Provider rows
// (serves-key dispatch), then the route only streams. Real executor + stubbed fetchSource
// exercises the true match('resolve', `${platform}-video`) path end-to-end.
/** B 站那条播放解析行是**包声明**的（`packages/bilibili/package.json#stream.providers`），宿主静态表里
 *  没有它。这里照原样挂一份，好让 `bilibili-video` 这个 serves-key 有行可派——成员经裸名补全成
 *  `@streamapp/bilibili/bilibili-resolve`，下面各条都按这个全名认。 */
const BILI_ROW = {
  facility: 'bilibili',
  packageName: '@streamapp/bilibili',
  declaration: {
    id: 'video-bilibili', category: 'resolve' as const, serveKeys: ['bilibili-video'],
    strategy: 'sequential' as const, label: 'bilibili 视频解析', description: 'd',
    members: [{ source: 'bilibili-resolve' }], callsites: ['video.resolve'],
  },
}
const BILI_SRC = '@streamapp/bilibili/bilibili-resolve'
/** 抖音那条同样是包声明的（`packages/Douyin_TikTok_Download_API/package.json#stream.providers`），
 *  宿主静态表里没有任何平台行。 */
const DOUYIN_ROW = {
  facility: 'Douyin_TikTok_Download_API',
  packageName: '@streamapp/douyin-tiktok-download-api',
  declaration: {
    id: 'video-douyin', category: 'resolve' as const, serveKeys: ['douyin-video'],
    strategy: 'sequential' as const, label: 'douyin 视频解析', description: 'd',
    members: [{ source: 'douyin-resolve' }], callsites: ['video.resolve'],
  },
}
const DOUYIN_SRC = '@streamapp/douyin-tiktok-download-api/douyin-resolve'

describe('video playback resolution → per-platform resolve providers', () => {
  let dir: string
  const health = async (): Promise<HealthInfo> => ({ cookies: { domains: [], updatedAt: null }, manifests: 0, streams: 0 })
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vid-')); setPackageIdentities([BILI_ROW, DOUYIN_ROW]) })
  afterEach(() => { setPackageIdentities([]); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

  function buildVideoApp(resolve: (sourceId: string, input: unknown) => unknown[]) {
    const channelStore = new UserStore(join(dir, `prov-${Math.random()}.db`))
    ensureSystemRows(channelStore)
    const stats = new ProviderStatsStore(join(dir, `stats-${Math.random()}.db`))
    const registry = new Registry(manifests)
    const seen: Array<{ sourceId: string; input: unknown }> = []
    const debug: Array<{ channel: string; ok: boolean; summary: string; fields: Array<{ label: string; value: string }> }> = []
    const executor = new ProviderExecutor({
      directory: new ProviderDirectory(channelStore, allIdentities()), registry, stats,
      fetchSource: async (sourceId, input) => { seen.push({ sourceId, input }); return resolve(sourceId, input) },
    })
    const app = createHttpApp({
      service: { streamsResource: () => [] }, itemStore: { get: () => undefined },
      health, providers: { executor, stats },
      debug: { record: (e: never) => debug.push(e), recent: () => [], clear: () => {} },
    } as never)
    return { app, seen, debug }
  }

  const dashManifest = {
    durationS: 5,
    video: [{ id: 80, codecs: 'avc1.640033', mimeType: 'video/mp4', bandwidth: 1000, url: 'https://primary.bilivideo.com/v.m4s', init: '0-9', indexRange: '10-20' }],
    audio: [],
  }

  it('dash：按 platform 派发到 <platform>-video 的行，回 dash+xml', async () => {
    const { app, seen } = buildVideoApp((id) => (id === BILI_SRC ? [{ kind: 'dash', manifest: dashManifest }] : []))
    const res = await app.request('/api/media/dash?platform=bilibili&vid=BV1xx')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/dash+xml')
    expect(seen).toEqual([{ sourceId: BILI_SRC, input: { vid: 'BV1xx', format: 'dash' } }])
  })

  it('dash：结果里每条流的主机（主 + 备节点）连同 manifest.headers 由路由登进信任表，seg 路由随后放行', async () => {
    // 主机名独一份：信任表是模块级单例、带 90 分钟 TTL，跨用例不清——用别处不会出现的主机避免假绿。
    const manifest = {
      durationS: 5,
      headers: { Referer: 'https://www.example-site.test', Cookie: 'SESSDATA=route-test' },
      video: [{ id: 80, codecs: 'avc1.640033', mimeType: 'video/mp4', bandwidth: 1000,
        url: 'https://route-primary.seg-trust.test/v.m4s', backupUrls: ['https://route-backup.seg-trust.test/v.m4s'], init: '0-9', indexRange: '10-20' }],
      audio: [{ id: 30280, codecs: 'mp4a.40.2', mimeType: 'audio/mp4', bandwidth: 200,
        url: 'https://route-audio.seg-trust.test/a.m4s', init: '0-5', indexRange: '6-9' }],
    }
    expect(isAllowedSegHost('https://route-primary.seg-trust.test/x.m4s')).toBe(false)
    const { app } = buildVideoApp((id) => (id === BILI_SRC ? [{ kind: 'dash', manifest }] : []))
    const res = await app.request('/api/media/dash?platform=bilibili&vid=BV1xx')
    expect(res.status).toBe(200)
    for (const u of ['https://route-primary.seg-trust.test/x.m4s', 'https://route-backup.seg-trust.test/x.m4s', 'https://route-audio.seg-trust.test/x.m4s']) {
      expect(isAllowedSegHost(u), u).toBe(true)
      expect(segHeadersFor(u)).toEqual(manifest.headers)
    }
    // 没在结果里出现过的主机仍然不放行——登记的是结果，不是「这个站点」。
    expect(isAllowedSegHost('https://route-other.seg-trust.test/x.m4s')).toBe(false)
  })

  it('dash：manifest 不带 headers → 主机照样登记、请求头为空（不是不登）', async () => {
    const manifest = { ...dashManifest, video: [{ ...dashManifest.video[0], url: 'https://route-noheaders.seg-trust.test/v.m4s' }] }
    const { app } = buildVideoApp((id) => (id === BILI_SRC ? [{ kind: 'dash', manifest }] : []))
    expect((await app.request('/api/media/dash?platform=bilibili&vid=BV1xx')).status).toBe(200)
    expect(isAllowedSegHost('https://route-noheaders.seg-trust.test/v.m4s')).toBe(true)
    expect(segHeadersFor('https://route-noheaders.seg-trust.test/v.m4s')).toEqual({})
  })

  it('dash：vid 原样递给包——宿主不改写任何 id 形状', async () => {
    const { app, seen } = buildVideoApp((id) => (id === BILI_SRC ? [{ kind: 'dash', manifest: dashManifest }] : []))
    await app.request('/api/media/dash?platform=bilibili&vid=av98765')
    expect(seen[0].input).toEqual({ vid: 'av98765', format: 'dash' })
  })

  it('play：要 progressive，带解析出的请求头 Range 代理它的字节', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('partial', { status: 206, headers: { 'content-range': 'bytes 0-4/10' } }))
    const { app, seen } = buildVideoApp((id) => (id === BILI_SRC ? [{ kind: 'progressive', url: 'https://cdn.bilivideo.com/v.mp4', headers: { Referer: 'https://www.bilibili.com' } }] : []))
    const res = await app.request('/api/media/play?platform=bilibili&vid=BV1xx', { headers: { Range: 'bytes=0-4' } })
    expect(res.status).toBe(206)
    expect(seen[0].input).toEqual({ vid: 'BV1xx', format: 'progressive' })
    const call = fetchSpy.mock.calls[0]
    expect(call[0]).toBe('https://cdn.bilivideo.com/v.mp4')
    expect((call[1] as RequestInit).headers).toMatchObject({ Referer: 'https://www.bilibili.com', Range: 'bytes=0-4' })
  })

  it('play / dash：缺 platform 或 vid → 400', async () => {
    const { app, seen } = buildVideoApp(() => [])
    for (const p of ['/api/media/play?vid=ID1', '/api/media/play?platform=somesite', '/api/media/dash?vid=ID1', '/api/media/dash?platform=somesite']) {
      expect((await app.request(p)).status, p).toBe(400)
    }
    expect(seen).toEqual([])
  })

  it('seg：主机没被任何解析器登记过 → 400（SSRF 闸门）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { app } = buildVideoApp(() => [])
    expect((await app.request('/api/media/seg?u=https%3A%2F%2Fevil.test%2Fx.m4s&m=video')).status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('老的带站名路由已经不存在（没有重定向）', async () => {
    const { app } = buildVideoApp(() => [])
    for (const p of ['/api/media/bilibili/play?bvid=BV1', '/api/media/bilibili/dash?bvid=BV1', '/api/media/bilibili/seg?u=x', '/api/media/bilibili/audio?bvid=BV1', '/api/media/douyin/video?u=x']) {
      expect((await app.request(p)).status, p).toBe(404)
    }
  })

  // 抖音和别的平台走同一条 `/api/media/play`：宿主只按 `<platform>-video` 派发、只管代理字节，
  // vid 长什么样、CDN 要什么头都是包的事（成员回的 headers 原样带到 CDN 请求上）。
  it('play?platform=douyin: dispatches to video-douyin by serves-key with { vid, format }, range-proxies with the member\'s headers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/9' } }))
    const { app, seen } = buildVideoApp((id) => (id === DOUYIN_SRC ? [{ kind: 'progressive', url: 'https://cdn.example.test/v.mp4', headers: { Referer: 'https://www.douyin.com/' } }] : []))
    const res = await app.request('/api/media/play?platform=douyin&vid=7659053070483203953', { headers: { Range: 'bytes=0-0' } })
    expect(res.status).toBe(206)
    expect(seen).toEqual([{ sourceId: DOUYIN_SRC, input: { vid: '7659053070483203953', format: 'progressive' } }])
    expect(fetchSpy.mock.calls[0][0]).toBe('https://cdn.example.test/v.mp4')
    expect((fetchSpy.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Referer: 'https://www.douyin.com/' })
  })

  it('dash: 502 when no source resolves', async () => {
    const { app } = buildVideoApp(() => [])
    expect((await app.request('/api/media/dash?platform=bilibili&vid=BV1xx')).status).toBe(502)
  })

  describe('解析为空时的回执（play / dash 同一份判据）', () => {
    // 成员抛「内容不可用」→ 404 + 站方原话。内容没了不是解析器坏了，别当 502 报成"我们这边挂了"。
    it('成员抛 ContentUnavailableError → 404 { error: "unavailable", detail }', async () => {
      const { app } = buildVideoApp((id) => {
        if (id === BILI_SRC) throw new ContentUnavailableError('稿件已失效')
        return []
      })
      for (const p of ['/api/media/play?platform=bilibili&vid=BV1xx', '/api/media/dash?platform=bilibili&vid=BV1xx']) {
        const res = await app.request(p)
        expect(res.status, p).toBe(404)
        expect(await res.json(), p).toEqual({ error: 'unavailable', detail: '稿件已失效' })
      }
    })

    it('普通 miss → 502 { error: "unresolved", detail: 第一条 miss 的 reason }', async () => {
      const { app } = buildVideoApp((id) => {
        if (id === BILI_SRC) throw new Error('upstream 500')
        return []
      })
      for (const p of ['/api/media/play?platform=bilibili&vid=BV1xx', '/api/media/dash?platform=bilibili&vid=BV1xx']) {
        const res = await app.request(p)
        expect(res.status, p).toBe(502)
        expect(await res.json(), p).toEqual({ error: 'unresolved', detail: 'upstream 500' })
      }
    })

    it('decline 也是一条 miss：502 带 declined 的 reason', async () => {
      const { app } = buildVideoApp(() => [])
      const res = await app.request('/api/media/play?platform=bilibili&vid=BV1xx')
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: 'unresolved', detail: 'declined (no result)' })
    })

    it('没有任何 miss（没有行匹配这个平台）→ 502 不带 detail', async () => {
      const { app, seen } = buildVideoApp(() => [])
      const res = await app.request('/api/media/dash?platform=nosuchsite&vid=1')
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: 'unresolved' })
      expect(seen).toEqual([])
    })
  })

  it('records a video-resolve debug entry riding the executor ladder (win → rung + ok)', async () => {
    const { app, debug } = buildVideoApp((id) => (id === BILI_SRC ? [{ kind: 'dash', manifest: dashManifest }] : []))
    await app.request('/api/media/dash?platform=bilibili&vid=BV1xx')
    expect(debug).toHaveLength(1)
    const e = debug[0]
    expect(e.channel).toBe('video-resolve')
    expect(e.ok).toBe(true)
    // the ladder surfaces as a per-member rung + a 来源 (via) field
    expect(e.fields.some((f) => f.label === BILI_SRC && /win/.test(f.value))).toBe(true)
    expect(e.fields.some((f) => f.label === '来源' && f.value === BILI_SRC)).toBe(true)
  })

  it('records a failing video-resolve entry with the decline reason (miss → not ok)', async () => {
    const { app, debug } = buildVideoApp(() => []) // every source declines
    await app.request('/api/media/play?platform=douyin&vid=1')
    const e = debug.find((d) => d.channel === 'video-resolve')!
    expect(e.ok).toBe(false)
    expect(e.summary).toMatch(/解析失败/)
    expect(e.fields.some((f) => f.label === DOUYIN_SRC && /miss/.test(f.value))).toBe(true)
  })

  // 播放器失败分类器在播放失败后会再打一次同一条 play?…&diag=1 读失败信封（ArtPlayer.tsx）——那是
  // 对刚才那次失败的复读，不记：否则同一次失败在 DebugBox 里出现两回。
  it('diag=1 的复读不记 DebugBox；同一条不带 diag 的请求记一条', async () => {
    const { app, debug } = buildVideoApp(() => [])
    const diag = await app.request('/api/media/play?platform=douyin&vid=1&diag=1')
    expect(diag.status).toBe(502) // 失败信封照旧回
    expect(debug.filter((d) => d.channel === 'video-resolve')).toHaveLength(0)
    await app.request('/api/media/play?platform=douyin&vid=1')
    expect(debug.filter((d) => d.channel === 'video-resolve')).toHaveLength(1)
  })

  it('dash: 503 without providers configured', async () => {
    const app = createHttpApp({ service: { streamsResource: () => [] }, itemStore: { get: () => undefined }, health } as never)
    expect((await app.request('/api/media/dash?platform=bilibili&vid=BV1xx')).status).toBe(503)
  })
})
