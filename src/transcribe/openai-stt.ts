import type { TranscribeResult, TranscriptSegment } from './client.ts'
import type { DebugEntry } from '../debug.ts'
import { planSttChunks, type SttChunk, type SttChunkFormat } from '../media/audio-windows.ts'
import { sieveFabricated, type DroppedSegment, type RawSttSegment } from './no-speech.ts'

export type { SttChunk, SttChunkFormat }

/** Produce upload-ready audio chunks from source bytes (compress + size-split). Injectable so
 *  the backend can be tested without ffmpeg. Each chunk must declare its `format` — the upload's
 *  filename extension and Blob type come from there, never from the source media's mime. */
export type ChunkAudioFn = (bytes: Uint8Array, mime: string, signal?: AbortSignal) => Promise<SttChunk[]>

/** Cap on how much of an error response body travels in the thrown message — it lands in the debug
 *  bus and the ladder's miss reason, so an HTML error page must not flood them. */
const MAX_ERROR_BODY = 500

/** Read a failed response's body for the error message. Best effort by design: if the body cannot
 *  be read we return '' rather than throw, so the status code (the one thing we always have)
 *  survives. Only server-returned text goes in here — never our own headers/token. */
async function errorDetail(r: { text: () => Promise<string> }): Promise<string> {
  try {
    const body = (await r.text()).trim()
    if (!body) return ''
    return body.length > MAX_ERROR_BODY ? `${body.slice(0, MAX_ERROR_BODY)}…(truncated)` : body
  } catch {
    return ''
  }
}

/** Build the multipart filename. OpenAI-compatible Whisper endpoints pick the decoder by the
 *  uploaded filename's **extension** (flac/mp3/mp4/mpeg/mpga/m4a/ogg/wav/webm) — an extension-less
 *  name is a 400. The caller's name is only a stem: any extension it carries describes the
 *  *source* media, which chunking already re-encoded away. */
function uploadFilename(stem: string, ext: string): string {
  const base = stem.replace(/\.[^./\\]+$/, '') || 'audio'
  return `${base}.${ext}`
}

/**
 * OpenAI-compatible speech-to-text backend — Groq and OpenAI both expose the same
 * `POST <base>/audio/transcriptions` (multipart file → verbose_json) shape and differ only by
 * `baseUrl` + `model`. Bearer = the user's own key (BYOK). ASR ONLY: never asks for or emits
 * speaker labels (diarization is the voiceprint engine's job); the member fn declines diarize
 * requests before ever reaching here.
 *
 * Whisper's ~25MB payload cap is handled by chunking (see planSttChunks): audio is compressed to
 * mono/16k/32kbps m4a, uploaded whole when ≤24MB, else sliced into 600s chunks. Each chunk's
 * segment timeline is shifted by its `startS` so the concatenated transcript stays global. If any
 * chunk's HTTP call fails, transcribe() throws — no half transcript is returned as success, so the
 * transcribe Provider ladder fails over to the next member.
 *
 * Note the split is never "a couple of chunks": the trigger is 24MB ≈ 100 minutes and the slice is
 * 600s, so anything that chunks at all yields ≥10 of them.
 *
 * **Don't mount a long-timeout fetch dispatcher for this.** Measured on a 110-minute episode
 * (2026-08-02, groq whisper-large-v3, 12 chunks): each chunk is ~2.4MB and uploads in 4.8–8.8s,
 * 67.7s for all twelve — three orders off any default fetch timeout, because the chunk size is
 * capped by the payload limit, not by the source length. A longer source buys more chunks, not
 * bigger ones, so this margin does not erode. Likewise the ffmpeg side: compression runs ~218×
 * realtime, so even the longest thing in a library (190min) is ~52s, well under runFfmpeg's 120s.
 *
 * The `mime` argument describes the **source** media and is only forwarded to the chunker; what
 * goes on the wire is described by each chunk's own `format`. Getting that wrong is not cosmetic:
 * uploading the re-encoded m4a under a video mime with an extension-less name made Groq answer
 * `400` on every call for as long as that member existed (2026-07-27).
 */
export class OpenAiCompatBackend {
  private readonly chunkAudio: ChunkAudioFn
  private readonly onDebug: (entry: DebugEntry) => void

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly token: string,
    opts: { chunkAudio?: ChunkAudioFn; onDebug?: (entry: DebugEntry) => void } = {}
  ) {
    this.chunkAudio = opts.chunkAudio ?? ((b, m, s) => planSttChunks(b, m, { signal: s }))
    this.onDebug = opts.onDebug ?? (() => {})
  }

  async transcribe(
    bytes: Uint8Array,
    mime: string,
    filename = 'audio',
    signal?: AbortSignal,
    opts?: { translate?: boolean }
  ): Promise<TranscribeResult> {
    const runId = `${Date.now()}`
    const chunks = await this.chunkAudio(bytes, mime, signal)
    // Emitted BEFORE the first upload: whether the split branch ran at all is otherwise
    // unobservable from outside, and a run that dies on chunk #5 would take that fact with it.
    this.emitPlan(runId, chunks, bytes.byteLength)

    const segments: TranscriptSegment[] = []
    const texts: string[] = []
    const uploadMs: number[] = []
    const dropped: DroppedSegment[] = []
    let lang: string | undefined
    for (const chunk of chunks) {
      const t0 = Date.now()
      const r = await this.transcribeChunk(chunk, filename, signal, opts)
      uploadMs.push(Date.now() - t0)
      lang ??= r.lang
      // shift each chunk's timeline into the global one (0-based within a chunk → +startS)
      for (const s of r.segments ?? []) segments.push({ start: s.start + chunk.startS, end: s.end + chunk.startS, text: s.text })
      for (const d of r.dropped ?? []) dropped.push({ ...d, start: d.start + chunk.startS, end: d.end + chunk.startS })
      if (r.text) texts.push(r.text)
    }
    const text = segments.length ? segments.map((s) => s.text).join('\n') : texts.join('\n')
    this.emitDone(runId, chunks, uploadMs, segments, dropped)
    return { text, lang, segments, dropped }
  }

  /** The chunk plan, before any upload. `starts` is what proves the timeline offsets the uploader
   *  applies are the ones the chunker intended. */
  private emitPlan(runId: string, chunks: SttChunk[], sourceBytes: number): void {
    const at = Date.now()
    const totalMb = chunks.reduce((s, c) => s + c.bytes.byteLength, 0) / 1024 / 1024
    this.onDebug({
      id: `stt:${runId}:plan@${at}`,
      at,
      channel: 'stt',
      key: `${runId}:plan`,
      title: `切块 ${chunks.length} 块`,
      summary:
        chunks.length > 1
          ? `压缩后 ${totalMb.toFixed(1)}MB 超过单次上限，切成 ${chunks.length} 块上传`
          : `压缩后 ${totalMb.toFixed(1)}MB，${chunks.length} 块直接上传`,
      ok: true,
      fields: [
        { label: 'chunks', value: String(chunks.length) },
        { label: 'starts', value: chunks.map((c) => `${c.startS}s`).join(', ') },
        { label: 'sizes', value: chunks.map((c) => `${(c.bytes.byteLength / 1024 / 1024).toFixed(1)}MB`).join(', ') },
        { label: 'source', value: `${(sourceBytes / 1024 / 1024).toFixed(1)}MB` },
        { label: 'model', value: this.model },
      ],
    })
  }

  /** Per-chunk upload wall-clock + the resulting global timeline. One row per chunk on purpose:
   *  a single total would hide the one slow chunk, and "does an upload approach the fetch timeout"
   *  is a question about the slowest chunk, not the sum. */
  private emitDone(
    runId: string,
    chunks: SttChunk[],
    uploadMs: number[],
    segments: TranscriptSegment[],
    dropped: DroppedSegment[] = [],
  ): void {
    const at = Date.now()
    const total = uploadMs.reduce((s, m) => s + m, 0)
    const lastEnd = segments.length ? segments[segments.length - 1].end : 0
    this.onDebug({
      id: `stt:${runId}:done@${at}`,
      at,
      channel: 'stt',
      key: `${runId}:done`,
      title: `转写完成 ${chunks.length} 块`,
      summary: `${chunks.length} 块共 ${(total / 1000).toFixed(1)}s，${segments.length} 段，时间轴到 ${lastEnd.toFixed(0)}s`,
      ok: true,
      fields: [
        ...chunks.map((c, i) => ({
          label: `chunk#${i}`,
          value: `start ${c.startS}s · ${(c.bytes.byteLength / 1024 / 1024).toFixed(1)}MB · ${uploadMs[i] ?? 0}ms`,
        })),
        { label: 'uploadTotal', value: `${total}ms` },
        { label: 'slowestChunk', value: `${uploadMs.length ? Math.max(...uploadMs) : 0}ms` },
        { label: 'segments', value: String(segments.length) },
        { label: 'timelineEnd', value: `${lastEnd.toFixed(1)}s` },
        // 丢了多少必须和「本来就没有」分得开：0 是「筛过，没有编造」，不是「没筛」。
        { label: 'dropped', value: String(dropped.length) },
      ],
    })
  }

  /** 丢掉的那几段各自留一条，带原始读数——阈值将来要拿真实分布重标，没有这些数就只能再拍一次。 */
  private emitDropped(chunk: SttChunk, dropped: DroppedSegment[]): void {
    const at = Date.now()
    this.onDebug({
      id: `stt:dropped:${chunk.startS}@${at}`,
      at,
      channel: 'stt',
      key: `dropped:${chunk.startS}`,
      title: `筛掉 ${dropped.length} 段疑似编造`,
      summary: dropped.map((d) => `${(d.start + chunk.startS).toFixed(1)}s ${d.reason} 「${d.text.slice(0, 20)}」`).join('；'),
      ok: true,
      fields: dropped.map((d) => ({
        label: `${(d.start + chunk.startS).toFixed(1)}s`,
        value: `${d.reason} · no_speech=${d.noSpeechProb ?? '—'} · logprob=${d.avgLogprob ?? '—'} · compression=${d.compressionRatio ?? '—'}`,
      })),
    })
  }

  private async transcribeChunk(
    chunk: SttChunk,
    filename: string,
    signal?: AbortSignal,
    opts?: { translate?: boolean }
  ): Promise<TranscribeResult> {
    const fd = new FormData()
    // name + type describe the chunk as re-encoded, not the source media — see uploadFilename.
    const blob = new Blob([chunk.bytes as unknown as BlobPart], { type: chunk.format.mime })
    fd.append('file', blob, uploadFilename(filename, chunk.format.ext))
    fd.append('model', this.model)
    fd.append('response_format', 'verbose_json') // segments + per-segment timestamps
    // translate → the sibling /audio/translations endpoint (English out); same multipart shape.
    const path = opts?.translate ? 'audio/translations' : 'audio/transcriptions'
    const r = await fetch(`${this.baseUrl}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: fd,
      signal,
    })
    if (!r.ok) {
      // The status alone is undebuggable (a 400 says nothing about *why* the file was rejected).
      const detail = await errorDetail(r)
      throw new Error(`[openai-stt] transcribe HTTP ${r.status}${detail ? `: ${detail}` : ''}`)
    }
    const j = (await r.json()) as { text?: string; language?: string; segments?: RawSttSegment[] }
    // 先筛掉模型编的段（静音/音乐上凭空造句、复读循环），再拼文本。判据与实测读数见
    // `no-speech.ts` 头注。**丢弃必须留痕**：静静抹掉一段和从来没有过那一段，长得一模一样。
    const { kept, dropped } = sieveFabricated(j.segments ?? [])
    const segments: TranscriptSegment[] = kept
      .filter((s) => (s.text ?? '').trim().length > 0)
      .map((s) => ({ start: s.start ?? 0, end: s.end ?? 0, text: (s.text ?? '').trim() }))
    // `j.text` 是整条的兜底文本，它**没有经过筛**——只有一段都没筛掉时才敢用它，
    // 否则会把刚丢掉的编造原样放回去。
    const text = segments.length ? segments.map((s) => s.text).join('\n') : dropped.length ? '' : (j.text ?? '')
    if (dropped.length) this.emitDropped(chunk, dropped)
    return { text, lang: j.language, segments, dropped }
  }
}
