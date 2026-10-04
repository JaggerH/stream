import { describe, it, expect } from 'vitest'
import {
  pickIntroCandidates,
  correctNameAgainstCast,
  buildIntroMessages,
  parseIntroName,
  resolveIntroNames,
} from './intro-names.ts'
import type { TranscriptSegment } from '../transcribe/client.ts'
import { SpeakerRegistryStore } from './store.ts'

describe('buildIntroMessages', () => {
  it('puts the intro text in the user message and instructs JSON name output', () => {
    const msgs = buildIntroMessages('大家好我是庞博')
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toMatch(/name/)
    expect(msgs[1]).toEqual({ role: 'user', content: '大家好我是庞博' })
  })
})

describe('parseIntroName', () => {
  it('extracts a name from clean JSON', () => {
    expect(parseIntroName('{"name": "庞博"}')).toBe('庞博')
  })
  it('extracts from JSON embedded in prose / code fence', () => {
    expect(parseIntroName('```json\n{"name":"徐志胜"}\n```')).toBe('徐志胜')
  })
  it('returns null for an explicit null name', () => {
    expect(parseIntroName('{"name": null}')).toBeNull()
  })
  it('returns null for unparseable / empty output', () => {
    expect(parseIntroName('抱歉我不确定')).toBeNull()
    expect(parseIntroName('')).toBeNull()
    expect(parseIntroName(null)).toBeNull()
  })
  it('rejects a sentence masquerading as a name (too long / has punctuation)', () => {
    expect(parseIntroName('{"name": "大家好我是主持人接下来有请"}')).toBeNull()
    expect(parseIntroName('{"name": "我是，狗哥。"}')).toBeNull()
  })
})

describe('pickIntroCandidates', () => {
  function seg(start: number, end: number, speaker: string, text: string): TranscriptSegment {
    return { start, end, text, speaker }
  }
  // intro line belongs to cluster A; the performance right after is dominated by cluster B
  const live: TranscriptSegment[] = [
    seg(1964, 1966, 'SPEAKER_16', '我是林剪七'),
    ...Array.from({ length: 60 }, (_, i) => seg(1976 + i * 2, 1978 + i * 2, 'SPEAKER_11', `set${i}`)),
    seg(2100, 2104, 'SPEAKER_05', '插话'),
  ]

  it('names the cluster that dominates AFTER the intro, not the intro line own cluster', () => {
    const out = pickIntroCandidates(live)
    expect(out).toHaveLength(1)
    expect(out[0].cluster).toBe('SPEAKER_11')   // ← the set, not SPEAKER_16
    expect(out[0].text).toContain('我是林剪七')
    expect(out[0].atSeconds).toBe(1964)
  })

  it('drops a candidate whose following window has no dominant speaker', () => {
    const weak = [seg(10, 12, 'SPEAKER_01', '我是小明'), seg(14, 20, 'SPEAKER_02', '只说了六秒')]
    expect(pickIntroCandidates(weak, { minDominantSeconds: 60 })).toEqual([])
  })

  it('only considers intro-shaped lines', () => {
    const none = Array.from({ length: 60 }, (_, i) => seg(i * 2, i * 2 + 2, 'SPEAKER_11', `普通台词${i}`))
    expect(pickIntroCandidates(none)).toEqual([])
  })

  it('keeps at most one candidate per dominant cluster (earliest wins)', () => {
    const twice = [
      seg(1948, 1950, 'SPEAKER_01', '大家好'),
      seg(1964, 1966, 'SPEAKER_16', '我是林剪七'),
      ...Array.from({ length: 60 }, (_, i) => seg(1976 + i * 2, 1978 + i * 2, 'SPEAKER_11', `set${i}`)),
    ]
    const out = pickIntroCandidates(twice)
    expect(out).toHaveLength(1)
    expect(out[0].atSeconds).toBe(1948)
  })
})

describe('correctNameAgainstCast', () => {
  const cast = ['林简七', '庞博', '徐不气', '翟佳宁']
  it('fixes an ASR homophone against the cast list', () => {
    expect(correctNameAgainstCast('林剪七', cast)).toBe('林简七')  // 剪→简
    expect(correctNameAgainstCast('徐不弃', cast)).toBe('徐不气')  // 弃→气
  })
  it('passes an exact cast name through', () => {
    expect(correctNameAgainstCast('庞博', cast)).toBe('庞博')
  })
  it('rejects a name that matches no cast member (do not enroll unverifiable names)', () => {
    expect(correctNameAgainstCast('张三丰', cast)).toBeNull()
  })
  it('passes through unchanged when no cast list is available', () => {
    expect(correctNameAgainstCast('林剪七', [])).toBe('林剪七')
  })
})

describe('resolveIntroNames (time-proximity attribution)', () => {
  function seg(start: number, end: number, speaker: string, text: string): TranscriptSegment {
    return { start, end, text, speaker }
  }
  it('renames + enrolls the DOMINANT cluster, corrected against the cast', async () => {
    const reg = new SpeakerRegistryStore(':memory:')
    reg.putItemCluster('ep', 'SPEAKER_11', [0.4, 0.5, 0.6], 'model-v1')
    const segs = [
      seg(1964, 1966, 'SPEAKER_16', '我是林剪七'),
      ...Array.from({ length: 60 }, (_, i) => seg(1976 + i * 2, 1978 + i * 2, 'SPEAKER_11', `set${i}`)),
    ]
    const out = await resolveIntroNames('ep', segs, {
      invokeLlm: async () => '{"name":"林剪七"}',
      registry: reg,
      cast: ['林简七', '庞博'],
    })
    // the performance cluster carries the corrected name; the stray intro line's cluster is untouched
    expect(out.filter((s) => s.speaker === '林简七').length).toBe(60)
    expect(out.find((s) => s.start === 1964)!.speaker).toBe('SPEAKER_16')
    expect(reg.listPersons().map((p) => p.name)).toEqual(['林简七'])
    expect(reg.match([0.4, 0.5, 0.6], 'model-v1')[0]?.name).toBe('林简七')
  })

  it('自动认名也要落到时间线上——时间线是唯一权威，只改投影就是漂移', async () => {
    // 漂移实锤（收敛前的现网 bug）：自动抽名只改了投影 segments，没改时间线；
    // 于是出现账里有他、/clusters 与 /blocks（走时间线）里他还叫「说话人 N」。
    const reg = new SpeakerRegistryStore(':memory:')
    reg.putItemCluster('ep', 'SPEAKER_11', [0.4, 0.5, 0.6], 'model-v1')
    reg.putItemTimeline('ep', [
      { start: 1964, end: 1966, speaker: 'SPEAKER_16' },
      { start: 1976, end: 2096, speaker: 'SPEAKER_11' },
    ])
    const segs = [
      seg(1964, 1966, 'SPEAKER_16', '我是林剪七'),
      ...Array.from({ length: 60 }, (_, i) => seg(1976 + i * 2, 1978 + i * 2, 'SPEAKER_11', `set${i}`)),
    ]
    await resolveIntroNames('ep', segs, {
      invokeLlm: async () => '{"name":"林剪七"}',
      registry: reg,
      cast: ['林简七', '庞博'],
    })
    expect(reg.getItemTimeline('ep').map((s) => s.speaker)).toEqual(['SPEAKER_16', '林简七'])
  })

  it('LLM 哑掉时不许把已有待确认清没——重建不了就别拆', async () => {
    // 活体实测（2026-07-25）：LLM 端点返回「未配置」，抽名整条链路是哑的。
    // 若重跑时无条件先清空待确认，用户排队等确认的名字就凭空消失了。
    const reg = new SpeakerRegistryStore(':memory:')
    reg.putItemCluster('ep', 'SPEAKER_11', [0.4, 0.5, 0.6], 'model-v1')
    reg.enqueuePendingName({ itemId: 'ep', cluster: 'SPEAKER_17', name: '徐不弃', evidence: '我是徐不弃', atSeconds: 3024 })
    const segs = [
      seg(1964, 1966, 'SPEAKER_16', '我是徐不弃'),
      ...Array.from({ length: 60 }, (_, i) => seg(1976 + i * 2, 1978 + i * 2, 'SPEAKER_11', `set${i}`)),
    ]
    await resolveIntroNames('ep', segs, {
      invokeLlm: async () => null, // LLM 不可用
      registry: reg,
      cast: ['林简七'],
    })
    expect(reg.listPendingNames('ep').map((p) => p.name)).toEqual(['徐不弃'])
  })

  it('抽名成功时，待确认整份替换掉旧的——簇号重跑会变，旧行必然过时', async () => {
    const reg = new SpeakerRegistryStore(':memory:')
    reg.putItemCluster('ep', 'SPEAKER_11', [0.4, 0.5, 0.6], 'model-v1')
    // 上一轮把「徐不弃」挂在了 SPEAKER_17（重跑后那个簇已经是别人）
    reg.enqueuePendingName({ itemId: 'ep', cluster: 'SPEAKER_17', name: '徐不弃', evidence: '旧证据', atSeconds: 1 })
    const segs = [
      seg(1964, 1966, 'SPEAKER_16', '我是徐不弃'),
      ...Array.from({ length: 60 }, (_, i) => seg(1976 + i * 2, 1978 + i * 2, 'SPEAKER_11', `set${i}`)),
    ]
    await resolveIntroNames('ep', segs, {
      invokeLlm: async () => '{"name":"徐不弃"}',
      registry: reg,
      cast: ['林简七'], // 校不上 → 落待确认
    })
    const list = reg.listPendingNames('ep')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ cluster: 'SPEAKER_11', name: '徐不弃' }) // 挂到了新的主导簇
  })

  it('校不上演职员表 → 不丢、落一条待确认（含名字/簇/证据句），且不 enroll、不改名', async () => {
    const reg = new SpeakerRegistryStore(':memory:')
    reg.putItemCluster('ep', 'SPEAKER_11', [0.4, 0.5, 0.6], 'model-v1')
    const segs = [
      seg(1964, 1966, 'SPEAKER_16', '我是多多'),
      ...Array.from({ length: 60 }, (_, i) => seg(1976 + i * 2, 1978 + i * 2, 'SPEAKER_11', `set${i}`)),
    ]
    const out = await resolveIntroNames('ep', segs, {
      invokeLlm: async () => '{"name":"多多"}',
      registry: reg,
      cast: ['林简七', '庞博'], // 「多多」不在演职员表
    })
    // 名字没被丢弃,但也没硬认:簇仍是 SPEAKER_11,声纹库里没有人
    expect(out.filter((s) => s.speaker === 'SPEAKER_11').length).toBe(60)
    expect(reg.listPersons()).toEqual([])
    expect(reg.match([0.4, 0.5, 0.6], 'model-v1')).toEqual([])
    // 落成一条待确认:名字 + 该被命名的主导簇 + 开场白证据句
    const pending = reg.listPendingNames('ep')
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ cluster: 'SPEAKER_11', name: '多多' })
    expect(pending[0].evidence).toContain('我是多多')
  })

  it('校得上的照旧自动走(现行为不变),不产生待确认', async () => {
    const reg = new SpeakerRegistryStore(':memory:')
    reg.putItemCluster('ep', 'SPEAKER_11', [0.4, 0.5, 0.6], 'model-v1')
    const segs = [
      seg(1964, 1966, 'SPEAKER_16', '我是庞博'),
      ...Array.from({ length: 60 }, (_, i) => seg(1976 + i * 2, 1978 + i * 2, 'SPEAKER_11', `set${i}`)),
    ]
    const out = await resolveIntroNames('ep', segs, {
      invokeLlm: async () => '{"name":"庞博"}',
      registry: reg,
      cast: ['林简七', '庞博'],
    })
    expect(out.filter((s) => s.speaker === '庞博').length).toBe(60)
    expect(reg.listPersons().map((p) => p.name)).toEqual(['庞博'])
    expect(reg.listPendingNames('ep')).toEqual([])
  })
})
