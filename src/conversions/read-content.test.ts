import { describe, expect, it, vi } from 'vitest'
import { readContent, type ReadContentDeps } from './read-content.ts'

const SEGMENTS = [
  { start: 0, end: 5, text: '大家好', speaker: 'SPEAKER_00' },
  { start: 30, end: 35, text: '我来补充', speaker: '李诞' },
]

const record = (kind: string, over: Record<string, unknown> = {}) => ({
  id: `${kind}-1`,
  kind,
  itemId: 'i',
  status: 'done',
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '',
  ...over,
})

/** 按 kind 分派的假 list。没给的 kind 返回空 = 那层没跑过。 */
function listOf(byKind: Record<string, unknown[]>) {
  return vi.fn(({ kind }: { kind?: string }) => ({ items: byKind[kind ?? ''] ?? [] })) as never
}

const run = (deps: ReadContentDeps, args: { include_speakers?: boolean; include_screen_text?: boolean } = {}) =>
  readContent(deps, 'i', { speakers: !!args.include_speakers, screen: !!args.include_screen_text }) as unknown as Record<
    string,
    unknown
  >

describe('read_content', () => {
  it('三条轨都在 → 一份按时刻排好的稿子（名字来自说话人读口）', () => {
    const out = run(
      {
        list: listOf({
          extract: [record('extract', { result: { text: '大家好 我来补充', detail: { segments: SEGMENTS } } })],
          identify: [record('identify', { result: { probe: { speakerCount: 2 } } })],
          frames: [record('frames', { result: { track: [{ at: 12, text: '第一页要点' }] } })],
        }),
        speakers: () => ({ segments: SEGMENTS, hasSpeakers: true }),
      },
      { include_speakers: true, include_screen_text: true },
    )
    expect(out.script).toBe('[00:00] 说话人 1：大家好\n[00:12] 〔画面〕第一页要点\n[00:30] 李诞：我来补充')
  })

  it('说话人读口抛错 → 稿子退成无名骨架，整次读不挂', () => {
    const out = run(
      {
        list: listOf({
          extract: [record('extract', { result: { text: '大家好', detail: { segments: SEGMENTS } } })],
          frames: [record('frames', { result: { track: [{ at: 12, text: 'x' }] } })],
        }),
        speakers: () => {
          throw new Error('registry gone')
        },
      },
      { include_speakers: true, include_screen_text: true },
    )
    expect(out.script).toContain('〔画面〕x')
    expect(out.script).not.toContain('李诞')
  })

  it('没要的层不装内容，但状况照报——模型据此知道「还能再问一次」', () => {
    const out = run({
      list: listOf({
        extract: [record('extract', { result: { text: 'hi', detail: { segments: SEGMENTS } } })],
        frames: [record('frames', { result: { track: [{ at: 1, text: 'x' }] } })],
      }),
    })
    expect(out.script).toBeUndefined()
    expect((out.layers as Record<string, { state: string }>).frames.state).toBe('ready')
  })

  it('同一层有多条记录（重跑过）→ 取最新那条，不是列表第一条', () => {
    const out = run({
      list: listOf({
        extract: [
          record('extract', { id: 'old', createdAt: '2026-08-01T00:00:00.000Z', result: { text: '旧的' } }),
          record('extract', { id: 'new', createdAt: '2026-08-14T00:00:00.000Z', result: { text: '新的' } }),
        ],
      }),
    })
    expect(out.text).toBe('新的')
  })

  it('正文那层还没跑 → 明说下一步该调 extract，别让模型对着一片 absent 自己编', () => {
    const out = run({ list: listOf({}) })
    expect((out.layers as Record<string, { state: string }>).extract.state).toBe('absent')
    expect(String(out.next_step)).toContain('extract')
  })

  it('正文在了就不再喊下一步', () => {
    expect(run({ list: listOf({ extract: [record('extract', { result: { text: 'hi' } })] }) }).next_step).toBeUndefined()
  })

  it('长正文整份返回时带 note:多条任务该扇出 subagent,别再往主会话里读全文', () => {
    const long = 'A'.repeat(4001)
    const out = run({ list: listOf({ extract: [record('extract', { result: { text: long } })] }) })
    expect(out.text).toBe(long)
    expect(String(out.note)).toMatch(/subagent/)
    // 短正文不带——每条回执都喊会把 note 变成背景噪音
    const short = run({ list: listOf({ extract: [record('extract', { result: { text: 'hi' } })] }) })
    expect(short.note).toBeUndefined()
  })

  it('某一层读记录时抛错 → 当那层没跑，另外两层照给（别让一层拖垮整次读）', () => {
    const out = run(
      {
        list: vi.fn(({ kind }: { kind?: string }) => {
          if (kind === 'frames') throw new Error('db locked')
          if (kind === 'extract') return { items: [record('extract', { result: { text: 'hi' } })] }
          return { items: [] }
        }) as never,
      },
      { include_screen_text: true },
    )
    expect(out.text).toBe('hi')
    expect((out.layers as Record<string, { state: string }>).frames.state).toBe('absent')
  })

  it('读记录时要带上 result——不带的话每一层都会看着像跑完了却空空如也', () => {
    const list = listOf({ extract: [record('extract', { result: { text: 'hi' } })] })
    run({ list })
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ item: 'i', expandResult: true }))
  })
})
