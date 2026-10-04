// 真实形状取自 Lean/artifacts/20260513-162632-9vemgb/phase_z_pre.json:
// data 是单组 {x: number[], y: number[]},不是 DataFrame[] 的多帧多色协议。
import { describe, it, expect } from 'vitest'
import { render } from './scatter.ts'
import type { Artifact } from '../artifact.ts'

const artifact = (data: unknown, config: Record<string, unknown> = {}): Artifact =>
  ({ schema: 'artifact/v1', view: 'scatter2d', name: 'phase_z_pre', data, config })

describe('scatter view', () => {
  it('按 artifact.data 的 x/y 画 SVG 圆点(null 洞跳过)+ 图例', () => {
    const root = document.createElement('div')
    render(root, artifact({ x: [0, 1, 2], y: [0, 1, null] }), 'dark')
    expect(root.querySelectorAll('circle')).toHaveLength(2)
    expect(root.textContent).toContain('phase_z_pre')
  })

  it('config.title/xlabel/ylabel 画出来', () => {
    const root = document.createElement('div')
    render(root, artifact({ x: [0, 1], y: [0, 1] }, { title: 'phase_z_pre', xlabel: 'z_p_60d', ylabel: 'z_i_60d' }), 'dark')
    expect(root.textContent).toContain('phase_z_pre')
    expect(root.textContent).toContain('z_p_60d')
    expect(root.textContent).toContain('z_i_60d')
  })

  it('data 形状不对时画一行提示,不抛', () => {
    const root = document.createElement('div')
    expect(() => render(root, artifact({ x: [1] }), 'dark')).not.toThrow()
    expect(root.textContent).toMatch(/数据形状/)
  })
})

// SVG 吃的是同一条百分比高度。它不像 lightweight-charts 那样"不画",而是被 viewBox 的
// 宽高比撑开:实测 1608×1640,每张卡约 1600px 高,一页只装得下一张图。同样给显式 px。
describe('scatter SVG 高度', () => {
  it('SVG 高度是自足的 px 值,不写百分比/calc', () => {
    const root = document.createElement('div')
    render(root, artifact({ x: [0, 1], y: [0, 1] }), 'dark')
    expect((root.querySelector('svg') as unknown as SVGElement).style.height).toMatch(/^\d+px$/)
  })

  it('config.height 生效', () => {
    const root = document.createElement('div')
    render(root, artifact({ x: [0, 1], y: [0, 1] }, { height: 300 }), 'dark')
    expect((root.querySelector('svg') as unknown as SVGElement).style.height).toBe('300px')
  })
})
