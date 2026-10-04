// src/http/config-rows-routes.ts
//
// 配置 row 的通用端点对（spec 2026-08-17-config-rows-slice1 §4）：
//   GET /api/config/:rowId → { schema, values, secrets }
//   PUT /api/config/:rowId → 校验(schema + validate 钩子) → 落盘 → apply 钩子 → 回 status
// 一对端点替掉「一族一对」的手写端点；旧 /api/settings/* 里被迁的三族是它的薄转发
// （域内 setter 已改走 rows.put，见 agent/harvest 域与 serve.ts 的 videoSources 接线）。
//
// 与 mountMcp / mountLlmIngress 同款 serve 直连挂载（HttpDeps 键冻结是房规）——
// 已登记进 ARCHITECTURE 内核一节的直连清单。
import type { Hono } from 'hono'
import type { ConfigRowRegistry } from '../settings/config-rows.ts'
import { unknownKey, unknownKeyMessage } from './strict-input.ts'

export function mountConfigRows(app: Hono, deps: { rows: ConfigRowRegistry }): void {
  app.get('/api/config/:rowId', (c) => {
    const id = c.req.param('rowId')
    if (!deps.rows.has(id)) return c.json({ error: `unknown config row: ${id}` }, 404)
    return c.json(deps.rows.status(id))
  })

  app.put('/api/config/:rowId', async (c) => {
    const id = c.req.param('rowId')
    if (!deps.rows.has(id)) return c.json({ error: `unknown config row: ${id}` }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'body must be a JSON object of row values' }, 400)
    }
    // 严格输入闸（docs/API.md §2）。合法键**不是手抄的名单**，是这一行 schema 声明的键
    // （`rows.keys(id)`）——引擎本来就只认这些，多出来的以前被静默丢掉：写错一个字段名
    // 拿到的是 200 + 一份"看起来存进去了"的 status。
    const allowed = deps.rows.keys(id)
    const bad = unknownKey(Object.keys(body), allowed)
    if (bad) return c.json({ error: unknownKeyMessage('字段', bad, allowed) }, 400)
    try {
      await deps.rows.put(id, body)
    } catch (e) {
      // schema 类型错 / validate 钩子拒绝 / apply 失败（已回滚）——统一 400 带原文。
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400)
    }
    return c.json(deps.rows.status(id))
  })
}
