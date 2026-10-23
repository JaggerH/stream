import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { FacilityDeviceStore } from './facility-devices.ts'

const fresh = () => join(mkdtempSync(join(tmpdir(), 'facdev-')), 'stream.db')

describe('FacilityDeviceStore', () => {
  it('set / get / list / clear', () => {
    const s = new FacilityDeviceStore(fresh())
    expect(s.get('eastmoney')).toBeUndefined()
    s.set('eastmoney', 'linux:nas')
    expect(s.get('eastmoney')).toBe('linux:nas')
    s.set('eastmoney', 'android:p')
    expect(s.list()).toEqual([{ facility: 'eastmoney', deviceId: 'android:p' }])
    expect(s.clear('eastmoney')).toBe(true)
    expect(s.clear('eastmoney')).toBe(false)
  })

  it('绑定到 local 等于清除', () => {
    const s = new FacilityDeviceStore(fresh())
    s.set('eastmoney', 'linux:nas')
    s.set('eastmoney', 'local')
    expect(s.get('eastmoney')).toBeUndefined()
  })

  it('重开库还在', () => {
    const p = fresh()
    const a = new FacilityDeviceStore(p)
    a.set('eastmoney', 'linux:nas')
    a.close()
    expect(new FacilityDeviceStore(p).get('eastmoney')).toBe('linux:nas')
  })
})

describe('FacilityDeviceStore：身份与环境目标（browser-identity D7）', () => {
  it('三种目标各存一格；list 只列设备目标、targets 全列', () => {
    const s = new FacilityDeviceStore(fresh())
    s.set('eastmoney', 'linux:nas')
    s.setTarget('xhs', { kind: 'identity', accountId: 'u1' })
    s.setTarget('bilibili', { kind: 'environment', environment: '个人' })
    expect(s.target('xhs')).toEqual({ kind: 'identity', accountId: 'u1' })
    expect(s.target('bilibili')).toEqual({ kind: 'environment', environment: '个人' })
    expect(s.target('eastmoney')).toEqual({ kind: 'device', deviceId: 'linux:nas' })
    expect(s.target('douyin')).toBeUndefined()
    // get 只回设备：读 get 的地方只有设备语义的那几处（cookie 域反查、面板的设备下拉）
    expect(s.get('xhs')).toBeUndefined()
    expect(s.list()).toEqual([{ facility: 'eastmoney', deviceId: 'linux:nas' }])
    expect(s.targets()).toEqual([
      { facility: 'bilibili', target: { kind: 'environment', environment: '个人' } },
      { facility: 'eastmoney', target: { kind: 'device', deviceId: 'linux:nas' } },
      { facility: 'xhs', target: { kind: 'identity', accountId: 'u1' } },
    ])
  })

  it('换目标种类：旧的那格清掉，恰好一格', () => {
    const s = new FacilityDeviceStore(fresh())
    s.set('xhs', 'linux:nas')
    s.setTarget('xhs', { kind: 'environment', environment: '工作' })
    expect(s.target('xhs')).toEqual({ kind: 'environment', environment: '工作' })
    s.setTarget('xhs', { kind: 'device', deviceId: 'local' })
    expect(s.target('xhs')).toBeUndefined()
  })

  it('老库（device_id NOT NULL、没有新列）原地升级，绑定还在', () => {
    const p = fresh()
    const db = new Database(p)
    db.exec('CREATE TABLE facility_devices (facility TEXT PRIMARY KEY, device_id TEXT NOT NULL)')
    db.prepare('INSERT INTO facility_devices VALUES (?, ?)').run('eastmoney', 'linux:nas')
    db.close()
    const s = new FacilityDeviceStore(p)
    expect(s.get('eastmoney')).toBe('linux:nas')
    s.setTarget('xhs', { kind: 'identity', accountId: 'u1' })
    expect(s.target('xhs')).toEqual({ kind: 'identity', accountId: 'u1' })
    s.close()
    // 再开一次不再迁移、数据不变
    expect(new FacilityDeviceStore(p).targets()).toHaveLength(2)
  })

  it('库里同时有两格的行（手改）被 CHECK 拒', () => {
    const p = fresh()
    new FacilityDeviceStore(p).close()
    const db = new Database(p)
    expect(() => db.prepare('INSERT INTO facility_devices (facility, device_id, account_id) VALUES (?, ?, ?)').run('x', 'd', 'a')).toThrow()
    db.close()
  })
})
