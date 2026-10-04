import { describe, it, expect, vi } from 'vitest'
import { probeContentLength, fillCandidateSizes } from './transcode-candidates.ts'

describe('probeContentLength', () => {
  it('reads the total from a Range response content-range', async () => {
    const fetchImpl = vi.fn(async () => new Response('x', {
      status: 206,
      headers: { 'content-range': 'bytes 0-0/121168000' },
    })) as unknown as typeof fetch
    expect(await probeContentLength('u', undefined, fetchImpl)).toBe(121168000)
  })

  it('falls back to content-length when the server ignores Range (200 + full length)', async () => {
    const fetchImpl = vi.fn(async () => new Response('x', {
      status: 200,
      headers: { 'content-length': '999' },
    })) as unknown as typeof fetch
    expect(await probeContentLength('u', undefined, fetchImpl)).toBe(999)
  })

  it('returns undefined on an error status or a throw — never guesses', async () => {
    const bad = (async () => new Response('', { status: 412 })) as unknown as typeof fetch
    expect(await probeContentLength('u', undefined, bad)).toBeUndefined()
    const boom = (async () => { throw new Error('net') }) as unknown as typeof fetch
    expect(await probeContentLength('u', undefined, boom)).toBeUndefined()
  })

  it('sends the candidate headers (quark 412s without cookie+referer)', async () => {
    const seen: RequestInit[] = []
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      seen.push(init)
      return new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/5' } })
    }) as unknown as typeof fetch
    await probeContentLength('u', { cookie: 'c', referer: 'r' }, fetchImpl)
    expect((seen[0].headers as Record<string, string>).cookie).toBe('c')
    expect((seen[0].headers as Record<string, string>).range).toBe('bytes=0-0')
  })
})

describe('fillCandidateSizes', () => {
  it('probes only the candidates missing a size, leaving reported ones untouched', async () => {
    const probed: string[] = []
    const probe = async (url: string) => { probed.push(url); return 100 }
    const out = await fillCandidateSizes(
      [
        { resolution: 'low', url: 'a', sizeBytes: 42 },
        { resolution: 'high', url: 'b' },
      ],
      probe,
    )
    expect(probed).toEqual(['b'])
    expect(out.map((c) => c.sizeBytes)).toEqual([42, 100])
  })

  it('leaves a candidate size-less when the probe fails (it must stay out of the cheapest race)', async () => {
    const out = await fillCandidateSizes([{ resolution: 'x', url: 'b' }], async () => undefined)
    expect(out[0].sizeBytes).toBeUndefined()
  })
})
