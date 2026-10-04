import { describe, it, expect, vi, afterEach } from 'vitest'
import { CloudflareAdapter } from './adapter.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

afterEach(() => vi.unstubAllGlobals())

const m = { id: '@streamapp/cloudflare/cf-whisper' } as unknown as SourceManifest
const input = { bytes: new Uint8Array([1, 2, 3]), mime: 'audio/mpeg' }
const keys = { runtimeConfig: { apiKey: 'tok', accountId: 'acct' } }

// 搬家等价：这几条是搬前 src/transcribe/sources.test.ts 里 makeCfWhisperFn 的同一组用例，
// 只是钥匙从宿主 tokenProvider + 环境变量换成了 context.runtimeConfig。
describe('CloudflareAdapter (cf-whisper)', () => {
  it('declines (→[]) when the token or the account id is not configured', async () => {
    const a = new CloudflareAdapter()
    expect(await a.fetch({ ...input, tokenName: 'cloudflare' }, m, { runtimeConfig: {} })).toEqual([])
    expect(await a.fetch(input, m, { runtimeConfig: { apiKey: 'tok' } })).toEqual([])
    expect(await a.fetch(input, m, { runtimeConfig: { accountId: 'acct' } })).toEqual([])
  })

  it('declines when diarize is requested (CF cannot diarize)', async () => {
    expect(await new CloudflareAdapter().fetch({ ...input, opts: { diarize: true } }, m, keys)).toEqual([])
  })

  it('declines a >20MB input without calling the backend', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await new CloudflareAdapter().fetch({ bytes: new Uint8Array(21 * 1024 * 1024), mime: 'audio/mpeg' }, m, keys)).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns [TranscribeResult] on success, calling the account-scoped endpoint with the key', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ success: true, result: { text: '你好', segments: [] } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const out = await new CloudflareAdapter().fetch(input, m, keys)
    expect(out).toHaveLength(1)
    expect((out[0] as { text: string }).text).toBe('你好')
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/accounts/acct/ai/run/')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('an upstream failure throws (decline means "yield", not "tried and failed")', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })))
    await expect(new CloudflareAdapter().fetch(input, m, keys)).rejects.toThrow(/500/)
  })
})
