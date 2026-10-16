import { describe, it, expect } from 'vitest'
import { packageNetwork } from './network-index.ts'

describe('packageNetwork', () => {
  it('hosts 缺省 = credentials，facility 缺省 = id', () => {
    expect(packageNetwork({ id: 'eastmoney', credentials: ['eastmoneysec.com'] }))
      .toEqual({ packageId: 'eastmoney', facility: 'eastmoney', hosts: ['eastmoneysec.com'] })
  })
  it('显式声明优先', () => {
    expect(packageNetwork({ id: 'x', facility: 'xf', credentials: ['a.com'], network: { hosts: ['b.com'] } }))
      .toEqual({ packageId: 'x', facility: 'xf', hosts: ['b.com'] })
  })
  it('什么都没声明 = 空清单（这样的包派不到远程设备）', () => {
    expect(packageNetwork({ id: 'y' }).hosts).toEqual([])
  })
})
