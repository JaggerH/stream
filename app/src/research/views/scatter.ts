// app/src/research/views/scatter.ts — 散点 view(迁自 boards/panels/scatter.ts;
// recharts 不随迁,手绘 SVG——见对齐笔记第 7 条)。
// 数据源从"每帧任意两个 number 列 = (x,y),多帧多色"换成 artifact.data 的单组
// {x, y} 数值数组(真实样本见 Lean/artifacts/20260513-162632-9vemgb/phase_z_pre.json)——
// 一份 artifact 就是一张图,不再是多序列聚合,图例标签改用 artifact.name。
import type { Artifact } from '../artifact.ts'
import { chartHeightPx, themeColors, type PanelTheme } from './base.ts'

const NS = 'http://www.w3.org/2000/svg'
const W = 100
const H = 100
const PAD = 8

interface ScatterData { x: Array<number | null>; y: Array<number | null> }

function isScatterData(d: unknown): d is ScatterData {
  if (!d || typeof d !== 'object') return false
  const o = d as Record<string, unknown>
  return Array.isArray(o.x) && Array.isArray(o.y) && o.x.length === o.y.length
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
  if (!isScatterData(d)) return renderShapeError(root, colors, artifact.name)

  const pts: Array<[number, number]> = []
  for (let i = 0; i < d.x.length; i++) {
    const x = d.x[i]; const y = d.y[i]
    if (typeof x === 'number' && typeof y === 'number') pts.push([x, y])
  }
  if (pts.length === 0) return renderShapeError(root, colors, artifact.name)

  const config = artifact.config as { title?: string; xlabel?: string; ylabel?: string; height?: number }
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1])
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)]
  const sx = (x: number) => PAD + (x1 === x0 ? 0.5 : (x - x0) / (x1 - x0)) * (W - 2 * PAD)
  const sy = (y: number) => H - PAD - (y1 === y0 ? 0.5 : (y - y0) / (y1 - y0)) * (H - 2 * PAD)

  if (config.title) {
    const h = document.createElement('div')
    h.style.cssText = `padding:4px 8px 0;font-size:11px;font-weight:600;color:${colors.text}`
    h.textContent = config.title
    root.appendChild(h)
  }

  const legend = document.createElement('div')
  legend.style.cssText = `display:flex;gap:8px;font-size:11px;padding:4px 8px;color:${colors.text}`
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  // 同样吃过百分比高度的亏,但症状相反:SVG 不是"不画",而是被 viewBox 的宽高比撑开
  // (实测 1608×1640,每张卡约 1600px 高,一页只装得下一张图)。给显式像素高度。
  svg.style.cssText = `width:100%;height:${chartHeightPx(config)}px`
  ;[0.25, 0.5, 0.75].forEach((t) => {
    const line = document.createElementNS(NS, 'line')
    line.setAttribute('x1', String(PAD)); line.setAttribute('x2', String(W - PAD))
    line.setAttribute('y1', String(PAD + t * (H - 2 * PAD))); line.setAttribute('y2', String(PAD + t * (H - 2 * PAD)))
    line.setAttribute('stroke', colors.grid); line.setAttribute('stroke-width', '0.3')
    svg.appendChild(line)
  })
  const c = colors.series[0]!
  const chip = document.createElement('span')
  chip.style.color = c
  chip.textContent = `● ${artifact.name}`
  legend.appendChild(chip)
  for (const [x, y] of pts) {
    const dot = document.createElementNS(NS, 'circle')
    dot.setAttribute('cx', String(sx(x))); dot.setAttribute('cy', String(sy(y)))
    dot.setAttribute('r', '1.2'); dot.setAttribute('fill', c); dot.setAttribute('fill-opacity', '0.85')
    const title = document.createElementNS(NS, 'title')
    title.textContent = `(${x}, ${y})`
    dot.appendChild(title)
    svg.appendChild(dot)
  }
  root.appendChild(legend)
  root.appendChild(svg)
  if (config.xlabel || config.ylabel) {
    const caption = document.createElement('div')
    caption.style.cssText = `padding:2px 8px;font-size:10px;opacity:.7;color:${colors.text}`
    caption.textContent = [config.xlabel && `x: ${config.xlabel}`, config.ylabel && `y: ${config.ylabel}`].filter(Boolean).join('  ·  ')
    root.appendChild(caption)
  }
}
