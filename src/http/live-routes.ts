// src/http/live-routes.ts — live present 的通用列表面。
// 与 mountConfigRows 同款 serve 直连挂载（HttpDeps 键冻结是房规）。
import type { Hono } from 'hono'
import type { LiveStreamService } from '../live/service.ts'

export function mountLiveRoutes(app: Hono, deps: { live: Pick<LiveStreamService, 'items'> }): void {
  app.get('/api/live/streams/:streamId/items', async (c) => {
    try {
      return c.json({ items: await deps.live.items(c.req.param('streamId')) })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const code = (e as { code?: string }).code
      if (code === 'unknown_stream') return c.json({ error: msg }, 404)
      // 其余一律 502 带原文：live 面读的是外部世界，读不到就说读不到，不返回空列表。
      return c.json({ error: msg }, 502)
    }
  })
}
