// GET /api/browser-capability —— 采集能力快判（spec §5）。
// 语义是「现在能不能用 + 以前装过没」，**不是**健康判定：扩展没连（MV3 的 SW 被回收）是常态，
// 不该往 sourceHealth 里写任何东西，也不该在这个端点里去探测/等待/唤醒什么。

import { describe, it, expect } from 'vitest'
import { createHttpApp } from './app.ts'
import { summarizeCapability } from '../browser/capability-store.ts'

const stubs = {
  service: { streamsResource: () => [] },
  itemStore: { get: () => undefined },
  health: async () => ({ cookies: { domains: [], updatedAt: null }, manifests: 0, streams: 0 }),
} as never

function appWith(dep: unknown) {
  return createHttpApp({ ...(stubs as object), browserCapability: dep } as never)
}

describe('GET /api/browser-capability', () => {
  it('连着 → state:ready，带上扩展自报的版本/浏览器/平台', async () => {
    const app = appWith(() =>
      summarizeCapability(
        { connected: true, since: '2026-07-29T11:00:00.000Z' },
        { everSeen: true, lastSeenAt: '2026-07-29T10:00:00.000Z', extVersion: '0.4.1', browser: 'Chrome/131', platform: 'win' },
      ),
    )
    const res = await app.request('/api/browser-capability')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      state: 'ready',
      connected: true,
      since: '2026-07-29T11:00:00.000Z',
      everSeen: true,
      lastSeenAt: '2026-07-29T10:00:00.000Z',
      extVersion: '0.4.1',
      browser: 'Chrome/131',
      platform: 'win',
    })
  })

  it('没连但连过 → state:disconnected（"扩展掉线了"，不是"没装"）', async () => {
    const app = appWith(() =>
      summarizeCapability({ connected: false, since: null }, { everSeen: true, lastSeenAt: '2026-07-29T10:00:00.000Z' }),
    )
    const body = await (await app.request('/api/browser-capability')).json() as Record<string, unknown>
    expect(body.state).toBe('disconnected')
    expect(body.everSeen).toBe(true)
    expect(body.lastSeenAt).toBe('2026-07-29T10:00:00.000Z')
  })

  it('从没连上过 → state:never-seen（装 Chrome + 装扩展是同一套引导）', async () => {
    const app = appWith(() => summarizeCapability({ connected: false, since: null }, { everSeen: false }))
    const body = await (await app.request('/api/browser-capability')).json() as Record<string, unknown>
    expect(body.state).toBe('never-seen')
    expect(body.everSeen).toBe(false)
  })

  it('扩展未连时也秒回 —— 不阻塞、不探测（dep 只被同步调用一次）', async () => {
    let calls = 0
    const app = appWith(() => {
      calls++
      return summarizeCapability({ connected: false, since: null }, { everSeen: true })
    })
    const started = Date.now()
    const res = await app.request('/api/browser-capability')
    expect(res.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(100)
    expect(calls).toBe(1)
  })

  it('配了 api_token 也不要求凭证 —— 装机引导要在拿到凭证之前就能读', async () => {
    const app = createHttpApp({
      ...(stubs as object),
      token: 'secret-token',
      browserCapability: () => summarizeCapability({ connected: false, since: null }, { everSeen: false }),
    } as never)
    const res = await app.request('/api/browser-capability')
    expect(res.status).toBe(200)
  })

  it('后端根本没接 relay（dep 缺失）→ 404，别伪装成「从没装过」', async () => {
    const res = await createHttpApp(stubs).request('/api/browser-capability')
    expect(res.status).toBe(404)
  })

  it('没接 Chrome 发现（dep 缺失）→ 诊断端点 404，不半残着回一半', async () => {
    const app = appWith(() => summarizeCapability({ connected: false, since: null }, { everSeen: false }))
    const res = await app.request('/api/browser-capability/diagnose', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

const WIN = { exe: '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe', side: 'windows', source: 'standard' } as const
const LINUX = { exe: '/usr/bin/google-chrome', side: 'linux', source: 'path' } as const

function appWithChrome(status: unknown, select?: (exe: string) => Promise<unknown>) {
  return createHttpApp({
    ...(stubs as object),
    browserCapability: () => summarizeCapability({ connected: false, since: null }, { everSeen: false }),
    harvestBrowser: { status: async () => status, select: select ?? (async () => status) },
  } as never)
}

describe('POST /api/browser-capability/diagnose', () => {
  it('= 快判 + chrome 候选块（不另造形状）', async () => {
    const app = appWithChrome({ selected: null, origin: null, candidates: [WIN, LINUX], mustChoose: true })
    const res = await app.request('/api/browser-capability/diagnose', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.state).toBe('never-seen') // 快判那几个字段原样在
    expect(body.chrome).toEqual({ selected: null, origin: null, candidates: [WIN, LINUX], mustChoose: true })
  })
})

describe('/api/settings/harvest-browser', () => {
  it('GET 列候选 + 当前选择 + 要不要问用户', async () => {
    const app = appWithChrome({ selected: null, origin: null, candidates: [WIN, LINUX], mustChoose: true })
    const body = (await (await app.request('/api/settings/harvest-browser')).json()) as Record<string, unknown>
    expect(body.mustChoose).toBe(true)
    expect(body.candidates).toEqual([WIN, LINUX])
  })

  it('PUT 存用户的选择', async () => {
    let got = ''
    const app = appWithChrome({ selected: WIN.exe, origin: 'settings', candidates: [WIN, LINUX], mustChoose: false }, async (exe) => {
      got = exe
      return { selected: exe, origin: 'settings', candidates: [WIN, LINUX], mustChoose: false }
    })
    const res = await app.request('/api/settings/harvest-browser', {
      method: 'PUT',
      body: JSON.stringify({ exe: WIN.exe }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(got).toBe(WIN.exe)
  })

  it('路径不存在 → 400 当场说不行（静默存下错路径的症状是几小时后某轮采集唤不起浏览器）', async () => {
    const app = appWithChrome({}, async () => {
      throw new Error('no such executable: /nope/chrome')
    })
    const res = await app.request('/api/settings/harvest-browser', {
      method: 'PUT',
      body: JSON.stringify({ exe: '/nope/chrome' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('no such executable')
  })

  it('exe 缺失 → 400', async () => {
    const app = appWithChrome({})
    const res = await app.request('/api/settings/harvest-browser', { method: 'PUT', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(400)
  })
})
