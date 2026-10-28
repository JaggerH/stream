import type { Hono } from 'hono'
import { checkinOutcome, type HelperClient } from '../workbuddy/client.ts'

export function mountWorkBuddyRoutes(app: Hono, helper: HelperClient): void {
  const safe = async (c: import('hono').Context, work: () => Promise<unknown>) => {
    try { return c.json(await work()) }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 502) }
  }
  app.get('/api/workbuddy/state', (c) => safe(c, () => helper.state()))
  app.post('/api/workbuddy/claim-schedule', (c) => safe(c, async () => {
    await helper.disableOwnSchedule()
    return { ok: true }
  }))
  app.post('/api/workbuddy/login/start', (c) => safe(c, () => helper.loginStart()))
  app.post('/api/workbuddy/login/poll', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { loginId?: unknown }
    if (typeof body.loginId !== 'string' || body.loginId.length < 1 || body.loginId.length > 200) {
      return c.json({ error: 'loginId 必填' }, 400)
    }
    return safe(c, () => helper.loginPoll(body.loginId as string))
  })
  app.post('/api/workbuddy/checkin', (c) => safe(c, async () => {
    const { accounts } = await helper.runAll()
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    return { outcome: checkinOutcome(accounts, today) }
  }))
  app.post('/api/workbuddy/accounts/:id/checkin', (c) => safe(c, () => helper.checkin(c.req.param('id'))))
  app.post('/api/workbuddy/accounts/:id/points', (c) => safe(c, () => helper.points(c.req.param('id'))))
  app.put('/api/workbuddy/accounts/:id', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { enabled?: unknown }
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled 必须是布尔值' }, 400)
    return safe(c, () => helper.setEnabled(c.req.param('id'), body.enabled as boolean))
  })
  app.delete('/api/workbuddy/accounts/:id', (c) => safe(c, () => helper.remove(c.req.param('id'))))
}
