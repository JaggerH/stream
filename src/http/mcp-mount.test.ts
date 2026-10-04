import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mountMcp } from './mcp-mount.ts'
import { StreamService } from '../mcp/tools.ts'
import { Registry } from '../registry/registry.ts'
import { Scheduler } from '../scheduler.ts'
import { DedupStore } from '../dedup-store.ts'
import type { Adapter } from '../adapters/types.ts'
import type { SourceManifest } from '../manifest/types.ts'
import { UserStore } from '../store/user-store.ts'

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

describe('mountMcp (real MCP client over HTTP, real listening server)', () => {
  let dir: string
  let dedup: DedupStore
  let service: StreamService
  let scheduler: Scheduler
  let httpServer: ReturnType<typeof serve>
  let client: Client

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-mount-'))
    mkdirSync(join(dir, 'vault', 'tech'), { recursive: true })
    dedup = new DedupStore(join(dir, 'dedup.db'))
    scheduler = new Scheduler({
      registry: new Registry(manifests),
      streams: [],
      adapters: new Map([['fake', fake]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
    })
    service = new StreamService({ registry: new Registry(manifests), scheduler, channels: new UserStore(join(dir, 'stream.db')) })

    const app = new Hono()
    await mountMcp(app, service, { isCommunitySource: () => false })
    httpServer = await new Promise((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s))
    })
    const port = (httpServer.address() as AddressInfo).port

    client = new Client({ name: 'test', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/api/mcp`)))
  })

  afterEach(async () => {
    await client.close()
    await new Promise((resolve) => httpServer.close(() => resolve(undefined)))
    dedup.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('advertises the fixed tool surface over the HTTP transport', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(names).toContain('stream_subscribe')
    expect(names).toContain('stream_unsubscribe')
    expect(names).toContain('stream_list')
  })

  it('stream_subscribe over HTTP is immediately visible on the same service/scheduler instance — no restart', async () => {
    expect(scheduler.list().map((s) => s.id)).not.toContain('my-tech')

    await client.callTool({
      name: 'stream_subscribe',
      arguments: {
        id: 'my-tech', description: 'my tech feed',
        sources: [{ source_id: 'hn-best', params: {} }],
        cadence_seconds: 1800, vault_subdir: 'tech',
      },
    })

    // No process boundary in this test — proving the wiring reaches the exact
    // scheduler instance the test constructed, not a copy.
    expect(scheduler.list().map((s) => s.id)).toContain('my-tech')
    expect(service.list().map((s) => s.id)).toContain('my-tech')
  })

  it('stream_unsubscribe over HTTP removes it from the same scheduler instance', async () => {
    await client.callTool({
      name: 'stream_subscribe',
      arguments: {
        id: 'my-tech', description: 'my tech feed',
        sources: [{ source_id: 'hn-best', params: {} }],
        cadence_seconds: 1800, vault_subdir: 'tech',
      },
    })
    expect(scheduler.list().map((s) => s.id)).toContain('my-tech')

    const r = await client.callTool({ name: 'stream_unsubscribe', arguments: { id: 'my-tech' } })
    expect(JSON.parse(text(r))).toEqual({ unsubscribed: 'my-tech', existed: true })
    expect(scheduler.list().map((s) => s.id)).not.toContain('my-tech')
  })
})
