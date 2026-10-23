/**
 * 站点身份（browser-identity D6）：身份表的读口与手动刷新。
 *
 * - `GET /api/identities?facility=&nodeId=`：每个（facility，节点）一条，带节点在不在线与 profile 名。
 * - `POST /api/identities/refresh`（body 可带 `nodeId` / `facility`）：在线节点上现问一遍，回这次的结果与刷新后的表。
 *   `unknown` 也回给调用方（面板要说「这台没问着」），只是不写表。
 */
import type { Hono } from 'hono'
import type { IdentityService } from '../identity/identity-service.ts'

export function mountIdentityRoutes(app: Hono, deps: { identities: () => IdentityService | undefined }): void {
  const unavailable = { error: '身份表不可用（stream.db 打不开）' }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

  app.get('/api/identities', (c) => {
    const svc = deps.identities()
    if (!svc) return c.json(unavailable, 503)
    const facility = str(c.req.query('facility'))
    const nodeId = str(c.req.query('nodeId'))
    return c.json({ identities: svc.list({ ...(facility ? { facility } : {}), ...(nodeId ? { nodeId } : {}) }) })
  })

  app.post('/api/identities/refresh', async (c) => {
    const svc = deps.identities()
    if (!svc) return c.json(unavailable, 503)
    let body: Record<string, unknown> = {}
    const raw = await c.req.text()
    if (raw.trim()) {
      try { body = JSON.parse(raw) as Record<string, unknown> } catch { return c.json({ error: 'body 不是合法 JSON' }, 400) }
    }
    const filter = { ...(str(body.facility) ? { facility: str(body.facility)! } : {}), ...(str(body.nodeId) ? { nodeId: str(body.nodeId)! } : {}) }
    const results = await svc.refresh(filter)
    return c.json({ results, identities: svc.list(filter) })
  })
}
