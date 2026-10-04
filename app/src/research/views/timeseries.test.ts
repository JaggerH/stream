// 真实形状取自 Lean/artifacts/20260513-174415-kjfe4s/b1_beta_miner_60d.json:
// data 是 {index: string[], series: {列名: number[]}},不是 DataFrame[]。
import { describe, it, expect } from 'vitest'
import { render } from './timeseries.ts'
import type { Artifact } from '../artifact.ts'

const artifact = (data: unknown, config: Record<string, unknown> = {}): Artifact =>
  ({ schema: 'artifact/v1', view: 'timeseries', name: 'b1_beta_miner_60d', data, config })

const data = {
  index: ['2010-08-02', '2010-08-03'],
  series: { beta_miner_60d: [0.98, 0.97], commodity_norm: [1.0, 1.01] },
}

describe('timeseries view', () => {
  it('按 artifact.data 的 index/series 画图例(一个 series 键一条线)', () => {
    const root = document.createElement('div')
    render(root, artifact(data), 'dark')
    expect(root.textContent).toContain('beta_miner_60d')
    expect(root.textContent).toContain('commodity_norm')
    expect(root.querySelector('[data-chart]')).toBeTruthy()
  })

  it('config.title / yAxisLabel 画出来(此前被 DataFrame 层丢掉的那部分)', () => {
    const root = document.createElement('div')
    render(root, artifact(data, { title: 'B1_copper_2011', yAxisLabel: 'β / commodity (normalized)' }), 'dark')
    expect(root.textContent).toContain('B1_copper_2011')
    expect(root.textContent).toContain('β / commodity (normalized)')
  })

  it('data 形状不对时画一行提示,不抛', () => {
    const root = document.createElement('div')
    expect(() => render(root, artifact({ nope: true }), 'dark')).not.toThrow()
    expect(root.textContent).toMatch(/数据形状/)
  })
})

// —— 图表宿主必须拿到**显式像素高度** ——
//
// 这一档不是像素洁癖,它锁的是「一张图都画不出来」:宿主原本写 height:calc(100% - 24px),
// 而它上面两层(ArtifactView 的 root、ArtifactCard 的卡片)都是自动高度,百分比高度于是
// 回落成 auto,真实 Chrome 里实测算出来是 0(实测 {hostW:1608, hostH:0, computed:"0px"}),
// `if (host.clientWidth > 0 && host.clientHeight > 0)` 恒假,createChart 从不执行,卡片上
// 只剩一行图例——**不报错也不降级**,343 个 artifact(29.6%)是这个下场。
//
// jsdom 没有布局引擎,断言不了"算出来是多少",但能断言**依赖百分比这件事本身没有了**:
// 高度是一个自足的 px 值。老看板里 height:100% 能用,是因为面板挂在固定尺寸的网格格子里;
// 换成流式卡片后那个前提没了。
describe('timeseries 图表宿主高度', () => {
  it('没有 config.height 时给一个自足的 px 高度,不写百分比/calc', () => {
    const root = document.createElement('div')
    render(root, artifact(data), 'dark')
    const host = root.querySelector('[data-chart]') as HTMLElement
    expect(host.style.height).toMatch(/^\d+px$/)
  })

  it('config.height 是给它用的:真实数据里的 timeseries artifact 就带这个字段', () => {
    const root = document.createElement('div')
    render(root, artifact(data, { height: 320 }), 'dark')
    expect((root.querySelector('[data-chart]') as HTMLElement).style.height).toBe('320px')
  })
})
