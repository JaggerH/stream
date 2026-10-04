import { describe, it, expect } from 'vitest'
import { getView, VIEW_IDS } from './registry.ts'
import type { Artifact } from '../artifact.ts'

const a = (view: string, data: unknown = {}): Artifact => ({ schema: 'artifact/v1', view, name: 'n', data, config: {} })

describe('view 注册表', () => {
  it('真实数据里出现过的 8 种 view 全都认识', () => {
    for (const v of ['table', 'timeseries', 'text', 'scatter2d', 'heatmap', 'backtest_chart', 'distribution', 'html']) {
      expect(VIEW_IDS).toContain(v)
    }
  })

  it('认不出的 view 走兜底,把 JSON 摊开而不是抛错', () => {
    const root = document.createElement('div')
    expect(() => getView('no-such-view')(root, a('no-such-view', { k: 1 }), 'dark')).not.toThrow()
    expect(root.textContent).toContain('no-such-view')
    expect(root.textContent).toContain('"k"')
  })

  it('text view 走 markdown,标题渲染成 h1', () => {
    const root = document.createElement('div')
    getView('text')(root, a('text', '# 标题'), 'dark')
    expect(root.querySelector('h1')?.textContent).toBe('标题')
  })

  it('html view 进 sandbox iframe,且不带 allow-same-origin', () => {
    const root = document.createElement('div')
    getView('html')(root, a('html', '<p>hi</p>'), 'dark')
    const iframe = root.querySelector('iframe')!
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin')
  })
})
