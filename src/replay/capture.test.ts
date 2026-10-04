import { describe, it, expect } from 'vitest'
import { captureXhr, type CaptureContext, type CapturedXhr } from './capture.ts'

/** Fake context: emits canned responses synchronously when goto is called. */
function fakeContext(emit: CapturedXhr[]): CaptureContext {
  let cb: ((r: CapturedXhr) => void) | undefined
  return {
    onResponse(fn) { cb = fn },
    async newPage() {
      return {
        async goto() {
          for (const r of emit) cb?.(r)
          return undefined
        },
      }
    },
    async close() {},
  }
}

const xhr = (over: Partial<CapturedXhr>): CapturedXhr => ({
  url: 'https://x/api', method: 'GET', status: 200, requestHeaders: {}, json: { ok: true }, ...over,
})

describe('captureXhr', () => {
  it('collects the JSON XHRs fired on load', async () => {
    const ctx = fakeContext([xhr({ url: 'https://x/api/a' }), xhr({ url: 'https://x/api/b' })])
    const out = await captureXhr(ctx, 'https://x/', {}, { settle: async () => {} })
    expect(out.map((r) => r.url)).toEqual(['https://x/api/a', 'https://x/api/b'])
  })

  it('dedups by method+url (last write wins)', async () => {
    const ctx = fakeContext([
      xhr({ url: 'https://x/api/a', json: { v: 1 } }),
      xhr({ url: 'https://x/api/a', json: { v: 2 } }),
    ])
    const out = await captureXhr(ctx, 'https://x/', {}, { settle: async () => {} })
    expect(out).toHaveLength(1)
    expect(out[0].json).toEqual({ v: 2 })
  })
})
