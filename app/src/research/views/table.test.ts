// 真实形状取自 Lean/artifacts/20260515-052143-qvj96o/per_asset_betas.json:
// data 是 pandas split 格式 {columns, index, data},不是 {columns, rows}。
import { describe, it, expect } from 'vitest'
import { render } from './table.ts'
import type { Artifact } from '../artifact.ts'

const artifact = (data: unknown, config: Record<string, unknown> = {}): Artifact =>
  ({ schema: 'artifact/v1', view: 'table', name: 't', data, config })

describe('table view', () => {
  it('按 artifact.data 的 columns/index/data 画表', () => {
    const root = document.createElement('div')
    render(root, artifact({ columns: ['symbol', 'beta'], index: [0, 1], data: [['BTCUSDT', 0.0005], ['ETHUSDT', -0.0045]] }), 'dark')
    expect([...root.querySelectorAll('thead th')].map((n) => n.textContent)).toEqual(['symbol', 'beta'])
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(root.textContent).toContain('BTCUSDT')
  })

  it('config.pageSize 截断行数,config.title 画标题', () => {
    const root = document.createElement('div')
    render(root, artifact({ columns: ['a'], index: [0, 1, 2], data: [[1], [2], [3]] }, { pageSize: 2, title: 'Per-asset β' }), 'dark')
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(root.textContent).toContain('前 2 行,共 3 行')
    expect(root.textContent).toContain('Per-asset β')
  })

  it('点击列头排序切换', () => {
    const root = document.createElement('div')
    render(root, artifact({ columns: ['a'], index: [0, 1], data: [[2], [1]] }), 'dark')
    const th = root.querySelector('th')!
    ;(th as HTMLElement).click()
    const firstCell = root.querySelector('tbody tr td')!.textContent
    expect(firstCell).toBe('1') // 升序
  })

  it('data 形状不对时画一行提示,不抛', () => {
    const root = document.createElement('div')
    expect(() => render(root, artifact(null), 'dark')).not.toThrow()
    expect(root.textContent).toMatch(/数据形状/)
  })
})
