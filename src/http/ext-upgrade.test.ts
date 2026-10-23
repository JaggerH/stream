import { describe, expect, it } from 'vitest'
import { FOREIGN_NODE_CLOSE_CODE, resolveExtToken } from './ext-upgrade.ts'

const LOCAL = 'l'.repeat(64)
const PAIRED = 'p'.repeat(64)

function deps(nodeId?: string) {
  const row: { bindingId: string; nodeId?: string } = { bindingId: 'ext:a', ...(nodeId ? { nodeId } : {}) }
  const touched: string[] = []
  return {
    row,
    touched,
    d: {
      localToken: LOCAL,
      bindings: {
        bindingForToken: (t: string) => (t === PAIRED ? row : undefined),
        touch: (id: string) => { touched.push(id) },
        recordNode: (_id: string, n: string) => { row.nodeId = n },
      },
    },
  }
}

describe('resolveExtToken', () => {
  it('本机 token：带 nodeId → local:<nodeId>，不带 → 兼容槽 local', () => {
    const { d } = deps()
    expect(resolveExtToken(LOCAL, { nodeId: 'node_a' }, d)).toBe('local:node_a')
    expect(resolveExtToken(LOCAL, {}, d)).toBe('local')
  })

  it('配对 token 第一次带 nodeId：记进绑定', () => {
    const { d, row, touched } = deps()
    expect(resolveExtToken(PAIRED, { nodeId: 'node_a' }, d)).toBe('ext:a')
    expect(row.nodeId).toBe('node_a')
    expect(touched).toEqual(['ext:a'])
  })

  it('同一个节点重连照常放行', () => {
    const { d } = deps('node_a')
    expect(resolveExtToken(PAIRED, { nodeId: 'node_a' }, d)).toBe('ext:a')
  })

  it('【核心】token 被拷到另一个 profile：带着别的 nodeId 来连 → 4004，绑定仍属于原节点、不记 lastSeen', () => {
    const { d, row, touched } = deps('node_a')
    expect(resolveExtToken(PAIRED, { nodeId: 'node_b' }, d)).toEqual({ close: FOREIGN_NODE_CLOSE_CODE, reason: expect.any(String) })
    expect(row.nodeId).toBe('node_a')
    expect(touched).toEqual([])
  })

  it('不带 nodeId 的老扩展照旧放行', () => {
    const { d } = deps('node_a')
    expect(resolveExtToken(PAIRED, {}, d)).toBe('ext:a')
  })

  it('不认得的 token = null（401）', () => {
    expect(resolveExtToken('x'.repeat(64), { nodeId: 'node_a' }, deps().d)).toBeNull()
  })
})
