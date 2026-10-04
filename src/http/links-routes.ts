import type { Hono } from 'hono'
import { recognizeLink, type LinkRef } from '../links/recognize.ts'

/**
 * `GET /api/links/recognize?url=` —— 「这条链接是谁的、是什么」的只读口（spec 2026-09-26-link-recognition §4）。
 * 回 `LinkRef | null`（null = 没有已装的包认领它）。命中某包 `shortHosts` 的链接会先展开（只打那个包声明过的
 * 公网主机，见 `recognizeLink`）。调试和以后的前端粘贴框用；它不派发、不抓内容。
 *
 * 认领表是模块级 thunk（sources 域挂的），这里不需要 deps；`recognize` 只为测试注入。
 */
export function registerLinkRoutes(app: Hono, deps: { recognize?: (url: string) => Promise<LinkRef | null> } = {}): void {
  const recognize = deps.recognize ?? ((url: string) => recognizeLink(url))
  app.get('/api/links/recognize', async (c) => {
    const url = c.req.query('url')
    if (!url) return c.json({ error: { code: 'validation_error', message: 'url required' } }, 400)
    return c.json(await recognize(url))
  })
}
