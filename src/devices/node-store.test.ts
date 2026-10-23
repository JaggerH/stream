import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeStore } from './node-store.ts'

const fresh = () => join(mkdtempSync(join(tmpdir(), 'nodes-')), 'stream.db')

describe('NodeStore', () => {
  it('第一次连上建行，之后刷新绑定与 last_seen_at，不动 first_seen_at', () => {
    let t = 100
    const s = new NodeStore(fresh(), { now: () => t })
    const a = s.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a' })
    expect(a).toMatchObject({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a', isDefault: false, firstSeenAt: 100, lastSeenAt: 100 })
    t = 200
    const again = s.seen({ nodeId: 'node_a', deviceId: 'linux:nas', bindingId: 'ext:1' })
    expect(again).toMatchObject({ deviceId: 'linux:nas', bindingId: 'ext:1', firstSeenAt: 100, lastSeenAt: 200 })
    expect(s.byBinding('ext:1')?.nodeId).toBe('node_a')
  })

  it('profile 两格只在带了时覆盖——一次没带的握手不清掉认领记下的名字', () => {
    const s = new NodeStore(fresh())
    s.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a', profileDir: 'Profile 1', profileName: '工作' })
    expect(s.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a' })).toMatchObject({ profileDir: 'Profile 1', profileName: '工作' })
    expect(s.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a', profileName: '公司' }).profileName).toBe('公司')
  })

  it('forDevice / 默认节点每台设备至多一个', () => {
    const s = new NodeStore(fresh())
    s.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a' })
    s.seen({ nodeId: 'node_b', deviceId: 'local', bindingId: 'local:node_b' })
    s.seen({ nodeId: 'node_c', deviceId: 'linux:nas', bindingId: 'ext:c' })
    expect(s.forDevice('local').map((n) => n.nodeId)).toEqual(['node_a', 'node_b'])
    expect(s.setDefault('node_a')).toBe(true)
    expect(s.setDefault('node_c')).toBe(true)
    expect(s.defaultOf('local')?.nodeId).toBe('node_a')
    expect(s.setDefault('node_b')).toBe(true)
    expect(s.defaultOf('local')?.nodeId).toBe('node_b')
    expect(s.get('node_a')?.isDefault).toBe(false)
    expect(s.defaultOf('linux:nas')?.nodeId).toBe('node_c')
    expect(s.clearDefault('node_b')).toBe(true)
    expect(s.defaultOf('local')).toBeUndefined()
    expect(s.setDefault('node_zz')).toBe(false)
  })

  it('升级前的默认绑定在它的节点连上时迁到节点；同设备已有默认节点时不抢', () => {
    const s = new NodeStore(fresh())
    s.seen({ nodeId: 'node_a', deviceId: 'linux:nas', bindingId: 'ext:a', legacyDefault: true })
    expect(s.defaultOf('linux:nas')?.nodeId).toBe('node_a')
    s.seen({ nodeId: 'node_b', deviceId: 'linux:nas', bindingId: 'ext:b', legacyDefault: true })
    expect(s.defaultOf('linux:nas')?.nodeId).toBe('node_a')
  })

  it('落盘：重新打开仍在；表带着计划 4 / 5 才用的列', () => {
    const p = fresh()
    const s = new NodeStore(p)
    s.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a' })
    s.setDefault('node_a')
    s.close()
    expect(new NodeStore(p).defaultOf('local')?.nodeId).toBe('node_a')
    const cols = (new Database(p).prepare('PRAGMA table_info(browser_nodes)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['woken_at', 'label', 'environment', 'profile_dir', 'profile_name', 'is_default']))
  })
})
