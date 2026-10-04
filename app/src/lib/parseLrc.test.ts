import { describe, expect, it } from 'vitest'
import { parseLrc } from './parseLrc.ts'

describe('parseLrc', () => {
  it('parses [mm:ss.xxx] timestamps into sorted seconds', () => {
    const lrc = '[00:28.950]故事的小黄花\n[00:00.000]作词 : 周杰伦'
    expect(parseLrc(lrc)).toEqual([
      { time: 0, text: '作词 : 周杰伦' },
      { time: 28.95, text: '故事的小黄花' },
    ])
  })

  it('handles [mm:ss:xx] (colon before the fraction — NetEase emits both forms)', () => {
    expect(parseLrc('[00:05:50]hi')).toEqual([{ time: 5.5, text: 'hi' }])
  })

  it('drops lines with no timestamp tag', () => {
    expect(parseLrc('plain text, no tag\n[00:01.00]tagged')).toEqual([{ time: 1, text: 'tagged' }])
  })

  it('drops a tag whose text is empty after stripping', () => {
    expect(parseLrc('[00:01.00]')).toEqual([])
  })

  it('returns [] for an empty or fully-untimed string', () => {
    expect(parseLrc('')).toEqual([])
    expect(parseLrc('no timestamps here')).toEqual([])
  })

  it('expands a line with multiple timestamp tags into one entry per tag (repeated chorus)', () => {
    expect(parseLrc('[00:01.00][00:05.00]chorus')).toEqual([
      { time: 1, text: 'chorus' },
      { time: 5, text: 'chorus' },
    ])
  })
})
