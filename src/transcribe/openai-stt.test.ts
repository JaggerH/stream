import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAiCompatBackend, type SttChunk } from './openai-stt.ts'
import type { DebugEntry } from '../debug.ts'

afterEach(() => vi.unstubAllGlobals())

const bytes = new Uint8Array([1, 2, 3, 4])

/** What planSttChunks really emits (mono/16k/32kbps AAC in mp4). Chunks declare it; the upload
 *  must mirror it. */
const m4a = { ext: 'm4a', mime: 'audio/mp4' } as const

/** One injected chunk with the real compressed format declared on it. */
const oneChunk = async (): Promise<SttChunk[]> => [{ startS: 0, bytes, format: { ...m4a } }]

/** verbose_json response body for one chunk. */
function verbose(segments: { start: number; end: number; text: string }[], language = 'zh'): Response {
  const text = segments.map((s) => s.text).join('\n')
  return new Response(JSON.stringify({ text, language, segments }), { status: 200 })
}

describe('OpenAiCompatBackend.transcribe', () => {
  it('single chunk: posts multipart to <base>/audio/transcriptions with model + Bearer, parses segments', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init }
        return verbose([{ start: 0, end: 2, text: '你好' }])
      }),
    )
    const backend = new OpenAiCompatBackend('https://api.groq.com/openai/v1', 'whisper-large-v3', 'sk-tok', {
      chunkAudio: oneChunk, // inject: one chunk, no ffmpeg
    })
    const res = await backend.transcribe(bytes, 'audio/mp4')

    expect(captured!.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    const headers = captured!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-tok')
    const fd = captured!.init.body as FormData
    expect(fd.get('model')).toBe('whisper-large-v3')
    expect(fd.get('response_format')).toBe('verbose_json')
    expect(fd.get('file')).toBeInstanceOf(Blob)

    expect(res.text).toBe('你好')
    expect(res.lang).toBe('zh')
    expect(res.segments).toEqual([{ start: 0, end: 2, text: '你好' }])
  })

  it('translate → posts to /audio/translations instead, with the same chunk-format filename + mime', async () => {
    let url = ''
    let captured: FormData | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init: RequestInit) => {
        url = u
        captured = init.body as FormData
        return verbose([{ start: 0, end: 1, text: 'hi' }])
      }),
    )
    const backend = new OpenAiCompatBackend('https://api.openai.com/v1', 'whisper-1', 'sk', {
      chunkAudio: oneChunk,
    })
    await backend.transcribe(bytes, 'video/mp4', 'audio', undefined, { translate: true })
    expect(url).toBe('https://api.openai.com/v1/audio/translations')
    const file = captured!.get('file') as File
    expect(file.name).toBe('audio.m4a')
    expect(file.type).toBe('audio/mp4')
  })

  it('multi-chunk: transcribes each and offsets later-chunk segment times by chunk.startS', async () => {
    const bodies = [
      verbose([{ start: 0, end: 5, text: 'a' }]),
      verbose([{ start: 0, end: 5, text: 'b' }]),
    ]
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => bodies[call++]))
    const backend = new OpenAiCompatBackend('https://x/v1', 'm', 'tok', {
      // two 600s chunks
      chunkAudio: async (): Promise<SttChunk[]> => [
        { startS: 0, bytes, format: { ...m4a } },
        { startS: 600, bytes, format: { ...m4a } },
      ],
    })
    const res = await backend.transcribe(bytes, 'audio/mp4')
    expect(res.segments).toEqual([
      { start: 0, end: 5, text: 'a' },
      { start: 600, end: 605, text: 'b' }, // second chunk offset by 600s
    ])
    expect(res.text).toBe('a\nb')
  })

  it('reports the chunk plan on the debug bus before uploading (the split branch is otherwise invisible)', async () => {
    const entries: DebugEntry[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => verbose([{ start: 0, end: 5, text: 'a' }])),
    )
    const backend = new OpenAiCompatBackend('https://x/v1', 'm', 'tok', {
      onDebug: (e) => entries.push(e),
      chunkAudio: async (): Promise<SttChunk[]> => [
        { startS: 0, bytes: new Uint8Array(2_400_000), format: { ...m4a } },
        { startS: 600, bytes: new Uint8Array(2_400_000), format: { ...m4a } },
      ],
    })
    await backend.transcribe(bytes, 'audio/mp4')

    // Emitted BEFORE the uploads, so a run that dies mid-upload still tells us it was chunked.
    const plan = entries.find((e) => e.key.endsWith(':plan'))!
    expect(plan.channel).toBe('stt')
    expect(plan.summary).toContain('2 块')
    expect(plan.fields.find((f) => f.label === 'chunks')!.value).toBe('2')
    expect(plan.fields.find((f) => f.label === 'starts')!.value).toBe('0s, 600s')
  })

  it('reports per-chunk upload wall-clock on the debug bus (answers the fetch-timeout question)', async () => {
    const entries: DebugEntry[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => verbose([{ start: 0, end: 5, text: 'a' }])),
    )
    const backend = new OpenAiCompatBackend('https://x/v1', 'm', 'tok', {
      onDebug: (e) => entries.push(e),
      chunkAudio: async (): Promise<SttChunk[]> => [
        { startS: 0, bytes, format: { ...m4a } },
        { startS: 600, bytes, format: { ...m4a } },
      ],
    })
    await backend.transcribe(bytes, 'audio/mp4')

    const done = entries.find((e) => e.key.endsWith(':done'))!
    expect(done.channel).toBe('stt')
    expect(done.ok).toBe(true)
    // one row per chunk, each carrying the upload's own wall-clock — a single roll-up would hide
    // the one slow chunk that is exactly what the timeout question is about
    expect(done.fields.filter((f) => /^chunk#\d+$/.test(f.label))).toHaveLength(2)
    expect(done.fields.find((f) => f.label === 'chunk#1')!.value).toMatch(/start 600s · .* · \d+ms$/)
  })

  it('a chunk failing still reports the plan, so a mid-run death is not silent', async () => {
    const entries: DebugEntry[] = []
    let n = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1
        return n === 1 ? verbose([{ start: 0, end: 1, text: 'a' }]) : new Response('nope', { status: 500 })
      }),
    )
    const backend = new OpenAiCompatBackend('https://x/v1', 'm', 'tok', {
      onDebug: (e) => entries.push(e),
      chunkAudio: async (): Promise<SttChunk[]> => [
        { startS: 0, bytes, format: { ...m4a } },
        { startS: 600, bytes, format: { ...m4a } },
      ],
    })
    await backend.transcribe(bytes, 'audio/mp4').catch(() => {})
    expect(entries.some((e) => e.key.endsWith(':plan'))).toBe(true)
  })

  it('a chunk failing throws (no half result) so the ladder can fail over', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++
        return call === 1 ? verbose([{ start: 0, end: 5, text: 'a' }]) : new Response('nope', { status: 500 })
      }),
    )
    const backend = new OpenAiCompatBackend('https://x/v1', 'm', 'tok', {
      chunkAudio: async (): Promise<SttChunk[]> => [
        { startS: 0, bytes, format: { ...m4a } },
        { startS: 600, bytes, format: { ...m4a } },
      ],
    })
    await expect(backend.transcribe(bytes, 'audio/mp4')).rejects.toThrow(/HTTP 500/)
  })
})

describe('OpenAiCompatBackend upload naming', () => {
  /** Capture the multipart file of a single-chunk transcribe call. */
  async function upload(
    sourceMime: string,
    filename?: string,
    format: { ext: string; mime: string } = { ...m4a },
  ): Promise<File> {
    let captured: FormData | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        captured = init.body as FormData
        return verbose([{ start: 0, end: 1, text: 'x' }])
      }),
    )
    const backend = new OpenAiCompatBackend('https://x/v1', 'm', 'tok', {
      chunkAudio: async (): Promise<SttChunk[]> => [{ startS: 0, bytes, format }],
    })
    await backend.transcribe(bytes, sourceMime, filename)
    return captured!.get('file') as File
  }

  it('names the upload after the chunk format, not the source media mime (Whisper sniffs the extension)', async () => {
    // 抖音那种源是视频；切块后上传的其实是 aac/m4a。没扩展名 + video mime = Groq 400。
    const file = await upload('video/mp4')
    expect(file.name).toBe('audio.m4a')
    expect(file.type).toBe('audio/mp4')
    expect(file.type).not.toBe('video/mp4')
  })

  it('a caller-supplied filename keeps its stem but gets the chunk format extension', async () => {
    const file = await upload('video/webm', 'clip.webm')
    expect(file.name).toBe('clip.m4a')
    expect(file.type).toBe('audio/mp4')
  })

  it('follows the chunk declaration when the encoder emits something else', async () => {
    const file = await upload('video/mp4', 'audio', { ext: 'wav', mime: 'audio/wav' })
    expect(file.name).toBe('audio.wav')
    expect(file.type).toBe('audio/wav')
  })
})

describe('OpenAiCompatBackend error reporting', () => {
  /** `make` runs per call — a Response body can only be read once. */
  function backendWith(make: () => unknown): OpenAiCompatBackend {
    vi.stubGlobal('fetch', vi.fn(async () => make()))
    return new OpenAiCompatBackend('https://x/v1', 'm', 'tok', { chunkAudio: oneChunk })
  }

  it('carries the response body into the thrown error (a bare status code is undebuggable)', async () => {
    const body = JSON.stringify({ error: { message: 'could not process file', type: 'invalid_request_error' } })
    const backend = backendWith(() => new Response(body, { status: 400 }))
    const err = await backend.transcribe(bytes, 'video/mp4').catch((e: Error) => e)
    expect((err as Error).message).toMatch(/HTTP 400/)
    expect((err as Error).message).toMatch(/could not process file/)
  })

  it('truncates a huge body so the debug bus / miss reason cannot explode', async () => {
    const backend = backendWith(() => new Response('x'.repeat(5000), { status: 413 }))
    const err = await backend.transcribe(bytes, 'video/mp4').catch((e: Error) => e)
    expect((err as Error).message).toMatch(/HTTP 413/)
    expect((err as Error).message.length).toBeLessThan(700)
    expect((err as Error).message).toContain('xxxxx')
  })

  it('still reports the status when the body itself cannot be read', async () => {
    const backend = backendWith(() => ({
      ok: false,
      status: 400,
      text: async () => {
        throw new Error('body stream already read')
      },
    }))
    const err = await backend.transcribe(bytes, 'video/mp4').catch((e: Error) => e)
    expect((err as Error).message).toMatch(/HTTP 400/)
    expect((err as Error).message).not.toMatch(/body stream already read/)
  })
})

// whisper 在静音/音乐上不会说"没听见"，它会编一句出来（实测 Groq：20 秒静音 → " you"）。
// 判据与实测读数在 `no-speech.ts`；这里钉的是**这条腿真的用了它**，以及丢弃不静默。
describe('OpenAiCompatBackend.transcribe — 编造的段筛掉', () => {
  const raw = (segments: unknown[]) =>
    new Response(JSON.stringify({ text: '整条兜底文本', language: 'zh', segments }), { status: 200 })

  it('静音上编出来的那段不进转写，真话照常留下', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => raw([
      { start: 0, end: 2, text: '真正说的话', no_speech_prob: 0.23, avg_logprob: -0.08, compression_ratio: 1.2 },
      { start: 2, end: 3, text: ' you', no_speech_prob: 0.7, avg_logprob: -0.71, compression_ratio: 0.33 },
    ])))
    const backend = new OpenAiCompatBackend('https://x/v1', 'm', 't', { chunkAudio: oneChunk })
    const r = await backend.transcribe(bytes, 'video/mp4')
    expect(r.segments?.map((s) => s.text)).toEqual(['真正说的话'])
    expect(r.dropped?.map((d) => d.reason)).toEqual(['no_speech'])
  })

  // 整块都是编的时候，绝不能退回去用 `j.text`——那是**没经过筛**的整条兜底文本，
  // 用它等于把刚丢掉的编造原样放回来。
  it('整块都是编的 → 文本为空，不退回未经筛的兜底文本', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => raw([
      { start: 0, end: 1, text: ' you', no_speech_prob: 0.7, avg_logprob: -0.71, compression_ratio: 0.33 },
    ])))
    const backend = new OpenAiCompatBackend('https://x/v1', 'm', 't', { chunkAudio: oneChunk })
    const r = await backend.transcribe(bytes, 'video/mp4')
    expect(r.text).toBe('')
    expect(r.segments).toEqual([])
    expect(r.dropped).toHaveLength(1)
  })

  // 没有判据字段的后端（本地/其他 API）必须照常通过——缺信息不等于没有语音。
  it('返回不带判据字段 → 一段不丢', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => raw([{ start: 0, end: 2, text: '正常的一句话' }])))
    const backend = new OpenAiCompatBackend('https://x/v1', 'm', 't', { chunkAudio: oneChunk })
    const r = await backend.transcribe(bytes, 'video/mp4')
    expect(r.segments?.map((s) => s.text)).toEqual(['正常的一句话'])
    expect(r.dropped).toEqual([])
  })

  it('丢弃在 debug 总线上留痕，带原始读数', async () => {
    const seen: DebugEntry[] = []
    vi.stubGlobal('fetch', vi.fn(async () => raw([
      { start: 0, end: 1, text: ' you', no_speech_prob: 0.7, avg_logprob: -0.71, compression_ratio: 0.33 },
    ])))
    const backend = new OpenAiCompatBackend('https://x/v1', 'm', 't', { chunkAudio: oneChunk, onDebug: (e) => seen.push(e) })
    await backend.transcribe(bytes, 'video/mp4')
    const entry = seen.find((e) => e.key?.startsWith('dropped:'))
    expect(entry).toBeTruthy()
    expect(JSON.stringify(entry)).toContain('no_speech=0.7')
  })
})
