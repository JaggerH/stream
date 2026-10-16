import { describe, it, expect, vi } from 'vitest'
import { openSession, getRepoBid1, SessionExpired } from './client.ts'

describe('eastmoney client uses the injected fetch', () => {
  it('openSession 读 validatekey，用的是传入的 fetch', async () => {
    const f = vi.fn(async () => new Response('<input id="em_validatekey" value="k-123">'))
    const s = await openSession('c=1', f as never)
    expect(s.validatekey).toBe('k-123')
    expect(f).toHaveBeenCalledOnce()
    expect((f.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: 'manual' })
  })

  it('302 → SessionExpired', async () => {
    const f = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/Login' } }))
    await expect(openSession('c=1', f as never)).rejects.toBeInstanceOf(SessionExpired)
  })

  it('getRepoBid1 用传入的 fetch', async () => {
    const f = vi.fn(async () => Response.json({ name: 'GC001', fivequote: { buy1: '1.85' } }))
    expect(await getRepoBid1('204001', f as never)).toBe(1.85)
    expect(f).toHaveBeenCalledOnce()
  })
})
