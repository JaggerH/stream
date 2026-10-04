import { describe, expect, it, vi } from 'vitest'
import { makeIdentifyConverter, probeOf, type IdentifyConverterDeps, type IdentifyProbe } from './identify.ts'
import { makeSummaryConverter } from './summary.ts'
import { ConversionRunner } from '../runner.ts'
import { ConversionStore } from '../store.ts'

const settle = () => new Promise((r) => setTimeout(r, 0))
const SEGMENTS = [{ start: 0, end: 2, text: 'hello' }]

/** 种一条已完成的 extract（转写分支）——identify / summary 的输入都是它。
 *  时间轴在 detail 下：那是转写分支特产，不进公共合同（合同只有 text）。 */
function seedTranscript(store: ConversionStore, itemId = 'i') {
  const rec = store.create({ kind: 'extract', itemId })
  store.update(rec.id, {
    status: 'done',
    result: { text: 'hello', format: 'plain', branch: 'stt', detail: { lang: 'zh', segments: SEGMENTS } },
  })
  return store.get(rec.id)!
}

function setup(over: Partial<IdentifyConverterDeps> = {}) {
  const store = new ConversionStore(':memory:')
  const deps: IdentifyConverterDeps = {
    store,
    resolveMedia: vi.fn(async () => ({ bytes: new Uint8Array([1]), mime: 'audio/mp4' })),
    // identify 只答「谁在说」：一条时间线，**不认识文字**。投影是 converter 自己做的一步。
    identify: (async () => [{ start: 0, end: 2, speaker: 'SPEAKER_00' }]) as never,
    available: () => true,
    ...over,
  }
  const runner = new ConversionRunner({ store, converters: [makeIdentifyConverter(deps)], derivations: [], costarts: [] })
  return { store, runner, deps }
}

describe('identify converter', () => {
  it('不回灌上游、不存投影——时间线是唯一产物落点，result 只剩 probe', async () => {
    const readTimeline = vi.fn(() => [{ start: 0, end: 2, speaker: 'SPEAKER_00' }])
    const resolveIntroNames = vi.fn(async (_i: string, s: never) => s)
    const { store, runner } = setup({ readTimeline, resolveIntroNames: resolveIntroNames as never })
    const stt = seedTranscript(store)
    const { record } = runner.start('identify', 'i', {})
    await settle()

    const rec = runner.get(record.id)!
    expect(rec.status).toBe('done')
    expect(rec.result).toEqual({ probe: { speakerCount: 1, spokenSeconds: 2, clusters: [{ label: 'SPEAKER_00', seconds: 2 }] } })
    // 上游那条转写**一个字不动**——「名字贴在文字上」是读口（view.ts）读时现算的
    const upstream = store.get(stt.id)!
    expect((upstream.result as { detail: { segments: { speaker?: string }[] } }).detail.segments[0].speaker).toBeUndefined()
    expect((upstream.result as { text: string }).text).toBe('hello')
    // 抽名仍然吃投影（它要文字里的自我介绍句）——投影只在内存里算一次，不落库
    expect(resolveIntroNames).toHaveBeenCalledWith('i', [{ start: 0, end: 2, text: 'hello', speaker: 'SPEAKER_00' }])
  })

  it('没有转写照样跑纯 diarization——识别只需要音频', async () => {
    const identify = vi.fn(async (..._args: unknown[]) => [])
    const readTimeline = vi.fn(() => [{ start: 0, end: 30, speaker: 'SPEAKER_00' }])
    const recordAppearances = vi.fn()
    const { runner, deps } = setup({ identify: identify as never, readTimeline, recordAppearances })
    const { record } = runner.start('identify', 'i', {})
    await settle()

    const rec = runner.get(record.id)!
    expect(rec.status).toBe('done')
    // 文字为空、媒体提示为空（提示本来就来自转写结果），但音频照解析、identify 照调
    expect(deps.resolveMedia).toHaveBeenCalledWith('i', undefined)
    // identify 的入参里**没有文字**——它只拿到 itemId/字节/mime/signal/windowing
    expect(identify.mock.calls[0].slice(0, 3)).toEqual(['i', new Uint8Array([1]), 'audio/mp4'])
    // 出现账重算只认 itemId——账源统一是时间线（recordAppearances 的实现自己去读）
    expect(recordAppearances).toHaveBeenCalledWith('i')
  })

  it('并肩起跑：上游还在跑时开工，分人跑完之后才去读转写——那时它已经落定，抽名照吃投影', async () => {
    // 这条钉的正是并行的关窍。起跑那一刻上游是 running（读不到 segments）；分人期间它跑完了；
    // identify 必须在**分人之后**再读一次，抽名才拿得到带文字的投影。
    // 从头读一次就会拿到空——那正是「改之前」的行为，并行也就白并了。
    const resolveIntroNames = vi.fn(async (_i: string, s: never) => s)
    const { store, runner } = setup({
      identify: (async () => {
        // 分人进行中，上游此刻落定
        store.update(sttId, {
          status: 'done',
          result: { text: 'hello', format: 'plain', branch: 'stt', detail: { segments: SEGMENTS } },
        })
        return [{ start: 0, end: 2, speaker: 'SPEAKER_00' }]
      }) as never,
      resolveIntroNames: resolveIntroNames as never,
    })
    const pending = store.create({ kind: 'extract', itemId: 'i' })
    const sttId = pending.id
    store.update(sttId, { status: 'running' })

    const { record } = runner.start('identify', 'i', { inputId: sttId })
    await settle()

    expect(runner.get(record.id)!.status).toBe('done')
    expect(resolveIntroNames).toHaveBeenCalledWith('i', [{ start: 0, end: 2, text: 'hello', speaker: 'SPEAKER_00' }])
  })

  it('分人跑完上游仍未落定 → 抽名跳过，时间线照样成功（这条 kind 答的是「谁在说」）', async () => {
    const readTimeline = vi.fn(() => [{ start: 0, end: 30, speaker: 'SPEAKER_00' }])
    const resolveIntroNames = vi.fn(async (_i: string, s: never) => s)
    const { store, runner } = setup({
      identify: (async () => [{ start: 0, end: 2, speaker: 'SPEAKER_00' }]) as never,
      readTimeline,
      resolveIntroNames: resolveIntroNames as never,
    })
    const pending = store.create({ kind: 'extract', itemId: 'i' })
    store.update(pending.id, { status: 'running' })

    const { record } = runner.start('identify', 'i', { inputId: pending.id })
    await settle()

    const rec = runner.get(record.id)!
    expect(rec.status).toBe('done')
    expect(resolveIntroNames).not.toHaveBeenCalled()
    expect((rec.result as { probe: IdentifyProbe }).probe.speakerCount).toBe(1)
  })

  it('并肩起跑时上游还没产出 media → 退到 options.media（否则常态就是 no_media）', async () => {
    const { runner, deps } = setup()
    const media = [{ kind: 'audio', platform: 'lizhi', track_id: '1' }]
    runner.start('identify', 'i', { options: { media } })
    await settle()
    expect(deps.resolveMedia).toHaveBeenCalledWith('i', media)
  })

  it('没有转写时不做抽名（抽名要文字）', async () => {
    const resolveIntroNames = vi.fn(async (_i: string, s: never) => s)
    const { runner } = setup({ identify: (async () => []) as never, resolveIntroNames: resolveIntroNames as never })
    runner.start('identify', 'i', {})
    await settle()
    expect(resolveIntroNames).not.toHaveBeenCalled()
  })

  it('reports degradation as failure —补名就是它的全部意图', async () => {
    const { store, runner } = setup({
      identify: (async (_i: string, _b: unknown, _m: unknown, _s: unknown, w: { onDegrade?: (e: unknown) => void } | undefined) => {
        w?.onDegrade?.(new Error('engine OOM'))
        return []
      }) as never,
      makeWindowing: (_ctx, onDegrade) => ({ onDegrade }) as never,
    })
    const stt = seedTranscript(store)
    const { record } = runner.start('identify', 'i', {})
    await settle()
    expect(runner.get(record.id)!.error!.code).toBe('degraded')
    // 转写一个字不动——失败模式是「没补上」，不是「弄坏了」
    expect((store.get(stt.id)!.result as { detail: { segments: { speaker?: string }[] } }).detail.segments[0].speaker).toBeUndefined()
  })

  it('does not resurrect a transcript deleted while it was running', async () => {
    const { store, runner } = setup({ identify: (async () => []) as never })
    const stt = seedTranscript(store)
    store.delete(stt.id)
    const { record } = runner.start('identify', 'i', { inputId: stt.id })
    await settle()
    // 转写没了 → 退化成纯 diarization（成功），但绝不把那条记录写回来
    expect(runner.get(record.id)!.status).toBe('done')
    expect(store.get(stt.id)).toBeNull()
  })

  it('recycles the previous run cluster vectors before re-clustering', async () => {
    const onRecluster = vi.fn()
    const { store, runner } = setup({ onRecluster })
    seedTranscript(store)
    runner.start('identify', 'i', {})
    await settle()
    expect(onRecluster).toHaveBeenCalledWith('i')
  })

  it('没有转写时照样记得出读数——读的是 diarization 时间线不是转写段', async () => {
    // 判据镜像真实退化：没有转写时 identify 返回空 segments（对齐的输入就是空的)。若读数改从
    // segments 算，这一类 item 会被记成「0 个说话人」，而它恰恰是这份账最该覆盖的一类——
    // 纯音频、没人转写过的那些。
    const readTimeline = vi.fn(() => [
      { start: 0, end: 20, speaker: 'SPEAKER_00' },
      { start: 20, end: 30, speaker: 'SPEAKER_01' },
    ])
    const { runner } = setup({ identify: (async () => []) as never, readTimeline })
    const { record } = runner.start('identify', 'i', {})
    await settle()

    const rec = runner.get(record.id)!
    expect(rec.status).toBe('done')
    const result = rec.result as { probe: IdentifyProbe }
    expect(result.probe.speakerCount).toBe(2)
    expect(result.probe.spokenSeconds).toBe(30)
  })
})

describe('probeOf', () => {
  it('按簇累计发言秒数，最长的排前面', () => {
    const probe = probeOf([
      { start: 0, end: 10, speaker: 'SPEAKER_00' },
      { start: 10, end: 40, speaker: 'SPEAKER_01' },
      { start: 40, end: 45, speaker: 'SPEAKER_00' },
    ])
    expect(probe.speakerCount).toBe(2)
    expect(probe.spokenSeconds).toBe(45)
    expect(probe.clusters).toEqual([
      { label: 'SPEAKER_01', seconds: 30 },
      { label: 'SPEAKER_00', seconds: 15 },
    ])
  })

  it('空时间线 → 三个字段都是零值，不是缺席', () => {
    // 「探过、一个人都没探到」和「没探过」必须分得开：前者是这份 probe 的合法读数。
    expect(probeOf([])).toEqual({ speakerCount: 0, spokenSeconds: 0, clusters: [] })
  })

  it('零时长与负时长的段不计入——它们不是发言', () => {
    const probe = probeOf([
      { start: 5, end: 5, speaker: 'SPEAKER_00' },
      { start: 9, end: 8, speaker: 'SPEAKER_00' },
      { start: 0, end: 4, speaker: 'SPEAKER_01' },
    ])
    expect(probe.speakerCount).toBe(1)
    expect(probe.clusters).toEqual([{ label: 'SPEAKER_01', seconds: 4 }])
  })

  it('spokenSeconds 是原始秒数求和后只舍入一次，不是各分项舍入后相加', () => {
    // 三个不同说话人各说 0.5s：各分项 Math.round(0.5)=1，若先分项舍入再相加会得 3；
    // 真实总时长是 1.5s，求和后只舍入一次得 2——两种写法在这组数据上刻意分叉。
    const probe = probeOf([
      { start: 0, end: 0.5, speaker: 'SPEAKER_00' },
      { start: 0, end: 0.5, speaker: 'SPEAKER_01' },
      { start: 0, end: 0.5, speaker: 'SPEAKER_02' },
    ])
    expect(probe.clusters.map((c) => c.seconds)).toEqual([1, 1, 1]) // 分项各自舍入——展示用近似
    expect(probe.spokenSeconds).toBe(2) // 账：round(0.5+0.5+0.5) = round(1.5) = 2，不是 1+1+1=3
  })

  it('NaN 时长（start/end 数据坏了）不计入——不会凭空多出一个说话人', () => {
    const probe = probeOf([
      { start: 0, end: 4, speaker: 'SPEAKER_00' },
      { start: 5, end: NaN, speaker: 'SPEAKER_01' },
    ])
    expect(probe.speakerCount).toBe(1)
    expect(probe.clusters).toEqual([{ label: 'SPEAKER_00', seconds: 4 }])
    expect(probe.spokenSeconds).toBe(4)
  })
})

describe('summary converter', () => {
  function setupSummary(summarize = vi.fn(async () => ({ summary: '## 摘要', ladder: { via: 'zhipu', rungs: [{ member: 'zhipu', source: 'llm-openai', ms: 9, outcome: 'win' as const }] } }))) {
    const store = new ConversionStore(':memory:')
    const runner = new ConversionRunner({
      store,
      converters: [makeSummaryConverter({ store, summarize, available: () => true })],
      derivations: [], costarts: [],
    })
    return { store, runner, summarize }
  }

  it('summarizes the upstream transcript text', async () => {
    const { store, runner, summarize } = setupSummary()
    seedTranscript(store)
    const { record } = runner.start('summary', 'i', { options: { lang: 'zh' } })
    await settle()
    expect(summarize).toHaveBeenCalledWith('hello', 'zh')
    const rec = runner.get(record.id)!
    expect(rec.status).toBe('done')
    expect(rec.result).toEqual({ summary: '## 摘要', lang: 'zh' })
    expect(rec.timing!.stages).toEqual([{ name: 'summarize', ms: expect.any(Number) }])
  })

  it('refuses when the item has no transcript yet', async () => {
    const { runner } = setupSummary()
    const { record } = runner.start('summary', 'i', {})
    await settle()
    expect(runner.get(record.id)!.error!.code).toBe('no_content')
  })
})
