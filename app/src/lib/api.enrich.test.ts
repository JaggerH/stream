import { describe, expect, it, vi, beforeEach } from 'vitest'
import { api } from './api.ts'

const conn = { baseUrl: 'http://x', token: undefined } as const

beforeEach(() => { vi.restoreAllMocks() })

describe('api.enrich', () => {
  it('generic { source, params } variant: every param lands in the query as-is', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ article: null, comments: [] }), { status: 200 }))
    await api.enrich(conn, { source: 'demo-detail', params: { id: 'n1', token: 'T=1&x' } })
    const url = new URL(String(spy.mock.calls[0][0]))
    expect(url.pathname).toBe('/api/enrich')
    expect(url.searchParams.get('source')).toBe('demo-detail')
    expect(url.searchParams.get('id')).toBe('n1')
    expect(url.searchParams.get('token')).toBe('T=1&x')
    expect([...url.searchParams.keys()].sort()).toEqual(['id', 'source', 'token'])
  })

  // `prefetch` 是前端自己判预取 / 传输用的，不是 enricher 的参数。
  it('generic variant: prefetch never leaks into the query', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }))
    await api.enrich(conn, { source: 'demo-comments', params: { id: '7' }, prefetch: true })
    const url = new URL(String(spy.mock.calls[0][0]))
    expect([...url.searchParams.entries()].sort()).toEqual([['id', '7'], ['source', 'demo-comments']])
  })

  it('host variants keep their own query mapping', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }))
    await api.enrich(conn, { source: 'link', url: 'https://example.com/a' })
    const url = new URL(String(spy.mock.calls[0][0]))
    expect(url.searchParams.get('source')).toBe('link')
    expect(url.searchParams.get('url')).toBe('https://example.com/a')
  })
})
