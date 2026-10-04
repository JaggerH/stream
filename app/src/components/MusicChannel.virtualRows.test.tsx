import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { TrackTable } from './MusicChannel.tsx'
import { pickDownloadTargets } from '../lib/musicToolbar.ts'
import type { TrackTableRow } from '../lib/playlistScope.ts'
import type { AudioTrack } from '../lib/audioStage.ts'

// 曲目表的**虚拟化**（只渲染视口里的那十几行）。守两件事：
//
//  1. 阈值 200 —— 200 行以内维持全量渲染。这不是性能取舍，是**功能取舍**：没上屏的行不在 DOM 里，
//     浏览器自带的 Ctrl+F 页内查找就找不到它们。短列表用 Ctrl+F 找歌是真实用法，不能砍。
//  2. 超过阈值以后，行仍然待在真 <table>/<tbody> 里、靠上下两个占位 <tr> 撑高度——不是绝对定位。
//     绝对定位会破坏 table 布局并让 sticky <thead> 失效。
//
// 起因（活体实测，怡乐播客播单 1031 首）：全量渲染出 28147 个 DOM 节点，其中 98.4% 永远看不见；
// 每行还挂一个 Radix DropdownMenu root，开一次行内菜单光是往 body 写 pointer-events 那一下的样式
// 重算就要 196ms，且随行数线性增长。

const ROW_H = 53
/** jsdom 没有排版:滚动容器的 offsetHeight / clientHeight / scrollHeight 全是 0。虚拟化器拿 0
 *  视口高会算出"一行都不在窗口里"从而整片不渲染，拿 0 滚动高会把任何跳转目标夹回 0。给它一份
 *  真实几何，测的才是虚拟化本身而不是 jsdom 的空布局。 */
const VIEWPORT_H = 800
function protoOwning(prop: string): object {
  for (const proto of [HTMLElement.prototype, Element.prototype]) {
    if (Object.getOwnPropertyDescriptor(proto, prop)) return proto
  }
  throw new Error(`jsdom 没有 ${prop} 的属性描述符`)
}
const GEOMETRY = ['offsetHeight', 'clientHeight', 'scrollHeight'].map((prop) => {
  const proto = protoOwning(prop)
  return { prop, proto, desc: Object.getOwnPropertyDescriptor(proto, prop)! }
})
function stubGeometry(contentHeight = VIEWPORT_H) {
  for (const { prop, proto } of GEOMETRY) {
    const value = prop === 'scrollHeight' ? contentHeight : VIEWPORT_H
    Object.defineProperty(proto, prop, { configurable: true, get: () => value })
  }
}
function restoreGeometry() {
  for (const { prop, proto, desc } of GEOMETRY) Object.defineProperty(proto, prop, desc)
}

function track(id: string): AudioTrack {
  return { id, url: `/api/media/x?id=${id}`, kind: 'music', title: id }
}

function makeRows(n: number): TrackTableRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    title: `曲目 ${i}`,
    poster: `poster-${i}.jpg`,
    track: track(`t${i}`),
    playIndex: i,
  }))
}

function fakeStage(currentId: string | null) {
  return {
    current: currentId ? track(currentId) : null,
    playing: false,
    toggle: vi.fn(),
    playQueue: vi.fn(),
    queues: { music: [], podcast: [] },
    queue: [],
    activeKind: 'music',
    currentTime: 0,
    duration: 0,
    seek: vi.fn(),
    stop: vi.fn(),
    play: vi.fn(),
    getVolume: () => 1,
    setVolume: vi.fn(),
  } as never
}

function renderTable(opts: {
  rows: TrackTableRow[]
  currentId?: string | null
  jumpKey?: string
  selectMode?: boolean
  selectedIds?: Set<string>
  stage?: ReturnType<typeof fakeStage>
  onToggleSelect?: () => void
}) {
  return render(
    <TrackTable
      rows={opts.rows}
      queue={opts.rows.map((r) => r.track!) as AudioTrack[]}
      stage={opts.stage ?? fakeStage(opts.currentId ?? null)}
      baseUrl=""
      liked={new Set<string>()}
      toggleLike={vi.fn()}
      emptyText="空"
      jumpKey={opts.jumpKey}
      selectMode={opts.selectMode}
      selectedIds={opts.selectedIds}
      onToggleSelect={opts.onToggleSelect ?? vi.fn()}
    />,
  )
}

/** 真正的曲目行（占位行是裸 <tr>，没有 TableRow 的 data-slot）。 */
function bodyRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('tbody tr[data-slot="table-row"]')]
}
function padHeight(container: HTMLElement, which: 'top' | 'bottom'): number {
  const el = container.querySelector<HTMLElement>(`[data-testid="track-vpad-${which}"]`)
  return el ? parseFloat(el.style.height || '0') : 0
}

describe('曲目表虚拟化', () => {
  beforeEach(() => { cleanup(); stubGeometry(300 * ROW_H) })
  afterEach(restoreGeometry)

  it('200 行（阈值以内）→ 全量渲染，Ctrl+F 找得到最后一行', () => {
    const { container } = renderTable({ rows: makeRows(200) })
    expect(bodyRows(container)).toHaveLength(200)
    expect(screen.getByText('曲目 199')).toBeTruthy()
  })

  it('300 行（超过阈值）→ 只渲染视口窗口，末尾那行不在 DOM 里', () => {
    const { container } = renderTable({ rows: makeRows(300) })
    const rendered = bodyRows(container)
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered.length).toBeLessThan(60) // 视口 + overscan，绝不是 300
    expect(screen.queryByText('曲目 299')).toBeNull()
  })

  it('虚拟化后总高度不塌：上下占位行补齐没渲染的那些行', () => {
    const { container } = renderTable({ rows: makeRows(300) })
    const rendered = bodyRows(container).length
    expect(rendered).toBeLessThan(300)
    expect(padHeight(container, 'bottom')).toBeGreaterThan(0)
    const total = padHeight(container, 'top') + rendered * ROW_H + padHeight(container, 'bottom')
    expect(total).toBe(300 * ROW_H)
  })

  it('占位用的是 <tbody> 里的真 <tr>，行不脱离表格布局（绝对定位会毁掉 sticky 表头）', () => {
    const { container } = renderTable({ rows: makeRows(300) })
    const pad = container.querySelector('[data-testid="track-vpad-bottom"]')
    expect(pad?.closest('tbody')).toBeTruthy()
    // 占位块本身是 <tr>（或它就长在 <tr> 里），不是浮在表外的 div
    expect(pad?.closest('tr')).toBeTruthy()
    for (const tr of bodyRows(container)) {
      expect(tr.style.position).toBe('') // 没有 absolute
      expect(tr.closest('tbody')).toBeTruthy()
    }
    expect(container.querySelector('thead[data-sticky]')).toBeTruthy()
  })

  it('多选：没上屏的行照样在选中集里——动作吃的是数据不是 DOM', () => {
    const rows = makeRows(300)
    const selectedIds = new Set(['t0', 't299'])
    const { container } = renderTable({ rows, selectMode: true, selectedIds })
    // t299 压根没渲染
    expect(screen.queryByText('曲目 299')).toBeNull()
    // 上屏的那一行的勾选态来自 selectedIds（数据），不是 DOM 扫描
    expect(container.querySelector('[aria-label="取消选择"]')).toBeTruthy()
    // 批量动作的取材同样是整份 rows + selectedIds，与渲染窗口无关
    const { targets } = pickDownloadTargets({
      rows,
      canDownload: () => true,
      selection: { ids: selectedIds, idOf: (r) => r.id },
    })
    expect(targets.map((r) => r.id)).toEqual(['t0', 't299'])
  })

  it('上屏的行照常可点、可键盘操作、带行内 ⋯ 菜单', () => {
    const rows = makeRows(300)
    const stage = fakeStage(null)
    const { container } = renderTable({ rows, stage })
    const first = bodyRows(container)[0]
    expect(first.getAttribute('tabindex')).toBe('0')
    fireEvent.keyDown(first, { key: 'Enter' })
    expect((stage as unknown as { playQueue: ReturnType<typeof vi.fn> }).playQueue).toHaveBeenCalledTimes(1)
    fireEvent.click(first)
    expect((stage as unknown as { playQueue: ReturnType<typeof vi.fn> }).playQueue).toHaveBeenCalledTimes(2)
    // 每个上屏的行都还带着自己的 ⋯ 菜单触发器（菜单本体在 jsdom 里展不开，见 toolbar 测试的注解）
    expect(container.querySelectorAll('[aria-label="歌曲操作"]')).toHaveLength(bodyRows(container).length)
  })

  it('多选模式下点行 = 勾选，勾的是那一行的数据对象', () => {
    const rows = makeRows(300)
    const onToggleSelect = vi.fn()
    const { container } = renderTable({ rows, selectMode: true, selectedIds: new Set(), onToggleSelect })
    fireEvent.click(bodyRows(container)[3])
    expect(onToggleSelect).toHaveBeenCalledWith(rows[3])
  })
})

describe('虚拟化后跳到正在播放', () => {
  let scrollTo: ReturnType<typeof vi.fn>
  let scrollIntoView: ReturnType<typeof vi.fn>
  const origScrollTo = Element.prototype.scrollTo
  const origScrollIntoView = Element.prototype.scrollIntoView

  // 虚拟化器挂上滚动容器时会先把当前偏移原样写回一次（scrollTo({top: 0})）——那不是"跳"。
  // 只数真正跳走的那些。
  const jumps = () => scrollTo.mock.calls.map((c) => (c[0] as { top: number }).top).filter((t) => t > 0)

  beforeEach(() => {
    cleanup()
    stubGeometry(300 * ROW_H)
    scrollTo = vi.fn()
    scrollIntoView = vi.fn()
    Element.prototype.scrollTo = scrollTo as unknown as Element['scrollTo']
    Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView']
  })
  afterEach(() => {
    restoreGeometry()
    Element.prototype.scrollTo = origScrollTo
    Element.prototype.scrollIntoView = origScrollIntoView
  })

  it('正在播放的那行没上屏 → 用虚拟化器按数据下标滚过去（DOM 里查不到它，scrollIntoView 是死路）', () => {
    renderTable({ rows: makeRows(300), currentId: 't250', jumpKey: 'pl-big' })
    expect(jumps().length).toBeGreaterThan(0)
    // 第 250 行居中：行顶 - (视口 - 行高)/2
    expect(jumps()[0]).toBeCloseTo(250 * ROW_H - (VIEWPORT_H - ROW_H) / 2, 0)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('不在本列表的曲目 → 不跳', () => {
    renderTable({ rows: makeRows(300), currentId: 'not-in-list', jumpKey: 'pl-big' })
    expect(jumps()).toEqual([])
  })
})
