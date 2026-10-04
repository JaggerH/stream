// 真实形状取自 Lean/artifacts/20260516-170735-yrfo2h/「R-multiple distribution.json」:
// data 是 {values: number[]},名字带空格(不是下划线)。
import { describe, it, expect } from 'vitest'
import { render } from './distribution.ts'
import { DEFAULT_CHART_HEIGHT } from './base.ts'
import type { Artifact } from '../artifact.ts'

const artifact = (data: unknown, config: Record<string, unknown> = {}): Artifact =>
  ({ schema: 'artifact/v1', view: 'distribution', name: 'R-multiple distribution', data, config })

const values = [-1, 2, -1, 0.61, 2, -0.5, 1.15, -1, 2, 0.03]

describe('distribution view', () => {
  it('按 values 画直方图的柱子 + 统计数字', () => {
    const root = document.createElement('div')
    render(root, artifact({ values }), 'dark')
    expect(root.querySelectorAll('[data-bin]').length).toBeGreaterThan(0)
    expect(root.textContent).toContain('median')
  })

  it('data 形状不对时画一行提示,不抛', () => {
    const root = document.createElement('div')
    expect(() => render(root, artifact({ bins: [0, 1], counts: [2] }), 'dark')).not.toThrow()
    expect(root.textContent).toMatch(/数据形状/)
  })
})

// 柱高是容器高度的百分比,容器又是 `flex:1` 于一个 `height:100%` 的 wrap——挂在流式卡片里
// (自动高度的祖先)百分比没有可参照的父高,整张图塌到 1px 底线,统计数字还在,于是"路通了图没有"。
// 同 timeseries/scatter/backtest:高度必须是自足的 px。
describe('distribution 高度', () => {
  it('外层高度是自足的 px 值,不写百分比', () => {
    const root = document.createElement('div')
    render(root, artifact({ values }), 'dark')
    const wrap = root.firstElementChild as HTMLElement
    expect(wrap.style.height).toBe(`${DEFAULT_CHART_HEIGHT}px`)
  })

  it('config.height 说了算', () => {
    const root = document.createElement('div')
    render(root, artifact({ values }, { height: 320 }), 'dark')
    expect((root.firstElementChild as HTMLElement).style.height).toBe('320px')
  })
})
