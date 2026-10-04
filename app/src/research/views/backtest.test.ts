// 真实形状取自 Lean/artifacts/20260526-181120-aqakue/equity_curve.json:
// data 是 {strategy, benchmark, positions, markers},markers 数组已经是
// lightweight-charts 的 SeriesMarker 形状(position/shape/color/text 现成),不是待反推的
// buy/sell tag。
import { describe, it, expect } from 'vitest'
import { render } from './backtest.ts'
import type { Artifact } from '../artifact.ts'

const artifact = (data: unknown, config: Record<string, unknown> = {}): Artifact =>
  ({ schema: 'artifact/v1', view: 'backtest_chart', name: 'equity_curve', data, config })

const data = {
  strategy: [{ time: '2022-01-01', value: 100 }, { time: '2022-01-02', value: 110 }],
  benchmark: [{ time: '2022-01-01', value: 100 }, { time: '2022-01-02', value: 105 }],
  positions: { 'Regime/State': [{ time: '2022-01-01', value: 0 }, { time: '2022-01-02', value: 1 }] },
  markers: [{ time: '2022-01-02', position: 'belowBar', color: '#2196F3', shape: 'arrowUp', text: 'B 1.00' }],
}

describe('backtest view', () => {
  it('曲线(strategy/benchmark/positions)进图例,markers 计数显示', () => {
    const root = document.createElement('div')
    render(root, artifact(data), 'dark')
    expect(root.textContent).toContain('strategy')
    expect(root.textContent).toContain('benchmark')
    expect(root.textContent).toContain('Regime/State')
    expect(root.textContent).toContain('1 markers')
    expect(root.querySelector('[data-chart]')).toBeTruthy()
  })

  it('config.title 画出来', () => {
    const root = document.createElement('div')
    render(root, artifact(data, { title: 'CryptoVolSellerVolPlus — Equity + Positions' }), 'dark')
    expect(root.textContent).toContain('CryptoVolSellerVolPlus — Equity + Positions')
  })

  it('data 形状不对时画一行提示,不抛', () => {
    const root = document.createElement('div')
    expect(() => render(root, artifact({ strategy: [] }), 'dark')).not.toThrow()
    expect(root.textContent).toMatch(/数据形状/)
  })
})

// 与 timeseries 同一条缺陷、同一条判据（理由见 timeseries.test.ts 那一档的头注）。
describe('backtest 图表宿主高度', () => {
  it('没有 config.height 时给一个自足的 px 高度,不写百分比/calc', () => {
    const root = document.createElement('div')
    render(root, artifact(data), 'dark')
    expect((root.querySelector('[data-chart]') as HTMLElement).style.height).toMatch(/^\d+px$/)
  })

  it('config.height 生效', () => {
    const root = document.createElement('div')
    render(root, artifact(data, { height: 300 }), 'dark')
    expect((root.querySelector('[data-chart]') as HTMLElement).style.height).toBe('300px')
  })
})
