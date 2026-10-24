import { describe, it, expect } from 'vitest'
import { publicSource } from './public.ts'
import { SourceSites } from '../packages/item-projection.ts'
import type { SourceManifest } from '../manifest/types.ts'

const m = {
  schema_version: 1, id: '@acme/demo/demo-home', adapter: 'replay', type: 'post', description: 'd', topics: [],
  params_schema: {}, auth: { type: 'none' }, capabilities: [], example_queries: [], facility: { key: 'demo', label: '演示' },
} as unknown as SourceManifest

describe('publicSource —— site 格', () => {
  it('没给站点查法 → 没有 site', () => {
    expect('site' in publicSource(m)).toBe(false)
  })

  it('包给出站点 → 带上 site；查法每次现取', () => {
    let domain = 'demo.example'
    const sites = new SourceSites(() => (e) => (e.facility?.key === 'demo' ? { name: '演示', domain } : undefined))
    expect(publicSource(m, sites.lookup).site).toEqual({ name: '演示', domain: 'demo.example' })
    domain = 'demo2.example'
    expect(publicSource(m, sites.lookup).site?.domain).toBe('demo2.example')
    expect('site' in publicSource({ ...m, facility: { key: 'other', label: 'o' } }, sites.lookup)).toBe(false)
  })

  it('一个实例一张：A 认领的站点 B 查不到', () => {
    const a = new SourceSites(() => (e) => (e.facility?.key === 'demo' ? { name: 'A 站', domain: 'a.example' } : undefined))
    const b = new SourceSites(() => () => undefined)
    expect(publicSource(m, a.lookup).site).toEqual({ name: 'A 站', domain: 'a.example' })
    expect('site' in publicSource(m, b.lookup)).toBe(false)
  })
})
