import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

function stubStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial }
  const set = vi.fn(async (o: Record<string, unknown>) => { Object.assign(data, o) })
  vi.stubGlobal('chrome', {
    storage: { local: { get: async (k: string) => (k in data ? { [k]: data[k] } : {}), set } },
  })
  return { data, set }
}

describe('getNode', () => {
  it('首次运行生成 node_<uuid> 并落进 chrome.storage.local.node', async () => {
    const s = stubStorage()
    const { getNode } = await import('./node.ts')
    const n = await getNode()
    expect(n.nodeId).toMatch(/^node_[0-9a-f-]{36}$/)
    expect(s.data.node).toEqual({ nodeId: n.nodeId })
  })

  it('之后读回同一个；并发首读也只生成一次', async () => {
    const s = stubStorage()
    const { getNode } = await import('./node.ts')
    const [a, b] = await Promise.all([getNode(), getNode()])
    expect(a.nodeId).toBe(b.nodeId)
    expect((await getNode()).nodeId).toBe(a.nodeId)
    expect(s.set).toHaveBeenCalledTimes(1)
  })

  it('认领过的 profile 原样读出', async () => {
    stubStorage({ node: { nodeId: 'node_x', profileDir: 'Profile 1', profileName: '工作' } })
    const { getNode } = await import('./node.ts')
    expect(await getNode()).toEqual({ nodeId: 'node_x', profileDir: 'Profile 1', profileName: '工作' })
  })
})

describe('nodeQuery', () => {
  it('只带存储里有的格', async () => {
    const { nodeQuery } = await import('./node.ts')
    expect(nodeQuery({ nodeId: 'node_x' })).toBe('nodeId=node_x')
    expect(new URLSearchParams(nodeQuery({ nodeId: 'node_x', profileDir: 'Default', profileName: '个人' })).get('profileName')).toBe('个人')
  })
})

describe('rememberProfile', () => {
  it('认领后两格写进 node，nodeId 不变；之后的握手带上它们', async () => {
    const s = stubStorage({ node: { nodeId: 'node_x' } })
    const { rememberProfile, nodeQuery, getNode } = await import('./node.ts')
    await rememberProfile('Profile 1', '个人')
    expect(s.data.node).toEqual({ nodeId: 'node_x', profileDir: 'Profile 1', profileName: '个人' })
    expect(new URLSearchParams(nodeQuery(await getNode())).get('profileName')).toBe('个人')
  })
})
