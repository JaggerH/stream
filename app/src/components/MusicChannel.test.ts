import { describe, it, expect } from 'vitest'
import { sourceLabel } from './MusicChannel.tsx'

describe('sourceLabel', () => {
  it('标签取源自己申报的 facility.label，不从 id 猜站名', () => {
    expect(sourceLabel({ sources: [{ source: { id: 'rsshub:163/music/playlist/:id', facility: { key: '163', label: '网易云音乐' } } }] } as never)).toBe('网易云音乐')
  })
  it('没有 facility → 空串（不猜）', () => {
    expect(sourceLabel({ sources: [{ source: { id: 'whatever' } }] } as never)).toBe('')
    expect(sourceLabel({} as never)).toBe('')
  })
  it('多个源取第一个带 facility 的', () => {
    expect(sourceLabel({ sources: [{ source: { id: 'a' } }, { source: { id: 'b', facility: { key: 'x', label: 'X' } } }] } as never)).toBe('X')
  })
})
