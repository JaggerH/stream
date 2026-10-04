// src/http/research-routes.ts — research present 的详情面（spec 2026-08-25 §二）。
// 与 Cockpit 的 /api/runs/{id} 和 /api/runs/{id}/artifacts/{name} 逐字同形。
// 详情**刻意不泛化**进 live 通用面：列表天生同形，详情天生各不相同（影视是播放器、
// 研究是 manifest+artifacts）。造通用详情面就是第二个 DataFrame——压不进去的能力被拒。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { readRunManifest } from '../board/run-source.ts'
// 段校验用全仓唯一那一份判据（拒分隔符 + 拒纯点）。**先判后拼**——不做「拼完再检查是否
// 越界」那种事后补救。这里曾经自带一份 ASCII 白名单，把 90 个中文名 artifact 判成 400。
export { isSafeSegment } from '../safe-segment.ts'
import { isSafeSegment } from '../safe-segment.ts'

export interface ResearchRoutesDeps {
  /** streamId → 该流的 artifacts 目录绝对路径。取不到就抛（错误原文透给用户）。 */
  dirForStream(streamId: string): string
}

export function mountResearchRoutes(app: Hono, deps: ResearchRoutesDeps): void {
  app.get('/api/research/streams/:streamId/runs/:runId', (c) => {
    const runId = c.req.param('runId')
    if (!isSafeSegment(runId)) return c.json({ error: `bad run id: ${runId}` }, 400)
    let dir: string
    try { dir = deps.dirForStream(c.req.param('streamId')) }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 400) }
    try { return c.json(readRunManifest(dir, runId)) }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 404) }
  })

  app.get('/api/research/streams/:streamId/runs/:runId/artifacts/:name', (c) => {
    const runId = c.req.param('runId')
    const name = c.req.param('name')
    if (!isSafeSegment(runId)) return c.json({ error: `bad run id: ${runId}` }, 400)
    if (!isSafeSegment(name)) return c.json({ error: `bad artifact name: ${name}` }, 400)
    let dir: string
    try { dir = deps.dirForStream(c.req.param('streamId')) }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 400) }
    const file = join(dir, runId, `${name}.json`)
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(file, 'utf8')) }
    catch (e) { return c.json({ error: `cannot read artifact ${file}: ${e instanceof Error ? e.message : String(e)}` }, 404) }
    const a = parsed as { schema?: string }
    // schema 不对是 404 而不是 500：这是"你要的那个东西不在这儿"，不是服务器坏了。
    if (a.schema !== 'artifact/v1') return c.json({ error: `${file} is not an artifact/v1 file` }, 404)
    return c.json(parsed)
  })
}
