import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { TrackTable } from './MusicChannel.tsx'
import type { TrackTableRow } from '../lib/playlistScope.ts'
import type { AudioTrack } from '../lib/audioStage.ts'

// 播单内拖拽排序。表格自己**不改名单**——它只把 (from, to) 报上去，父级才是名单的唯一持有者。
// 这几条钉的就是那个边界，以及两个真会咬人的浏览器细节（dragover 必须 preventDefault、
// 拖到表外只有 dragend）。

const track = (id: string): AudioTrack => ({ id, url: `/x?id=${id}`, kind: 'music', title: id })

/** 真浏览器的 drag 事件一定带 dataTransfer；jsdom 的合成事件不带，所以测试自己补上一份，
 *  而不是让生产代码去容忍一个现实中不存在的缺失。 */
const dt = () => ({ dataTransfer: { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() } })

const rows = (n: number): TrackTableRow[] =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `曲目 ${i}`, track: track(`t${i}`), playIndex: i }))

const stage = () => ({
  current: null, playing: false, toggle: vi.fn(), playQueue: vi.fn(),
  queues: { music: [], podcast: [] }, queue: [], activeKind: 'music',
  currentTime: 0, duration: 0, seek: vi.fn(), stop: vi.fn(), play: vi.fn(),
  getVolume: () => 1, setVolume: vi.fn(),
}) as never

function renderTable(opts: { onReorder?: (f: number, t: number) => void; selectMode?: boolean; n?: number }) {
  const list = rows(opts.n ?? 4)
  const r = render(
    <TrackTable
      rows={list}
      queue={list.map((x) => x.track!) as AudioTrack[]}
      stage={stage()}
      baseUrl="http://b"
      liked={new Set()}
      toggleLike={vi.fn()}
      emptyText="空"
      selectMode={opts.selectMode}
      onToggleSelect={opts.selectMode ? vi.fn() : undefined}
      onReorder={opts.onReorder}
    />,
  )
  const bodyRows = () => [...r.container.querySelectorAll('tbody tr')].filter((tr) => !tr.hasAttribute('aria-hidden'))
  return { ...r, bodyRows }
}

afterEach(cleanup)

describe('播单内拖拽排序', () => {
  it('不给 onReorder 就不可拖——普通节目列表不该冒出一个改不了的排序手势', () => {
    const { bodyRows } = renderTable({})
    expect(bodyRows().every((tr) => !(tr as HTMLElement).draggable)).toBe(true)
  })

  it('给了 onReorder 每一行都可拖', () => {
    const { bodyRows } = renderTable({ onReorder: vi.fn() })
    expect(bodyRows().every((tr) => (tr as HTMLElement).draggable)).toBe(true)
  })

  it('多选模式下不可拖：那时候按住一行的意思是"勾上它"，两种手势会抢同一个按压', () => {
    const { bodyRows } = renderTable({ onReorder: vi.fn(), selectMode: true })
    expect(bodyRows().every((tr) => !(tr as HTMLElement).draggable)).toBe(true)
  })

  it('拖 0 到 2：只上报 (0,2)，表格自己一行都不动', () => {
    const onReorder = vi.fn()
    const { bodyRows } = renderTable({ onReorder })
    const before = bodyRows().map((tr) => tr.textContent)
    fireEvent.dragStart(bodyRows()[0], dt())
    fireEvent.dragEnter(bodyRows()[2])
    fireEvent.drop(bodyRows()[2])
    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(onReorder).toHaveBeenCalledWith(0, 2)
    expect(bodyRows().map((tr) => tr.textContent)).toEqual(before) // 名单归父级，表格不自作主张
  })

  it('原地松手不上报——否则每次误触都写一次库', () => {
    const onReorder = vi.fn()
    const { bodyRows } = renderTable({ onReorder })
    fireEvent.dragStart(bodyRows()[1], dt())
    fireEvent.dragEnter(bodyRows()[1])
    fireEvent.drop(bodyRows()[1])
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('dragover 必须被 preventDefault——不拦掉浏览器就判定"这儿不能放"，drop 永不触发', () => {
    const { bodyRows } = renderTable({ onReorder: vi.fn() })
    fireEvent.dragStart(bodyRows()[0], dt())
    const over = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(over, 'dataTransfer', { value: { dropEffect: '' } })
    bodyRows()[2].dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
  })

  it('拖到表格外面松手（只来 dragend）照样落位，并且落点提示清干净', () => {
    const onReorder = vi.fn()
    const { bodyRows, container } = renderTable({ onReorder })
    fireEvent.dragStart(bodyRows()[3], dt())
    fireEvent.dragEnter(bodyRows()[0])
    fireEvent.dragEnd(bodyRows()[3])
    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(onReorder).toHaveBeenCalledWith(3, 0)
    expect(container.querySelectorAll('.\\[\\&\\>td\\]\\:border-t-primary')).toHaveLength(0)
  })

  it('落点提示只画在当前悬停的那一行，且不画在被拖起的那一行上', () => {
    const { bodyRows } = renderTable({ onReorder: vi.fn() })
    fireEvent.dragStart(bodyRows()[0], dt())
    fireEvent.dragEnter(bodyRows()[0])
    expect(bodyRows()[0].className).not.toContain('border-t-primary')
    fireEvent.dragEnter(bodyRows()[2])
    const cued = bodyRows().filter((tr) => tr.className.includes('border-t-primary'))
    expect(cued).toHaveLength(1)
    expect(cued[0]).toBe(bodyRows()[2])
  })
})
