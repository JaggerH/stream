// src/http/track-resolve.test.ts
//
// `/api/media/tracks/resolve` 这条**统一漏斗**的行为闸门：四档的顺序、每档的响应形状、
// 以及记进 DebugBox（`audio` 频道）的那条 entry 的字段取值。
//
// 为什么单独一份：这是播放路径——`<audio>` 每次播放都打它，播放器因此不必知道这条是免费还是
// 付费、在本地还是在网盘。转写也复用同一个判据（`resolveTrackSource`），所以这四档的顺序一旦
// 悄悄变了，坏的是两个消费方，而且都**不会报错**——只是本地已下好的文件又跑去 CDN 拉、或者
// 官方源够不着变成一句「没有可转写的东西」。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHttpApp } from './app.ts'
import { SlotBrokenError } from '../providers/bindings.ts'
import { rejectionCooldown, hostStats, setServingPolicySource } from '../media/serving.ts'
import type { DebugEntry } from './debug-log.ts'

let dir: string
let entries: DebugEntry[]

/** 造一个 InvokeResult（sequential 行）——路由只读 strategy/value/via/timings/misses。 */
function invokeResult(value: unknown, opts: { via?: string; misses?: Array<{ member: string; reason: string; stack?: string }> } = {}) {
  return {
    strategy: 'sequential' as const,
    value,
    via: opts.via ?? 'src:catalog',
    timings: [{ member: 'src:catalog', source: 'src:catalog', ms: 3, outcome: value ? ('win' as const) : ('miss' as const) }],
    misses: opts.misses ?? (value ? [] : [{ member: 'src:catalog', reason: 'no result' }]),
  }
}

function makeApp(over: Record<string, unknown> = {}) {
  return createHttpApp({
    debug: { record: (e: DebugEntry) => entries.push(e), recent: () => [], clear: () => {} },
    ...over,
  } as never)
}

const field = (e: DebugEntry, label: string) => (e.fields ?? []).find((f) => f.label === label)?.value

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trackresolve-'))
  entries = []
  rejectionCooldown.clear()
  hostStats.clear()
})
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

describe('GET /api/media/tracks/resolve — 入参与不可用', () => {
  it('缺 platform → 400', async () => {
    const res = await makeApp().request('/api/media/tracks/resolve')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'platform required' })
  })

  it('没有 providers → 503 unavailable（archive/netdisk 两档都没命中时）', async () => {
    const res = await makeApp().request('/api/media/tracks/resolve?platform=netease&id=1')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: { code: 'unavailable', message: 'providers not configured' } })
    expect(entries).toHaveLength(0) // 早退不记 debug
  })

  it('有 providers 但缺 id → 404 song id required', async () => {
    const app = makeApp({ providers: { executor: { invoke: vi.fn() } } })
    const res = await app.request('/api/media/tracks/resolve?platform=netease')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'unresolved', detail: 'song id required' })
    expect(entries).toHaveLength(0)
  })

  it('槽位废 → 422 slot_broken', async () => {
    const app = makeApp({
      providers: { executor: { invoke: vi.fn() } },
      providerBindings: { dispatch: () => { throw new SlotBrokenError('c1', 'music.track.resolve', ['p']) } },
    })
    const res = await app.request('/api/media/tracks/resolve?platform=netease&id=1')
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe('slot_broken')
  })
})

describe('第 1 档 本地归档', () => {
  it('归档命中 → 302 到本地 assets 路由，且 debug 记 archive', async () => {
    const abs = join(dir, 'song.flac')
    writeFileSync(abs, 'z')
    const app = makeApp({
      audioArchive: { lookup: () => ({ assetId: 42, absPath: abs, format: 'flac', qualityTier: 4 }) },
      providers: { executor: { invoke: vi.fn() } },
    })
    const res = await app.request('/api/media/tracks/resolve?platform=netease&id=1')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/api/media/assets/42/file')
    expect(entries).toHaveLength(1)
    expect(entries[0].channel).toBe('audio-resolve')
    expect(entries[0].key).toBe('netease:1')
    expect(field(entries[0], '方式')).toBe('archive')
    expect(field(entries[0], '本地归档')).toBe('命中')
    expect(field(entries[0], '音质')).toContain('FLAC')
  })

  it('有归档记录但文件没了 → 继续往下走，probe 留在 entry 上', async () => {
    const app = makeApp({
      audioArchive: { lookup: () => ({ assetId: 42, absPath: join(dir, 'gone.flac'), format: 'flac', qualityTier: 4 }) },
      providers: { executor: { invoke: async () => invokeResult([{ enclosure_url: 'https://cdn.test/a.mp3' }]) } },
    })
    const res = await app.request('/api/media/tracks/resolve?platform=netease&id=1')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://cdn.test/a.mp3')
    expect(field(entries[0], '本地归档')).toBe('有记录但文件缺失 → 走在线')
  })
})

describe('第 2 档 网盘绑定', () => {
  const hit = { setId: 7, dirPath: '/quark/pod', rightFile: 'e1.mp3' }

  it('绑定命中 → 302 AList 直链，debug via=alist', async () => {
    const app = makeApp({
      netdisk: { lookup: (k: string) => (k === 'lizhi:900' ? hit : undefined), resolveUrl: async () => 'https://alist.test/raw/e1.mp3', markError: vi.fn() },
      providers: { executor: { invoke: vi.fn() } },
    })
    const res = await app.request('/api/media/tracks/resolve?platform=lizhi&id=900')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://alist.test/raw/e1.mp3')
    expect(field(entries[0], '来源')).toBe('alist')
    expect(field(entries[0], '方式')).toBe('redirect')
    expect(field(entries[0], 'CDN')).toBe('alist.test')
  })

  it('绑定在但 resolveUrl 抛 → markError 后静默回落官方梯子', async () => {
    const markError = vi.fn()
    const app = makeApp({
      netdisk: { lookup: () => hit, resolveUrl: async () => { throw new Error('object not found') }, markError },
      providers: { executor: { invoke: async () => invokeResult([{ enclosure_url: 'https://cdn.test/a.mp3' }]) } },
    })
    const res = await app.request('/api/media/tracks/resolve?platform=lizhi&id=900')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://cdn.test/a.mp3')
    expect(markError).toHaveBeenCalledWith(hit, 'object not found')
  })

  it('归档档在网盘档之前：两档都命中时走归档', async () => {
    const abs = join(dir, 'song.mp3')
    writeFileSync(abs, 'z')
    const app = makeApp({
      audioArchive: { lookup: () => ({ assetId: 5, absPath: abs, format: 'mp3', qualityTier: 1 }) },
      netdisk: { lookup: () => hit, resolveUrl: async () => 'https://alist.test/raw/e1.mp3', markError: vi.fn() },
      providers: { executor: { invoke: vi.fn() } },
    })
    const res = await app.request('/api/media/tracks/resolve?platform=lizhi&id=900')
    expect(res.headers.get('location')).toBe('/api/media/assets/5/file')
  })
})

describe('第 3 档 官方 provider 梯子', () => {
  it('enclosure_url（无 headers）→ 302 直发', async () => {
    const invoke = vi.fn(async () => invokeResult([{ enclosure_url: 'https://cdn.test/song.mp3', br: 320000 }], { via: 'netease-track' }))
    const app = makeApp({ providers: { executor: { invoke } } })
    const res = await app.request('/api/media/tracks/resolve?platform=netease&id=2')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://cdn.test/song.mp3')
    expect(field(entries[0], '来源')).toBe('netease-track')
    expect(field(entries[0], '音质')).toContain('320kbps')
  })

  it('url + headers → 代理透传（Range 原样带上）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('audio-bytes', {
      status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-10/11' },
    }))
    const app = makeApp({
      providers: { executor: { invoke: async () => invokeResult([{ url: 'https://provider.test/s.mp3', headers: { Referer: 'https://provider.test/' } }]) } },
    })
    const res = await app.request('/api/media/tracks/resolve?platform=netease&id=2', { headers: { Range: 'bytes=0-10' } })
    expect(res.status).toBe(206)
    expect(await res.text()).toBe('audio-bytes')
    expect(fetchSpy).toHaveBeenCalledWith('https://provider.test/s.mp3', {
      headers: { Referer: 'https://provider.test/', Range: 'bytes=0-10' },
    })
    expect(field(entries[0], '方式')).toBe('proxy')
  })

  it('quality 缺省/auto 不覆盖档位，给具体值才 overrides.level', async () => {
    const invoke = vi.fn(async () => invokeResult([{ enclosure_url: 'https://cdn.test/s.mp3' }]))
    const app = makeApp({ providers: { executor: { invoke } } })
    await app.request('/api/media/tracks/resolve?platform=netease&id=2')
    expect(invoke).toHaveBeenLastCalledWith({ category: 'resolve', key: 'netease' }, '2', undefined)
    await app.request('/api/media/tracks/resolve?platform=netease&id=2&quality=auto')
    expect(invoke).toHaveBeenLastCalledWith({ category: 'resolve', key: 'netease' }, '2', undefined)
    await app.request('/api/media/tracks/resolve?platform=netease&id=2&quality=lossless')
    expect(invoke).toHaveBeenLastCalledWith({ category: 'resolve', key: 'netease' }, '2', { overrides: { level: 'lossless' } })
  })

  it('绑定的 Provider（dispatch 按平台键挑行）优先于裸 platform 键', async () => {
    const invoke = vi.fn(async () => invokeResult([{ enclosure_url: 'https://cdn.test/s.mp3' }]))
    const app = makeApp({
      providers: { executor: { invoke } },
      providerBindings: { dispatch: () => 'bound-provider' },
    })
    await app.request('/api/media/tracks/resolve?platform=netease&id=2')
    expect(invoke).toHaveBeenLastCalledWith('bound-provider', '2', undefined)
  })
})

describe('第 4 档 回落原始直链 / 全无', () => {
  // 策略表来自包声明（spec 2026-09-18），测试自己注入它假定的那条。
  beforeAll(() => setServingPolicySource(() => [{
    match: '.lizhi.fm', label: '荔枝 FM',
    hosts: ['cdn101.lizhi.fm', 'cdn102.lizhi.fm', 'cdn.gzlzfm.com', 'cdn101.gzlzfm.com'],
  }]))
  afterAll(() => setServingPolicySource(() => []))

  it('梯子无结果 + fallback 未命中服务策略 → 302 原样', async () => {
    const app = makeApp({ providers: { executor: { invoke: async () => invokeResult(null) } } })
    const res = await app.request('/api/media/tracks/resolve?platform=lizhi&id=9&fallback=' + encodeURIComponent('https://plain.example/a.mp3'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://plain.example/a.mp3')
    expect(field(entries[0], '来源')).toBe('fallback')
    expect(field(entries[0], '方式')).toBe('redirect')
  })

  it('梯子无结果 + fallback 命中服务策略 → 后端代理（换主机、Range 透传）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bytes', {
      status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-4/5' },
    }))
    const app = makeApp({ providers: { executor: { invoke: async () => invokeResult(null) } } })
    const url = 'http://cdn5.lizhi.fm/audio/2026/a_hd.mp3'
    const res = await app.request('/api/media/tracks/resolve?platform=lizhi&id=9&fallback=' + encodeURIComponent(url), { headers: { Range: 'bytes=0-4' } })
    expect(res.status).toBe(206)
    expect(await res.text()).toBe('bytes')
    // 策略表接管送法：打的是候选主机之一,而且带着原样的 Range
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toContain('/audio/2026/a_hd.mp3')
    expect((init.headers as Record<string, string>).Range).toBe('bytes=0-4')
    expect(field(entries[0], '方式')).toBe('proxy')
  })

  it('梯子无结果且没有 fallback → 404 unresolved，detail 是各档的 miss 原因', async () => {
    const app = makeApp({
      providers: { executor: { invoke: async () => invokeResult(null, { misses: [{ member: 'src:a', reason: 'declined' }] }) } },
    })
    const res = await app.request('/api/media/tracks/resolve?platform=netease&id=9')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'unresolved', detail: 'src:a: declined' })
    expect(field(entries[0], '方式')).toBe('unresolved')
  })
})
