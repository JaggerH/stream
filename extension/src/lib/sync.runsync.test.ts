import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runSync } from './sync.ts'
import * as relayNotify from './relay-notify.ts'

/**
 * The scope question: WHICH domains does a sync actually read out of Chrome?
 *
 * This is the bug these tests exist for — the extension used to answer it from a hardcoded list,
 * so a facility Stream needed (quark.cn) was never read, the broker answered "no cookie for
 * domain" forever, and the only visible symptom was a permanently logged-out facility.
 */

let stored: Record<string, unknown> = {}
const getAll = vi.fn(async ({ domain }: { domain: string }) => [
  { name: 'sid', value: `v-${domain}`, domain: `.${domain}`, path: '/' } as chrome.cookies.Cookie,
])

const SYNC_CONFIG = {
  configured: true,
  requiredDomains: ['quark.cn', 'xiaohongshu.com'],
}

beforeEach(() => {
  stored = { config: { baseUrl: 'http://127.0.0.1:8900', domains: ['bilibili.com'], autoSync: true } }
  getAll.mockClear()
  vi.spyOn(relayNotify, 'notifyCookiesChanged').mockReturnValue(true)
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
    vi.fn(async (url: string) =>
      String(url).includes('/api/ext/sync-config')
        ? new Response(JSON.stringify(SYNC_CONFIG), { status: 200 })
        : new Response(JSON.stringify({ action: 'done' }), { status: 200 })
    )
  )
})

describe('runSync scope', () => {
  it('reads the union of user domains and the domains Stream says it needs', async () => {
    const res = await runSync()
    expect(res.reason).toBe('nudged')
    expect(getAll.mock.calls.map((c) => c[0].domain)).toEqual(['bilibili.com', 'quark.cn', 'xiaohongshu.com'])
    expect(Object.keys(res.counts)).toContain('quark.cn')
  })

  it('caches requiredDomains so the cookie-change trigger knows the full scope', async () => {
    await runSync()
    expect((stored.config as { requiredDomains: string[] }).requiredDomains).toEqual(['quark.cn', 'xiaohongshu.com'])
  })

  it('still syncs when the user has configured no domains of their own', async () => {
    stored.config = { baseUrl: 'http://127.0.0.1:8900', domains: [], autoSync: true }
    const res = await runSync()
    expect(res.reason).toBe('nudged')
    expect(getAll.mock.calls.map((c) => c[0].domain)).toEqual(['quark.cn', 'xiaohongshu.com'])
  })

  it('reports no_domains only when neither side names one', async () => {
    stored.config = { baseUrl: 'http://127.0.0.1:8900', domains: [], autoSync: true }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ...SYNC_CONFIG, requiredDomains: [] }), { status: 200 }))
    )
    expect(await runSync()).toMatchObject({ reason: 'no_domains' })
  })

  it('tolerates an older backend that reports no requiredDomains at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/api/ext/sync-config')
          ? new Response(JSON.stringify({ configured: true }), { status: 200 })
          : new Response('{}', { status: 200 })
      )
    )
    const res = await runSync()
    expect(res.reason).toBe('nudged')
    expect(getAll.mock.calls.map((c) => c[0].domain)).toEqual(['bilibili.com'])
  })
})
