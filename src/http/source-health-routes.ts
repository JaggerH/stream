import type { Context, Hono } from 'hono'
import type { RepairManager } from '../intervention/repair-manager.ts'
import type { SourceHealthIndex } from '../intervention/source-health-view.ts'
import { unknownKey, unknownKeyMessage } from './strict-input.ts'

/** 手动拉起的 body 只认这两个键（API.md 第 2 条：写错键名要响亮的 400）。 */
export const REPAIR_BODY_KEYS = ['sourceId', 'reason'] as const

export interface SourceHealthRoutesDeps {
  index: Pick<SourceHealthIndex, 'one' | 'unhealthy'>
  /** 缺席 = 没接 agent 档，手动拉起 503。读口不受影响。 */
  repairs?: Pick<RepairManager, 'start'>
  /** 手动拉起没给 reason 时的缺省：关禁账 lastReason → 健康账 lastError → 'manual'。 */
  reasonFor: (sourceId: string) => string
  /** 连累名单（`Registry.affectedSources(...).affected`）。 */
  affectedFor: (sourceId: string) => string[]
}

const err = (c: Context, status: 400 | 404 | 409 | 503, code: string, message: string, extra: Record<string, unknown> = {}) =>
  c.json({ error: { code, message }, ...extra }, status)

/**
 * 源健康：三本账合成一个词的读口 + 手动拉起 agent 修复的写口（spec 2026-09-12 §7）。
 * 现有 `/api/interventions/*` 七个操作口不在这里、也不改。
 */
export function mountSourceHealthRoutes(app: Hono, deps: SourceHealthRoutesDeps): void {
  app.get('/api/source-health', (c) => c.json({ sources: deps.index.unhealthy() }))

  // sourceId 形如 `@scope/pkg/foo-home`（多段）：正则参数吃到行尾，裸写和整体 encodeURIComponent 都要命中。
  app.get('/api/source-health/:sourceId{.+}', (c) => {
    const v = deps.index.one(c.req.param('sourceId'))
    return v ? c.json(v) : err(c, 404, 'unknown-source', `不认识这个源：${c.req.param('sourceId')}`)
  })

  app.post('/api/interventions/repairs', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const bad = unknownKey(Object.keys(body), REPAIR_BODY_KEYS)
    if (bad) return err(c, 400, 'unknown-key', unknownKeyMessage('字段', bad, REPAIR_BODY_KEYS))
    const sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim() : ''
    if (!sourceId) return err(c, 400, 'need-source-id', 'body 要带 sourceId')
    if (!deps.repairs) return err(c, 503, 'agent-unavailable', '这台后端没接 agent 档（介入域缺 repairs）')
    const view = deps.index.one(sourceId)
    if (!view) return err(c, 404, 'unknown-source', `不认识这个源：${sourceId}`)
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : deps.reasonFor(sourceId)
    const r = deps.repairs.start({ sourceId, reason, affectedSources: deps.affectedFor(sourceId) })
    if (r === 'unconfigured') return err(c, 503, 'agent-unavailable', '还没配 ai-agent：PUT /api/config/ai-agent 填 command 后再试')
    if (r === 'busy') return err(c, 409, 'repair-busy', '这个源已经有一条修复会话在跑', view.run ? { runId: view.run.id } : {})
    return c.json(r.failed ? { runId: r.runId, failed: true } : { runId: r.runId }, 201)
  })
}
