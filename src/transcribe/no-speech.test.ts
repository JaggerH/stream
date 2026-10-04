import { describe, it, expect } from 'vitest'
import { fabricationReason, sieveFabricated, type RawSttSegment } from './no-speech.ts'

/** 实测三组（2026-08-15，真 Groq whisper-large-v3，各 20 秒）——判据就是照它们定的。 */
const SILENCE: RawSttSegment = { start: 0, end: 0.62, text: ' you', no_speech_prob: 0.7006836, avg_logprob: -0.7080598, compression_ratio: 0.33333334 }
const TONE: RawSttSegment = { start: 0, end: 20, text: ' .', no_speech_prob: 0.7026367, avg_logprob: -0.61653423, compression_ratio: 0.2 }
const SPEECH: RawSttSegment = { start: 0, end: 2, text: '因为AI智能体爆发式崛起', no_speech_prob: 0.233, avg_logprob: -0.075, compression_ratio: 1.2 }

describe('fabricationReason — 实测那三组必须判对', () => {
  it('静音上编出来的 " you" 判为 no_speech', () => {
    expect(fabricationReason(SILENCE)).toBe('no_speech')
  })

  it('纯音调上编出来的 " ." 判为 no_speech', () => {
    expect(fabricationReason(TONE)).toBe('no_speech')
  })

  it('真人声留下', () => {
    expect(fabricationReason(SPEECH)).toBeUndefined()
  })
})

describe('fabricationReason — 两个字段取交集', () => {
  // 正常语句之间的停顿段：no_speech 高，但模型对转出的字有把握（logprob 高）。
  // 误杀一段真话是永久丢失且没人会喊，所以这一段必须留下。
  it('no_speech 高但 logprob 也高 → 留下（句间停顿，不是编的）', () => {
    expect(fabricationReason({ ...SPEECH, no_speech_prob: 0.82, avg_logprob: -0.09 })).toBeUndefined()
  })

  it('logprob 低但 no_speech 低 → 留下（口音重/环境吵，仍是真话）', () => {
    expect(fabricationReason({ ...SPEECH, no_speech_prob: 0.15, avg_logprob: -0.9 })).toBeUndefined()
  })
})

describe('fabricationReason — 复读循环是相反方向的编造', () => {
  it('compression_ratio 飙高判 repetition，与 no_speech 分开记', () => {
    const loop = { start: 0, end: 30, text: '谢谢观看。'.repeat(40), no_speech_prob: 0.1, avg_logprob: -0.05, compression_ratio: 6.7 }
    expect(fabricationReason(loop)).toBe('repetition')
  })
})

describe('fabricationReason — 拿不到字段就不判', () => {
  // Cloudflare / OpenAI 那两条腿未必带这些字段。**缺信息不等于没有语音**——
  // 判成 no_speech 会把一整条正常转写静静抹掉。
  it('三个字段全缺 → 留下', () => {
    expect(fabricationReason({ start: 0, end: 2, text: '正常的一句话' })).toBeUndefined()
  })

  it('只有 no_speech、没有 logprob → 留下（交集判据缺一半，不猜）', () => {
    expect(fabricationReason({ start: 0, end: 2, text: '正常的一句话', no_speech_prob: 0.95 })).toBeUndefined()
  })
})

describe('sieveFabricated', () => {
  it('只丢那一段，其余照常留下', () => {
    const r = sieveFabricated([SPEECH, SILENCE, { ...SPEECH, text: '第二句' }])
    expect(r.kept.map((s) => s.text)).toEqual(['因为AI智能体爆发式崛起', '第二句'])
    expect(r.dropped).toHaveLength(1)
  })

  it('丢掉的段连原始读数一起留着——将来要拿真实分布重新标定阈值', () => {
    const [d] = sieveFabricated([SILENCE]).dropped
    expect(d).toMatchObject({
      reason: 'no_speech',
      noSpeechProb: SILENCE.no_speech_prob,
      avgLogprob: SILENCE.avg_logprob,
      compressionRatio: SILENCE.compression_ratio,
    })
  })

  it('全是编的 → kept 为空，但那是调用方要回答的问题，这里不抛', () => {
    const r = sieveFabricated([SILENCE, TONE])
    expect(r.kept).toEqual([])
    expect(r.dropped.map((d) => d.reason)).toEqual(['no_speech', 'no_speech'])
  })
})
