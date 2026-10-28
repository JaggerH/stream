import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { HelperClient } from '../workbuddy/client.ts'
import { mountWorkBuddyRoutes } from './workbuddy-routes.ts'

describe('WorkBuddy management routes', () => {
  it('returns account status without relaying the Helper page token', async () => {
    const helper = new HelperClient('http://127.0.0.1:18080', async (input) => {
      if (String(input).endsWith('/api/state')) return Response.json({ accounts: [{ id: 'one', balance: 20, accessToken: 'secret-account-token' }], settings: { scheduleEnabled: false }, summary: { accounts: 1 }, serverTime: 'now' })
      throw new Error('unexpected request')
    })
    const app = new Hono()
    mountWorkBuddyRoutes(app, helper)
    const response = await app.request('/api/workbuddy/state')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ accounts: [{ id: 'one', balance: 20 }] })
    expect(JSON.stringify(body)).not.toContain('secret-account-token')
  })

  it('disables Helper scheduling before Stream claims the daily task', async () => {
    const paths: string[] = []
    const helper = new HelperClient('http://127.0.0.1:18080', async (input, init) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      if (path === '/') return new Response('<meta name="app-token" content="secret">')
      if (path === '/api/settings') {
        expect(JSON.parse(String(init?.body))).toEqual({ scheduleEnabled: false })
        return Response.json({ settings: { scheduleEnabled: false } })
      }
      throw new Error('unexpected request')
    })
    const app = new Hono()
    mountWorkBuddyRoutes(app, helper)
    expect((await app.request('/api/workbuddy/claim-schedule', { method: 'POST' })).status).toBe(200)
    expect(paths).toEqual(['/', '/api/settings'])
  })

  it('reports a partial batch as failed to the Stream panel', async () => {
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const helper = new HelperClient('http://127.0.0.1:18080', async (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/') return new Response('<meta name="app-token" content="secret">')
      if (path === '/api/run-all') return Response.json({ accounts: [
        { id: 'one', displayName: 'one', lastCheckin: 'confirmed', lastCheckinDate: today },
        { id: 'two', displayName: 'two', lastCheckin: 'error', lastCheckinDate: '' },
      ] })
      throw new Error(`unexpected ${path}`)
    })
    const app = new Hono()
    mountWorkBuddyRoutes(app, helper)
    const response = await app.request('/api/workbuddy/checkin', { method: 'POST' })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('two') })
  })
})
