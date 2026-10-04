// 真实形状取自 Lean/artifacts/20260513-162632-9vemgb/joint_dist_pre.json:
// data 是直接的网格 {matrix, xlabels, ylabels}(matrix[yi][xi]),不再是待 pivot 的长表。
import { describe, it, expect } from 'vitest'
import { render } from './heatmap.ts'
import type { Artifact } from '../artifact.ts'

const artifact = (data: unknown, config: Record<string, unknown> = {}): Artifact =>
  ({ schema: 'artifact/v1', view: 'heatmap', name: 'joint_dist_pre', data, config })

const data = {
  matrix: [[1, -1], [0.5, null]],
  xlabels: ['a', 'b'],
  ylabels: ['r1', 'r2'],
}

describe('heatmap view', () => {
  it('按 artifact.data 的 matrix/xlabels/ylabels 画网格:2×2=4 格', () => {
    const root = document.createElement('div')
    render(root, artifact(data), 'dark')
    expect(root.querySelectorAll('[data-cell]')).toHaveLength(4)
    expect(root.textContent).toContain('r1')
    expect(root.textContent).toContain('b')
    const first = root.querySelector('[data-cell]') as HTMLElement
    expect(first.title).toContain('a / r1')
  })

  it('config.title/xlabel/ylabel 画出来', () => {
    const root = document.createElement('div')
    render(root, artifact(data, { title: 'joint_dist_pre', xlabel: 'Δ log P (daily)', ylabel: 'Δ log I (daily)' }), 'dark')
    expect(root.textContent).toContain('joint_dist_pre')
    expect(root.textContent).toContain('Δ log P (daily)')
    expect(root.textContent).toContain('Δ log I (daily)')
  })

  it('data 形状不对时画一行提示,不抛', () => {
    const root = document.createElement('div')
    expect(() => render(root, artifact({ matrix: [[1, 2]], xlabels: ['a'], ylabels: ['r1'] }), 'dark')).not.toThrow()
    expect(root.textContent).toMatch(/数据形状/)
  })
})
