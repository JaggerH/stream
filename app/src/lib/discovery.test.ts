import { describe, expect, it, vi } from 'vitest'
import { backendCandidates, resolveBackend } from './discovery.ts'

describe('backendCandidates order', () => {
  it('configured remote 先试，同源哨兵兜底', () => {
    expect(backendCandidates({ configuredUrl: 'http://remote:9' })).toEqual(['http://remote:9', ''])
  })
  it('without configured: same-origin sentinel ""', () => {
    expect(backendCandidates({})).toEqual([''])
  })
})

describe('resolveBackend health-gate', () => {
  it('configured upstream 健康 → 直取它（HTTP 原样、WS 换 scheme）', async () => {
    const probe = vi.fn(async (u: string) => u === 'http://remote:9')
    const r = await resolveBackend({ configuredUrl: 'http://remote:9', probe })
    expect(probe).toHaveBeenNthCalledWith(1, 'http://remote:9')
    expect(r).toEqual({
      httpBase: 'http://remote:9',
      wsBase: 'ws://remote:9',
      upstream: 'http://remote:9',
    })
  })
  it('configured upstream 不健康 → 回落同源', async () => {
    const r = await resolveBackend({ configuredUrl: 'http://remote:9', probe: async () => false })
    expect(r).toEqual({ httpBase: '', wsBase: '', upstream: '' })
  })
  it('same-origin sentinel resolves without probing', async () => {
    const probe = vi.fn(async () => false)
    const r = await resolveBackend({ probe })
    expect(r).toEqual({ httpBase: '', wsBase: '', upstream: '' })
    expect(probe).not.toHaveBeenCalled()
  })
})
