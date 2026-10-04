import { describe, expect, it, vi, beforeEach } from 'vitest'
import { api } from './api.ts'

const conn = { baseUrl: 'http://x', token: undefined } as const

beforeEach(() => { vi.restoreAllMocks() })

describe('api.archiveStatus chunking', () => {
  it('splits a large track list into ≤200-ref requests and merges results (a single 1000+ URL blows past the server 16KB header limit → HTTP 431)', async () => {
    const tracks = Array.from({ length: 250 }, (_, i) => ({ platform: 'netease', trackId: String(i) }))
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const refs = new URL(String(url), 'http://x').searchParams.get('refs') ?? ''
      const archived = Object.fromEntries(refs.split(',').map((r) => [r, true]))
      return new Response(JSON.stringify({ archived }), { status: 200 })
    })
    const res = await api.archiveStatus(conn, tracks)
    // 250 / 200-per-chunk = 2 requests
    expect(spy.mock.calls.length).toBe(2)
    // every ref survives the merge
    expect(Object.keys(res.archived).length).toBe(250)
    expect(res.archived['netease:0']).toBe(true)
    expect(res.archived['netease:249']).toBe(true)
    // each request URL stays well under Node's 16384-byte maxHeaderSize
    for (const [url] of spy.mock.calls) {
      expect(String(url).length).toBeLessThan(16384)
    }
  })

  it('makes no request for an empty track list', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const res = await api.archiveStatus(conn, [])
    expect(spy.mock.calls.length).toBe(0)
    expect(res.archived).toEqual({})
  })
})
