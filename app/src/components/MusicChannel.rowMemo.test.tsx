import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { TrackTable } from './MusicChannel.tsx'
import type { TrackTableRow } from '../lib/playlistScope.ts'
import type { AudioTrack } from '../lib/audioStage.ts'

// 一行只在**自己**的数据变了才重渲染。
//
// 起因：下载进度是每秒好几帧的高频更新，而 `jobs` 是一个整表共用的对象——它一变，整张表
// 全部行跟着重渲染。1031 首的播单里，这等于每一帧都重建上千个 Radix 菜单 root。
//
// 怎么观察"这一行渲染了没有"：有封面的行在渲染时会调 imgUrl。把它 mock 成计数器，
// 数调用次数就等于数哪些行真的重跑了 render。
//
// 这条同时钉住 TrackTable 内部那层「回调引用要稳」——父级（MusicChannel）每次渲染都会新建
// toggleLike / onDownload 这些函数，行组件套了 React.memo 也白套；所以下面 rerender 时
// **故意传全新的回调实例**，memo 仍必须挡住。

// 工厂里只放空桩、行为在 beforeEach 里装——restoreMocks 会把工厂里设的实现还原掉
// （规矩写在 vite.config.ts 那个开关旁边）。
const imgUrlMock = vi.hoisted(() => vi.fn())
vi.mock('../lib/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.ts')>()
  return { ...actual, imgUrl: imgUrlMock }
})

function track(id: string): AudioTrack {
  return { id, url: `/api/media/x?id=${id}`, kind: 'music', title: id }
}
const ROWS: TrackTableRow[] = ['a', 'b', 'c'].map((id, i) => ({
  id, title: id, poster: `p-${id}.jpg`, track: track(id), playIndex: i, trackKey: `qq:${id}`,
}))

function fakeStage() {
  return {
    current: null, playing: false, toggle: vi.fn(), playQueue: vi.fn(),
    queues: { music: [], podcast: [] }, queue: [], activeKind: 'music',
    currentTime: 0, duration: 0, seek: vi.fn(), stop: vi.fn(), play: vi.fn(),
    getVolume: () => 1, setVolume: vi.fn(),
  } as never
}

function table(jobs: Record<string, { state: string; downloadedBytes?: number; totalBytes?: number }>) {
  return (
    <TrackTable
      rows={ROWS}
      queue={ROWS.map((r) => r.track!) as AudioTrack[]}
      stage={fakeStage()}
      baseUrl=""
      liked={new Set<string>()}
      toggleLike={vi.fn()}      // 每次都是全新实例——正是父级的真实行为
      onDownload={vi.fn()}
      jobs={jobs}
      emptyText="空"
    />
  )
}

describe('行组件按行记忆', () => {
  beforeEach(() => {
    cleanup()
    imgUrlMock.mockReset()
    imgUrlMock.mockImplementation((base: string, u: string) => `${base}/${u}`)
  })

  it('只有下载进度变了的那一行重渲染，其余两行不动', () => {
    const { rerender } = render(table({}))
    expect(imgUrlMock).toHaveBeenCalledTimes(3) // 首渲染：三行都画

    imgUrlMock.mockClear()
    rerender(table({ 'qq:a': { state: 'running', downloadedBytes: 10, totalBytes: 100 } }))
    expect(imgUrlMock).toHaveBeenCalledTimes(1)
    expect(imgUrlMock.mock.calls[0][1]).toBe('p-a.jpg')
  })

  it('进度再往前走一格，仍然只有那一行动', () => {
    const { rerender } = render(table({ 'qq:a': { state: 'running', downloadedBytes: 10, totalBytes: 100 } }))
    imgUrlMock.mockClear()
    rerender(table({ 'qq:a': { state: 'running', downloadedBytes: 60, totalBytes: 100 } }))
    expect(imgUrlMock).toHaveBeenCalledTimes(1)
  })
})
