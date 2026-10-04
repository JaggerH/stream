import { describe, expect, it, vi, beforeEach } from 'vitest'
import { api } from './api.ts'

const conn = { baseUrl: 'http://x', token: undefined } as const

beforeEach(() => { vi.restoreAllMocks() })

describe('api providers/members', () => {
  it('providers() unwraps { items }', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [{ id: 'p1' }] }), { status: 200 }))
    expect(await api.providers(conn)).toEqual([{ id: 'p1' }])
  })

  it('patchStreamMembers PATCHes members', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 's1' }), { status: 200 }))
    await api.patchStreamMembers(conn, 's1', [{ plugin: 'rsshub', source: 'a', params: {} }])
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toContain('/api/streams/s1')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual({ members: [{ plugin: 'rsshub', source: 'a', params: {} }] })
  })
})
