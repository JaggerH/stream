import { describe, it, expect, afterEach } from 'vitest'
import { publicSource, setSourceSiteSource } from './public.ts'
import type { SourceManifest } from '../manifest/types.ts'

const m = {
  schema_version: 1, id: '@acme/demo/demo-home', adapter: 'replay', type: 'post', description: 'd', topics: [],
  params_schema: {}, auth: { type: 'none' }, capabilities: [], example_queries: [], facility: { key: 'demo', label: '演示' },
} as unknown as SourceManifest

describe('publicSource —— site 格', () => {
  afterEach(() => setSourceSiteSource(null))

  it('没挂站点查法 → 没有 site', () => {
    expect('site' in publicSource(m)).toBe(false)
  })

  it('包给出站点 → 带上 site；查法每次现取', () => {
    let domain = 'demo.example'
    setSourceSiteSource(() => (e) => (e.facility?.key === 'demo' ? { name: '演示', domain } : undefined))
    expect(publicSource(m).site).toEqual({ name: '演示', domain: 'demo.example' })
    domain = 'demo2.example'
    expect(publicSource(m).site?.domain).toBe('demo2.example')
    expect('site' in publicSource({ ...m, facility: { key: 'other', label: 'o' } })).toBe(false)
  })
})
