import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeOpenAiSttFn, type TranscribeInput } from './sources.ts'

afterEach(() => vi.unstubAllGlobals())

const input: TranscribeInput = { bytes: new Uint8Array([1, 2, 3]), mime: 'audio/mpeg' }

describe('makeOpenAiSttFn (groq / openai members)', () => {
  const backendUrl = 'https://api.groq.com/openai/v1'
  const model = 'whisper-large-v3'

  it('declines (→[]) when no key is configured — member not in play, ladder slides on', async () => {
    const backend = { transcribe: vi.fn() }
    const fn = makeOpenAiSttFn({
      tokenProvider: { token: () => null },
      tokenName: 'groq',
      baseUrl: backendUrl,
      model,
      makeBackend: () => backend,
    })
    expect(await fn(input, { tokenName: 'groq' })).toEqual([])
    expect(backend.transcribe).not.toHaveBeenCalled()
  })

  it('declines when diarize is requested (ASR only — voiceprint engine diarizes)', async () => {
    const backend = { transcribe: vi.fn() }
    const fn = makeOpenAiSttFn({
      tokenProvider: { token: () => 'sk' },
      tokenName: 'groq',
      baseUrl: backendUrl,
      model,
      makeBackend: () => backend,
    })
    expect(await fn({ ...input, opts: { diarize: true } }, { tokenName: 'groq' })).toEqual([])
    expect(backend.transcribe).not.toHaveBeenCalled()
  })

  it('with key → builds the backend with baseUrl+model+token and returns [TranscribeResult]', async () => {
    let seen: { baseUrl: string; model: string; token: string } | undefined
    const backend = { transcribe: vi.fn(async () => ({ text: '你好', segments: [] })) }
    const fn = makeOpenAiSttFn({
      tokenProvider: { token: (n: string) => (n === 'groq' ? 'sk-live' : null) },
      tokenName: 'groq',
      baseUrl: backendUrl,
      model,
      makeBackend: (baseUrl, model, token) => {
        seen = { baseUrl, model, token }
        return backend
      },
    })
    const out = await fn(input, { tokenName: 'groq' })
    expect(seen).toEqual({ baseUrl: backendUrl, model, token: 'sk-live' })
    expect(out).toHaveLength(1)
    expect((out[0] as { text: string }).text).toBe('你好')
  })
})

/** 通用档：宿主不认识任何一家 STT 服务，端点 / 模型 / 钥匙名全从 manifest 的 fixed_params 来
 *  （builtin adapter 把 fixed_params ⊕ 成员 params 合成 params 递进来）。 */
describe('makeOpenAiSttFn — endpoint declared by the manifest (generic mode)', () => {
  const declared = { baseUrl: 'https://stt.example/openai/v1', model: 'whisper-x', tokenName: 'acme' }

  it('builds the backend from params alone — no host-side defaults', async () => {
    let seen: { baseUrl: string; model: string; token: string } | undefined
    const backend = { transcribe: vi.fn(async () => ({ text: 'ok', segments: [] })) }
    const fn = makeOpenAiSttFn({
      tokenProvider: { token: (n: string) => (n === 'acme' ? 'sk-acme' : null) },
      makeBackend: (baseUrl, model, token) => {
        seen = { baseUrl, model, token }
        return backend
      },
    })
    const out = await fn(input, { mode: 'transcribe-openai-compat', ...declared })
    expect(seen).toEqual({ baseUrl: declared.baseUrl, model: declared.model, token: 'sk-acme' })
    expect(out).toHaveLength(1)
  })

  it('declines when the declared key is absent (ladder slides on)', async () => {
    const backend = { transcribe: vi.fn() }
    const fn = makeOpenAiSttFn({ tokenProvider: { token: () => null }, makeBackend: () => backend })
    expect(await fn(input, declared)).toEqual([])
    expect(backend.transcribe).not.toHaveBeenCalled()
  })

  it('throws (not declines) when the manifest forgot baseUrl / model / tokenName — a broken declaration must be loud', async () => {
    const fn = makeOpenAiSttFn({ tokenProvider: { token: () => 'sk' }, makeBackend: () => ({ transcribe: vi.fn() }) })
    await expect(fn(input, { model: 'm', tokenName: 'acme' })).rejects.toThrow(/baseUrl/)
    await expect(fn(input, { baseUrl: 'https://x/v1', tokenName: 'acme' })).rejects.toThrow(/model/)
    await expect(fn(input, { baseUrl: 'https://x/v1', model: 'm' })).rejects.toThrow(/tokenName/)
  })
})
