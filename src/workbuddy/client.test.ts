import { describe, expect, it, vi } from 'vitest'
import { HelperClient, checkinOutcome } from './client.ts'

const account = (id: string, lastCheckin: string, lastCheckinDate = '2026-10-29') => ({
  id, displayName: id, version: 'cn', enabled: true, status: lastCheckin,
  lastCheckin, lastCheckinDate, balance: 100, lastPointsAt: '2026-10-29T01:00:00Z',
})

describe('WorkBuddy Helper client', () => {
  it('rejects non-loopback services', () => {
    expect(() => new HelperClient('https://example.com')).toThrow(/本机/)
  })

  it('refreshes the page token after Helper restarts', async () => {
    let pages = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path === '/') return new Response(`<meta name="app-token" content="${++pages === 1 ? 'old-token' : 'new-token'}">`)
      if (path === '/api/run-all' && init?.headers && new Headers(init.headers).get('X-App-Token') === 'old-token') {
        return Response.json({ error: 'token expired' }, { status: 403 })
      }
      if (path === '/api/run-all') return Response.json({ accounts: [account('a', 'confirmed')] })
      throw new Error(`unexpected ${path}`)
    })
    const helper = new HelperClient('http://127.0.0.1:18080', fetcher)
    expect((await helper.runAll()).accounts).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('does not count a mixed batch as successful', () => {
    expect(() => checkinOutcome([
      account('a', 'confirmed'), account('b', 'error', ''),
    ], '2026-10-29')).toThrow(/b/)
  })

  it('reports empty account lists instead of a successful no-op', () => {
    expect(() => checkinOutcome([], '2026-10-29')).toThrow(/没有/)
  })
})
