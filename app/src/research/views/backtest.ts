// app/src/research/views/backtest.ts — 回测曲线 view(迁自 boards/panels/backtest.ts)。
// 数据源从"markers 帧 + 曲线帧的 DataFrame[] 拍平结构"换成 artifact.data 直接给的
// {strategy, benchmark, positions, markers}(真实样本见
// Lean/artifacts/20260526-181120-aqakue/equity_curve.json)——markers 数组本身已经是
// lightweight-charts 的 SeriesMarker 形状(position/shape/color/text 已算好),不用再从
// buy/sell tag 反推箭头方向与颜色。图表 = lightweight-charts,markers 挂第一条曲线。
import { createChart, createSeriesMarkers, LineSeries, ColorType, type IChartApi, type UTCTimestamp, type SeriesMarker, type Time } from 'lightweight-charts'
import type { Artifact } from '../artifact.ts'
import { chartHeightPx, themeColors, type PanelTheme } from './base.ts'

interface Point { time: string; value: number }
interface RawMarker { time: string; position: 'aboveBar' | 'belowBar'; color: string; shape: 'arrowUp' | 'arrowDown' | 'circle'; text: string }
interface BacktestData {
  strategy: Point[]
  benchmark?: Point[]
  positions?: Record<string, Point[]>
  markers?: RawMarker[]
}

function isBacktestData(d: unknown): d is BacktestData {
  if (!d || typeof d !== 'object') return false
  const o = d as Record<string, unknown>
  return Array.isArray(o.strategy) && o.strategy.length > 0
}

function toPoints(points: Point[]): Array<{ time: UTCTimestamp; value: number }> {
  const out: Array<{ time: UTCTimestamp; value: number }> = []
  for (const p of points) {
    const t = Date.parse(p.time)
    if (!Number.isNaN(t) && typeof p.value === 'number') out.push({ time: (t / 1000) as UTCTimestamp, value: p.value })
  }
  return out
}

function renderShapeError(root: HTMLElement, colors: { text: string }, name: string): void {
  const p = document.createElement('div')
  p.style.cssText = `padding:8px;font-size:12px;color:${colors.text}`
  p.textContent = `数据形状不是这个 view 认识的样子(${name})`
  root.appendChild(p)
}

export function render(root: HTMLElement, artifact: Artifact, theme: PanelTheme): (() => void) | void {
  const colors = themeColors(theme)
  const d = artifact.data
  if (!isBacktestData(d)) return renderShapeError(root, colors, artifact.name)
  const config = artifact.config as { title?: string; height?: number }

  const lines: Array<{ label: string; points: Array<{ time: UTCTimestamp; value: number }> }> = [
    { label: 'strategy', points: toPoints(d.strategy) },
  ]
  if (d.benchmark) lines.push({ label: 'benchmark', points: toPoints(d.benchmark) })
  for (const [label, points] of Object.entries(d.positions ?? {})) lines.push({ label, points: toPoints(points) })

  const markers: Array<SeriesMarker<Time>> = (d.markers ?? []).flatMap((m) => {
    const t = Date.parse(m.time)
    if (Number.isNaN(t)) return []
    return [{ time: (t / 1000) as UTCTimestamp, position: m.position, shape: m.shape, color: m.color, text: m.text }]
  })

  if (config.title) {
    const h = document.createElement('div')
    h.style.cssText = `padding:4px 8px 0;font-size:11px;font-weight:600;color:${colors.text}`
    h.textContent = config.title
    root.appendChild(h)
  }

  const legend = document.createElement('div')
  legend.style.cssText = `display:flex;flex-wrap:wrap;gap:8px;font-size:11px;padding:4px 8px;color:${colors.text}`
  lines.forEach((s, i) => {
    const chip = document.createElement('span')
    chip.style.color = colors.series[i % colors.series.length]!
    chip.textContent = `— ${s.label}`
    legend.appendChild(chip)
  })
  if (markers.length > 0) {
    const chip = document.createElement('span')
    chip.textContent = `◆ ${markers.length} markers`
    legend.appendChild(chip)
  }
  const host = document.createElement('div')
  host.dataset.chart = 'backtest'
  // 显式像素高度(理由见 base.ts chartHeightPx):百分比高度在流式卡片里算出来是 0,
  // 下面那句尺寸守卫恒假,图表静默不画。
  host.style.cssText = `width:100%;height:${chartHeightPx(config)}px`
  root.appendChild(legend)
  root.appendChild(host)

  if (host.clientWidth > 0 && host.clientHeight > 0) {
    const chart: IChartApi = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: colors.text },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
    })
    const chartLines = lines.map((s, i) => {
      const line = chart.addSeries(LineSeries, { color: colors.series[i % colors.series.length]!, lineWidth: 2 })
      line.setData(s.points)
      return line
    })
    if (markers.length > 0 && chartLines[0]) createSeriesMarkers(chartLines[0], markers.sort((a, b) => (a.time as number) - (b.time as number)))
    chart.timeScale().fitContent()
    // timeseries.ts 同款理由:0 尺寸的测试环境不创建图表、不需要 disposer;真实环境必须
    // .remove(),否则换 artifact 或卸载 ArtifactView 时这个图表实例(canvas + observer)漏在那。
    return () => chart.remove()
  }
}
