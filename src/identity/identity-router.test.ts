import { describe, it, expect } from 'vitest'
import { IdentityOffline } from '../devices/errors.ts'
import type { SiteIdentity } from './identity-store.ts'
import { makeIdentityRouter, type IdentityRouterDeps, type RouterNode } from './identity-router.ts'

const NODES: Record<string, RouterNode> = {
  node_work: { nodeId: 'node_work', deviceId: 'local', bindingId: 'local:node_work', profileDir: 'Profile 1', profileName: '工作', environment: '工作' },
  node_home: { nodeId: 'node_home', deviceId: 'local', bindingId: 'local:node_home', profileDir: 'Default', profileName: '个人', environment: '个人' },
  node_lap: { nodeId: 'node_lap', deviceId: 'linux:lap', bindingId: 'ext:lap', profileName: '笔记本', environment: '个人' },
}

const row = (nodeId: string, accountId: string, verifiedAt: number, state: SiteIdentity['state'] = 'signed-in'): SiteIdentity =>
  ({ facility: 'xhs', nodeId, accountId, displayName: `号${accountId}`, state, verifiedAt })

function world(rows: SiteIdentity[], online: string[], over: Partial<IdentityRouterDeps> = {}) {
  const deps: IdentityRouterDeps = {
    identities: (f) => rows.filter((r) => r.facility === f),
    node: (id) => NODES[id],
    isOnline: (b) => online.includes(b),
    now: () => 1_000_000,
    ...over,
  }
  return makeIdentityRouter(deps)
}

describe('IdentityRouter：选节点（D7）', () => {
  it('身份目标：该账号 signed-in 的节点；在线优先', async () => {
    const r = world([row('node_work', 'B', 10), row('node_lap', 'B', 50), row('node_home', 'A', 99)], ['local:node_work'])
    const got = await r.resolve({ target: { kind: 'identity', accountId: 'B' }, facility: 'xhs', purpose: 'action' })
    expect(got.node.nodeId).toBe('node_work')
    expect(got.identity).toEqual({ facility: 'xhs', accountId: 'B', accountName: '号B', nodeId: 'node_work' })
  })

  it('同为在线取最近核对过的', async () => {
    const r = world([row('node_work', 'B', 10), row('node_lap', 'B', 50)], ['local:node_work', 'ext:lap'])
    expect((await r.resolve({ target: { kind: 'identity', accountId: 'B' }, facility: 'xhs', purpose: 'action' })).node.nodeId).toBe('node_lap')
  })

  it('环境目标：该环境里该 facility signed-in 的节点，不论账号', async () => {
    const r = world([row('node_work', 'B', 10), row('node_home', 'A', 20), row('node_lap', 'C', 30)], ['local:node_home', 'local:node_work'])
    const got = await r.resolve({ target: { kind: 'environment', environment: '个人' }, facility: 'xhs', purpose: 'harvest' })
    expect(got.node.nodeId).toBe('node_home')
    expect(got.identity.accountId).toBe('A')
  })

  it('signed-out 的行不是候选；别的 facility 的行不算', async () => {
    const rows = [row('node_work', 'B', 10, 'signed-out'), { ...row('node_home', 'B', 10), facility: 'bilibili' }]
    const r = world(rows, ['local:node_work', 'local:node_home'])
    await expect(r.resolve({ target: { kind: 'identity', accountId: 'B' }, facility: 'xhs', purpose: 'action' })).rejects.toBeInstanceOf(IdentityOffline)
  })

  it('候选为空 → identity-offline，不回落（别的在线节点不被选）', async () => {
    const r = world([row('node_home', 'A', 10)], ['local:node_home'])
    const e = await r.resolve({ target: { kind: 'identity', accountId: 'B' }, facility: 'xhs', purpose: 'action' }).catch((x) => x)
    expect(e).toBeInstanceOf(IdentityOffline)
    expect(e.message).toContain('身份 xhs:B')
  })

  it('候选都离线 → identity-offline', async () => {
    const r = world([row('node_lap', 'B', 10)], ['local:node_home'])
    await expect(r.resolve({ target: { kind: 'identity', accountId: 'B' }, facility: 'xhs', purpose: 'action' })).rejects.toBeInstanceOf(IdentityOffline)
  })
})
