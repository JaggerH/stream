/**
 * 从 Stream 仓库钉住 `hosts/dsh/cordis.patch.yml` 的两条不变量（spec 2026-09-05 §3.5）。
 * yml 住在插件包里，但判据的另一端在后端：
 *  1. MCP 客户端每次 callTool 的超时必须 ≥ 2 × extract 的服务端等待预算，否则模型拿到的是
 *     硬错误 TOOL_TIMEOUT 而不是我们那份说得清「还在跑」的回执。
 *  2. ui-layout 与 ui-sidebar 必须**同时**关且 stream-ui 行在场——三者缺一整页空白或装载期抛。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { repoRoot } from './build-identity.ts'
import { EXTRACT_SETTLE_BUDGET_MS } from '../mcp/extract-settle.ts'
import { DSH_MCP_SERVER_NAME } from '../mcp/capability-tool-names.ts'

type Entry = { id?: string; disabled?: boolean; config?: Record<string, unknown>; insert?: Array<{ id: string; name: string; config?: Record<string, unknown> }> }

function patch(): Entry[] {
  return parse(readFileSync(join(repoRoot, 'hosts', 'dsh', 'cordis.patch.yml'), 'utf8')) as Entry[]
}
function inserted(entries: Entry[]) { return entries.flatMap((e) => e.insert ?? []) }

describe('stream-ui bundle patch', () => {
  it('stream-mcp 行指 /api/mcp，serverName 是契约名，toolCallTimeoutMs ≥ 2 × EXTRACT_SETTLE_BUDGET_MS', () => {
    const row = inserted(patch()).find((r) => r.id === 'stream-mcp')
    expect(row?.name).toBe('@deepseek-ai/dsh-mcp-client')
    expect(row?.config?.serverName).toBe(DSH_MCP_SERVER_NAME)
    expect(String(row?.config?.url)).toMatch(/\/api\/mcp$/)
    expect(Number(row?.config?.toolCallTimeoutMs)).toBeGreaterThanOrEqual(2 * EXTRACT_SETTLE_BUDGET_MS)
  })

  it('ui-layout 与 ui-sidebar 同时关，且 stream-ui 行带 streamBaseUrl', () => {
    const entries = patch()
    expect(entries.find((e) => e.id === 'ui-layout')).toEqual({ id: 'ui-layout', disabled: true })
    expect(entries.find((e) => e.id === 'ui-sidebar')).toEqual({ id: 'ui-sidebar', disabled: true })
    const ui = inserted(entries).find((r) => r.id === 'stream-ui')
    expect(ui?.name).toBe('@streamapp/dsh-plugin-stream-ui')
    expect(typeof ui?.config?.streamBaseUrl).toBe('string')
  })

  it('目录选择器钉 browse 面：auto 行关、host/client 两半各一行', () => {
    const entries = patch()
    expect(entries.find((e) => e.id === 'directory-picker')).toEqual({ id: 'directory-picker', disabled: true })
    const names = inserted(entries).map((r) => r.id)
    expect(names).toContain('directory-picker-browse')
    expect(names).toContain('directory-picker-browse-ui')
  })
})
