import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runSync } from './sync.ts'
import * as relayNotify from './relay-notify.ts'

/**
 * 扩展**不推 cookie**：登录态由后端来取（`op:'cookiePull'`）。
 * 它这一轮只做两件事——刷新范围缓存、在中继上叫一声。
 *
 * 为什么要有这组测试：这两件事都是"不做也不报错"的形状。范围缓存不刷 → 后端能取的域少一个，
 * 表现和"用户没登录"一模一样（quark.cn 就这么漏过）；通知不发 → 一切照常，只是 cookie 轮换后
 * 要一直错到下一轮采集。两个都静默。
 */
let stored: Record<string, unknown> = {}
const getAll = vi.fn(async ({ domain }: { domain: string }) => [
  { name: 'sid', value: `v-${domain}`, domain: `.${domain}`, path: '/' } as chrome.cookies.Cookie,
])

const SYNC_CONFIG = {
  configured: true,
  requiredDomains: ['quark.cn', 'xiaohongshu.com'],
}

let posted: string[] = []

beforeEach(() => {
  posted = []
  stored = { config: { baseUrl: 'http://127.0.0.1:8900', domains: ['bilibili.com'], autoSync: true } }
  getAll.mockClear()
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: stored[k] }),
        set: async (patch: Record<string, unknown>) => Object.assign(stored, patch),
      },
    },
    cookies: { getAll },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      posted.push(String(url))
      return String(url).includes('/api/ext/sync-config')
        ? new Response(JSON.stringify(SYNC_CONFIG), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 })
    }),
  )
})

const cfg = () => stored.config as Record<string, unknown>

describe('runSync — 不推，只叫一声', () => {
  it('【核心】一个 cookie 都不往网络上发', async () => {
    vi.spyOn(relayNotify, 'notifyCookiesChanged').mockReturnValue(true)
    const res = await runSync()
    expect(res.reason).toBe('nudged')
    // 唯一该打的只有 sync-config（读范围），一条 cookie 都不上网络
    expect(posted.filter((u) => !u.includes('/api/ext/sync-config'))).toEqual([])
  })

  it('叫的那一声带上浏览器里真有 cookie 的域', async () => {
    const spy = vi.spyOn(relayNotify, 'notifyCookiesChanged').mockReturnValue(true)
    await runSync()
    expect(spy.mock.calls[0][0].sort()).toEqual(['bilibili.com', 'quark.cn', 'xiaohongshu.com'])
  })

  it('中继没连 → relay_down，不是错误（后端连上时会自己拉一次全量）', async () => {
    vi.spyOn(relayNotify, 'notifyCookiesChanged').mockReturnValue(false)
    const res = await runSync()
    expect(res.reason).toBe('relay_down')
    // 没叫动就不该记 lastSync —— 否则 popup 上显示"刚同步过"，而其实什么都没发生
    expect(cfg().lastSync).toBeUndefined()
  })

  it('【核心】范围缓存要落盘 —— 它是 cookiePull 的闸门，陈旧就等于后端少一个域', async () => {
    vi.spyOn(relayNotify, 'notifyCookiesChanged').mockReturnValue(true)
    await runSync()
    expect(cfg().requiredDomains).toEqual(['quark.cn', 'xiaohongshu.com'])
  })

  it('一个域都没有时也要先把范围落盘，再早退', async () => {
    // 用户没填域、Stream 也还没装任何要登录的源 —— 但下一次 Stream 装了，缓存必须已经是新的
    stored = { config: { baseUrl: 'http://127.0.0.1:8900', domains: [], autoSync: true } }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ configured: true, requiredDomains: [] }), { status: 200 })),
    )
    const res = await runSync()
    expect(res.reason).toBe('no_domains')
    expect(cfg().requiredDomains).toEqual([])
  })
})
