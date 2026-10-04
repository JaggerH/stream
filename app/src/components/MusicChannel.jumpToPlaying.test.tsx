import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { TrackTable } from './MusicChannel.tsx'
import type { TrackTableRow } from '../lib/playlistScope.ts'
import type { AudioTrack } from '../lib/audioStage.ts'

// 打开一个歌单时要跳到「正在播放」的那一行。这里守的是 TIMING，不是像素：
// 只在打开(切列表)时跳一次——队列自动播下一首、或用户在列表里点点点导致的 re-render
// 都不能把视口拽走。跳转依赖当前播放行的 ref 真的挂到了 DOM 上，所以这个测试同时
// 证明了 ref 转发没断（断了的话 scrollIntoView 永远拿到 null，静默不跳）。

function track(id: string): AudioTrack {
  return { id, url: `/api/media/x?id=${id}`, kind: 'music', title: id }
}

function row(id: string, index: number): TrackTableRow {
  return { id, title: id, track: track(id), playIndex: index }
}

const ROWS = [row('t1', 0), row('t2', 1), row('t3', 2)]

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

function renderTable(opts: { jumpKey?: string; currentId: string | null; rows?: TrackTableRow[] }) {
  return render(
    <TrackTable
      rows={opts.rows ?? ROWS}
      queue={(opts.rows ?? ROWS).map((r) => r.track!) as AudioTrack[]}
      stage={fakeStage(opts.currentId)}
      baseUrl=""
      liked={new Set<string>()}
      toggleLike={vi.fn()}
      emptyText="空"
      jumpKey={opts.jumpKey}
    />,
  )
}

describe('打开歌单跳到正在播放', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>

  beforeEach(() => {
    cleanup()
    scrollIntoView = vi.fn()
    // jsdom 不实现 scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView']
  })

  it('当前播放曲目在本列表里 → 打开时滚动到它（居中）', () => {
    renderTable({ jumpKey: 'pl-a', currentId: 't2' })
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
  })

  it('当前播放曲目不在本列表 → 不跳（视口不动）', () => {
    renderTable({ jumpKey: 'pl-a', currentId: 'not-in-list' })
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('什么都没在播 → 不跳', () => {
    renderTable({ jumpKey: 'pl-a', currentId: null })
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('同一个列表内 re-render（如自动播下一首）→ 不再跳，不打断浏览', () => {
    const { rerender } = renderTable({ jumpKey: 'pl-a', currentId: 't2' })
    expect(scrollIntoView).toHaveBeenCalledTimes(1)

    // 同 jumpKey，换当前曲目（模拟队列前进）
    rerender(
      <TrackTable
        rows={ROWS}
        queue={ROWS.map((r) => r.track!) as AudioTrack[]}
        stage={fakeStage('t3')}
        baseUrl=""
        liked={new Set<string>()}
        toggleLike={vi.fn()}
        emptyText="空"
        jumpKey="pl-a"
      />,
    )
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('切到另一个歌单 → 重新武装，再跳一次', () => {
    const { rerender } = renderTable({ jumpKey: 'pl-a', currentId: 't2' })
    expect(scrollIntoView).toHaveBeenCalledTimes(1)

    rerender(
      <TrackTable
        rows={ROWS}
        queue={ROWS.map((r) => r.track!) as AudioTrack[]}
        stage={fakeStage('t2')}
        baseUrl=""
        liked={new Set<string>()}
        toggleLike={vi.fn()}
        emptyText="空"
        jumpKey="pl-b"
      />,
    )
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
  })

  it('列表还在加载(busy) → 先不跳，等行真的出来', () => {
    render(
      <TrackTable
        rows={[]}
        queue={[]}
        stage={fakeStage('t2')}
        baseUrl=""
        liked={new Set<string>()}
        toggleLike={vi.fn()}
        emptyText="空"
        busy
        jumpKey="pl-a"
      />,
    )
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})
