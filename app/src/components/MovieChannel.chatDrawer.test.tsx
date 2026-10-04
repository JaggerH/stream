// 影视页一级页的陈列：「继续观看」「正在追的」与下面的榜单**是同一种东西**——横向 Rail、
// 160px 定宽海报、标题旁带条数与翻页键。
//
// 这条为什么要钉：它们此前是会换行的自适应网格（`auto-fill/minmax(160px,1fr)`，卡片被拉到比
// 160 宽），于是同一页上出现两种尺寸的海报，看起来像两个来源不同的模块。改回网格不会报错，
// 只会又变成两种陈列。
//
// 「被聊天抽屉挤」那条前提仍然成立，只是换了兑现方式：以前靠 container-width 驱动的列数重排
// （所以不能用视口断点），现在靠 Rail 自己那个 `overflow-x-auto` 的滚动容器——容器被挤窄就
// 少露几张、翻页键接管，不会把页面撑出横向滚动条。所以这里连带钉住那个滚动容器还在。
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MovieChannel } from './MovieChannel.tsx'

const itemsMock = vi.hoisted(() => vi.fn())
const collectionsMock = vi.hoisted(() => vi.fn())
const collectionItemsMock = vi.hoisted(() => vi.fn())
const whereCollectedMock = vi.hoisted(() => vi.fn())
const watchProgressListMock = vi.hoisted(() => vi.fn())
const watchProgressRemoveMock = vi.hoisted(() => vi.fn())
const markStreamSeenMock = vi.hoisted(() => vi.fn())

vi.mock('../lib/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.ts')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      items: itemsMock,
      markStreamSeen: markStreamSeenMock,
      collections: collectionsMock,
      collectionItems: collectionItemsMock,
      whereCollected: whereCollectedMock,
      watchProgressList: watchProgressListMock,
      watchProgressRemove: watchProgressRemoveMock,
    },
  }
})

beforeEach(() => {
  itemsMock.mockReset().mockResolvedValue([])
  markStreamSeenMock.mockResolvedValue(undefined)
  collectionsMock.mockReset().mockResolvedValue([])
  collectionItemsMock.mockReset().mockResolvedValue([])
  whereCollectedMock.mockReset().mockResolvedValue({ item: null, collectionIds: [] })
  watchProgressListMock.mockReset().mockResolvedValue([])
  watchProgressRemoveMock.mockReset().mockResolvedValue(undefined)
})

const channels = [{
  id: 'videos', label: '影视', kind: 'video' as const, present: 'video' as const, space_id: 'default-space', streams: [{
    id: 'work-1', description: '示例作品', newCount: 2, sources: [], cadence_seconds: 1800, vault_subdir: 'work-1',
  }],
}]

describe('影视页「正在追的」的陈列', () => {
  it('是横向 Rail：160px 定宽海报 + 可横滚的容器，与下面的榜单同一种', async () => {
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={channels} onReload={vi.fn()} />)
    // 卡片真渲染出来了才说明这条分支挂上了——不是断言了个空壳
    const card = await screen.findByRole('button', { name: '示例作品' })

    // 定宽 160，不随容器伸缩（榜单那边的 tile 同一个数）
    const tile = card.closest('.shrink-0')
    expect(tile?.className).toContain('w-[160px]')

    // 外面是可横滚的容器：容器被挤窄时少露几张、翻页键接管，而不是把页面撑宽
    const scroller = tile?.parentElement
    expect(scroller?.className).toContain('overflow-x-auto')

    // 反：不能退回换行网格——那正是"同一页两种海报尺寸"的来源
    expect(scroller?.className.includes('grid')).toBe(false)
    expect(scroller?.className.includes('auto-fill')).toBe(false)
  })
})
