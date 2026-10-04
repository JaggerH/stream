import { describe, expect, it, vi, afterEach } from 'vitest'

import { selectTransport, webTransport } from './transport.ts'

describe('selectTransport', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('→ webTransport (native fetch)', async () => {
    const t = selectTransport()
    expect(t).toBe(webTransport)
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    await t.fetch('http://x/api/health')
    expect(spy).toHaveBeenCalledWith('http://x/api/health', undefined)
  })
})
