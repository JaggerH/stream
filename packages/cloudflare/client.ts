import type { TranscribeResult, TranscriptSegment } from '../../src/transcribe/client.ts'

/** Cloudflare Workers AI Whisper client. whisper-large-v3-turbo is multilingual (auto Chinese)
 *  and returns segments + word timestamps. No diarization. Wrapped by this package's `cloudflare`
 *  adapter (adapter.ts, source `cf-whisper`), which declines diarize requests so the transcribe
 *  Provider fails over to a diarize-capable member. */
export class CloudflareBackend {
  constructor(
    private readonly accountId: string,
    private readonly token: string,
    private readonly model = '@cf/openai/whisper-large-v3-turbo'
  ) {}

  async transcribe(
    bytes: Uint8Array,
    _mime: string,
    _filename?: string,
    signal?: AbortSignal,
    opts?: { diarize?: boolean; translate?: boolean }
  ): Promise<TranscribeResult> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.model}`
    const body = JSON.stringify({
      audio: Buffer.from(bytes).toString('base64'),
      task: opts?.translate ? 'translate' : 'transcribe',
    })
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body,
      signal,
    })
    if (!r.ok) throw new Error(`[cloudflare] transcribe HTTP ${r.status}`)
    const j = (await r.json()) as {
      success?: boolean
      result?: { text?: string; language?: string; segments?: { start?: number; end?: number; text?: string }[] }
      errors?: unknown
    }
    if (!j.success || !j.result) throw new Error(`[cloudflare] transcribe failed: ${JSON.stringify(j.errors)}`)
    const segments: TranscriptSegment[] = (j.result.segments ?? [])
      .filter((s) => (s.text ?? '').trim().length > 0)
      .map((s) => ({ start: s.start ?? 0, end: s.end ?? 0, text: (s.text ?? '').trim() }))
    const text = segments.map((s) => s.text).join('\n') || j.result.text || ''
    return { text, lang: j.result.language, segments }
  }
}
