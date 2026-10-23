import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiteIdentityStore } from './identity-store.ts'

const open = (path = join(mkdtempSync(join(tmpdir(), 'identities-')), 'stream.db'), now = () => 1000) => new SiteIdentityStore(path, { now })

describe('SiteIdentityStore', () => {
  it('signed-in 写入；unknown 不写', () => {
    const s = open()
    expect(s.record('xhs', 'node_a', { state: 'unknown', reason: 'x' }).written).toBe(false)
    expect(s.get('xhs', 'node_a')).toBeUndefined()
    s.record('xhs', 'node_a', { state: 'signed-in', accountId: 'A', name: '个人号' })
    expect(s.get('xhs', 'node_a')).toEqual({ facility: 'xhs', nodeId: 'node_a', accountId: 'A', displayName: '个人号', state: 'signed-in', verifiedAt: 1000 })
  })

  it('signed-out 保留上次的账号 id；unknown 不动已有记录', () => {
    let t = 1000
    const s = open(undefined, () => t)
    s.record('xhs', 'node_a', { state: 'signed-in', accountId: 'A' })
    t = 2000
    s.record('xhs', 'node_a', { state: 'unknown', reason: '节点断开' })
    expect(s.get('xhs', 'node_a')).toMatchObject({ state: 'signed-in', verifiedAt: 1000 })
    const r = s.record('xhs', 'node_a', { state: 'signed-out' })
    expect(r.before).toMatchObject({ accountId: 'A', state: 'signed-in' })
    expect(s.get('xhs', 'node_a')).toEqual({ facility: 'xhs', nodeId: 'node_a', accountId: 'A', displayName: 'A', state: 'signed-out', verifiedAt: 2000 })
  })

  it('从没见过账号就登出：记一条没有账号的登出', () => {
    const s = open()
    s.record('bilibili', 'node_a', { state: 'signed-out' })
    expect(s.get('bilibili', 'node_a')).toEqual({ facility: 'bilibili', nodeId: 'node_a', state: 'signed-out', verifiedAt: 1000 })
  })

  it('同一账号可以登在两个节点上；换号覆盖；重开库数据仍在', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'identities-')), 'stream.db')
    const s = open(path)
    s.record('xhs', 'node_home', { state: 'signed-in', accountId: 'A' })
    s.record('xhs', 'node_laptop', { state: 'signed-in', accountId: 'A' })
    s.record('xhs', 'node_work', { state: 'signed-in', accountId: 'B' })
    s.record('xhs', 'node_work', { state: 'signed-in', accountId: 'A' })
    s.close()
    const again = open(path)
    expect(again.list({ facility: 'xhs' }).filter((i) => i.accountId === 'A').map((i) => i.nodeId)).toEqual(['node_home', 'node_laptop', 'node_work'])
    expect(again.list({ nodeId: 'node_work' })).toHaveLength(1)
  })
})
