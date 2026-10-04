import { describe, it, expect, afterEach } from 'vitest'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import { probeBackend } from './probe-backend.ts'

describe('probeBackend', () => {
  let server: ReturnType<typeof serve> | undefined
  afterEach(() => { server?.close(); server = undefined })

  function listen(app: Hono): Promise<string> {
    return new Promise((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
        resolve(`http://127.0.0.1:${(info as AddressInfo).port}`)
      )
    })
  }

  it('true when /api/health answers 200', async () => {
    const app = new Hono()
    app.get('/api/health', (c) => c.json({ ok: true }))
    const url = await listen(app)
    expect(await probeBackend(url)).toBe(true)
  })

  it('false when /api/health answers non-2xx', async () => {
    const app = new Hono()
    app.get('/api/health', (c) => c.text('nope', 500))
    const url = await listen(app)
    expect(await probeBackend(url)).toBe(false)
  })

  it('false when nothing is listening', async () => {
    expect(await probeBackend('http://127.0.0.1:1')).toBe(false)
  })

  it('false on timeout (slow backend counts as absent)', async () => {
    const app = new Hono()
    app.get('/api/health', async (c) => {
      await new Promise((r) => setTimeout(r, 500))
      return c.json({ ok: true })
    })
    const url = await listen(app)
    expect(await probeBackend(url, 50)).toBe(false)
  })
})
