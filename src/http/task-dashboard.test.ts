import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { mountTaskDashboard } from './task-dashboard.ts'

describe('mountTaskDashboard', () => {
  it('proxies /_p/sidequest/* to loopback WITHOUT stripping the prefix', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }))
    const app = new Hono()
    mountTaskDashboard(app, { port: 8678, fetchImpl: fetchImpl as never })
    const res = await app.request('/_p/sidequest/jobs?state=failed')
    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8678/_p/sidequest/jobs?state=failed',
      expect.anything(),
    )
  })

  it('dashboard down → 502 with error body（不裸抛）', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const app = new Hono()
    mountTaskDashboard(app, { port: 8678, fetchImpl: fetchImpl as never })
    const res = await app.request('/_p/sidequest/')
    expect(res.status).toBe(502)
  })

  it('strips hop-by-hop headers and sets duplex for streaming bodies', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }))
    const app = new Hono()
    mountTaskDashboard(app, { port: 8678, fetchImpl: fetchImpl as never })
    const res = await app.request(
      new Request('http://localhost/_p/sidequest/jobs/run', {
        method: 'POST',
        headers: {
          'transfer-encoding': 'chunked',
          'expect': '100-continue',
          'connection': 'x-foo',
          'x-foo': '1',
          'x-keep': 'yes',
        },
        body: 'test-body',
      }),
    )
    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledOnce()
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit & { duplex?: string }]>
    expect(calls.length).toBeGreaterThan(0)
    const [, init] = calls[0]
    const headers = init.headers as Headers
    expect(headers.get('transfer-encoding')).toBe(null)
    expect(headers.get('expect')).toBe(null)
    expect(headers.get('x-foo')).toBe(null)
    expect(headers.get('x-keep')).toBe('yes')
    expect(init.duplex).toBe('half')
  })
})
