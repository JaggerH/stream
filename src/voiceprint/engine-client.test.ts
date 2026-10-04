import { describe, it, expect, vi, afterEach } from 'vitest'
import { VoiceprintEngineClient } from './engine-client.ts'
import { setPluginTargetMissReporter, setPluginTargetResolver } from '../plugins/plugin-target.ts'

const bytes = new Uint8Array([1, 2, 3])
afterEach(() => vi.restoreAllMocks())

describe('VoiceprintEngineClient', () => {
  it('configured() is false with no base', () => {
    expect(new VoiceprintEngineClient('').configured()).toBe(false)
    expect(new VoiceprintEngineClient('http://x').configured()).toBe(true)
  })

  // configured() 问的是「管不管得着」，不打算马上发请求 —— host 档下容器睡着时它必然答空，
  // 那是正确答案，不是故障。它每次 GET /api/conversion-kinds 都会被问一遍，喊出来只会把
  // `plugin-target` 故障频道淹掉（实测 777:0）。真正的消费路径（withAwake 里的 base getter）
  // 照常喊。
  it('configured() 走窥视档：答空不进 plugin-target 故障频道', () => {
    vi.stubEnv('VOICEPRINT_URL', undefined as unknown as string)
    const seen: string[] = []
    setPluginTargetResolver(() => null)
    setPluginTargetMissReporter((s) => { seen.push(s) })
    try {
      expect(new VoiceprintEngineClient().configured()).toBe(false)
      expect(seen).toEqual([])
      // 同一个客户端的取数路径（base，在 withAwake 回调里求值）仍然照喊。
      expect(new VoiceprintEngineClient().base).toBe('')
      expect(seen).toEqual(['voiceprint'])
    } finally {
      setPluginTargetMissReporter(null)
      setPluginTargetResolver(() => null)
      vi.unstubAllEnvs()
    }
  })

  it('diarize posts multipart and maps the response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          model_version: 'wespeaker-1',
          segments: [{ start: 0, end: 5, speaker: 'SPEAKER_00', embedding: [0.1, 0.2] }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    const c = new VoiceprintEngineClient('http://engine')
    const r = await c.diarize(bytes, 'audio/mp4', { hint: 'accuracy' })
    expect(r.modelVersion).toBe('wespeaker-1')
    expect(r.segments[0]).toMatchObject({ start: 0, end: 5, speaker: 'SPEAKER_00', embedding: [0.1, 0.2] })
    const url = fetchMock.mock.calls[0][0]
    expect(String(url)).toBe('http://engine/diarize')
  })

  it('diarize 保留弃权条目（空 embedding + abstained），别当成"没给代表"过滤掉', async () => {
    // 弃权 = 容器的帧级门控看过音频后拒绝作答。它必须原样传到 mergeWindows——被过滤成
    // "缺省"的话，下游会拿段级均值把刚拦下的脏音频放回来（见 WindowSpeakerRep.abstained）。
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          model_version: 'v1',
          segments: [{ start: 0, end: 5, speaker: 'SPEAKER_00', embedding: [0.1] }],
          speakers: [
            { speaker: 'SPEAKER_00', embedding: [0.3, 0.4], clip_seconds: 20, gated_seconds: 19.5 },
            { speaker: 'SPEAKER_01', embedding: [], clip_seconds: 0, gated_seconds: 2.1, abstained: true },
            { speaker: '', embedding: [0.9] }, // 无名条目照旧丢弃
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    const r = await new VoiceprintEngineClient('http://engine').diarize(bytes, 'audio/mp4')
    expect(r.speakers).toHaveLength(2)
    expect(r.speakers?.[0]).toEqual({ speaker: 'SPEAKER_00', embedding: [0.3, 0.4], clipSeconds: 20, gatedSeconds: 19.5 })
    expect(r.speakers?.[1]).toEqual({ speaker: 'SPEAKER_01', embedding: [], clipSeconds: 0, gatedSeconds: 2.1, abstained: true })
  })

  it('diarize throws on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }))
    await expect(new VoiceprintEngineClient('http://engine').diarize(bytes, 'audio/mp4')).rejects.toThrow(/500/)
  })

  it('embed maps the response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ model_version: 'wespeaker-1', embedding: [1, 2, 3] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    const r = await new VoiceprintEngineClient('http://engine').embed(bytes, 'audio/wav')
    expect(r).toEqual({ modelVersion: 'wespeaker-1', embedding: [1, 2, 3] })
  })
})
