import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStream, type Stream } from './index.ts'
import { readConfig } from '../bootstrap.ts'
import { createMcpServer } from '../mcp/server.ts'
import { withCapabilityTools } from '../mcp/capability-tools.ts'
import type { AgentDomain } from '../kernel/plugins/agent.ts'
import type { ToolDef } from '../../shared/capability/types.ts'

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'stream-tools-'))
  const packages = join(root, 'packages')
  mkdirSync(packages)
  return { root, config: { ...readConfig(join(root, 'config.yaml'), { STREAM_DATA_DIR: root }), packages_dir: packages, rsshub_catalog: '' } }
}

const capTool = (name: string): ToolDef => ({
  name,
  description: name,
  parameters: {},
  output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: name }] },
  execute: async () => ({ ok: true }),
})

describe('stream.tools', () => {
  const roots: string[] = []
  const open: Stream[] = []
  afterEach(async () => {
    for (const s of open.splice(0)) await s.close()
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  it('不经网络调工具；工具表与同一实例上的 MCP 端点一致（含运行期挂上的能力包工具）', async () => {
    const { root, config } = tempRoot(); roots.push(root)
    const s = await createStream({ dataDir: root, config, log: () => {} })
    open.push(s)

    const names = s.tools.list().map((t) => t.name)
    expect(names).toContain('stream_list')
    expect(names).toContain('inbox_search')

    const r = await s.tools.call('inbox_search', { q: 'x' }, { caller: 'test' })
    expect(r.isError).toBeUndefined()
    expect(r.value).toMatchObject({ items: [] })

    // 能力包在运行期上线 → list 随之出现
    await s.capabilities.host.mount({ name: 'late', mount: async (ctx) => { ctx.registerTools([capTool('late_verb')]) } }, {})
    expect(s.tools.list().map((t) => t.name)).toContain('late_verb')

    // MCP 端点（serve.ts 挂的就是这一份 service + extras）看到的表与 tools.list() 相同
    const server = createMcpServer(
      s.kernel.scheduling.service,
      withCapabilityTools((s.kernel.agent as AgentDomain).mcpExtras, () => s.capabilities.host.toolDefs()),
    )
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: 't', version: '0' })
    await client.connect(ct)
    const viaMcp = (await client.listTools()).tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }))
    expect(viaMcp).toEqual(s.tools.list())
    await client.close()
  })
})
