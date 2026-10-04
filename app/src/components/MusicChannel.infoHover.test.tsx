import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react'
import { TrackTable } from './MusicChannel.tsx'
import type { TrackTableRow } from '../lib/playlistScope.ts'
import type { AudioTrack } from '../lib/audioStage.ts'

// 曲目名后面那个 info 图标：hover 出一张节目元数据卡。
//
// 两条要钉住的：
// 1. 没东西可讲的行不挂图标——弹出一张空卡片比没有更糟。
// 2. 卡片内容是**懒**的：没 hover 到的行不构造它。这张表 200 行以上要虚拟化，行内每一份
//    常驻开销都会被行数乘一遍。

function track(id: string): AudioTrack {
  return { id, url: `/api/media/x?id=${id}`, kind: 'music', title: id }
}

const RICH: TrackTableRow = {
  id: 'a', title: '950.荒唐且搞笑的案件', author: '怡楽播客', album: '怡楽', durationS: 2730,
  track: track('a'), playIndex: 0, sourceUrl: 'https://www.lizhi.fm/vod/3226503323560351238',
  sourceItem: {
    id: 'a', stream_id: 's1', type: 'post', title: '950.荒唐且搞笑的案件',
    timestamp: '2026-08-02T16:00:01.000Z', fetched_at: '2026-08-04T02:51:57.722Z',
    content: { archetype: 'audio', text: '主播：小伟、阿达' },
  } as never,
}
const BARREN: TrackTableRow = { id: 'b', title: '无名', track: track('b'), playIndex: 1 }

function fakeStage() {
  return {
    current: null, playing: false, toggle: vi.fn(), playQueue: vi.fn(),
    queues: { music: [], podcast: [] }, queue: [], activeKind: 'music',
    currentTime: 0, duration: 0, seek: vi.fn(), stop: vi.fn(), play: vi.fn(),
    getVolume: () => 1, setVolume: vi.fn(),
  } as never
}

function renderTable(rows: TrackTableRow[]) {
  return render(
    <TrackTable
      rows={rows}
      queue={rows.map((r) => r.track!) as AudioTrack[]}
      stage={fakeStage()}
      baseUrl=""
      liked={new Set<string>()}
      toggleLike={vi.fn()}
      jobs={{}}
      emptyText="空"
    />
  )
}

describe('曲目名后的 info 图标', () => {
  beforeEach(cleanup)

  it('有元数据的行挂图标，只有标题的行不挂', () => {
    renderTable([RICH, BARREN])
    expect(screen.getAllByRole('button', { name: '节目信息' })).toHaveLength(1)
  })

  it('没 hover 时卡片内容不在文档里', () => {
    renderTable([RICH])
    expect(screen.queryByText('主播：小伟、阿达')).toBeNull()
    expect(screen.queryByText('发布时间')).toBeNull()
  })

  it('hover 图标 → 卡片给出作者/专辑/时长/发布时间/简介/原文链接', () => {
    vi.useFakeTimers()
    try {
      renderTable([RICH])
      // Radix 的 hover 触发认的是 pointerenter，且 pointerType 是 touch 时故意不开。
      fireEvent.pointerEnter(screen.getByRole('button', { name: '节目信息' }), { pointerType: 'mouse' })
      act(() => { vi.advanceTimersByTime(400) }) // 越过 openDelay

      // 断言限定在卡片里面：作者/专辑这些字面在表格行上也有一份，全局查会撞上。
      const card = document.querySelector('[data-slot="hover-card-content"]')
      expect(card).toBeTruthy()
      const inCard = within(card as HTMLElement)
      expect(inCard.getByText('怡楽播客')).toBeTruthy()
      expect(inCard.getByText('怡楽')).toBeTruthy()
      expect(inCard.getByText('45:30')).toBeTruthy()
      expect(inCard.getByText('发布时间')).toBeTruthy()
      expect(inCard.getByText('主播：小伟、阿达')).toBeTruthy()
      expect(inCard.getByRole('link', { name: RICH.sourceUrl! })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('点图标不会连带把这首歌放出来——它是查看信息，不是播放', () => {
    const stage = fakeStage() as unknown as { playQueue: ReturnType<typeof vi.fn> }
    render(
      <TrackTable rows={[RICH]} queue={[RICH.track!]} stage={stage as never} baseUrl=""
        liked={new Set<string>()} toggleLike={vi.fn()} jobs={{}} emptyText="空" />
    )
    fireEvent.click(screen.getByRole('button', { name: '节目信息' }))
    expect(stage.playQueue).not.toHaveBeenCalled()
  })
})
