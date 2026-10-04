// app/src/research/views/table.ts — 表格 view(迁自 boards/panels/table.ts)。
// 数据源从 DataFrame 换成 artifact.data 的 pandas split 格式:{columns, index, data}
// (真实样本见 Lean/artifacts/20260515-052143-qvj96o/per_asset_betas.json)。列不再带
// FrameField.type 标注,格式化按值的 runtime 类型判断。列头排序交互、pageSize 截断——
// 渲染逻辑原样保留;options 的读取全部换成 artifact.config。
import type { Artifact } from '../artifact.ts'
import { themeColors, type PanelTheme } from './base.ts'

type Cell = number | string | boolean | null

interface TableData { columns: string[]; index: unknown[]; data: Cell[][] }

function isTableData(d: unknown): d is TableData {
  if (!d || typeof d !== 'object') return false
  const o = d as Record<string, unknown>
  return Array.isArray(o.columns) && Array.isArray(o.data)
}

function fmt(v: Cell): string {
  if (v === null) return '—'
  if (typeof v === 'number') return Number(v.toPrecision(4)).toString()
  if (typeof v === 'boolean') return v ? '✓' : '✗'
  return String(v)
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
  if (!isTableData(d)) return renderShapeError(root, colors, artifact.name)
  const { columns, data: rows } = d
  const config = artifact.config as { title?: string; pageSize?: number }
  const pageSize = typeof config.pageSize === 'number' && config.pageSize > 0 ? config.pageSize : Infinity

  if (config.title) {
    const h = document.createElement('div')
    h.style.cssText = `padding:6px 8px 2px;font-size:11px;font-weight:600;color:${colors.text}`
    h.textContent = config.title
    root.appendChild(h)
  }

  const wrap = document.createElement('div')
  wrap.style.cssText = `height:100%;overflow:auto;font-size:12px;color:${colors.text}`
  root.appendChild(wrap)

  let sort: { col: number; dir: 1 | -1 } | null = null

  function paint(): void {
    wrap.textContent = ''
    let order = [...Array(rows.length).keys()]
    if (sort) {
      const { col, dir } = sort
      order.sort((a, b) => {
        const va = rows[a]![col] ?? null
        const vb = rows[b]![col] ?? null
        if (va === null) return 1
        if (vb === null) return -1
        return (va < vb ? -1 : va > vb ? 1 : 0) * dir
      })
    }
    const shown = order.slice(0, pageSize)

    const table = document.createElement('table')
    table.style.cssText = 'width:100%;border-collapse:collapse'
    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    columns.forEach((name, ci) => {
      const th = document.createElement('th')
      th.textContent = name
      th.style.cssText = `position:sticky;top:0;text-align:left;padding:4px 8px;border-bottom:1px solid ${colors.grid};cursor:pointer;background:inherit`
      th.onclick = () => {
        sort = sort?.col === ci && sort.dir === 1 ? { col: ci, dir: -1 } : { col: ci, dir: 1 }
        paint()
      }
      headRow.appendChild(th)
    })
    thead.appendChild(headRow)
    const tbody = document.createElement('tbody')
    for (const i of shown) {
      const tr = document.createElement('tr')
      for (const v of rows[i]!) {
        const td = document.createElement('td')
        td.textContent = fmt(v)
        td.style.cssText = `padding:3px 8px;border-bottom:1px solid ${colors.grid}`
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    table.appendChild(thead)
    table.appendChild(tbody)
    wrap.appendChild(table)
    if (shown.length < rows.length) {
      const note = document.createElement('div')
      note.style.cssText = 'padding:4px 8px;opacity:.7'
      note.textContent = `前 ${shown.length} 行,共 ${rows.length} 行`
      wrap.appendChild(note)
    }
  }

  paint()
}
