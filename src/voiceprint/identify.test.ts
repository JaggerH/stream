import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeIdentifyFn, type SavedWindow } from './identify.ts'
import { SpeakerRegistryStore } from './store.ts'
import type { DiarizeResult } from './engine-client.ts'
import type { TranscriptSegment } from '../transcribe/client.ts'

const bytes = new Uint8Array([1])
const textSegs: TranscriptSegment[] = [
  { start: 1, end: 4, text: 'hello' },
  { start: 12, end: 18, text: 'world' },
]
// two clusters; SPEAKER_00 embedding matches an enrolled person, SPEAKER_01 does not
const fakeEngine = (res: DiarizeResult, configured = true) =>
  ({ configured: () => configured, diarize: async () => res }) as any

const diar: DiarizeResult = {
  modelVersion: 'v1',
  segments: [
    { start: 0, end: 10, speaker: 'SPEAKER_00', embedding: [1, 0] },
    { start: 10, end: 20, speaker: 'SPEAKER_01', embedding: [0, 1] },
  ],
}

describe('makeIdentifyFn', () => {
  it('names a text seg with the matched person, leaves unmatched anonymous', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const p = registry.createPerson('庞博')
    registry.addVoiceprint(p.id, [1, 0], 'v1', 'seed')
    const identify = makeIdentifyFn({ engine: fakeEngine(diar), registry, threshold: 0.65 })
    const out = await identify('item1', bytes, 'audio/wav')
    expect(out[0].speaker).toBe('庞博') // matched
    expect(out[1].speaker).toBe('SPEAKER_01') // below threshold → anonymous
  })

  it('stores each cluster embedding for later enroll', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const identify = makeIdentifyFn({ engine: fakeEngine(diar), registry })
    await identify('item1', bytes, 'audio/wav')
    expect(registry.getItemCluster('item1', 'SPEAKER_01')?.embedding).toEqual([0, 1])
  })

  it('簇代表是时长加权均值，不是「第一段」——第一段是别人的短插话时不能把整簇代表带偏', async () => {
    // 真实故障的形状（spec 2026-07-25 §8.1）：一个簇的第一段恰好是别人的几秒插话，
    // 其余是这个人的整段发言。代表若取第一段，登记进声纹库的就是那个插话者的声音。
    const registry = new SpeakerRegistryStore(':memory:')
    const intruderFirst: DiarizeResult = {
      modelVersion: 'v1',
      segments: [
        { start: 0, end: 3, speaker: 'SPEAKER_00', embedding: [0, 1] }, // 插话者，3s
        { start: 3, end: 63, speaker: 'SPEAKER_00', embedding: [1, 0] }, // 本人，60s
        { start: 63, end: 123, speaker: 'SPEAKER_00', embedding: [1, 0] }, // 本人，60s
      ],
    }
    const identify = makeIdentifyFn({ engine: fakeEngine(intruderFirst), registry })
    await identify('item1', bytes, 'audio/wav')
    const rep = registry.getItemCluster('item1', 'SPEAKER_00')!.embedding
    // 120s 的 [1,0] 压过 3s 的 [0,1] → 代表应当靠向本人（x 分量远大于 y）
    expect(rep[0]).toBeGreaterThan(0.9)
    expect(rep[1]).toBeLessThan(0.2)
  })

  it('碎片簇不参与自动认名（但仍存下来供手动 enroll）', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const p = registry.createPerson('庞博')
    registry.addVoiceprint(p.id, [1, 0], 'v1', 'seed')
    const withScrap: DiarizeResult = {
      modelVersion: 'v1',
      segments: [
        { start: 1, end: 2.5, speaker: 'SPEAKER_00', embedding: [1, 0] }, // 1.5s 碎片，向量却完全匹配
        { start: 12, end: 18, speaker: 'SPEAKER_01', embedding: [0, 1] },
      ],
    }
    const identify = makeIdentifyFn({ engine: fakeEngine(withScrap), registry, threshold: 0.65 })
    const out = await identify('item1', bytes, 'audio/wav')
    // 1.5s 的音频不足以判定"这是谁"——不许自动挂上真人名字
    expect(out[0].speaker).toBe('SPEAKER_00')
    // 但代表仍要存下来，手动 enroll 得用它
    expect(registry.getItemCluster('item1', 'SPEAKER_00')?.embedding).toEqual([1, 0])
  })

  it('默认认名阈值是 0.85：0.79 那档相似度不再自动认名（实测异人簇能到 0.787）', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const p = registry.createPerson('庞博')
    registry.addVoiceprint(p.id, [1, 0], 'v1', 'seed')
    // 与登记声纹相似度 ≈0.79 的另一个人（cos(0.79,0.613)= 0.79）
    const nearMiss: DiarizeResult = {
      modelVersion: 'v1',
      segments: [{ start: 0, end: 60, speaker: 'SPEAKER_00', embedding: [0.79, 0.613] }],
    }
    const identify = makeIdentifyFn({ engine: fakeEngine(nearMiss), registry })
    const out = await identify('item1', bytes, 'audio/wav')
    expect(out[0].speaker).toBe('SPEAKER_00') // 0.79 < 0.85 → 不认
    // 同一份数据在旧的 0.65 下会被认成庞博——钉住这次改动本身
    const loose = makeIdentifyFn({ engine: fakeEngine(nearMiss), registry, threshold: 0.65 })
    expect((await loose('item2', bytes, 'audio/wav'))[0].speaker).toBe('庞博')
  })

  // ---- 库用簇代表优先吃容器门控后的干净代表（前门装了闸，后门也得关上）----

  it('(g1) 单发路径：registry 存的是容器的干净代表，不是段级均值', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const withClean: DiarizeResult = {
      modelVersion: 'v1',
      segments: [{ start: 0, end: 60, speaker: 'SPEAKER_00', embedding: [1, 0] }], // 段级（含脏帧）
      speakers: [{ speaker: 'SPEAKER_00', embedding: [0, 1], clipSeconds: 20 }], // 门控后重算
    }
    const identify = makeIdentifyFn({ engine: fakeEngine(withClean), registry })
    await identify('clean-single', bytes, 'audio/wav')
    const rep = registry.getItemCluster('clean-single', 'SPEAKER_00')!.embedding
    expect(rep[1]).toBeGreaterThan(0.999) // ≈[0,1] 干净代表
  })

  it('(g2) 自动认名比的也是干净代表——段级均值配不上、干净代表配得上时要认出来', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const p = registry.createPerson('庞博')
    registry.addVoiceprint(p.id, [0, 1], 'v1', 'seed')
    const withClean: DiarizeResult = {
      modelVersion: 'v1',
      segments: [{ start: 0, end: 60, speaker: 'SPEAKER_00', embedding: [1, 0] }],
      speakers: [{ speaker: 'SPEAKER_00', embedding: [0, 1], clipSeconds: 20 }],
    }
    const out = await makeIdentifyFn({ engine: fakeEngine(withClean), registry })(
      'clean-match', bytes, 'audio/wav'
    )
    expect(out[0].speaker).toBe('庞博')
    // 对照：同一份段级数据、没有干净代表 → 段级均值 [1,0] 与 [0,1] 正交，认不出来
    const noClean: DiarizeResult = { modelVersion: 'v1', segments: withClean.segments }
    const out2 = await makeIdentifyFn({ engine: fakeEngine(noClean), registry })(
      'dirty-match', bytes, 'audio/wav'
    )
    expect(out2[0].speaker).toBe('SPEAKER_00')
  })

  it('(g3) 弃权的簇仍入库（退回段级均值）——手动 enroll 的兜底权利不能因门控弃权而没收', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const abstained: DiarizeResult = {
      modelVersion: 'v1',
      segments: [{ start: 0, end: 60, speaker: 'SPEAKER_00', embedding: [1, 0] }],
      speakers: [{ speaker: 'SPEAKER_00', embedding: [], clipSeconds: 0, abstained: true, gatedSeconds: 2 }],
    }
    const identify = makeIdentifyFn({ engine: fakeEngine(abstained), registry })
    await identify('abstain1', bytes, 'audio/wav')
    // 用户耳朵认过的簇不该因为门控弃权就没法登记 —— 存，且存的是唯一还拿得出的那份（段级均值）
    expect(registry.getItemCluster('abstain1', 'SPEAKER_00')?.embedding).toEqual([1, 0])
  })

  it('(g4) 碎片簇即便有干净代表也不自动认名——MIN_IDENTIFY_S 仍按实际发言秒数算', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const p = registry.createPerson('庞博')
    registry.addVoiceprint(p.id, [0, 1], 'v1', 'seed')
    const scrap: DiarizeResult = {
      modelVersion: 'v1',
      segments: [{ start: 1, end: 2.5, speaker: 'SPEAKER_00', embedding: [1, 0] }], // 1.5s
      speakers: [{ speaker: 'SPEAKER_00', embedding: [0, 1], clipSeconds: 1.5 }],
    }
    const out = await makeIdentifyFn({ engine: fakeEngine(scrap), registry })('scrap1', bytes, 'audio/wav')
    expect(out[0].speaker).toBe('SPEAKER_00') // 1.5s < 3s，不许自动认名
    expect(registry.getItemCluster('scrap1', 'SPEAKER_00')?.embedding[1]).toBeGreaterThan(0.999) // 但代表照存
  })

  it('把 diarization 时间线落库——它是一等数据，不再只活在转写 segments 上', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const identify = makeIdentifyFn({ engine: fakeEngine(diar), registry })
    await identify('item1', bytes, 'audio/wav')
    expect(registry.getItemTimeline('item1')).toEqual([
      { start: 0, end: 10, speaker: 'SPEAKER_00' },
      { start: 10, end: 20, speaker: 'SPEAKER_01' },
    ])
  })

  it('没有转写也照跑：textSegs 为空时时间线照样落库（识别 = 纯 diarization）', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const p = registry.createPerson('庞博')
    registry.addVoiceprint(p.id, [1, 0], 'v1', 'seed')
    const identify = makeIdentifyFn({ engine: fakeEngine(diar), registry, threshold: 0.65 })
    const out = await identify('item1', bytes, 'audio/wav')
    // 产物就是带名字的时间线本身——「投影到文字上」已经不在这一层了
    // 认名照做，且名字写进时间线
    expect(registry.getItemTimeline('item1')).toEqual([
      { start: 0, end: 10, speaker: '庞博' },
      { start: 10, end: 20, speaker: 'SPEAKER_01' },
    ])
    expect(registry.getItemCluster('item1', 'SPEAKER_00')?.embedding).toEqual([1, 0])
  })

  it('降级（engine 未就绪 / 抛错）时不碰已有时间线——失败模式是「没补上」不是「弄坏了」', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    registry.putItemTimeline('item1', [{ start: 0, end: 9, speaker: '旧的' }])
    const engine = { configured: () => true, diarize: async () => { throw new Error('boom') } } as any
    await makeIdentifyFn({ engine, registry })('item1', bytes, 'audio/wav')
    expect(registry.getItemTimeline('item1')).toEqual([{ start: 0, end: 9, speaker: '旧的' }])
  })

  it('engine unconfigured → 空时间线（降级；失败与否只从 onDegrade 认）', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const identify = makeIdentifyFn({ engine: fakeEngine(diar, false), registry })
    const out = await identify('item1', bytes, 'audio/wav')
    expect(out).toEqual([])
  })

  it('engine throwing → 空时间线，onError 被叫到', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    let caught: unknown = null
    const engine = { configured: () => true, diarize: async () => { throw new Error('boom') } } as any
    const identify = makeIdentifyFn({ engine, registry, onError: (e) => (caught = e) })
    const out = await identify('item1', bytes, 'audio/wav')
    expect(out).toEqual([])
    expect(caught).toBeInstanceOf(Error)
  })

  // 终审 Fix 4:early-return 门问的问题从"engine 配置了吗"改成"ready() 说可以吗"——
  // host 档下 engine.configured() 在容器睡着时恒假,但 standby 管着它就该走下去(diarize
  // 内部的 withAwake 会真的唤醒容器)。ready 缺省沿用旧行为,显式传入才走新语义。
  it('engine base 为空(unconfigured)但 ready() 返 true → 不早退,diarize 被调用', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    let diarizeCalls = 0
    const engine = {
      configured: () => false, // 容器睡着,惰性 base 求值出空串
      diarize: async () => { diarizeCalls += 1; return diar },
    } as any
    const identify = makeIdentifyFn({ engine, registry, ready: () => true })
    const out = await identify('item1', bytes, 'audio/wav')
    expect(diarizeCalls).toBe(1)
    expect(out[1].speaker).toBe('SPEAKER_01') // 走完整流程,没有在门口就退回原样
  })

  it('未传 ready → 默认沿用 engine.configured()(旧语义不变)', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const identify = makeIdentifyFn({ engine: fakeEngine(diar, false), registry })
    const out = await identify('item1', bytes, 'audio/wav')
    expect(out).toEqual([]) // configured() false 且没传 ready → 仍然早退
  })

  it('ready() 返 false → 早退,即便 engine.configured() 为 true', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    let diarizeCalls = 0
    const engine = { configured: () => true, diarize: async () => { diarizeCalls += 1; return diar } } as any
    const identify = makeIdentifyFn({ engine, registry, ready: () => false })
    const out = await identify('item1', bytes, 'audio/wav')
    expect(diarizeCalls).toBe(0)
    expect(out).toEqual([])
  })
})

// ---------- Task 5: 分窗链（planner → 逐窗短调用 → assembler）+ 断点续跑 + 进度 ----------
//
// 真 ffmpeg 现场合成正弦 wav 当 fixture（同 audio-windows.test.ts 手法）：45s @ windowS=20/
// overlapS=10 → 4 窗 startS=[0,10,20,30]。假 engine 按调用顺序给每窗返回可辨识的
// segments+embeddings（偶数窗 [1,0]、奇数窗 [0,1] → merge 后应得 2 个全局说话人）。

const execFileP = promisify(execFile)

let fixDir: string
let sine45s: Uint8Array
let sine5s: Uint8Array

beforeAll(async () => {
  fixDir = await mkdtemp(join(tmpdir(), 'identify-windowed-test-'))
  const p45 = join(fixDir, 'sine45.wav')
  const p5 = join(fixDir, 'sine5.wav')
  await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=45', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', p45])
  await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', p5])
  sine45s = await readFile(p45)
  sine5s = await readFile(p5)
}, 30000)

afterAll(async () => {
  await rm(fixDir, { recursive: true, force: true })
})

/** 每窗一段：窗内相对 [8,12]（中点落进各窗的归属区，重叠去重后 4 窗都保留），
 *  embedding 按窗序奇偶交替 → 全局并成 2 个说话人。 */
const windowedEngine = (embForCall: (callIdx: number) => number[], failAtCall?: number) => {
  const calls: Uint8Array[] = []
  const engine = {
    configured: () => true,
    diarize: async (b: Uint8Array) => {
      const idx = calls.length
      calls.push(b)
      if (failAtCall !== undefined && idx === failAtCall) throw new Error(`window call ${idx} boom`)
      return {
        modelVersion: 'v1',
        segments: [{ start: 8, end: 12, speaker: 'SPEAKER_00', embedding: embForCall(idx) }],
      } satisfies DiarizeResult
    },
  } as any
  return { engine, calls }
}

describe('makeIdentifyFn windowed (Task 5)', () => {
  const longText: TranscriptSegment[] = [
    { start: 9, end: 11, text: 'w0' },
    { start: 19, end: 21, text: 'w1' },
    { start: 29, end: 31, text: 'w2' },
    { start: 39, end: 41, text: 'w3' },
  ]

  it('(a) 短音频（总时长 ≤ windowS）不切窗：engine 恰被调 1 次,且吃的是原始 bytes', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const { engine, calls } = windowedEngine(() => [1, 0])
    const identify = makeIdentifyFn({ engine, registry, windowing: { windowS: 20 } })
    await identify('short1', sine5s, 'audio/wav')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe(sine5s) // 单发路径一字不变:原 bytes/mime 直送,不是抽轨后的 wav
  })

  it('(b) 长音频切 4 窗:engine 被调 4 次,merge 出全局 label,registry 收到全局 cluster', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const p = registry.createPerson('庞博')
    registry.addVoiceprint(p.id, [1, 0], 'v1', 'seed')
    const { engine, calls } = windowedEngine((i) => (i % 2 === 0 ? [1, 0] : [0, 1]))
    const identify = makeIdentifyFn({ engine, registry, threshold: 0.65, windowing: { windowS: 20 } })
    const out = await identify('long1', sine45s, 'audio/wav')
    expect(calls).toHaveLength(4)
    // 每窗局部 label 都叫 SPEAKER_00,merge 后是两个**全局** label——registry 存的必须是全局的
    expect(registry.getItemCluster('long1', 'SPEAKER_00')?.embedding).toEqual([1, 0])
    expect(registry.getItemCluster('long1', 'SPEAKER_01')?.embedding).toEqual([0, 1])
    // 偶数窗（全局时间 [8,12]/[28,32]）配上庞博;奇数窗是没配上的全局 SPEAKER_01
    expect(out.map((s) => s.speaker)).toEqual(['庞博', 'SPEAKER_01', '庞博', 'SPEAKER_01'])
  })

  it('(c0) 容器给的干净代表要落进 resume 文件——不然断点续跑捡回来的窗会悄悄退化成段级均值', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const engine = {
      configured: () => true,
      diarize: async () =>
        ({
          modelVersion: 'v1',
          segments: [{ start: 8, end: 12, speaker: 'SPEAKER_00', embedding: [1, 0] }],
          speakers: [{ speaker: 'SPEAKER_00', embedding: [0, 1], clipSeconds: 20 }],
        }) satisfies DiarizeResult,
    } as any
    const saved: SavedWindow[] = []
    const identify = makeIdentifyFn({
      engine,
      registry,
      windowing: { windowS: 20, resume: { load: () => [], save: (w) => saved.push(w) } },
    })
    await identify('clean1', sine45s, 'audio/wav')
    expect(saved.length).toBeGreaterThan(0)
    expect(saved[0].speakers).toEqual([{ speaker: 'SPEAKER_00', embedding: [0, 1], clipSeconds: 20 }])
  })

  it('(c0b) 分窗路径：registry 存的簇代表由各窗干净代表聚出，不是段级均值', async () => {
    // (c0) 守的是干净代表落进 resume 文件；这条守它一路走到声纹库——门控只惠及跨窗合并
    // 而库里仍存脏代表的话，自动认名与手动 enroll 用的都还是没过闸的向量。
    const registry = new SpeakerRegistryStore(':memory:')
    const engine = {
      configured: () => true,
      diarize: async () =>
        ({
          modelVersion: 'v1',
          segments: [{ start: 8, end: 12, speaker: 'SPEAKER_00', embedding: [1, 0] }],
          speakers: [{ speaker: 'SPEAKER_00', embedding: [0, 1], clipSeconds: 20 }],
        }) satisfies DiarizeResult,
    } as any
    const identify = makeIdentifyFn({ engine, registry, windowing: { windowS: 20 } })
    await identify('clean2', sine45s, 'audio/wav')
    const rep = registry.getItemCluster('clean2', 'SPEAKER_00')!.embedding
    expect(rep[1]).toBeGreaterThan(0.999) // ≈[0,1]：干净代表，不是段级的 [1,0]
  })

  it('(c) resume.load 预置 2/4 窗 → engine 只被调 2 次,save 只收到新算的 2 窗', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const { engine, calls } = windowedEngine((i) => ([1, 0]))
    const preset: SavedWindow[] = [
      { index: 0, startS: 0, durS: 20, modelVersion: 'v1', segments: [{ start: 8, end: 12, speaker: 'SPEAKER_00', embedding: [1, 0] }] },
      { index: 1, startS: 10, durS: 20, modelVersion: 'v1', segments: [{ start: 8, end: 12, speaker: 'SPEAKER_00', embedding: [1, 0] }] },
    ]
    const saved: SavedWindow[] = []
    const progress: Array<[number, number]> = []
    const identify = makeIdentifyFn({
      engine,
      registry,
      windowing: {
        windowS: 20,
        resume: { load: () => preset, save: (w) => saved.push(w) },
        onProgress: (d, t) => progress.push([d, t]),
      },
    })
    await identify('resume1', sine45s, 'audio/wav')
    expect(calls).toHaveLength(2) // 只算了 2、3 两窗
    expect(saved.map((w) => w.index)).toEqual([2, 3])
    expect(progress).toEqual([[3, 4], [4, 4]]) // done 计数把预置窗也算进分子
    // 预置窗全程有效:merge 覆盖 4 窗 → 全局 SPEAKER_00 进了 registry(modelVersion 来自预置窗也行)
    expect(registry.getItemCluster('resume1', 'SPEAKER_00')?.modelVersion).toBe('v1')
  })

  it('(c2) resume.load 里的垃圾条目(缺 index/segments)被忽略,不挡整跑', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const { engine, calls } = windowedEngine(() => [1, 0])
    const identify = makeIdentifyFn({
      engine,
      registry,
      windowing: { windowS: 20, resume: { load: () => [{} as any, { index: 99, startS: 0, durS: 20, segments: [] }], save: () => {} } },
    })
    const out = await identify('junk1', sine45s, 'audio/wav')
    expect(calls).toHaveLength(4) // 垃圾条目一个都没顶掉真窗
    expect(out.some((s) => s.speaker)).toBe(true) // 没有因此降级
  })

  it('(c3) 几何守卫:resume 里 startS/durS 和重算出的同 index 窗对不上(窗参数变了)→ 当没存过,该窗重算', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const { engine, calls } = windowedEngine(() => [1, 0])
    // index 0 的几何被错配成 startS=999(旧参数残留/损坏),真实窗是 startS=0——守卫要拦住它
    const preset: SavedWindow[] = [
      { index: 0, startS: 999, durS: 20, modelVersion: 'v1', segments: [{ start: 8, end: 12, speaker: 'SPEAKER_00', embedding: [1, 0] }] },
      { index: 1, startS: 10, durS: 20, modelVersion: 'v1', segments: [{ start: 8, end: 12, speaker: 'SPEAKER_00', embedding: [1, 0] }] },
    ]
    const identify = makeIdentifyFn({
      engine,
      registry,
      windowing: { windowS: 20, resume: { load: () => preset, save: () => {} } },
    })
    await identify('geom1', sine45s, 'audio/wav')
    // 预置窗只剩 1(index 1)几何对得上,其余 3 个(0、2、3)都得重算
    expect(calls).toHaveLength(3)
  })

  it('(c4) modelVersion 守卫:全部窗来自 resume 但预置窗版本彼此不一致 → 保守全部重算', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const { engine, calls } = windowedEngine(() => [1, 0])
    const preset: SavedWindow[] = [
      { index: 0, startS: 0, durS: 20, modelVersion: 'v1', segments: [{ start: 8, end: 12, speaker: 'SPEAKER_00', embedding: [1, 0] }] },
      { index: 1, startS: 10, durS: 20, modelVersion: 'v2', segments: [{ start: 8, end: 12, speaker: 'SPEAKER_00', embedding: [1, 0] }] },
      { index: 2, startS: 20, durS: 20, modelVersion: 'v1', segments: [{ start: 8, end: 12, speaker: 'SPEAKER_00', embedding: [1, 0] }] },
      { index: 3, startS: 30, durS: 15, modelVersion: 'v1', segments: [{ start: 8, end: 12, speaker: 'SPEAKER_00', embedding: [1, 0] }] },
    ]
    const identify = makeIdentifyFn({
      engine,
      registry,
      windowing: { windowS: 20, resume: { load: () => preset, save: () => {} } },
    })
    await identify('mixver1', sine45s, 'audio/wav')
    expect(calls).toHaveLength(4) // 全窗都来自 resume 但版本混杂 → 全部重算,一个都没采信
  })

  it('(c5) modelVersion 守卫:部分窗来自 resume,新鲜调用确立权威版本后,版本不一致的预置窗被丢弃重算', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const { engine, calls } = windowedEngine(() => [1, 0]) // 新鲜调用一律返回 v1
    // index 0 预置成旧版本 v0(7 天前 error 行遗留、期间镜像换过模型);index 1 缺,要新鲜算
    const preset: SavedWindow[] = [
      { index: 0, startS: 0, durS: 20, modelVersion: 'v0', segments: [{ start: 8, end: 12, speaker: 'SPEAKER_00', embedding: [1, 0] }] },
    ]
    const identify = makeIdentifyFn({
      engine,
      registry,
      windowing: { windowS: 20, resume: { load: () => preset, save: () => {} } },
    })
    await identify('mixver2', sine45s, 'audio/wav')
    // index 0 的 v0 和权威版本 v1 不一致 → 连同 1、2、3 一起重算,4 窗全打了引擎
    expect(calls).toHaveLength(4)
  })

  it('(d) onProgress 每窗完成回调,收到 (1,4)...(4,4)', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const { engine } = windowedEngine(() => [1, 0])
    const progress: Array<[number, number]> = []
    const identify = makeIdentifyFn({
      engine,
      registry,
      windowing: { windowS: 20, onProgress: (d, t) => progress.push([d, t]) },
    })
    await identify('prog1', sine45s, 'audio/wav')
    expect(progress).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]])
  })

  it('(e) 任一窗抛错 → 整体降级返回空时间线,onError 与 onDegrade 都被叫到', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const { engine, calls } = windowedEngine(() => [1, 0], 2) // 第 3 窗(callIdx=2)炸
    let caught: unknown = null
    let degraded: unknown = null
    const identify = makeIdentifyFn({
      engine,
      registry,
      onError: (e) => (caught = e),
      windowing: { windowS: 20, onDegrade: (e) => (degraded = e) },
    })
    const out = await identify('boom1', sine45s, 'audio/wav')
    expect(calls).toHaveLength(3) // 0、1 成功,2 炸,3 没跑
    // 失败 = 没补上：交出空时间线。**「没补上」不能从返回值认**（空也可能是真的没人说话），
    // 只能从 onDegrade 认——下面那条断言才是分账的依据。
    expect(out).toEqual([])
    expect(caught).toBeInstanceOf(Error)
    expect(degraded).toBeInstanceOf(Error) // 让 service 分账"真异常 → fail"的通道
    expect(registry.getItemCluster('boom1', 'SPEAKER_00')).toBeFalsy() // 半截结果没进 registry
  })

  it('per-call windowing(第 6 参)在 deps 没配 windowing 时也能启用分窗', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const { engine, calls } = windowedEngine(() => [1, 0])
    const identify = makeIdentifyFn({ engine, registry })
    await identify('call1', sine45s, 'audio/wav', undefined, { windowS: 20 })
    expect(calls).toHaveLength(4)
  })
})

// 掌声/笑声被判成说话人这件事：结构判据（shards.ts）+ 容器帧证据两个信号都命中才摘段。
// 这里验的是**接线**：嫌疑区间确实被送去问帧证据、判为非人声的段真的从时间线上消失、
// 而取不到帧证据时一段都不摘（宁可留错簇，不删真话——2026-07-27 那次证伪的教训）。
describe('makeIdentifyFn — 摘掉非人声碎片', () => {
  /** 一个人连续讲、掌声按 0 秒间隔插进来的形状（与 shards.test.ts 同一形状）。 */
  function shardShaped(): DiarizeResult {
    const segments: DiarizeResult['segments'] = []
    let t = 10
    for (let i = 0; i < 6; i++) {
      segments.push({ start: t, end: t + 8, speaker: 'SPEAKER_00', embedding: [1, 0] })
      t += 8
      segments.push({ start: t, end: t + 3, speaker: 'SPEAKER_09', embedding: [0, 1] })
      t += 3
    }
    segments.push({ start: t, end: t + 40, speaker: 'SPEAKER_00', embedding: [1, 0] })
    return { modelVersion: 'v1', segments }
  }

  const engineWith = (res: DiarizeResult, speechFrac: unknown) =>
    ({ configured: () => true, diarize: async () => res, speechFrac }) as any

  it('帧证据说是非人声 → 那些段从时间线上摘掉，宿主的段一段不动', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const res = shardShaped()
    let asked: [number, number][] = []
    const identify = makeIdentifyFn({
      engine: engineWith(res, async (_b: unknown, _m: unknown, ivs: [number, number][]) => {
        asked = ivs
        return ivs.map(([s, e]) => ({ start: s, end: e, frac: 0.1, nonspeech: true }))
      }),
      registry,
    })
    await identify('shard1', bytes, 'audio/wav')
    // 只问了嫌疑簇的段，没把宿主的段也送去问
    expect(asked.length).toBe(6)
    const spans = registry.getItemTimeline('shard1')
    expect(spans.some((s) => s.speaker === 'SPEAKER_09')).toBe(false)
    expect(spans.filter((s) => s.speaker === 'SPEAKER_00').length).toBe(7)
  })

  it('帧证据说还是人声 → 一段不摘（只命中结构一个信号不够）', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const identify = makeIdentifyFn({
      engine: engineWith(shardShaped(), async (_b: unknown, _m: unknown, ivs: [number, number][]) =>
        ivs.map(([s, e]) => ({ start: s, end: e, frac: 0.8, nonspeech: false }))
      ),
      registry,
    })
    await identify('shard2', bytes, 'audio/wav')
    expect(registry.getItemTimeline('shard2').some((s) => s.speaker === 'SPEAKER_09')).toBe(true)
  })

  it('帧证据取不到（容器 503/超时）→ 一段不摘，识别照常完成', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const identify = makeIdentifyFn({
      engine: engineWith(shardShaped(), async () => {
        throw new Error('HTTP 503')
      }),
      registry,
    })
    const out = await identify('shard3', bytes, 'audio/wav')
    // 摘不掉噪声段不影响完成：时间线照样产出、照样落库
    expect(out.length).toBeGreaterThan(0)
    expect(registry.getItemTimeline('shard3').some((s) => s.speaker === 'SPEAKER_09')).toBe(true)
  })

  it('摘段要往 debug bus 记一条——dev 档下后端 stdout 进不了 docker logs,console.log 等于写进黑洞', async () => {
    const registry = new SpeakerRegistryStore(':memory:')
    const seen: { channel: string; key: string; summary: string }[] = []
    const identify = makeIdentifyFn({
      engine: engineWith(shardShaped(), async (_b: unknown, _m: unknown, ivs: [number, number][]) =>
        ivs.map(([s, e]) => ({ start: s, end: e, frac: 0.1, nonspeech: true }))
      ),
      registry,
      onDebug: (e) => seen.push({ channel: e.channel, key: e.key, summary: e.summary }),
    })
    await identify('shard4', bytes, 'audio/wav')
    const rec = seen.find((e) => e.channel === 'voiceprint')
    expect(rec).toBeTruthy()
    expect(rec!.key).toBe('shard4')
    expect(rec!.summary).toContain('6/6 段')
  })
})
