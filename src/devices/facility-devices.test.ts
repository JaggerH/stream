import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
