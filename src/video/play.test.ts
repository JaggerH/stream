import { describe, it, expect, vi, afterEach } from 'vitest'
import { proxyRangedStream } from './play.ts'

afterEach(() => vi.restoreAllMocks())

describe('proxyRangedStream', () => {
  it('透传 Range 并 relay 上游 body + 状态', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('partial', { status: 206, headers: { 'content-range': 'bytes 0-6/100' } }))
    const resp = await proxyRangedStream('https://cdn.test/v.mp4', { Referer: 'https://x/' }, 'bytes=0-6')
    expect(resp.status).toBe(206)
    expect(resp.headers.get('accept-ranges')).toBe('bytes')
    const call = spy.mock.calls[0]
    expect(call[0]).toBe('https://cdn.test/v.mp4')
    expect((call[1] as RequestInit).headers).toMatchObject({ Referer: 'https://x/', Range: 'bytes=0-6' })
  })
})
