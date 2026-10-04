// app/src/research/views/registry.ts — view 注册表。**开放 + 有兜底**:认不出的 view 摊开 JSON,
// 绝不抛错。上一版是 `throw new Error('not an artifact/v1 file')`,一个没见过的 view 能炸掉整格;
// 而真实数据里 8 种 view 是会长的(distribution 现在只有 1 个,将来会更多)。
import type { Artifact } from '../artifact.ts'
import * as table from './table.ts'
import * as timeseries from './timeseries.ts'
import * as scatter from './scatter.ts'
import * as heatmap from './heatmap.ts'
import * as backtest from './backtest.ts'
import * as text from './text.ts'
import * as html from './html.ts'
import * as distribution from './distribution.ts'

// void:大多数 view 只画 DOM,没有资源要收。`() => void`:timeseries/backtest 各持有一个
// lightweight-charts 图表实例,不 `.remove()` 会一直挂着(observer、canvas)——它们返回一个
// 会做这件事的 disposer,ArtifactView 在卸载时调用它。
export type ViewRender = (root: HTMLElement, artifact: Artifact, theme: 'light' | 'dark') => void | (() => void)

const REGISTRY: Record<string, ViewRender> = {
  table: table.render,
  timeseries: timeseries.render,
  scatter2d: scatter.render,
  heatmap: heatmap.render,
  backtest_chart: backtest.render,
  text: text.render,
  html: html.render,
  distribution: distribution.render,
}

export const VIEW_IDS = Object.keys(REGISTRY)

export const unknownView: ViewRender = (root, artifact) => {
  const box = document.createElement('div')
  box.style.cssText = 'padding:12px;font-size:12px;border:1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,.3));border-radius:8px'
  const head = document.createElement('div')
  head.style.cssText = 'margin-bottom:6px;font-weight:600'
  head.textContent = `不认识的 view 类型:${artifact.view}`
  const pre = document.createElement('pre')
  pre.style.cssText = 'overflow:auto;max-height:240px;margin:0;font-size:11px'
  pre.textContent = `${JSON.stringify(artifact.data, null, 2).slice(0, 500)}…`
  box.append(head, pre)
  root.appendChild(box)
}

export function getView(view: string): ViewRender {
  return REGISTRY[view] ?? unknownView
}
