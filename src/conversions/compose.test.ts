import { describe, expect, it } from 'vitest'
import { composeContent, type LayerRecords, type SpeakerInput } from './compose.ts'
import type { ConversionRecord } from './store.ts'

const rec = (over: Partial<ConversionRecord>): ConversionRecord =>
  ({ id: 'c', kind: 'extract', itemId: 'i', status: 'done', createdAt: '', updatedAt: '', ...over }) as ConversionRecord

const SEGMENTS = [
  { start: 0, end: 5, text: '大家好', speaker: 'SPEAKER_00' },
  { start: 5, end: 10, text: '看这一页', speaker: 'SPEAKER_00' },
  { start: 30, end: 35, text: '我来补充', speaker: '李诞' },
]
const extractDone = rec({ kind: 'extract', result: { text: '大家好 看这一页 我来补充', detail: { segments: SEGMENTS } } })
const identifyDone = rec({ kind: 'identify', result: { probe: { speakerCount: 2 } } })
const framesDone = rec({ kind: 'frames', result: { track: [{ at: 12, text: '第一页要点' }], probe: { stop: 'done' } } })
// 说话人读口（view.ts）的产物：时间线 × 转写段的现算投影
const SPEAKERS: SpeakerInput = { segments: SEGMENTS, hasSpeakers: true }

const ALL = { speakers: true, screen: true }
const NONE = { speakers: false, screen: false }

describe('composeContent —— 一个口读三条轨', () => {
  it('只要底座：交正文，不额外合成一份一模一样的稿子', () => {
    const out = composeContent({ extract: extractDone }, NONE)
    expect(out.text).toBe('大家好 看这一页 我来补充')
    expect(out.script).toBeUndefined()
    expect(out.speakers).toBeUndefined()
  })

  it('要说话人：稿子按时刻排、连续同一个人并成一段', () => {
    const out = composeContent({ extract: extractDone, identify: identifyDone }, { speakers: true, screen: false }, SPEAKERS)
    expect(out.script).toBe('[00:00] 说话人 1：大家好 看这一页\n[00:30] 李诞：我来补充')
    expect(out.speakers?.map((s) => [s.name, s.anonymous])).toEqual([['说话人 1', true], ['李诞', false]])
  })

  it('要画面文字：按时刻插进稿子，且**标明这不是有人说的话**', () => {
    const out = composeContent({ extract: extractDone, identify: identifyDone, frames: framesDone }, ALL, SPEAKERS)
    expect(out.script).toBe(
      '[00:00] 说话人 1：大家好 看这一页\n[00:12] 〔画面〕第一页要点\n[00:30] 李诞：我来补充',
    )
  })

  it('只要画面文字、不要说话人：名字不出现，但稿子照样按时刻排得出来', () => {
    const out = composeContent({ extract: extractDone, identify: identifyDone, frames: framesDone }, { speakers: false, screen: true }, SPEAKERS)
    expect(out.script).toBe('[00:00] 大家好 看这一页\n[00:12] 〔画面〕第一页要点\n[00:30] 我来补充')
    expect(out.speakers).toBeUndefined()
  })

  it('画面文字里的换行压成一行——一条画面条目在稿子里必须只占一行', () => {
    const multi = rec({ kind: 'frames', result: { track: [{ at: 1, text: 'a\nb' }] } })
    const out = composeContent({ extract: extractDone, frames: multi }, { speakers: false, screen: true })
    expect(out.script).toContain('〔画面〕a / b')
  })
})

describe('composeContent —— 四种「空」必须分得开', () => {
  it('没跑 → absent（不是「这条视频屏幕上没字」）', () => {
    const out = composeContent({ extract: extractDone }, ALL)
    expect(out.layers.frames).toEqual({ state: 'absent' })
    expect(out.layers.identify).toEqual({ state: 'absent' })
  })

  it('还在跑 → running（稍后再问就有）', () => {
    const out = composeContent({ extract: extractDone, frames: rec({ kind: 'frames', status: 'running' }) }, ALL)
    expect(out.layers.frames.state).toBe('running')
    const queued = composeContent({ extract: extractDone, frames: rec({ kind: 'frames', status: 'queued' }) }, ALL)
    expect(queued.layers.frames.state).toBe('running')
  })

  it('跑失败 → error，且带上失败原话', () => {
    const failed = rec({ kind: 'frames', status: 'error', error: { code: 'plan_failed', message: 'ffmpeg 炸了' } })
    const out = composeContent({ extract: extractDone, frames: failed }, ALL)
    expect(out.layers.frames).toEqual({ state: 'error', detail: 'ffmpeg 炸了' })
  })

  it('跑成功但判为纯口播 → empty + 说得出为什么（这是有效答案，不是故障）', () => {
    const gated = rec({ kind: 'frames', result: { track: [], probe: { stop: 'gate' } } })
    const out = composeContent({ extract: extractDone, frames: gated }, ALL)
    expect(out.layers.frames.state).toBe('empty')
    expect(out.layers.frames.detail).toContain('纯口播')
  })

  it('抽帧四种止损各有各的说法——别都糊成一句「没有画面文字」', () => {
    const said = new Set<string>()
    for (const stop of ['gate', 'no_source', 'still_picture', 'no_new_text']) {
      const r = rec({ kind: 'frames', result: { track: [], probe: { stop } } })
      const d = composeContent({ extract: extractDone, frames: r }, ALL).layers.frames.detail!
      expect(d).toBeTruthy()
      said.add(d)
    }
    expect(said.size).toBe(4)
  })

  it('识别跑完但一个说话人都没分出来 → empty，不是 ready', () => {
    const noSpeakers = rec({ kind: 'identify', result: { probe: { speakerCount: 0 } } })
    const out = composeContent({ extract: extractDone, identify: noSpeakers }, ALL)
    expect(out.layers.identify.state).toBe('empty')
  })

  it('identify 一无所获时，哪怕时间线上还留着上一轮的名字也报 empty——状态只看它自己的产物', () => {
    const noSpeakers = rec({ kind: 'identify', result: { probe: { speakerCount: 0 } } })
    const out = composeContent({ extract: extractDone, identify: noSpeakers }, ALL, SPEAKERS)
    expect(out.layers.identify.state).toBe('empty')
  })

  it('转成文字跑完但一个字都没取到 → empty', () => {
    const blank = rec({ kind: 'extract', result: { text: '   ' } })
    expect(composeContent({ extract: blank }, ALL).layers.extract.state).toBe('empty')
  })

  it('没要的层照样报 state——「你没要」和「它没有」是两件事', () => {
    const out = composeContent({ extract: extractDone, frames: framesDone }, NONE)
    expect(out.layers.frames.state).toBe('ready') // 有内容，只是这次没装进来
    expect(out.script).toBeUndefined()
  })
})

describe('composeContent —— 说话人以哪一份为准', () => {
  it('名字只来自读口投影；extract 段上残留的旧名字（历史回灌）被剥掉', () => {
    const stale = rec({
      kind: 'extract',
      result: { text: 'x', detail: { segments: [{ start: 0, end: 5, text: '大家好', speaker: '旧名字' }] } },
    })
    const out = composeContent(
      { extract: stale, identify: identifyDone },
      { speakers: true, screen: false },
      { segments: [{ start: 0, end: 5, text: '大家好', speaker: 'SPEAKER_00' }], hasSpeakers: true },
    )
    expect(out.script).toContain('说话人 1')
    expect(out.script).not.toContain('旧名字')
  })

  it('没递读口产物（声纹域没配）：稿子骨架用 extract 的段，但残留名字不冒充「识别过」', () => {
    const backfilled = rec({
      kind: 'extract',
      result: { text: 'x', detail: { segments: [{ start: 0, end: 5, text: '大家好', speaker: '李诞' }] } },
    })
    const out = composeContent({ extract: backfilled, frames: framesDone }, { speakers: true, screen: true })
    expect(out.script).toBeDefined() // 骨架还在（帧文字有地方插）
    expect(out.script).not.toContain('李诞')
    expect(out.speakers).toBeUndefined()
  })
})

describe('composeContent —— 畸形记录不许抛（它读的是历史数据）', () => {
  const junk: LayerRecords[] = [
    {},
    { extract: null },
    { extract: rec({ result: undefined }) },
    { extract: rec({ result: { detail: { segments: null } } as never }) },
    { extract: extractDone, frames: rec({ kind: 'frames', result: { track: null } as never }) },
    { extract: extractDone, identify: rec({ kind: 'identify', result: {} }) },
  ]
  it.each(junk.map((r, i) => [i, r] as const))('第 %i 条畸形记录', (_i, r) => {
    expect(() => composeContent(r, ALL)).not.toThrow()
  })
})
