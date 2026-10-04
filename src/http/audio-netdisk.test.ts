// src/http/audio-netdisk.test.ts — 网盘直链档插在 archive 之后、官方源之前
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AudioArchive } from '../audio/archive.ts'
import type { AudioResolver } from '../audio/index.ts'
import type { TrackRef } from '../audio/resolver.ts'
import { createHttpApp } from './app.ts'
import { UserStore } from '../store/user-store.ts'
import { Registry } from '../registry/registry.ts'
import { ProviderStatsStore } from '../providers/stats-store.ts'
import { ProviderExecutor } from '../providers/executor.ts'
import { ProviderBindings } from '../providers/bindings.ts'
import { ProviderDirectory } from '../providers/directory.ts'
import { SYSTEM_IDENTITIES } from '../providers/system/index.ts'
import { rejectionCooldown, setServingPolicySource } from '../media/serving.ts'

function makeProviders(dir: string, play: AudioResolver[]) {
  const store = new UserStore(join(dir, `prov-${Math.random()}.db`))
  const stats = new ProviderStatsStore(join(dir, `stats-${Math.random()}.db`))
  const attempts = new Map<string, (input: unknown) => Promise<unknown[]>>()
  for (const r of play) {
    attempts.set(`src:${r.name}`, async (input) => {
      const ref = { platform: 'netease', id: String(input) } as TrackRef
      if (!r.supports(ref)) return []
      const v = await r.resolve(ref)
      return v == null ? [] : [v]
    })
  }
  store.putProvider({
    id: 'netease-track', label: '', description: '', category: 'resolve', serves: ['netease', 'netease-track'],
    strategy: 'sequential', members: play.map((r) => ({ source: `src:${r.name}` })),
    contract: null, options: {},
  })
  const executor = new ProviderExecutor({
    directory: new ProviderDirectory(store, SYSTEM_IDENTITIES), registry: new Registry([]), stats,
    fetchSource: async (sourceId, input) => {
      const attempt = attempts.get(sourceId)
      if (!attempt) throw new Error(`no source ${sourceId}`)
      return attempt(input)
    },
  })
  return { executor, stats, store }
}

const catalogResolver: AudioResolver = {
  name: 'catalog',
  supports: () => true,
  resolve: async () => ({ enclosure_url: 'https://cdn.test/official.mp3' } as unknown as { url: string }),
}

let dir: string, archive: AudioArchive
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'netdisk-http-'))
  archive = new AudioArchive(join(dir, 'a.db'), join(dir, 'files'))
})
afterEach(() => {
  vi.restoreAllMocks()
  archive.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('audio resolve — netdisk direct-link slot', () => {
  it('hit → 302 to alist raw_url, official provider not invoked', async () => {
    const providers = makeProviders(dir, [catalogResolver])
    const invokeSpy = vi.spyOn(providers.executor, 'invoke')
    const netdisk = {
      lookup: vi.fn(() => ({ setId: 'map_x', dirPath: '/d', rightFile: '01.m4a' })),
      resolveUrl: vi.fn(async () => 'https://alist.test/raw/01.m4a'),
      markError: vi.fn(),
    }
    const app = createHttpApp({
      itemStore: { get: () => undefined, recent: () => [] },
      audioArchive: archive,
      providers,
      netdisk,
    } as any)
    const res = await app.request('/api/media/tracks/resolve?platform=netease&id=1')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://alist.test/raw/01.m4a')
    expect(netdisk.lookup).toHaveBeenCalledWith('netease:1')
    expect(invokeSpy).not.toHaveBeenCalled()
  })

  it('direct-link failure → markError + falls back to official provider', async () => {
    const providers = makeProviders(dir, [catalogResolver])
    const netdisk = {
      lookup: vi.fn(() => ({ setId: 'map_x', dirPath: '/d', rightFile: '01.m4a' })),
      resolveUrl: vi.fn(async () => { throw new Error('alist down') }),
      markError: vi.fn(),
    }
    const app = createHttpApp({
      itemStore: { get: () => undefined, recent: () => [] },
      audioArchive: archive,
      providers,
      netdisk,
    } as any)
    const res = await app.request('/api/media/tracks/resolve?platform=netease&id=2')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://cdn.test/official.mp3')
    expect(netdisk.markError).toHaveBeenCalledTimes(1)
    expect(netdisk.markError.mock.calls[0][1]).toContain('alist down')
  })

  it('no hit → behaves exactly as before (official provider)', async () => {
    const providers = makeProviders(dir, [catalogResolver])
    const netdisk = {
      lookup: vi.fn(() => undefined),
      resolveUrl: vi.fn(),
      markError: vi.fn(),
    }
    const app = createHttpApp({
      itemStore: { get: () => undefined, recent: () => [] },
      audioArchive: archive,
      providers,
      netdisk,
    } as any)
    const res = await app.request('/api/media/tracks/resolve?platform=netease&id=3')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://cdn.test/official.mp3')
    expect(netdisk.resolveUrl).not.toHaveBeenCalled()
  })

  it('no netdisk deps → unchanged official path', async () => {
    const providers = makeProviders(dir, [catalogResolver])
    const app = createHttpApp({
      itemStore: { get: () => undefined, recent: () => [] },
      audioArchive: archive,
      providers,
    } as any)
    const res = await app.request('/api/media/tracks/resolve?platform=netease&id=4')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://cdn.test/official.mp3')
  })
})

// 播放解析按 platform 选 resolve Provider（serves 分发），无 provider 认领 → 回落 normalizer
// 带来的原始直链（fallback 参数）。这条对任何平台通用，不写死平台名。
describe('audio resolve — platform-generalized dispatch + fallback', () => {
  it('fallback host 不在服务策略表里 → 保持 302 直发（既有行为，一字不改）', async () => {
    const providers = makeProviders(dir, [catalogResolver]) // provider only serves netease
    const netdisk = { lookup: vi.fn(() => undefined), resolveUrl: vi.fn(), markError: vi.fn() }
    const app = createHttpApp({
      itemStore: { get: () => undefined, recent: () => [] }, audioArchive: archive, providers, netdisk,
    } as any)
    const fb = 'https://cdn.xiaoyuzhoufm.com/9.m4a'
    const res = await app.request(`/api/media/tracks/resolve?platform=xiaoyuzhou&id=9&fallback=${encodeURIComponent(fb)}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(fb)
  })

  it('podcast platform, no provider and no fallback → 404 unresolved', async () => {
    const providers = makeProviders(dir, [catalogResolver])
    const app = createHttpApp({
      itemStore: { get: () => undefined, recent: () => [] }, audioArchive: archive, providers,
    } as any)
    const res = await app.request('/api/media/tracks/resolve?platform=lizhi&id=9')
    expect(res.status).toBe(404)
  })

  it('netdisk hit wins for a podcast platform too (lookup is platform-agnostic)', async () => {
    const providers = makeProviders(dir, [catalogResolver])
    const netdisk = {
      lookup: vi.fn(() => ({ setId: 'm', dirPath: '/d', rightFile: 'x.mp3' })),
      resolveUrl: vi.fn(async () => 'https://alist.test/raw/x.mp3'),
      markError: vi.fn(),
    }
    const app = createHttpApp({
      itemStore: { get: () => undefined, recent: () => [] }, audioArchive: archive, providers, netdisk,
    } as any)
    const res = await app.request(`/api/media/tracks/resolve?platform=lizhi&id=2984&fallback=${encodeURIComponent('http://cdn/x.mp3')}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://alist.test/raw/x.mp3')
    expect(netdisk.lookup).toHaveBeenCalledWith('lizhi:2984')
  })
})

// 命中服务策略表的回落直链改走后端代理——为的是「上游拒绝」这件事看得见，不是为了加速。
// Range 原样透传：懒加载仍然由浏览器做（实测它做得很好，见 spec §1.1）。
describe('audio resolve — fallback 档的服务策略（代理 + 拒绝可见 + 冷却）', () => {
  const FB = 'http://cdn5.lizhi.fm/audio/9_hd.mp3'
  const mkApp = () => {
    const providers = makeProviders(dir, [catalogResolver]) // 只服务 netease → lizhi 必然落到回落档
    const netdisk = { lookup: vi.fn(() => undefined), resolveUrl: vi.fn(), markError: vi.fn() }
    return createHttpApp({
      itemStore: { get: () => undefined, recent: () => [] }, audioArchive: archive, providers, netdisk,
    } as any)
  }
  const ask = (app: ReturnType<typeof createHttpApp>, id: string, init?: RequestInit) =>
    app.request(`/api/media/tracks/resolve?platform=lizhi&id=${id}&fallback=${encodeURIComponent(FB)}`, init)

  // 策略表来自包声明（spec 2026-09-18），测试自己注入它假定的那条。
  beforeAll(() => setServingPolicySource(() => [{
    match: '.lizhi.fm', label: '荔枝 FM',
    hosts: ['cdn101.lizhi.fm', 'cdn102.lizhi.fm', 'cdn.gzlzfm.com', 'cdn101.gzlzfm.com'],
  }]))
  afterAll(() => setServingPolicySource(() => []))

  beforeEach(() => rejectionCooldown.clear())

  it('上游放行 → 字节透传,Range 原样带给上游（懒加载不受影响）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('mp3-bytes', { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-8/88095638' } }),
    )
    const res = await ask(mkApp(), '9', { headers: { Range: 'bytes=0-8' } })
    expect(res.status).toBe(206)
    expect(await res.text()).toBe('mp3-bytes')
    expect(res.headers.get('content-range')).toBe('bytes 0-8/88095638')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(FB)
    expect((init.headers as Record<string, string>).Range).toBe('bytes=0-8')
  })

  it('上游拒绝 → 502 + 说人话的 detail(不再静默转圈)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>ERROR: ACCESS DENIED</html>', { status: 403, headers: { 'content-type': 'text/html' } }),
    )
    const res = await ask(mkApp(), '9')
    expect(res.status).toBe(502)
    const body = await res.json() as { error: string; detail: string }
    expect(body.error).toBe('upstream_rejected')
    expect(body.detail).toContain('荔枝 FM')
    expect(body.detail).toContain('403')
  })

  it('拒绝之后的冷却窗口内不再打上游——失败恰恰是请求最容易翻倍的时刻', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 403 }))
    const app = mkApp()
    expect((await ask(app, '9')).status).toBe(502)
    // 第一轮会把候选主机挨个试一遍（serving.ts 的 hosts），次数不是判据——**增量**才是。
    const afterFirstRound = fetchSpy.mock.calls.length
    expect(afterFirstRound).toBeGreaterThan(0)
    const again = await ask(app, '9')                 // 前端 reportPlayFailure 的诊断二次拉取
    expect(again.status).toBe(502)
    expect((await again.json() as { detail: string }).detail).toContain('403')
    expect(fetchSpy.mock.calls.length).toBe(afterFirstRound)  // ← 一发都没再出去
  })

  it('冷却只认那一条 url,别的集照常去打上游', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 403 }))
    const app = mkApp()
    await ask(app, '9')
    const afterFirst = fetchSpy.mock.calls.length
    const other = 'http://cdn5.lizhi.fm/audio/10_hd.mp3'
    await app.request(`/api/media/tracks/resolve?platform=lizhi&id=10&fallback=${encodeURIComponent(other)}`)
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(afterFirst) // 换一条 url 就该重新去试
  })

  it('上游连不上（抛错）→ 也归到 502,不是 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'))
    const res = await ask(mkApp(), '9')
    expect(res.status).toBe(502)
    expect((await res.json() as { error: string }).error).toBe('upstream_rejected')
  })
})

// 用户给「音乐取流」这个调用点绑了一个 Provider（活体是 netease-track），而绑定本身与 platform 无关：
// 播一集播客也照样把网易云那条下载梯子整条跑一遍，declined 之后才回落（实测每次固定烧 ~6.8s）。
// 闸门：绑定行的 serves 不覆盖当前 platform 就当没绑，回落到按 platform 分发。
describe('audio resolve — 绑定的 Provider 必须 serves 覆盖当前 platform', () => {
  const mkBound = () => {
    const resolve = vi.fn(async () => ({ enclosure_url: 'https://cdn.test/official.mp3' } as unknown as { url: string }))
    const providers = makeProviders(dir, [{ name: 'catalog', supports: () => true, resolve }])
    const bindings = new ProviderBindings(providers.store, new ProviderDirectory(providers.store, SYSTEM_IDENTITIES))   // serves: ['netease','netease-track']
    bindings.put('music.track.resolve', ['netease-track'])
    const app = createHttpApp({
      itemStore: { get: () => undefined, recent: () => [] },
      audioArchive: archive, providers, providerBindings: bindings,
    } as any)
    return { app, resolve, store: providers.store, bindings }
  }

  it('播客 platform：绑定行不服务它 → 那条梯子一步都不跑,直接回落 fallback', async () => {
    const { app, resolve } = mkBound()
    const fb = 'https://cdn.xiaoyuzhoufm.com/a.m4a'
    const res = await app.request(`/api/media/tracks/resolve?platform=xiaoyuzhou&id=1&fallback=${encodeURIComponent(fb)}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(fb)
    expect(resolve).not.toHaveBeenCalled()
  })

  it("platform='netease'：serves 覆盖得到 → 仍然用绑定的那个 Provider（回归保护）", async () => {
    const { app, resolve } = mkBound()
    const fb = 'https://cdn.xiaoyuzhoufm.com/a.m4a'
    const res = await app.request(`/api/media/tracks/resolve?platform=netease&id=1&fallback=${encodeURIComponent(fb)}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://cdn.test/official.mp3')
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('频道槽位填了、槽里的行全 parked → 仍然 422 slot_broken（§5.1 不被闸门削弱,也不吃 fallback）', async () => {
    const { app, store } = mkBound()
    store.putProvider({
      id: 'track-parked', label: '', description: '', category: 'resolve', serves: ['xiaoyuzhou'],
      strategy: 'sequential', members: [], contract: null, options: { parked: true },
    } as any)
    store.putChannel({
      id: 'c-pod', label: '', present: 'audio', stream_ids: [],
      options: { slots: { 'music.track.resolve': ['track-parked'] } },
    } as any)
    const fb = 'https://cdn.xiaoyuzhoufm.com/a.m4a'
    const res = await app.request(`/api/media/tracks/resolve?platform=xiaoyuzhou&id=1&channelId=c-pod&fallback=${encodeURIComponent(fb)}`)
    expect(res.status).toBe(422)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('slot_broken')
  })
})
