import { describe, it, expect } from 'vitest'
import { sourceLabel } from './sourceLabel.ts'

describe('sourceLabel', () => {
  it('用后端投影的源名（源目录里 manifest 的标题，前端不手写任何源名）', () => {
    expect(sourceLabel({ source_label: '演示站 · 首页', source_id: 'demo-home', stream_id: 'demo-home-1' })).toBe('演示站 · 首页')
  })

  it('没有投影（老记录 / 源已不在目录里）→ 退回原始 stream_id', () => {
    expect(sourceLabel({ source_id: 'mystery', stream_id: 'mystery-42' })).toBe('mystery-42')
    expect(sourceLabel({ stream_id: 'legacy-stream' })).toBe('legacy-stream')
  })
})
