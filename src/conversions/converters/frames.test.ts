// src/conversions/converters/frames.test.ts
//
// 全部注入假 deps：不打 ffmpeg、不打网络、不碰真 store。抽帧的三条 ffmpeg 命令
// （sampleFrames / planVideoFrames / frameAt）都是注入进来的，测试才管得住「哪一步
// 有没有被调用」——而「全扫有没有被挡在闸门后面」正是这层最贵的那条不变量。
import { describe, it, expect, vi } from 'vitest'
import { makeFramesConverter, type FramesConverterDeps, type FramesResult } from './frames.ts'
import type { ConversionContext, ConversionOutcome } from '../runner.ts'
import type { ConversionRecord } from '../store.ts'
import type { KeyframeCandidate } from '../../media/video-frames.ts'

// —— 脚手架 ——

function ctxOf(overrides: Partial<ConversionContext> = {}): ConversionContext {
  return {
    id: 'c1',
    itemId: 'item-1',
    kind: 'extract',
    options: {},
    signal: new AbortController().signal,
    stage: async (_name, fn) => fn(),
    ...overrides,
  } as ConversionContext
}

/** 一条已完成的上游 extract 记录（只填这层读的那几个字段）。 */
function upstreamRecord(result: unknown): ConversionRecord {
  return {
    id: 'up-1',
    kind: 'extract',
    itemId: 'item-1',
    status: 'done',
    result,
    createdAt: '',
    updatedAt: '',
  } as ConversionRecord
}

/** 帧的 `at` 直接编进字节里，ocr 假实现按它查表——这样一次 ocr 调用能对上是哪一帧。 */
const bytesFor = (at: number) => new Uint8Array([at])

interface FakeOpts {
  /** 上游 extract 的产物；null = 这条 item 没有转写。 */
  upstream?: unknown | null
  source?: { url: string; headers?: Record<string, string> } | null
  sampled?: KeyframeCandidate[]
  planned?: KeyframeCandidate[]
  /** at → OCR 文本；返回 null = 没识别出东西；抛 = 这一帧失败。 */
  ocrText?: (at: number) => string | null
}

function makeDeps(o: FakeOpts) {
  const calls = { sample: 0, plan: 0, frameAt: [] as number[], ocr: [] as number[] }
  const deps: FramesConverterDeps = {
    store: {
      get: () => null,
      latestFor: () => (o.upstream === undefined || o.upstream === null ? null : upstreamRecord(o.upstream)),
    } as FramesConverterDeps['store'],
    resolveVideoSource: async () => (o.source === undefined ? { url: 'v.mp4' } : o.source),
    available: () => true,
    sampleFrames: async () => {
      calls.sample += 1
      return o.sampled ?? []
    },
    planVideoFrames: async () => {
      calls.plan += 1
      return o.planned ?? []
    },
    frameAt: async (_src, at) => {
      calls.frameAt.push(at)
      return bytesFor(at)
    },
    ocr: async (bytes) => {
      const at = bytes[0]!
      calls.ocr.push(at)
      return o.ocrText ? o.ocrText(at) : 'PPT 标题\n要点一\n要点二'
    },
  }
  return { deps, calls }
}

function resultOf(out: ConversionOutcome): FramesResult {
  expect(out.ok).toBe(true)
  return (out as { ok: true; result: unknown }).result as FramesResult
}

// 一段「他在指着屏幕讲」的转写：闸门会放行（deictic 命中足够）。
const TALKING = [{ start: 0, end: 20, text: '大家看这里 我点一下这个东西' }]

describe('frames converter — 五级止损，每一级都可能成功地什么都不产出', () => {
  it('闸门判纯口播：ok=true、stop=gate、track 空，且一步字节都不付', async () => {
    // 语速密度高（60 秒 300 字）且无指示语 → dense_speech。
    const { deps, calls } = makeDeps({
      upstream: { text: '啊'.repeat(300), detail: { segments: [{ start: 0, end: 60, text: '啊'.repeat(300) }] } },
    })
    const out = await makeFramesConverter(deps).run(ctxOf())

    expect(out.ok).toBe(true) // 「判为不抽」是成功，不是失败
    const r = resultOf(out)
    expect(r.track).toEqual([])
    expect(r.probe.stop).toBe('gate')
    expect(r.probe.gate.reason).toBe('dense_speech')
    // 最贵的那一步必须在闸门后面：全扫要读完整个文件（两小时的片子几个 GB）。
    expect(calls.plan).toBe(0)
    expect(calls.sample).toBe(0)
  })

  it('没有视频源：ok=true、stop=no_source（这条 item 没得抽，不是后端坏了）', async () => {
    const { deps, calls } = makeDeps({
      upstream: { text: '大家看这里', detail: { segments: TALKING } },
      source: null,
    })
    const out = await makeFramesConverter(deps).run(ctxOf())

    expect(out.ok).toBe(true)
    const r = resultOf(out)
    expect(r.probe.stop).toBe('no_source')
    expect(r.track).toEqual([])
    expect(calls.sample).toBe(0)
    expect(calls.plan).toBe(0)
  })

  it('画面不动：ok=true、stop=still_picture，读数进账，全扫不发生', async () => {
    const { deps, calls } = makeDeps({
      upstream: { text: '大家看这里', detail: { segments: TALKING } },
      sampled: [10, 11, 12, 13].map((at) => ({ at, hash: '0000' })),
    })
    const out = await makeFramesConverter(deps).run(ctxOf())

    expect(out.ok).toBe(true)
    const r = resultOf(out)
    expect(r.probe.stop).toBe('still_picture')
    expect(r.probe.sampled).toBe(4)
    expect(r.probe.maxDistance).toBe(0)
    expect(calls.sample).toBe(1)
    expect(calls.plan).toBe(0) // 稀疏探帧出局 → 不付全扫
  })

  it('探过没料：ok=true、stop=no_new_text，且账上看得出「探了几张」不是「没跑」', async () => {
    const { deps, calls } = makeDeps({
      upstream: { text: '大家看这里', detail: { segments: [{ start: 0, end: 40, text: '大家看这里 我点一下这个东西' }] } },
      sampled: [
        { at: 10, hash: '0000' },
        { at: 20, hash: 'ffff' },
        { at: 30, hash: '0f0f' },
      ],
      // 帧上的字就是烧进画面的字幕，和同一时刻的转写一模一样 → 没有新字。
      ocrText: () => '大家看这里 我点一下这个东西',
    })
    const out = await makeFramesConverter(deps).run(ctxOf())

    expect(out.ok).toBe(true)
    const r = resultOf(out)
    expect(r.probe.stop).toBe('no_new_text')
    expect(r.track).toEqual([])
    // 「没跑」和「跑了没料」必须分得开：track 空不算证据，ocrTried 才是。
    expect(r.probe.ocrTried).toBeGreaterThan(0)
    expect(calls.plan).toBe(0)
  })

  it('正式抽：stop=done，track 里只留「转写拿不到的那部分」', async () => {
    const segments = [
      { start: 0, end: 20, text: '大家看这里 我点一下这个东西' },
      { start: 100, end: 120, text: '大家看这里 我点一下这个东西' },
    ]
    const { deps, calls } = makeDeps({
      upstream: { text: '大家看这里 我点一下这个东西', detail: { segments } },
      sampled: [
        { at: 10, hash: '0000' },
        { at: 20, hash: 'ffff' },
      ],
      planned: [
        { at: 1, hash: '0000' },
        { at: 2, hash: 'ffff' },
      ],
      ocrText: (at) => {
        if (at === 1) return '大家看这里 我点一下这个东西' // 烧进画面的字幕 → 丢
        if (at === 2) return 'const x = 1\nconst y = 2\nreturn x + y' // 幻灯片上的代码 → 留
        return 'PPT 标题\n要点一\n要点二' // 探帧那几张（at >= 10）
      },
    })
    const out = await makeFramesConverter(deps).run(ctxOf())

    expect(out.ok).toBe(true)
    const r = resultOf(out)
    expect(r.probe.stop).toBe('done')
    // 稀疏样本（at 10/20）也是正式候选（`mergeCandidates`），所以它们的字照样进轨；
    // at 20 与 at 10 同字，被文本级去重收掉。
    expect(r.track).toEqual([
      { at: 2, text: 'const x = 1\nconst y = 2\nreturn x + y' },
      { at: 10, text: 'PPT 标题\n要点一\n要点二' },
    ])
    expect(r.probe.framesKept).toBe(2)
    expect(calls.plan).toBe(1)
    // 探帧那两张不会被再 OCR 一遍——两轮共用一份记账（同一张图付两次钱是纯亏）。
    expect(calls.ocr.filter((at) => at === 10)).toHaveLength(1)
  })

  it('同一行字跨帧重复：文本级去重收掉，且丢了多少记在账上', async () => {
    // 没有转写 → newTextAt 没有比较对象，每一行都算「新的」。这条路径上文本级去重
    // 是唯一的把关（活体撞过：轨里一半是反复出现的角标）。
    const { deps } = makeDeps({
      upstream: null,
      sampled: [
        { at: 10, hash: '0000' },
        { at: 20, hash: 'ffff' },
      ],
      planned: [
        { at: 1, hash: '0000' },
        { at: 2, hash: 'ffff' },
        { at: 3, hash: '0f0f' },
      ],
      ocrText: (at) => (at < 10 ? '```\n同一页的要点\n要点二\n要点三\n```' : 'PPT 标题\n要点一\n要点二'),
    })
    const out = await makeFramesConverter(deps).run(ctxOf({ options: { media: [{ kind: 'video', url: 'v.mp4' }] } }))

    const r = resultOf(out)
    expect(r.probe.stop).toBe('done')
    expect(r.track).toEqual([{ at: 1, text: '同一页的要点\n要点二\n要点三' }])
    // 候选 = 1、2（I 帧；3 与 2 只差 8 位，`mergeCandidates` 按同一条门槛并掉了）+ 10、20
    // （稀疏样本）。重复行：第 2 帧三行全重复、第 20 帧三行全重复，再加第 10 帧的「要点二」
    // ——它和第 1 帧那页共用这一行。
    expect(r.probe.repeatedLines).toBe(7)
    expect(r.probe.emptyLines).toBe(4) // 第 1、2 帧各两条 markdown 围栏
    expect(r.probe.framesKept).toBe(1)
  })

  it('单帧 OCR 抛错：换成一条看得见的标记，别的帧照跑', async () => {
    const { deps } = makeDeps({
      upstream: { text: '大家看这里', detail: { segments: TALKING } },
      sampled: [
        { at: 10, hash: '0000' },
        { at: 20, hash: 'ffff' },
      ],
      planned: [
        { at: 1, hash: '0000' },
        { at: 2, hash: 'ffff' },
        { at: 3, hash: '0f0f' },
      ],
      ocrText: (at) => {
        if (at === 2) throw new Error('OCR 后端 500')
        return `第 ${at} 帧的幻灯片标题\n第 ${at} 帧要点一\n第 ${at} 帧要点二`
      },
    })
    const out = await makeFramesConverter(deps).run(ctxOf())

    const r = resultOf(out)
    expect(r.probe.stop).toBe('done')
    // 塌掉的那一帧不能把整条带走，也不能静静消失。
    // 候选 = 1、2（3 与 2 只差 8 位被并掉）+ 稀疏样本 10、20。
    expect(r.track.map((t) => t.at)).toEqual([1, 2, 10, 20])
    expect(r.track[1]!.text).toContain('未识别')
    expect(r.track[1]!.text).toContain('OCR 后端 500')
    expect(r.probe.ocrFailed).toBe(1)
    expect(r.probe.framesKept).toBe(3) // 标记不算「抽到字的帧」
  })

  it('超上限：保留哈希差异最大的那些，且截掉多少必须记在账上', async () => {
    // 12 个候选帧，上限 3。
    // 哈希必须两两够远（≥ DEFAULT_MIN_DISTANCE），否则候选集在 `mergeCandidates` 那一步
    // 就被并掉了，这条用例（测的是**上限截断**）根本走不到 capFrames。原来那组
    // `'0000'..'000b'` 彼此只差几位，`planVideoFrames` 真身自己就会把它们并成两张——
    // 假件跳过了那一步，于是这个夹具从来不是一份合法的 plan 产物。
    const planned = Array.from({ length: 12 }, (_, i) => ({ at: i + 1, hash: i % 2 === 0 ? '0000' : 'ffff' }))
    const { deps, calls } = makeDeps({
      upstream: { text: '大家看这里', detail: { segments: TALKING } },
      sampled: [
        { at: 100, hash: '0000' },
        { at: 200, hash: 'ffff' },
      ],
      planned,
      ocrText: (at) => `第 ${at} 帧标题\n第 ${at} 帧要点一\n第 ${at} 帧要点二`,
    })
    const out = await makeFramesConverter(deps, { maxFrames: 3 }).run(ctxOf())

    const r = resultOf(out)
    // 候选 = 12 张 I 帧 + 2 张稀疏样本（都够远，一张没被并掉）。
    expect(r.probe.plannedKeyframes).toBe(12)
    expect(r.probe.planned).toBe(14)
    expect(r.probe.truncated).toBe(11) // 不许静默截断
    expect(r.track).toHaveLength(3)
    // 只对留下的 3 张付 OCR，不是先全抽再丢。
    expect(calls.frameAt.filter((at) => at <= 12)).toHaveLength(3)
    // 时间序不能被排序打乱——下游要拿它跟转写对齐。
    expect(r.track.map((t) => t.at)).toEqual([...r.track.map((t) => t.at)].sort((a, b) => a - b))
  })

  it('没有转写照样跑：闸门判 no_transcript（信息可能全在画面上）', async () => {
    const { deps, calls } = makeDeps({
      upstream: null,
      sampled: [
        { at: 10, hash: '0000' },
        { at: 20, hash: 'ffff' },
      ],
      planned: [{ at: 1, hash: '0000' }],
      ocrText: () => '屏幕上的字\n第二行\n第三行',
    })
    const out = await makeFramesConverter(deps).run(ctxOf())

    const r = resultOf(out)
    expect(r.probe.gate.reason).toBe('no_transcript')
    expect(r.probe.stop).toBe('done')
    expect(r.track).toEqual([{ at: 1, text: '屏幕上的字\n第二行\n第三行' }])
    expect(calls.plan).toBe(1)
  })

  it('没有转写时退到 item 自己的 media（ctx.options.media），不落成 no_source', async () => {
    // 闸门判 no_transcript 放行之后，取地址这一步不能因为「没有上游转写」就跟着没有 media
    // ——上游根本不存在时 detail.media 自然也不存在，这一步必须有 HTTP 路由早就递进来的
    // ctx.options.media 兜底，否则闸门刚判完「没转写最该抽」，下一步立刻打脸。
    const optionsMedia = [{ kind: 'video' as const, provider: 'bilibili', vid: 'BV-options' }]
    const { deps } = makeDeps({
      upstream: null,
      sampled: [
        { at: 10, hash: '0000' },
        { at: 20, hash: 'ffff' },
      ],
      planned: [{ at: 1, hash: '0000' }],
      ocrText: () => '屏幕上的字\n第二行\n第三行',
    })
    const resolve = vi.fn(async (_itemId: string, media: unknown) =>
      // 只有拿到了 media 才给地址——精确复现活体那次「media undefined → resolveVideoSource
      // 返回 null → 停在 no_source」的坏路径。
      media ? { url: 'v.mp4' } : null,
    )
    const out = await makeFramesConverter({ ...deps, resolveVideoSource: resolve }, {}).run(
      ctxOf({ options: { media: optionsMedia } }),
    )

    expect(resolve).toHaveBeenCalledWith('item-1', optionsMedia)
    const r = resultOf(out)
    expect(r.probe.stop).not.toBe('no_source')
    expect(r.probe.stop).toBe('done')
  })

  it('上游转写记下的 media 优先于 ctx.options.media（同源于当时真正用过的那份）', async () => {
    const upstreamMedia = [{ kind: 'video' as const, provider: 'bilibili', vid: 'BV-upstream' }]
    const optionsMedia = [{ kind: 'video' as const, provider: 'bilibili', vid: 'BV-options' }]
    const { deps } = makeDeps({
      upstream: { text: '大家看这里', detail: { segments: TALKING, media: upstreamMedia } },
    })
    const resolve = vi.fn(deps.resolveVideoSource)
    await makeFramesConverter({ ...deps, resolveVideoSource: resolve }, {}).run(
      ctxOf({ options: { media: optionsMedia } }),
    )

    expect(resolve).toHaveBeenCalledWith('item-1', upstreamMedia)
  })

  it('取视频源用的是上游转写记下的 media，headers 一路带到三条 ffmpeg 命令上', async () => {
    const media = [{ kind: 'video' as const, provider: 'bilibili', vid: 'BV1', duration_s: 600 }]
    const { deps } = makeDeps({
      upstream: { text: '大家看这里', detail: { segments: TALKING, media } },
      source: { url: 'https://cdn/v.m4s', headers: { Referer: 'https://www.bilibili.com' } },
      sampled: [
        { at: 10, hash: '0000' },
        { at: 20, hash: 'ffff' },
      ],
      planned: [{ at: 1, hash: '0000' }],
    })
    const resolve = vi.fn(deps.resolveVideoSource)
    const sample = vi.fn(deps.sampleFrames)
    const plan = vi.fn(deps.planVideoFrames)
    const frame = vi.fn(deps.frameAt)
    await makeFramesConverter({ ...deps, resolveVideoSource: resolve, sampleFrames: sample, planVideoFrames: plan, frameAt: frame }).run(ctxOf())

    expect(resolve).toHaveBeenCalledWith('item-1', media)
    expect(sample.mock.calls[0]![1]).toMatchObject({ headers: { Referer: 'https://www.bilibili.com' } })
    expect(plan.mock.calls[0]![1]).toMatchObject({ headers: { Referer: 'https://www.bilibili.com' } })
    expect(frame.mock.calls[0]![3]).toMatchObject({ headers: { Referer: 'https://www.bilibili.com' } })
  })

  it('取样/全扫这两条 ffmpeg 命令自己炸了：那才是真失败（ok=false），不许混进「探过没料」', async () => {
    const { deps } = makeDeps({ upstream: { text: '大家看这里', detail: { segments: TALKING } } })
    const boom: FramesConverterDeps = {
      ...deps,
      sampleFrames: async () => {
        throw new Error('ffprobe returned no duration')
      },
    }
    const out = await makeFramesConverter(boom).run(ctxOf())
    expect(out.ok).toBe(false)
    expect((out as { ok: false; error: { code: string } }).error.code).toBe('sample_failed')
  })

  it('全扫（planVideoFrames）自己炸了：ok=false、code=plan_failed，绝不能落成 no_new_text', async () => {
    // 探帧那 2–3 张必须先探出新字，才会往下付全扫这一步——否则根本走不到 plan。
    const { deps } = makeDeps({
      upstream: { text: '大家看这里', detail: { segments: TALKING } },
      sampled: [
        { at: 10, hash: '0000' },
        { at: 20, hash: 'ffff' },
      ],
      ocrText: () => 'PPT 标题\n要点一\n要点二', // 探帧就已经抽到新字 → 进入正式抽这一步
    })
    let planCalled = 0
    const boom: FramesConverterDeps = {
      ...deps,
      planVideoFrames: async () => {
        planCalled += 1
        throw new Error('ffmpeg crashed mid-scan')
      },
    }
    const out = await makeFramesConverter(boom).run(ctxOf())
    expect(out.ok).toBe(false)
    expect((out as { ok: false; error: { code: string } }).error.code).toBe('plan_failed')
    expect(planCalled).toBe(1) // 真的付出去了，不是被闸门拦下来的
  })

  it('取视频地址炸了（网盘/抖音容器/B站签名答不上来）：ok=false、code=source_failed，不许落成 no_source', async () => {
    const { deps } = makeDeps({ upstream: { text: '大家看这里', detail: { segments: TALKING } } })
    const boom: FramesConverterDeps = {
      ...deps,
      resolveVideoSource: async () => {
        throw new Error('netdisk rawUrl timed out')
      },
    }
    const out = await makeFramesConverter(boom).run(ctxOf())
    expect(out.ok).toBe(false)
    expect((out as { ok: false; error: { code: string } }).error.code).toBe('source_failed')
  })

  it('OCR 跑成功但图上没字：ocrEmpty 计数，和 ocrFailed（跑塌了）是两个相反的排查方向', async () => {
    const segments = [{ start: 0, end: 20, text: '大家看这里 我点一下这个东西' }]
    const { deps } = makeDeps({
      upstream: { text: '大家看这里 我点一下这个东西', detail: { segments } },
      sampled: [
        { at: 10, hash: '0000' },
        { at: 20, hash: 'ffff' },
      ],
      planned: [
        { at: 1, hash: '0000' }, // 空白画面 → OCR 跑成功但没识别出字
        { at: 2, hash: 'ffff' }, // 幻灯片上的代码 → 有新字
      ],
      ocrText: (at) => {
        if (at === 1) return null // 全扫里的空白画面 → 这才是要测的 ocrEmpty
        if (at === 2) return 'const x = 1\nconst y = 2\nreturn x + y'
        return 'PPT 标题\n要点一\n要点二' // 探帧那几张（at >= 10）先探出新字，才能过 no_new_text 这道闸
      },
    })
    const out = await makeFramesConverter(deps).run(ctxOf())

    const r = resultOf(out)
    expect(r.probe.stop).toBe('done')
    expect(r.probe.ocrEmpty).toBeGreaterThan(0)
    expect(r.probe.ocrFailed).toBe(0) // 「没字」不是「跑塌了」，不能记进同一个数
    // 稀疏样本也在正式候选里，所以它们的字照样进轨（at 20 与 at 10 同字，被去重收掉）。
    expect(r.track).toEqual([
      { at: 2, text: 'const x = 1\nconst y = 2\nreturn x + y' },
      { at: 10, text: 'PPT 标题\n要点一\n要点二' },
    ])
  })

  // 回归：2026-08-30 活体（抖音新闻 `54302ede4b47213a`，7.33s / 220 帧）。**全片只有 2 个
  // I 帧**（0.000 / 6.967），而第 3.5–4.5 秒整整一屏新闻通稿正文——这条视频信息量最大的
  // 那一屏——从头到尾没进过候选。稀疏取样的 4.13s 那一张恰好就是它，取到了、探 OCR 过了，
  // 然后被丢掉。夹具照抄那组数字。
  it('I 帧稀疏的短视频：稀疏样本必须进正式候选，否则整屏字永远抽不到', async () => {
    /** 那一屏新闻通稿正文在画面上的时段。 */
    const bodyScreen = (at: number) => at >= 2.9 && at <= 5.4

    const { deps } = makeDeps({
      upstream: { text: '山山流水终于穿过了群山一座座', detail: { segments: [{ start: 0, end: 6.96, text: '山山流水终于穿过了群山一座座' }] } },
      // 均匀 8 张（(i+0.5)/8 * 7.33），和 `sampleFrames` 真身一个算法。
      // 均匀 8 张（(i+0.5)/8 * 7.33 → 0.46/1.37/2.29/3.21/4.12/5.04/5.96/6.87）。
      // 画面分两段：正文屏占 2.9–5.4 秒，其余是标题屏——**哈希和 ocrText 必须按同一条
      // 分界切**，否则夹具自己就自相矛盾（去重只留每一段的第一张，那一张的字得对得上）。
      sampled: Array.from({ length: 8 }, (_, i) => {
        const at = ((i + 0.5) / 8) * 7.33
        return { at, hash: bodyScreen(at) ? 'ffff' : '0000' }
      }),
      // 真身在这条视频上只给得出这两张，而且都落在标题/片尾屏上。
      planned: [{ at: 0, hash: '0000' }, { at: 6.966667, hash: '0000' }],
      // 正文屏是整段通稿（多行）；标题屏两行。行数照抄真实 OCR 产物——**少于
      // `DEFAULT_MIN_LINES` 会被当成烧录字幕整帧丢掉**，一行的假件测不出这条路。
      ocrText: (at) =>
        bodyScreen(at)
          ? '中华慈善总会携手网球运动员郑钦文捐赠100万元善款支援西藏吉隆抢险救灾\n8月26日，因尼泊尔一侧发生泥石流灾害\n造成西藏日喀则市吉隆县吉隆口岸重大人员伤亡、失联\n通过中华慈善总会向西藏吉隆泥石流灾区捐赠善款100万元'
          : '郑钦文捐赠100万元\n驰援西藏吉隆泥石流灾区',
    })
    const out = await makeFramesConverter(deps).run(ctxOf())

    const r = resultOf(out)
    expect(r.probe.stop).toBe('done')
    // 两个数一比就看得出这条视频的 I 帧有多稀——将来调策略要靠这批读数。
    expect(r.probe.plannedKeyframes).toBe(2)
    expect(r.probe.planned).toBeGreaterThan(2)
    // 正文那一屏必须在轨里。**这是这条用例的全部意义**：改回「候选集只认 I 帧」它立刻变红。
    expect(r.track.some((t) => t.text.includes('中华慈善总会'))).toBe(true)
    expect(r.track.some((t) => t.at >= 3 && t.at <= 5)).toBe(true)
  })
})
