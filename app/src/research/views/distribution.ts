// app/src/research/views/distribution.ts — 直方图 view。数据形状取自 Cockpit 的
// DistributionView.tsx 读法(Cockpit/frontend/src/views/DistributionView.tsx):
// artifact.data = {values: number[]},artifact.config 可选 {bins, xlabel, showMean, showMedian,
// showQuantiles}。真实样本 1158 个里只有 1 个用这个 view,渲染沿用其它 view 同款 DOM/canvas 手法
// (heatmap.ts)与 base.ts 的 themeColors,不引 recharts。
import type { Artifact } from '../artifact.ts'
import { chartHeightPx, themeColors, type PanelTheme } from './base.ts'

interface DistributionData { values: number[] }
interface DistributionConfig { bins?: number; xlabel?: string; height?: number }

function isDistributionData(d: unknown): d is DistributionData {
  if (!d || typeof d !== 'object') return false
  return Array.isArray((d as Record<string, unknown>).values)
}

interface Bin { x0: number; x1: number; mid: number; count: number }

function histogram(values: number[], bins: number): Bin[] {
  if (values.length === 0) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return [{ x0: min, x1: max, mid: min, count: values.length }]
  const width = (max - min) / bins
  const out: Bin[] = Array.from({ length: bins }, (_, i) => ({ x0: min + i * width, x1: min + (i + 1) * width, mid: min + (i + 0.5) * width, count: 0 }))
  for (const v of values) {
    let idx = Math.floor((v - min) / width)
    if (idx >= bins) idx = bins - 1
    const bin = out[idx]
    if (bin) bin.count++
  }
  return out
}

function mean(xs: number[]): number {
  if (xs.length === 0) return NaN
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  const next = sorted[base + 1]
  return next !== undefined ? sorted[base]! + rest * (next - sorted[base]!) : sorted[base]!
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—'
  return Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v.toFixed(4)
}

function renderShapeError(root: HTMLElement, colors: { text: string }, name: string): void {
  const p = document.createElement('div')
  p.style.cssText = `padding:8px;font-size:12px;color:${colors.text}`
  p.textContent = `数据形状不是这个 view 认识的样子(${name})`
  root.appendChild(p)
}

export function render(root: HTMLElement, artifact: Artifact, theme: PanelTheme): void {
  const colors = themeColors(theme)
  const d = artifact.data
  if (!isDistributionData(d)) return renderShapeError(root, colors, artifact.name)
  const config = (artifact.config ?? {}) as DistributionConfig
  const clean = d.values.filter((v) => Number.isFinite(v))
  const sorted = [...clean].sort((a, b) => a - b)
  const bins = histogram(clean, config.bins ?? 30)
  const maxCount = Math.max(1, ...bins.map((b) => b.count))
  const m = mean(clean)
  const med = quantile(sorted, 0.5)

  const wrap = document.createElement('div')
  // 显式像素高度(理由见 base.ts chartHeightPx):柱高是容器高度的百分比,而 height:100%
  // 在流式卡片的自动高度祖先下塌成 auto,整张直方图退到 1px 底线——数字还在,图没了。
  wrap.style.cssText = `display:flex;flex-direction:column;height:${chartHeightPx(config)}px;padding:6px;gap:4px`

  const bars = document.createElement('div')
  bars.style.cssText = 'flex:1;display:flex;align-items:flex-end;gap:1px;min-height:0'
  bins.forEach((b) => {
    const bar = document.createElement('div')
    bar.dataset.bin = '1'
    bar.title = `${fmt(b.x0)} ~ ${fmt(b.x1)} = ${b.count}`
    bar.style.cssText = `flex:1;height:${(b.count / maxCount) * 100}%;background:${colors.series[0]};border-radius:1px 1px 0 0;min-height:${b.count > 0 ? 1 : 0}px`
    bars.appendChild(bar)
  })
  wrap.appendChild(bars)

  if (config.xlabel) {
    const caption = document.createElement('div')
    caption.style.cssText = `font-size:10px;opacity:.7;color:${colors.text}`
    caption.textContent = config.xlabel
    wrap.appendChild(caption)
  }

  const stats = document.createElement('div')
  stats.style.cssText = `display:flex;flex-wrap:wrap;gap:8px;font-size:11px;color:${colors.text}`
  const entries: Array<[string, number]> = [['n', clean.length], ['mean', m], ['median', med], ['q05', quantile(sorted, 0.05)], ['q95', quantile(sorted, 0.95)], ['min', sorted[0] ?? NaN], ['max', sorted[sorted.length - 1] ?? NaN]]
  for (const [label, v] of entries) {
    const span = document.createElement('span')
    span.textContent = `${label} = ${label === 'n' ? v : fmt(v)}`
    stats.appendChild(span)
  }
  wrap.appendChild(stats)

  root.appendChild(wrap)
}
