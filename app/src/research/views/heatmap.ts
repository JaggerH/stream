// app/src/research/views/heatmap.ts — 热力图 view(迁自 boards/panels/heatmap.ts)。
// 数据源从"长表(x/y/value 三列,面板侧 pivot 回网格)"换成 artifact.data 直接给的网格
// {matrix, xlabels, ylabels}(matrix[yi][xi],真实样本见
// Lean/artifacts/20260513-162632-9vemgb/joint_dist_pre.json)——不用再 pivot,连带原来
// pivot key 用空格拼接会撞车的那个坑也随 pivot 步骤一起消失了。
import type { Artifact } from '../artifact.ts'
import { themeColors, type PanelTheme } from './base.ts'

interface HeatmapData { matrix: Array<Array<number | null>>; xlabels: string[]; ylabels: string[] }

function isHeatmapData(d: unknown): d is HeatmapData {
  if (!d || typeof d !== 'object') return false
  const o = d as Record<string, unknown>
  if (!Array.isArray(o.matrix) || !Array.isArray(o.xlabels) || !Array.isArray(o.ylabels)) return false
  if (o.matrix.length !== o.ylabels.length) return false
  return o.matrix.every((row) => Array.isArray(row) && row.length === (o.xlabels as unknown[]).length)
}

function color(v: number, min: number, max: number): string {
  // 发散色标:负 → 蓝,0 → 灰,正 → 红;按各自半轴归一。
  if (v >= 0) {
    const t = max > 0 ? v / max : 0
    return `rgba(239,68,68,${0.15 + 0.7 * t})`
  }
  const t = min < 0 ? v / min : 0
  return `rgba(59,130,246,${0.15 + 0.7 * t})`
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
  if (!isHeatmapData(d)) return renderShapeError(root, colors, artifact.name)
  const { matrix, xlabels, ylabels } = d
  const config = artifact.config as { title?: string; xlabel?: string; ylabel?: string }

  if (config.title) {
    const h = document.createElement('div')
    h.style.cssText = `padding:4px 8px 0;font-size:11px;font-weight:600;color:${colors.text}`
    h.textContent = config.title
    root.appendChild(h)
  }

  const nums = matrix.flat().filter((v): v is number => typeof v === 'number')
  const min = Math.min(0, ...nums)
  const max = Math.max(0, ...nums)

  const grid = document.createElement('div')
  grid.style.cssText = `display:grid;grid-template-columns:auto repeat(${xlabels.length},1fr);gap:1px;font-size:10px;color:${colors.text};height:100%;overflow:auto;padding:6px`
  grid.appendChild(document.createElement('span')) // 左上空角
  for (const x of xlabels) {
    const h = document.createElement('span')
    h.textContent = x
    h.style.cssText = 'text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    grid.appendChild(h)
  }
  ylabels.forEach((y, yi) => {
    const h = document.createElement('span')
    h.textContent = y
    h.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:4px'
    grid.appendChild(h)
    xlabels.forEach((x, xi) => {
      const v = matrix[yi]?.[xi] ?? null
      const cell = document.createElement('div')
      cell.dataset.cell = '1'
      cell.title = `${x} / ${y}${v === null ? '' : ` = ${Number(v.toPrecision(4))}`}`
      cell.style.cssText = `min-height:18px;border-radius:2px;background:${v === null ? 'transparent' : color(v, min, max)}`
      grid.appendChild(cell)
    })
  })
  root.appendChild(grid)
  if (config.xlabel || config.ylabel) {
    const caption = document.createElement('div')
    caption.style.cssText = `padding:2px 8px;font-size:10px;opacity:.7;color:${colors.text}`
    caption.textContent = [config.xlabel && `x: ${config.xlabel}`, config.ylabel && `y: ${config.ylabel}`].filter(Boolean).join('  ·  ')
    root.appendChild(caption)
  }
}
