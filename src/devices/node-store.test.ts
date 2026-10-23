import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeStore, recordNodeSeen } from './node-store.ts'

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

  it('recordNodeSeen：升级前的默认绑定连上 → 默认迁到它的节点，绑定表上的旧标记清掉', () => {
    const s = new NodeStore(fresh())
    let legacy: string | undefined = 'ext:a'
    const bindings = { defaultOf: () => legacy, clearDefault: (id: string) => { if (legacy === id) legacy = undefined } }
    recordNodeSeen(s, bindings, { nodeId: 'node_b', deviceId: 'linux:nas', bindingId: 'ext:b' })
    expect(s.defaultOf('linux:nas')).toBeUndefined()
    expect(legacy).toBe('ext:a')
    recordNodeSeen(s, bindings, { nodeId: 'node_a', deviceId: 'linux:nas', bindingId: 'ext:a' })
    expect(s.defaultOf('linux:nas')?.nodeId).toBe('node_a')
    expect(legacy).toBeUndefined()
  })
  it('claimProfile：写两格；同设备同目录的旧节点让位，别的设备不动', () => {
    const s = new NodeStore(fresh())
    s.seen({ nodeId: 'node_old', deviceId: 'local', bindingId: 'local:node_old', profileDir: 'Default', profileName: '旧' })
    s.seen({ nodeId: 'node_new', deviceId: 'local', bindingId: 'local:node_new' })
    s.seen({ nodeId: 'node_nas', deviceId: 'linux:nas', bindingId: 'ext:n', profileDir: 'Default', profileName: 'NAS' })
    expect(s.claimProfile('node_new', 'Default', '工作')).toMatchObject({ profileDir: 'Default', profileName: '工作' })
    expect(s.get('node_old')?.profileDir).toBeUndefined()
    expect(s.get('node_old')?.profileName).toBeUndefined()
    expect(s.get('node_nas')).toMatchObject({ profileDir: 'Default', profileName: 'NAS' })
    expect(s.claimProfile('node_missing', 'Default', 'x')).toBeUndefined()
  })

  it('renameProfile：按目录刷新显示名，只在那台设备上', () => {
    const s = new NodeStore(fresh())
    s.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a', profileDir: 'Profile 1', profileName: '个人' })
    s.seen({ nodeId: 'node_b', deviceId: 'linux:nas', bindingId: 'ext:b', profileDir: 'Profile 1', profileName: '个人' })
    expect(s.renameProfile('local', 'Profile 1', '家里')).toBe(1)
    expect(s.renameProfile('local', 'Profile 1', '家里')).toBe(0)
    expect(s.get('node_a')?.profileName).toBe('家里')
    expect(s.get('node_b')?.profileName).toBe('个人')
  })

  it('update：label / environment，null 或空串清空，缺席不动', () => {
    const s = new NodeStore(fresh())
    s.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a' })
    expect(s.update('node_a', { label: '公司电脑', environment: '工作' })).toMatchObject({ label: '公司电脑', environment: '工作' })
    expect(s.update('node_a', { environment: null })).toMatchObject({ label: '公司电脑' })
    expect(s.get('node_a')?.environment).toBeUndefined()
    expect(s.update('node_a', { label: '' })?.label).toBeUndefined()
    expect(s.update('node_x', { label: 'x' })).toBeUndefined()
  })

  it('woken_at：记下、列出、清掉；重开库还在', () => {
    const p = fresh()
    const s = new NodeStore(p)
    s.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a' })
    s.seen({ nodeId: 'node_b', deviceId: 'local', bindingId: 'local:node_b' })
    s.setWokenAt('node_a', 123)
    s.setWokenAt('node_x', 1) // 没有这个节点：什么都不做
    expect(s.woken().map((n) => n.nodeId)).toEqual(['node_a'])
    s.close()
    const t = new NodeStore(p)
    expect(t.get('node_a')?.wokenAt).toBe(123)
    t.setWokenAt('node_a', null)
    expect(t.get('node_a')?.wokenAt).toBeUndefined()
    expect(t.woken()).toEqual([])
  })
})
