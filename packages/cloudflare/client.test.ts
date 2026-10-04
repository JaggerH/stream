import { describe, it, expect, vi, afterEach } from 'vitest'
import { CloudflareBackend } from './client.ts'

afterEach(() => vi.unstubAllGlobals())

describe('CloudflareBackend', () => {
  it('sets task=translate when opts.translate', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ success: true, result: { text: 'hi', segments: [] } }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const b = new CloudflareBackend('a', 't')
    await b.transcribe(new Uint8Array([1]), 'audio/mpeg', 'f', undefined, { translate: true })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ audio: 'AQ==', task: 'translate' })
  })

  it('posts base64 audio and maps the CF response to TranscribeResult', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              text: 'ignored top-level',
              segments: [
                { start: 0, end: 1.5, text: ' 来了 ' },
                { start: 1.5, end: 2, text: '' }, // blank dropped
                { start: 2, end: 3, text: '大空头' },
              ],
            },
          }),
          { status: 200 }
        )
    )
    vi.stubGlobal('fetch', fetchMock)

    const b = new CloudflareBackend('acct123', 'tok456')
    const res = await b.transcribe(new Uint8Array([1, 2, 3]), 'audio/mpeg')

    // request shape
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/openai/whisper-large-v3-turbo')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok456')
    expect(JSON.parse(init.body as string)).toEqual({ audio: 'AQID', task: 'transcribe' }) // base64 of [1,2,3]

    // response mapping: blank segment dropped, text = newline-join of segments
    expect(res.segments).toEqual([
      { start: 0, end: 1.5, text: '来了' },
      { start: 2, end: 3, text: '大空头' },
    ])
    expect(res.text).toBe('来了\n大空头')
  })

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })))
    const b = new CloudflareBackend('a', 't')
    await expect(b.transcribe(new Uint8Array([1]), 'audio/mpeg')).rejects.toThrow(/HTTP 401/)
  })

  it('throws when success is false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ code: 8007 }] }), { status: 200 }))
    )
    const b = new CloudflareBackend('a', 't')
    await expect(b.transcribe(new Uint8Array([1]), 'audio/mpeg')).rejects.toThrow(/8007/)
  })
})
