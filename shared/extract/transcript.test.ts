// 「这条 item 的转写是哪条 extract 记录」——前后端同吃这一份（后端 ConversionRunner.transcriptOf，
// 前端详情页转写档）。判据是**带不带 detail.segments**，不是新不新：同一条 item 可能先转写、
// 后来又 OCR 了一张图，取「最新一条」会被 OCR 盖掉真正的转写，而 OCR 产不出时间轴。
import { describe, expect, it } from 'vitest'
import { pickTranscript, segmentsIn } from './transcript.ts'

const done = (result: unknown, id = 'r') => ({ id, kind: 'extract' as const, status: 'done' as const, result })
const seg = (start: number, text: string, speaker?: string) => ({ start, end: start + 1, text, speaker })

describe('segmentsIn', () => {
  it('拿到转写那条的 segments', () => {
    expect(segmentsIn(done({ text: 'x', detail: { segments: [seg(0, '喂')] } }))).toEqual([seg(0, '喂')])
  })

  it('OCR 那条没有 segments → undefined（不是空数组）', () => {
    // undefined = 这条不是转写；[] = 是转写但一段都没切出来。两者必须分得开。
    expect(segmentsIn(done({ text: '# 标题', format: 'markdown' }))).toBeUndefined()
    expect(segmentsIn(done({ text: 'x', detail: { segments: [] } }))).toEqual([])
  })

  it('还没有产物 → undefined', () => {
    expect(segmentsIn({ kind: 'extract', status: 'queued' })).toBeUndefined()
  })
})

describe('pickTranscript（输入按新→旧）', () => {
  it('跳过更新的那条 OCR，挑带 segments 的转写', () => {
    const ocr = done({ text: '# 图里的字', format: 'markdown' }, 'ocr')
    const stt = done({ text: '喂', detail: { segments: [seg(0, '喂')] } }, 'stt')
    expect(pickTranscript([ocr, stt])?.id).toBe('stt')
  })

  it('在跑的那条一并返回——调用方要分「没转过」和「转到一半」', () => {
    const running = { id: 'run', kind: 'extract' as const, status: 'running' as const }
    expect(pickTranscript([running])?.id).toBe('run')
  })

  it('一条 extract 都没有 / 只有别的 kind → null', () => {
    expect(pickTranscript([])).toBeNull()
    expect(pickTranscript([{ id: 's', kind: 'summary', status: 'done', result: { summary: '一句话' } }])).toBeNull()
    expect(pickTranscript([done({ text: '# 只有 OCR', format: 'markdown' }, 'ocr')])).toBeNull()
  })

  it('失败的转写也算——错误要看得见，不能报成「还没转写过」', () => {
    const failed = { id: 'err', kind: 'extract' as const, status: 'error' as const, error: { code: 'x', message: '没音频' } }
    expect(pickTranscript([failed])?.id).toBe('err')
  })
})
