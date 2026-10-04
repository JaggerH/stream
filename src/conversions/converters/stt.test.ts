import { describe, expect, it, vi } from 'vitest'
import { makeSttConverter, type SttConverterDeps } from './stt.ts'
import { makeExtractConverter } from './extract.ts'
import { ConversionRunner } from '../runner.ts'
import { ConversionStore } from '../store.ts'

/** 一条视频 post —— archetype 把分支钉死在 stt 上。 */
const VIDEO = { archetype: 'video' as const, media: [{ kind: 'video' as const, url: 'https://x/v.mp4' }] }

const settle = () => new Promise((r) => setTimeout(r, 0))

const SEGMENTS = [
  { start: 0, end: 2, text: 'hello' },
  { start: 2, end: 4, text: 'world' },
]

/** identify 的产物：一条**说话人时间线**（没有文字）。覆盖上面两段的时间范围，
 *  这样投影（`alignTextToClusters`）之后两段都会带上名字。 */
const TIMELINE = [{ start: 0, end: 4, speaker: 'SPEAKER_00' }]

import type { InvokeResult } from '../../providers/executor.ts'

/** A winning sequential executor result (the shape src/providers/executor.ts returns). */
function ok(value: unknown): InvokeResult {
  return { strategy: 'sequential', provider: 'transcribe', value, via: 'mineru', misses: [], timings: [] }
}

/** Every member missed; `retryable` marks the "backend still warming up" case. */
function allMissed(misses: Array<{ member: string; reason: string; retryable?: boolean }>): InvokeResult {
  return { strategy: 'sequential', provider: 'transcribe', value: null, via: '', misses, timings: [] }
}

function setup(over: Partial<SttConverterDeps> = {}, runnerOpts: { now?: () => number; schedule?: (fn: () => void, ms: number) => void } = {}) {
  const deps: SttConverterDeps = {
    resolveMedia: vi.fn(async () => ({ bytes: new Uint8Array([1, 2]), mime: 'audio/mp4' })),
    invokeTranscribe: vi.fn(async () => ok([{ text: 'hello world', lang: 'zh', segments: SEGMENTS }])),
    available: () => true,
    ...over,
  }
  const store = new ConversionStore(':memory:')
  // 转写不再是一个对外的 kind——它是 extract 的一条分支，所以经 extract 驱动（唯一的真实入口）。
  // 另两条分支给成不可用，加上 archetype:'video'，判定只可能落在 stt 上。
  const runner = new ConversionRunner({
    store,
    converters: [
      makeExtractConverter({
        stt: makeSttConverter(deps),
        ocr: { stages: [], available: () => false, run: async () => ({ ok: false, error: { code: 'x', message: 'x' } }) },
        article: { available: () => false, fetch: async () => null, ocrImages: async (md: string) => md },
      }),
    ],
    now: runnerOpts.now,
    schedule: runnerOpts.schedule,
    derivations: [], costarts: [],
  })
  return { store, runner, deps }
}

describe('stt converter', () => {
  it('transcribes and times media + asr separately', async () => {
    let t = 0
    const { runner } = setup(
      {
        resolveMedia: vi.fn(async () => { t += 1200; return { bytes: new Uint8Array([1]), mime: 'audio/mp4' } }),
        invokeTranscribe: vi.fn(async () => { t += 9000; return ok([{ text: 'hi', lang: 'zh', segments: SEGMENTS }]) }),
      },
      { now: () => t }
    )
    const { record } = runner.start('extract', 'item-1', { options: { content: VIDEO } })
    await settle()
    const rec = runner.get(record.id)!
    expect(rec.status).toBe('done')
    expect(rec.result).toMatchObject({ text: 'hi', branch: 'stt', detail: { lang: 'zh' } })
    expect(rec.timing).toEqual({
      totalMs: 10200,
      stages: [{ name: 'stt:media', ms: 1200 }, { name: 'stt:asr', ms: 9000 }],
    })
  })

  it('times diarization as its own stage — the whole point of this refactor', async () => {
    let t = 0
    // identify 只答「谁在说」：一条时间线。投影到文字段上是 stt converter 自己做的一步。
    const identify = vi.fn(async () => {
      t += 75_000
      return TIMELINE
    })
    const { runner } = setup(
      {
        resolveMedia: vi.fn(async () => { t += 1000; return { bytes: new Uint8Array([1]), mime: 'audio/mp4' } }),
        invokeTranscribe: vi.fn(async () => { t += 40_000; return ok([{ text: 'hi', lang: 'zh', segments: SEGMENTS }]) }),
        identify: identify as never,
        identifyReady: () => true,
      },
      { now: () => t }
    )
    const { record } = runner.start('extract', 'item-1', { options: { diarize: true, content: VIDEO } })
    await settle()
    const rec = runner.get(record.id)!
    expect(rec.timing!.stages).toEqual([
      { name: 'stt:media', ms: 1000 },
      { name: 'stt:asr', ms: 40_000 },
      { name: 'stt:diarize', ms: 75_000 },
    ])
    expect(rec.timing!.totalMs).toBe(116_000)
    expect((rec.result as { detail: { segments: { speaker?: string }[] } }).detail.segments[0].speaker).toBe('SPEAKER_00')
  })

  it('has no diarize stage at all when the job did not ask for speakers', async () => {
    const { runner } = setup({ identify: vi.fn() as never, identifyReady: () => true })
    const { record } = runner.start('extract', 'i', { options: { content: VIDEO } })
    await settle()
    expect(runner.get(record.id)!.timing!.stages.map((s) => s.name)).toEqual(['stt:media', 'stt:asr'])
  })

  it('does not ask the STT backend to diarize when the voiceprint engine will do it', async () => {
    const invokeTranscribe = vi.fn(async () => ok([{ text: 'x', lang: 'zh', segments: SEGMENTS }]))
    const { runner } = setup({
      invokeTranscribe,
      identify: (async () => TIMELINE) as never,
      identifyReady: () => true,
    })
    runner.start('extract', 'i', { options: { diarize: true, content: VIDEO } })
    await settle()
    expect(invokeTranscribe).toHaveBeenCalledWith(expect.objectContaining({ opts: { diarize: false, translate: false } }))
  })

  it('asks the STT backend to diarize when there is no voiceprint engine', async () => {
    const invokeTranscribe = vi.fn(async () => ok([{ text: 'x', lang: 'zh', segments: SEGMENTS }]))
    const { runner } = setup({ invokeTranscribe, identifyReady: () => false })
    runner.start('extract', 'i', { options: { diarize: true, content: VIDEO } })
    await settle()
    expect(invokeTranscribe).toHaveBeenCalledWith(expect.objectContaining({ opts: { diarize: true, translate: false } }))
  })

  it('reports a wake timeout as retryable so the runner requeues instead of failing', async () => {
    const scheduled: Array<() => void> = []
    let call = 0
    const invokeTranscribe = vi.fn(async () => {
      call += 1
      if (call === 1) return allMissed([{ member: 'mineru', reason: 'wake timeout', retryable: true }])
      return ok([{ text: 'warm now', lang: 'zh', segments: SEGMENTS }])
    })
    const { runner } = setup({ invokeTranscribe }, { schedule: (fn) => { scheduled.push(fn) } })
    const { record } = runner.start('extract', 'i', { options: { content: VIDEO } })
    await settle()
    expect(runner.get(record.id)!.status).toBe('queued') // 意图未了结
    scheduled.shift()!()
    await settle()
    const rec = runner.get(record.id)!
    expect(rec.status).toBe('done')
    expect((rec.result as { text: string }).text).toBe('warm now')
  })

  it('fails outright when every source missed for a non-retryable reason', async () => {
    const invokeTranscribe = vi.fn(async () =>
      allMissed([{ member: 'cf-whisper', reason: 'declined' }, { member: 'mineru', reason: 'boom' }])
    )
    const { runner } = setup({ invokeTranscribe })
    const { record } = runner.start('extract', 'i', { options: { content: VIDEO } })
    await settle()
    const rec = runner.get(record.id)!
    expect(rec.status).toBe('error')
    expect(rec.error!.code).toBe('all_sources_missed')
    expect(rec.error!.message).toContain('cf-whisper: declined')
  })

  it('fails with no_media when the handle resolves to nothing playable', async () => {
    const { runner } = setup({ resolveMedia: vi.fn(async () => null) })
    const { record } = runner.start('extract', 'i', { options: { content: VIDEO } })
    await settle()
    expect(runner.get(record.id)!.error).toEqual({ code: 'no_media', message: 'no transcribable media' })
  })

  it('still delivers the transcript when identify degrades — diarization is a side dish', async () => {
    const identify = vi.fn(async (_id: string, _b: unknown, _m: unknown, _s: unknown, windowing: { onDegrade?: (e: unknown) => void } | undefined) => {
      windowing?.onDegrade?.(new Error('engine OOM'))
      return []
    })
    const { runner } = setup({
      identify: identify as never,
      identifyReady: () => true,
      makeWindowing: (_ctx, onDegrade) => ({ onDegrade }) as never,
    })
    const { record } = runner.start('extract', 'i', { options: { diarize: true, content: VIDEO } })
    await settle()
    const rec = runner.get(record.id)!
    expect(rec.status).toBe('done')
    expect((rec.result as { text: string }).text).toBe('hello world')
    expect((rec.result as { detail: { segments: { speaker?: string }[] } }).detail.segments[0].speaker).toBeUndefined()
  })

  it('books speaker appearances AFTER intro-name resolution（账源是时间线，重算只认 itemId）', async () => {
    const calls: string[] = []
    const recordAppearances = vi.fn(() => calls.push('record'))
    const { runner } = setup({
      identify: (async () => TIMELINE) as never,
      identifyReady: () => true,
      resolveIntroNames: (async (_i: string, segs: Array<Record<string, unknown>>) => {
        calls.push('intro')
        return segs
      }) as never,
      recordAppearances,
    })
    runner.start('extract', 'i', { options: { diarize: true, content: VIDEO } })
    await settle()
    expect(recordAppearances).toHaveBeenCalledWith('i')
    // 顺序是这条账的正确性前提：抽名把改名写进时间线，之后记账才带得上新名字
    expect(calls).toEqual(['intro', 'record'])
  })

  it('keeps the transcript when intro-name resolution throws', async () => {
    const { runner } = setup({
      identify: (async () => TIMELINE) as never,
      identifyReady: () => true,
      resolveIntroNames: vi.fn(async () => { throw new Error('LLM down') }) as never,
    })
    const { record } = runner.start('extract', 'i', { options: { diarize: true, content: VIDEO } })
    await settle()
    const rec = runner.get(record.id)!
    expect(rec.status).toBe('done')
    expect((rec.result as { detail: { segments: { speaker?: string }[] } }).detail.segments[0].speaker).toBe('SPEAKER_00')
  })
})
