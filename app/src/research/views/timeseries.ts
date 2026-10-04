// app/src/research/views/timeseries.ts — 时序 view(迁自 boards/panels/timeseries.ts)。
// 数据源从 DataFrame[](x = 帧内 time 列,每个 number 列一条线)换成 artifact.data 的
// {index, series} 形状(真实样本见 Lean/artifacts/20260513-174415-kjfe4s/b1_beta_miner_60d.json):
// index 是日期字符串数组,series 是 {列名: 数值数组} 字典——一个键一条线。
// options.logScale 改读 artifact.config.logScale;config.title / yAxisLabel 此前被
// DataFrame 层丢掉过(见 research/artifact.ts 头注),现在原样透传画出来。
import { createChart, LineSeries, ColorType, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import type { Artifact } from '../artifact.ts'
import { chartHeightPx, themeColors, type PanelTheme } from './base.ts'

interface TimeseriesData { index: string[]; series: Record<string, Array<number | null>> }
interface Line { label: string; points: Array<{ time: UTCTimestamp; value: number }> }

function isTimeseriesData(d: unknown): d is TimeseriesData {
  if (!d || typeof d !== 'object') return false
  const o = d as Record<string, unknown>
  return Array.isArray(o.index) && typeof o.series === 'object' && o.series !== null && !Array.isArray(o.series)
}

/** index/series → 曲线集:一个 series 键一条线,index[i] 解析不出日期或值不是 number 的点跳过。 */
function toLines(d: TimeseriesData): Line[] {
  const out: Line[] = []
  for (const [label, values] of Object.entries(d.series)) {
    const points: Line['points'] = []
    for (let i = 0; i < d.index.length; i++) {
      const t = Date.parse(String(d.index[i]))
      const v = values[i]
      if (!Number.isNaN(t) && typeof v === 'number') points.push({ time: (t / 1000) as UTCTimestamp, value: v })
    }
    out.push({ label, points })
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
  if (!isTimeseriesData(d)) return renderShapeError(root, colors, artifact.name)
  const lines = toLines(d)
  const config = artifact.config as { title?: string; yAxisLabel?: string; height?: number; logScale?: boolean }

  if (config.title) {
    const h = document.createElement('div')
    h.style.cssText = `padding:4px 8px 0;font-size:11px;font-weight:600;color:${colors.text}`
    h.textContent = config.title
    root.appendChild(h)
  }

  const legend = document.createElement('div')
  legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;font-size:11px;padding:4px 8px'
  const host = document.createElement('div')
  host.dataset.chart = 'timeseries'
  // 显式像素高度。config.height 早就解析出来了却从没用过——它正是为此存在的（真实
  // timeseries artifact 带这个字段）。理由与百分比高度的后果见 base.ts chartHeightPx。
  host.style.cssText = `width:100%;height:${chartHeightPx(config)}px`
  root.appendChild(legend)
  root.appendChild(host)

  // jsdom 没有布局引擎(clientWidth/clientHeight 恒 0),lightweight-charts 在 0 尺寸下会
  // 拒绝创建——测试环境跳过图形本体,契约测试断言的是图例与容器(数据→DOM 的映射),不是像素。
  // 注意这个守卫**不只在 jsdom 里生效**:宿主写百分比高度时真实浏览器里也恒假,于是整片
  // 图表静默消失。高度必须自足(上面那行),这个守卫才回到"只兜测试环境"的本意。
  let chart: IChartApi | null = null
  if (host.clientWidth > 0 && host.clientHeight > 0) {
    chart = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: colors.text },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { mode: config.logScale ? 1 : 0 },
    })
    lines.forEach((s, i) => {
      chart!.addSeries(LineSeries, { color: colors.series[i % colors.series.length]!, lineWidth: 2 }).setData(s.points)
    })
    chart.timeScale().fitContent()
  }
  lines.forEach((s, i) => {
    const chip = document.createElement('span')
    chip.style.color = colors.series[i % colors.series.length]!
    chip.textContent = `— ${s.label}`
    legend.appendChild(chip)
  })
  if (config.yAxisLabel) {
    const caption = document.createElement('div')
    caption.style.cssText = `padding:0 8px 4px;font-size:10px;opacity:.7;color:${colors.text}`
    caption.textContent = config.yAxisLabel
    root.appendChild(caption)
  }
  // 图表实例(canvas + resize observer)在 0 尺寸的测试环境里没创建,不需要 disposer;
  // 真实环境创建了就必须 .remove(),否则 ArtifactView 换 artifact/卸载时它会一直挂着。
  return chart ? () => chart!.remove() : undefined
}
