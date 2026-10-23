import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountNodeRoutes } from './node-routes.ts'
import { HostRelayRegistry, type HostHello } from './host-registry.ts'
import { NodeStore } from '../devices/node-store.ts'
import { ProfileClaims, agentFrom } from '../devices/profile-claim.ts'

const LIST = { userDataDir: 'C:\\U', profiles: [{ dir: 'Default', name: '工作' }, { dir: 'Profile 1', name: '个人' }], lastActive: ['Default'] }

let registry: HostRelayRegistry
let nodes: NodeStore
let claims: ProfileClaims
let local: boolean
let app: Hono
let ops: string[]

/** 一个在线的 agent：按 op 回包，记下收到的每个 op。 */
function connectAgent(hello: Partial<HostHello> & { deviceId: string }) {
  const h: HostHello = { platform: 'windows', name: 'PC', agentVersion: '0.1.0', ops: ['browser.profiles', 'browser.claim'], ...hello }
  const relay = registry.connect({
    send: (raw: string) => {
      const m = JSON.parse(raw) as { id: number; op: string; args?: { profileDirectory?: string } }
      ops.push(m.op === 'browser.claim' ? `${m.op}:${m.args?.profileDirectory}` : m.op)
      const result = m.op === 'browser.profiles' ? LIST : { launched: true }
      queueMicrotask(() => relay.handleMessage(JSON.stringify({ id: m.id, result })))
    },
  }, h)
}

beforeEach(() => {
  registry = new HostRelayRegistry()
  nodes = new NodeStore(join(mkdtempSync(join(tmpdir(), 'noderoutes-')), 'stream.db'))
  ops = []
  claims = new ProfileClaims({
    agent: agentFrom(registry), nodes, extId: 'dmhlfkdjljnilhnfajjpaobehenbokij',
    deviceOf: (b) => (b.startsWith('local') ? 'local' : 'linux:nas'),
    nodeOf: (b) => (b.startsWith('local:') ? b.slice(6) : undefined),
  })
  local = true
  app = new Hono()
  mountNodeRoutes(app, { claims, nodes, isLocal: () => local })
})

const json = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

describe('node routes', () => {
  it('profile 路由只认本机请求', async () => {
    connectAgent({ deviceId: 'desktop:pc' })
    local = false
    expect((await app.request('/api/devices/desktop:pc/profiles')).status).toBe(403)
    expect((await json('POST', '/api/devices/desktop:pc/profiles/claim')).status).toBe(403)
    expect((await app.request('/api/devices/desktop:pc/profiles/claim/x')).status).toBe(403)
    expect(ops).toEqual([])
  })

  it('设备不在线 404；agent 太旧（没声明 op）409', async () => {
    expect((await app.request('/api/devices/desktop:pc/profiles')).status).toBe(404)
    connectAgent({ deviceId: 'desktop:old', ops: ['ensureApp'] })
    const r = await json('POST', '/api/devices/desktop:old/profiles/claim')
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toContain('browser.claim')
  })

  it('discover：local 指本机桌面 agent；已认领的节点标出来', async () => {
    connectAgent({ deviceId: 'desktop:pc' })
    nodes.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a', profileDir: 'Default', profileName: '工作' })
    const r = await app.request('/api/devices/local/profiles')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      deviceId: 'desktop:pc', userDataDir: 'C:\\U',
      profiles: [{ dir: 'Default', name: '工作', active: true, nodeId: 'node_a' }, { dir: 'Profile 1', name: '个人', active: false }],
    })
    expect(ops).toEqual(['browser.profiles'])
  })

  it('claim：开会话、逐个 browser.claim、交回后轮询看到 claimed', async () => {
    connectAgent({ deviceId: 'desktop:pc' })
    const r = await json('POST', '/api/devices/desktop:pc/profiles/claim', {})
    expect(r.status).toBe(200)
    const s = await r.json() as { claimId: string; profiles: Array<{ state: string }> }
    expect(ops).toEqual(['browser.profiles', 'browser.claim:Default', 'browser.claim:Profile 1'])
    expect(s.profiles.map((p) => p.state)).toEqual(['pending', 'pending'])
    expect((await app.request('/api/devices/desktop:pc/profiles/claim/nope')).status).toBe(404)
    const poll = await (await app.request(`/api/devices/desktop:pc/profiles/claim/${s.claimId}`)).json() as { done: boolean }
    expect(poll.done).toBe(false)
  })

  it('exe / userDataDir 透传给 agent，类型不对 400', async () => {
    connectAgent({ deviceId: 'desktop:pc' })
    expect((await json('POST', '/api/devices/desktop:pc/profiles/claim', { exe: 3 })).status).toBe(400)
    expect((await app.request('/api/devices/desktop:pc/profiles?userDataDir=D%3A%5CU')).status).toBe(200)
  })

  it('PATCH 节点：改 label / environment，null 清空；类型不对 400；没有节点 404', async () => {
    nodes.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a' })
    const r = await json('PATCH', '/api/devices/nodes/node_a', { label: ' 公司电脑 ', environment: '工作' })
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ nodeId: 'node_a', label: '公司电脑', environment: '工作' })
    expect(await (await json('PATCH', '/api/devices/nodes/node_a', { environment: null })).json()).not.toHaveProperty('environment')
    expect((await json('PATCH', '/api/devices/nodes/node_a', { environment: 1 })).status).toBe(400)
    expect((await json('PATCH', '/api/devices/nodes/node_a', {})).status).toBe(400)
    expect((await json('PATCH', '/api/devices/nodes/node_a', { label: 'x'.repeat(65) })).status).toBe(400)
    expect((await json('PATCH', '/api/devices/nodes/node_x', { label: 'x' })).status).toBe(404)
  })
})

describe('agentFrom', () => {
  it('桌面 agent 的扩展设备是 local；配对设备是它自己；local 取本机桌面 agent', () => {
    registry = new HostRelayRegistry()
    const sock = { send: () => {} }
    registry.connect(sock, { deviceId: 'desktop:pc', platform: 'windows', name: 'PC', agentVersion: '1', ops: [] })
    registry.connect(sock, { deviceId: 'linux:nas', platform: 'linux', name: 'NAS', agentVersion: '1', ops: [] })
    const find = agentFrom(registry)
    expect(find('desktop:pc')?.extDeviceId).toBe('local')
    expect(find('linux:nas')?.extDeviceId).toBe('linux:nas')
    expect(find('local')?.deviceId).toBe('desktop:pc')
    expect(find('desktop:gone')).toBeUndefined()
  })
})

describe('GET /api/devices/nodes', () => {
  it('列出全部节点，带在线与「能不能识别 profile」', async () => {
    nodes.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a', profileDir: 'Default', profileName: '工作' })
    nodes.seen({ nodeId: 'node_b', deviceId: 'linux:nas', bindingId: 'eb_1' })
    nodes.setWokenAt('node_b', 1234)
    const a = new Hono()
    mountNodeRoutes(a, {
      claims, nodes, isLocal: () => false,
      online: (bindingId) => bindingId === 'local:node_a',
      claimable: () => ['local'],
    })
    // 只读设置，不是认领：远处打开面板（经 API token）也能看。
    const res = await a.request('/api/devices/nodes')
    expect(res.status).toBe(200)
    const body = await res.json() as { nodes: Array<{ nodeId: string; online: boolean; wokenAt?: number; profileName?: string }>; claimable: string[] }
    expect(body.claimable).toEqual(['local'])
    expect(body.nodes.map((n) => [n.nodeId, n.online])).toEqual([['node_a', true], ['node_b', false]])
    expect(body.nodes[0].profileName).toBe('工作')
    expect(body.nodes[1].wokenAt).toBe(1234)
  })

  it('没注入判据：都不在线、谁也不能识别', async () => {
    nodes.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a' })
    const body = await (await app.request('/api/devices/nodes')).json() as { nodes: Array<{ online: boolean }>; claimable: string[] }
    expect(body.nodes[0].online).toBe(false)
    expect(body.claimable).toEqual([])
  })
})
