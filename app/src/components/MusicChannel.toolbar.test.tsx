import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { TrackListToolbar, canDownloadRow, SelectionBar } from './MusicChannel.tsx'
import type { TrackTableRow } from '../lib/playlistScope.ts'

// 这个工具栏存在的理由就是「三种列表台面上长得一模一样」。所以这里守的是
// **恒定性**：不管传进来多少能力，可见按钮永远是那三个(或菜单为空时两个)。
// 菜单里有什么由 musicToolbar.test.ts 的纯函数测覆盖——Radix 菜单在 jsdom 里
// 用 fireEvent.click 展不开，这里不去碰它。

const BASE = { playDisabled: false, onPlayAll: vi.fn(), selectMode: false, onToggleSelectMode: vi.fn() }

beforeEach(() => { cleanup(); vi.clearAllMocks() })

describe('TrackListToolbar 台面恒定', () => {
  it('普通歌单(能力全有)台面仍只有三个按钮', () => {
    render(<TrackListToolbar {...BASE} onDownloadAll={vi.fn()} sync={{ on: false, onToggle: vi.fn() }}
      onNetdisk={vi.fn()} />)
    expect(screen.getByRole('button', { name: '播放全部' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '多选' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '更多操作' })).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  it('播单(只有下载/重命名/删除)台面还是那三个,位置不变', () => {
    render(<TrackListToolbar {...BASE} onDownloadAll={vi.fn()} onRename={vi.fn()} onRemove={vi.fn()} />)
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim())
    expect(names).toEqual(['播放全部', '多选', '更多操作'])
  })

  it('我喜欢的(只有下载整单)台面还是那三个', () => {
    render(<TrackListToolbar {...BASE} onDownloadAll={vi.fn()} />)
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  it('一项能力都没有 → ⋯ 不渲染(不留一个点开是空的按钮)', () => {
    render(<TrackListToolbar {...BASE} />)
    expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })
})

describe('TrackListToolbar 台面动作', () => {
  it('播放全部：空列表时 disabled，有内容时点了就播', () => {
    const onPlayAll = vi.fn()
    const { rerender } = render(<TrackListToolbar {...BASE} playDisabled onPlayAll={onPlayAll} />)
    expect(screen.getByRole('button', { name: '播放全部' }).hasAttribute('disabled')).toBe(true)
    rerender(<TrackListToolbar {...BASE} playDisabled={false} onPlayAll={onPlayAll} />)
    fireEvent.click(screen.getByRole('button', { name: '播放全部' }))
    expect(onPlayAll).toHaveBeenCalledTimes(1)
  })

  it('多选：三种列表都给(播单以前被挡掉了)', () => {
    const onToggleSelectMode = vi.fn()
    render(<TrackListToolbar {...BASE} onToggleSelectMode={onToggleSelectMode} onRename={vi.fn()} onRemove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    expect(onToggleSelectMode).toHaveBeenCalledTimes(1)
  })

  it('多选是开关,开关态要能被读屏拿到(只换颜色的话读屏什么都听不见)', () => {
    const { rerender } = render(<TrackListToolbar {...BASE} selectMode={false} />)
    expect(screen.getByRole('button', { name: '多选' }).getAttribute('aria-pressed')).toBe('false')
    rerender(<TrackListToolbar {...BASE} selectMode />)
    expect(screen.getByRole('button', { name: '多选' }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('canDownloadRow', () => {
  const bare = (over: Partial<TrackTableRow>): TrackTableRow => ({ id: 'x', title: 'x', playIndex: 0, ...over })

  it('有 sourceItem(普通歌单的分集)→ 能下', () => {
    expect(canDownloadRow(bare({ sourceItem: { id: 'i1' } as never }))).toBe(true)
  })
  it('有 likeRef(我喜欢的曲目)→ 能下', () => {
    expect(canDownloadRow(bare({ likeRef: { platform: 'p', trackId: 't' } }))).toBe(true)
  })
  it('只有 trackKey(播单里的 track 成员)→ 能下', () => {
    expect(canDownloadRow(bare({ trackKey: 'p:t' }))).toBe(true)
  })
  it('三者皆无(源 stream 被删的灰置行)→ 不能下', () => {
    expect(canDownloadRow(bare({}))).toBe(false)
  })
})

describe('SelectionBar 多选下载', () => {
  const conn = { baseUrl: '' } as never

  it('浮动条上有下载，点了就下这一批', () => {
    const onDownload = vi.fn()
    render(<SelectionBar conn={conn} count={12} anchorStreamId={null}
      onPick={vi.fn()} onDownload={onDownload} onCancel={vi.fn()} />)
    expect(screen.getByText('已选 12 首')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    expect(onDownload).toHaveBeenCalledTimes(1)
  })

  it('取消仍在', () => {
    const onCancel = vi.fn()
    render(<SelectionBar conn={conn} count={1} anchorStreamId={null}
      onPick={vi.fn()} onDownload={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
