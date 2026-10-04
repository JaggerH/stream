import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mountMcp } from '../../src/http/mcp-mount.ts'
import { makeBackendForwardServer } from './backend-forward.ts'
import { StreamService } from '../../src/mcp/tools.ts'
import { Registry } from '../../src/registry/registry.ts'
import { Scheduler } from '../../src/scheduler.ts'
import { DedupStore } from '../../src/dedup-store.ts'
import { UserStore } from '../../src/store/user-store.ts'
import type { Adapter } from '../../src/adapters/types.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

function mk(partial: Partial<SourceManifest> & { id: string }): SourceManifest {
  return {
    schema_version: 1, adapter: 'fake', type: 'post', description: partial.id,
    topics: [], example_queries: [], capabilities: ['timeline'], auth: { type: 'none' },
    params_schema: {}, cadence_hint_seconds: 1800, discoverable: true, ...partial,
  }
}
const fake: Adapter = { id: 'fake', init: async () => {}, fetch: async () => [{ guid: '1', title: 't' }] }
const manifests: SourceManifest[] = [mk({ id: 'hn-best', description: 'hacker news' })]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const text = (r: any) => (r.content as Array<{ text: string }>)[0].text

describe('makeBackendForwardServer (real backend HTTP server, real stdio-facing MCP client)', () => {
  let dir: string
  let dedup: DedupStore
  let httpServer: ReturnType<typeof serve>
  let backendUrl: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fwd-'))
    dedup = new DedupStore(join(dir, 'dedup.db'))
    const scheduler = new Scheduler({
      registry: new Registry(manifests), streams: [],
      adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'), dedup,
    })
    const service = new StreamService({ registry: new Registry(manifests), scheduler, channels: new UserStore(join(dir, 'stream.db')) })
    const app = new Hono()
    await mountMcp(app, service, { isCommunitySource: () => false })
    await new Promise<void>((resolve) => {
      httpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        backendUrl = `http://127.0.0.1:${(info as AddressInfo).port}`
        resolve()
      })
    })
  })
  afterEach(async () => {
    httpServer.close()
    dedup.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('forwards tools/list and tools/call to the real backend', async () => {
    const bridge = await makeBackendForwardServer(backendUrl)
    const [clientT, bridgeT] = InMemoryTransport.createLinkedPair()
    await bridge.connect(bridgeT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)

    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(names).toContain('stream_search')

    const result = await client.callTool({ name: 'stream_search', arguments: { intent: 'hacker' } })
    expect(text(result)).toContain('hn-best')

    await client.close()
  })
})
