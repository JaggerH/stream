import type { Hono } from 'hono'
import type { WishlistStore } from '../onboard/wishlist-store.ts'

/** 「想接还接不了」清单的只读面 + 删除。写入只有一条路：对话里的 `note_unonboardable` 工具
 *  （见 src/agent/tools.ts）——这里不开 POST，免得多出第二个写入口各写各的。 */
export interface OnboardDeps {
  wishlist: WishlistStore
}

export function registerOnboardRoutes(app: Hono, deps: OnboardDeps): void {
  app.get('/api/onboard/wishlist', (c) => c.json({ entries: deps.wishlist.list() }))

  app.delete('/api/onboard/wishlist/:id', (c) => {
    const ok = deps.wishlist.remove(c.req.param('id'))
    if (!ok) return c.json({ error: { code: 'not_found', message: 'no such wishlist entry' } }, 404)
    return c.json({ ok: true })
  })
}
