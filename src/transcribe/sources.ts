import type { BuiltinFn } from '../adapters/builtin/adapter.ts'
import type { TokenProvider } from '../credentials/token-provider.ts'
import type { DebugEntry } from '../debug.ts'
import { OpenAiCompatBackend } from './openai-stt.ts'
import type { TranscribeResult } from './client.ts'

/** The invoke input for the transcribe Provider — media resolved by the async layer. */
export interface TranscribeInput {
  bytes: Uint8Array
  mime: string
  opts?: { diarize?: boolean; translate?: boolean }
}

const asInput = (i: unknown): TranscribeInput => i as TranscribeInput

/** Minimal shape the member fn needs from an OpenAI-compatible STT backend. */
type SttBackend = {
  transcribe: (
    bytes: Uint8Array,
    mime: string,
    filename?: string,
    signal?: AbortSignal,
    opts?: { translate?: boolean }
  ) => Promise<TranscribeResult>
}

/** OpenAI-compatible cloud STT source — BYOK. One implementation for every vendor that speaks
 *  `/audio/transcriptions`: they differ only by baseUrl + model + which key. Those three come from
 *  `params` first (the manifest's `fixed_params` ⊕ the member's params — that is how a package
 *  declares its own endpoint without the host knowing the vendor), then from `deps` (the host's
 *  own pre-wired instances). A declaration missing any of the three **throws**: a broken manifest
 *  must be loud, not a member that silently declines forever.
 *  Declines ([]) if its key is missing (member not in play → ladder fails over) or diarize is
 *  requested (ASR only — the voiceprint engine diarizes). Chunking (>25MB Whisper cap) lives in
 *  the backend. `makeBackend` is injected for tests. */
export function makeOpenAiSttFn(deps: {
  tokenProvider: Pick<TokenProvider, 'token'>
  tokenName?: string
  baseUrl?: string
  model?: string
  /** Chunk plan + per-chunk upload wall-clock onto the shared debug bus. Without it, whether a
   *  long file took the split branch at all is invisible from outside the backend. */
  onDebug?: (entry: DebugEntry) => void
  makeBackend?: (baseUrl: string, model: string, token: string) => SttBackend
}): BuiltinFn {
  return async (input, params) => {
    const { bytes, mime, opts } = asInput(input)
    const p = (params ?? {}) as { tokenName?: unknown; baseUrl?: unknown; model?: unknown }
    const pick = (name: 'tokenName' | 'baseUrl' | 'model'): string => {
      const v = p[name] ?? deps[name]
      if (typeof v !== 'string' || !v) throw new Error(`[stt] OpenAI 兼容转写成员缺 ${name}——manifest 的 fixed_params 里没声明它`)
      return v
    }
    const tokenName = pick('tokenName')
    const baseUrl = pick('baseUrl')
    const model = pick('model')
    if (opts?.diarize) return [] // decline — ASR only, cannot diarize
    const token = deps.tokenProvider.token(tokenName)
    if (!token) return [] // decline — BYOK key absent
    const make = deps.makeBackend ?? ((b, m, t) => new OpenAiCompatBackend(b, m, t, { onDebug: deps.onDebug }))
    const backend = make(baseUrl, model, token)
    // 'audio' 只是上传文件名的**词干**：真扩展名/真 mime 由切块产出的 SttChunk.format 决定
    // （源 mime 可能是 video/mp4，切完其实是 m4a——写错了 Groq 一律 400）。
    const res = await backend.transcribe(bytes, mime, 'audio', undefined, { translate: opts?.translate })
    return [res]
  }
}

