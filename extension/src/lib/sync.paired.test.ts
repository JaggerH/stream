import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runSync } from './sync.ts'
import * as relayNotify from './relay-notify.ts'

// 配对绑定的一轮同步（design D7）：不问 sync-config（远处那个实例要 API token），
// 只在批准过的范围里数、只叫醒这条绑定的 Stream，本机那条不受影响。

let stored: Record<string, unknown> = {}
const getAll = vi.fn(async ({ domain }: { domain: string }) => [
  { name: 'sid', value: `v-${domain}`, domain: `.${domain}`, path: '/' } as chrome.cookies.Cookie,
])

beforeEach(() => {
  stored = {
    config: { baseUrl: 'http://127.0.0.1:8900', domains: ['bilibili.com'], autoSync: true },
    bindings: [{
      id: 'ext:a', kind: 'paired', baseUrl: 'https://main.example', token: 't', label: 'NAS',
      domains: [], requiredDomains: ['eastmoneysec.com', 'mail.google.com'], approvedDomains: ['eastmoneysec.com'], autoSync: true,
    }],
  }
  getAll.mockClear()
  vi.restoreAllMocks()
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: stored[k] }),
        set: async (patch: Record<string, unknown>) => Object.assign(stored, patch),
      },
    },
    cookies: { getAll },
  })
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('a paired sync must not call the network') }))
})

describe('runSync — 配对绑定', () => {
  it('只数批准过的域，叫醒的是这条绑定', async () => {
    const spy = vi.spyOn(relayNotify, 'notifyCookiesChanged').mockReturnValue(true)
    const res = await runSync('ext:a')
    expect(res.reason).toBe('nudged')
    expect(getAll.mock.calls.map((c) => c[0].domain)).toEqual(['eastmoneysec.com'])
    expect(spy).toHaveBeenCalledWith(['eastmoneysec.com'], 'ext:a')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('什么都没批准 → no_domains，不叫', async () => {
    const spy = vi.spyOn(relayNotify, 'notifyCookiesChanged').mockReturnValue(true)
    ;(stored.bindings as Array<Record<string, unknown>>)[0]!.approvedDomains = []
    expect((await runSync('ext:a')).reason).toBe('no_domains')
    expect(spy).not.toHaveBeenCalled()
  })

  it('本机那条的 config 一个字都没被改', async () => {
    vi.spyOn(relayNotify, 'notifyCookiesChanged').mockReturnValue(true)
    const before = JSON.stringify(stored.config)
    await runSync('ext:a')
    expect(JSON.stringify(stored.config)).toBe(before)
  })
})

describe('relay-notify — 按绑定', () => {
  it('各走各的连接', () => {
    const local = { send: vi.fn() }
    const a = { send: vi.fn() }
    relayNotify.setNotifySocket(local)
    relayNotify.setNotifySocket(a, 'ext:a')
    expect(relayNotify.notifyCookiesChanged(['x.com'], 'ext:a')).toBe(true)
    expect(a.send).toHaveBeenCalledOnce()
    expect(local.send).not.toHaveBeenCalled()
    relayNotify.setNotifySocket(null, 'ext:a')
    expect(relayNotify.notifyCookiesChanged(['x.com'], 'ext:a')).toBe(false)
    relayNotify.setNotifySocket(null)
  })
})
