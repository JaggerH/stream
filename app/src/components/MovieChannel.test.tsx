import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MovieChannel } from './MovieChannel.tsx'
import { setAskChatSink, type AskChatOp } from '../lib/askExtract.ts'

const itemsMock = vi.hoisted(() => vi.fn())
const collectionsMock = vi.hoisted(() => vi.fn())
const collectionItemsMock = vi.hoisted(() => vi.fn())
const whereCollectedMock = vi.hoisted(() => vi.fn())
const addToCollectionMock = vi.hoisted(() => vi.fn())
const removeFromCollectionMock = vi.hoisted(() => vi.fn())
const videoTitleSearchMock = vi.hoisted(() => vi.fn())
const watchProgressListMock = vi.hoisted(() => vi.fn())
const watchProgressRemoveMock = vi.hoisted(() => vi.fn())
// 行为在 beforeEach 里装，不在工厂里：restoreMocks 在每个测试**之前**还原所有 mock，
// 工厂里设的 mockResolvedValue 一个测试都活不到（组件里 `.catch(...)` 会炸在 undefined 上）。
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
      addToCollection: addToCollectionMock,
      removeFromCollection: removeFromCollectionMock,
      videoTitleSearch: videoTitleSearchMock,
      watchProgressList: watchProgressListMock,
      watchProgressRemove: watchProgressRemoveMock,
    },
  }
})

const artPlayerPropsMock = vi.hoisted(() => vi.fn())
vi.mock('./ArtPlayer.tsx', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ArtPlayer: (props: any) => { artPlayerPropsMock(props); return <div data-testid="art-player" /> },
}))

// MovieChannel always fetches 正在追的's tmdb-kind items on mount (see collectedTmdb state), and
// every CollectButton (WorkDetail/RankingDetail/TmdbWorkDetail) eagerly checks its own membership
// on mount — default both to "nothing collected" for every test; tests exercising the collect
// flow itself override these.
beforeEach(() => {
  markStreamSeenMock.mockResolvedValue(undefined)
  collectionItemsMock.mockReset().mockResolvedValue([])
  whereCollectedMock.mockReset().mockResolvedValue({ item: null, collectionIds: [] })
  // 每个 CollectButton 面板打开时都会拉 api.collections(conn, domain) 列出可选片单——默认给个
  // 空数组,免得没显式配置的用例里 .then 撞在 undefined 上。
  collectionsMock.mockReset().mockResolvedValue([])
  // 「继续观看」墙挂载时无条件拉一次——默认空列表,免得没显式配置的用例里都跑真 fetch/走 toast。
  watchProgressListMock.mockReset().mockResolvedValue([])
  watchProgressRemoveMock.mockReset().mockResolvedValue(undefined)
})

// 这里测的是接线；ResourceFinder 自身(会真发 mounts/search 请求)在它自己的测试里覆盖。
vi.mock('./ResourceFinder.tsx', () => ({
  ResourceFinder: ({ query }: { query: string }) => <div data-testid="resource-finder">{query}</div>,
  ResourceFinderSheet: ({ open, query }: { open: boolean; query: string }) => (open ? <div data-testid="resource-finder">{query}</div> : null),
}))

const episode = (id: string, title: string, url?: string) => ({
  id,
  stream_id: 'work-1',
  type: 'post' as const,
  title,
  timestamp: '2026-07-13T00:00:00.000Z',
  fetched_at: '2026-07-13T00:00:00.000Z',
  content: {
    archetype: 'video' as const,
    media: [{ kind: 'video' as const, url, poster: '/cover.jpg', resolveOnly: true }],
  },
})

describe('MovieChannel mapped episodes', () => {
  beforeEach(() => {
    itemsMock.mockReset()
    itemsMock.mockResolvedValue([
      episode('e1', '第 1 集', '/api/media/videos/resolve?id=e1'),
      episode('e2', '第 2 集'),
    ])
    artPlayerPropsMock.mockReset()
  })

  // review fix (task 4): the flat/未绑定 episode grid's itemId is a raw inbox item id (`e1`), not
  // a leftKey — workKeyParts can't derive a work identity from it, so WorkDetail must supply the
  // stream's own identity explicitly (see buildServerProgress's `override` param) instead of
  // letting every episode become its own "work" in the 继续观看 shelf.
  it('flat episode grid: serverProgress.workKey is the stream identity, not the raw item id', async () => {
    render(
      <MovieChannel
        conn={{ baseUrl: 'http://api' }}
        channels={[{
          id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{
            id: 'work-1', description: '示例作品', newCount: 2, sources: [], cadence_seconds: 1800, vault_subdir: 'work-1',
          }],
        }]} onReload={vi.fn()} />,
    )
    fireEvent.click(await screen.findByRole('button', { name: '示例作品' }))
    fireEvent.click(await screen.findByRole('button', { name: /第 1 集/ }))
    await waitFor(() => expect(screen.getByTestId('art-player')).toBeTruthy())
    const lastProps = artPlayerPropsMock.mock.calls.at(-1)![0]
    expect(lastProps.serverProgress.key).toBe('e1')
    expect(lastProps.serverProgress.workKey).toBe('stream:work-1')
    expect(lastProps.serverProgress.epLabel).toBeUndefined()
  })

  it('plays mapped episodes in a fullscreen overlay and renders unmapped episodes as disabled cards', async () => {
    render(
      <MovieChannel
        conn={{ baseUrl: 'http://api' }}
        channels={[{
          id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{
            id: 'work-1', description: '示例作品', newCount: 2, sources: [], cadence_seconds: 1800, vault_subdir: 'work-1',
          }],
        }]} onReload={vi.fn()} />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '示例作品' }))
    const firstEpisode = await screen.findByRole('button', { name: /第 1 集/ })
    expect((firstEpisode as HTMLElement).getAttribute('aria-disabled')).toBeNull()
    expect(screen.getByText('网盘未匹配')).toBeTruthy()
    expect(screen.getByText('网盘未匹配').closest('button')).toBeNull()

    fireEvent.click(firstEpisode)
    await waitFor(() => expect(screen.getByTestId('art-player')).toBeTruthy())
    // no intermediate page — the player opens straight into the fullscreen overlay, whose
    // only affordance back to the grid is the close button (Esc / native-fullscreen exit too).
    // 对齐后分集播放走共享的 DetailShell（与时间线帖子详情同一个外壳）——判据用外壳的语义标志
    // role=dialog，而不是某个按钮文案（作品详情自己也有一个「返回」，按文案找会撞车）。
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('keeps a ranking shelf visible and prefers its cached canonical detail preview', async () => {
    itemsMock.mockResolvedValue([{
      ...episode('rank-1', '豆瓣列表标题'), stream_id: 'video-douban-weekly',
      content: { archetype: 'gallery', text: '发现层已有的影片简介', meta: { source: 'douban', year: '2024', rating: '8.0', genres: ['剧情'] }, media: [{ kind: 'image', url: '/douban.jpg' }] },
      videoDetail: { title: 'The Substance', year: 2024, rating: 7.2, poster: 'https://image.tmdb.org/p.jpg' },
    }])
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{ id: 'video-douban-weekly', description: '豆瓣 · 一周口碑榜', sources: [], cadence_seconds: 1800, vault_subdir: 'rank' }] }]}  onReload={vi.fn()} />)

    const card = await screen.findByRole('button', { name: 'The Substance' })
    fireEvent.click(card)
    expect(await screen.findByText('发现层已有的影片简介')).toBeTruthy()
  })

  it('addresses a followed 剧 under the same /item/ segment a ranking row uses', async () => {
    window.history.replaceState(null, '', '/video')
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{ id: 'work-1', description: '示例作品', newCount: 2, sources: [], cadence_seconds: 1800, vault_subdir: 'work-1' }] }]}  onReload={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '示例作品' }))
    await screen.findByText('分集')
    // one segment: opening a title never reveals how Stream happens to store it
    expect(window.location.pathname).toBe('/video/item/work-1')

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(window.location.pathname).toBe('/video'))
  })

  it('still lands an old /work/ deep link, so open tabs keep working', async () => {
    window.history.replaceState(null, '', '/video/work/work-1')
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{ id: 'work-1', description: '示例作品', newCount: 2, sources: [], cadence_seconds: 1800, vault_subdir: 'work-1' }] }]}  onReload={vi.fn()} />)

    expect(await screen.findByText('分集')).toBeTruthy()
  })

  it('lets the open player own Esc, so closing it does not also leave the work page', async () => {
    window.history.replaceState(null, '', '/video')
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{ id: 'work-1', description: '示例作品', newCount: 2, sources: [], cadence_seconds: 1800, vault_subdir: 'work-1' }] }]}  onReload={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '示例作品' }))
    fireEvent.click(await screen.findByRole('button', { name: /第 1 集/ }))
    await waitFor(() => expect(screen.getByTestId('art-player')).toBeTruthy())
    const path = window.location.pathname

    // one Esc = one layer: the player closes and the page stays put
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('art-player')).toBeNull())
    expect(window.location.pathname).toBe(path)

    // and now that nothing covers it, the page takes the next Esc itself
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(window.location.pathname).toBe('/video'))
  })

  it('restores a ranking detail from a /video/item deep link after refresh', async () => {
    window.history.replaceState(null, '', '/video/item/rank-1')
    itemsMock.mockResolvedValue([{
      ...episode('rank-1', '三国第一部：争洛阳'), stream_id: 'video-douban-playing',
      content: { archetype: 'gallery', text: '标题：三国第一部：争洛阳', meta: { source: 'douban', year: '2026' }, media: [{ kind: 'image', url: '/douban.jpg' }] },
    }])

    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{ id: 'video-douban-playing', description: '豆瓣 · 正在热映', sources: [], cadence_seconds: 1800, vault_subdir: 'playing' }] }]}  onReload={vi.fn()} />)

    expect(await screen.findByText('标题：三国第一部：争洛阳')).toBeTruthy()
  })

  it('shows the whole cast as paged tiles, and leaves the detail on Esc', async () => {
    window.history.replaceState(null, '', '/video')
    const people = [
      { name: 'Michael Johnston', role: 'actor', character: 'Bear', image: '/p1.jpg' },
      { name: 'Curry Barker', role: 'director' },
      { name: 'Third Person', role: 'actor', character: 'Extra', image: '/p3.jpg' },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ detail: { metadata: { title: '痴迷', people }, images: {}, failures: [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    itemsMock.mockResolvedValue([{
      ...episode('rank-1', '痴迷'), stream_id: 'video-douban-playing',
      content: { archetype: 'gallery', meta: { source: 'douban' }, media: [{ kind: 'image', url: '/douban.jpg' }] },
    }])

    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{ id: 'video-douban-playing', description: '豆瓣 · 正在热映', sources: [], cadence_seconds: 1800, vault_subdir: 'playing' }] }]}  onReload={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '痴迷' }))
    expect(await screen.findByText('演职员')).toBeTruthy()
    // the cast reads like a ranking row: same paging affordance, whole cast counted
    expect(screen.getByText(String(people.length))).toBeTruthy()
    expect(screen.getByTitle('上一页')).toBeTruthy()
    expect(screen.getByTitle('下一页')).toBeTruthy()
    expect(screen.getByText('Bear')).toBeTruthy()
    // a director with no photo still gets a tile, falling back to the placeholder
    expect(screen.getByText('Curry Barker')).toBeTruthy()
    // cast tiles present rather than navigate — no dead `role="button"` promised to a11y
    expect(screen.queryByRole('button', { name: 'Michael Johnston' })).toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(window.location.pathname).toBe('/video'))
    vi.unstubAllGlobals()
  })
})

describe('收藏 — 正在追的成员来源, 独立于 Channel 成员关系(2026-07-20)', () => {
  const followingCollection = { id: 'col_video_following', domain: 'video' as const, label: '正在追的', system: 'following' as const, itemCount: 1, createdAt: 't', updatedAt: 't' }

  beforeEach(() => {
    itemsMock.mockReset()
    itemsMock.mockResolvedValue([episode('e1', '第 1 集')])
    collectionsMock.mockReset().mockResolvedValue([followingCollection])
    whereCollectedMock.mockReset()
    addToCollectionMock.mockReset().mockResolvedValue({})
    removeFromCollectionMock.mockReset().mockResolvedValue({ ok: true })
  })

  it('取消收藏 an already-followed work via WorkDetail: un-checking 正在追的 calls the API and drops it out of the grid', async () => {
    window.history.replaceState(null, '', '/video')
    whereCollectedMock.mockResolvedValue({ item: null, collectionIds: ['col_video_following'] })
    render(
      <MovieChannel
        conn={{ baseUrl: 'http://api' }}
        channels={[{
          id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{
            id: 'work-1', description: '示例作品', newCount: 2, sources: [], cadence_seconds: 1800, vault_subdir: 'work-1',
          }],
        }]} onReload={vi.fn()} />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '示例作品' }))
    fireEvent.click(await screen.findByRole('button', { name: '已收藏' })) // opens the panel
    fireEvent.click(await screen.findByText('正在追的')) // un-check it
    await waitFor(() => expect(removeFromCollectionMock).toHaveBeenCalledWith(
      { baseUrl: 'http://api' }, 'col_video_following', { kind: 'stream', streamId: 'work-1' },
    ))

    fireEvent.click(await screen.findByRole('button', { name: '收藏' })) // trigger flipped, close the panel
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(window.location.pathname).toBe('/video'))
    expect(screen.queryByRole('button', { name: '示例作品' })).toBeNull() // gone from 正在追的
  })

  it('收藏 a channel member that is not yet collected (deep-linked, so it never had to render in a shelf)', async () => {
    window.history.replaceState(null, '', '/video/item/work-1')
    whereCollectedMock.mockResolvedValue({ item: null, collectionIds: [] })
    render(
      <MovieChannel
        conn={{ baseUrl: 'http://api' }}
        channels={[{
          id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{
            id: 'work-1', description: '示例作品', image: '/poster.jpg', sources: [], cadence_seconds: 1800, vault_subdir: 'work-1',
            // no newCount — a channel member the backend does NOT consider collected yet
          }],
        }]} onReload={vi.fn()} />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '收藏' }))
    fireEvent.click(await screen.findByText('正在追的'))
    await waitFor(() => expect(addToCollectionMock).toHaveBeenCalledWith(
      { baseUrl: 'http://api' }, 'col_video_following', { kind: 'stream', streamId: 'work-1' }, { title: '示例作品', poster: '/poster.jpg' },
    ))
    await screen.findByRole('button', { name: '已收藏' })
  })

  it('a tmdb-kind (no-Stream) collected item renders in 正在追的, opens TmdbWorkDetail, and can be un-collected from there', async () => {
    window.history.replaceState(null, '', '/video')
    collectionItemsMock.mockResolvedValue([
      { key: 'tmdb:movie:1368337', kind: 'tmdb', domain: 'video', tmdbId: '1368337', media: 'movie', title: '奥德赛', poster: '/o.jpg', firstCollectedAt: 1 },
    ])
    whereCollectedMock.mockResolvedValue({ item: null, collectionIds: ['col_video_following'] })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ detail: { metadata: { title: '奥德赛' }, images: {}, failures: [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))

    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [] }]}  onReload={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '奥德赛' }))
    expect(window.location.pathname).toBe('/video/tmdb/movie/1368337') // 独立路由段,不挂在 Item/Stream 下

    fireEvent.click(await screen.findByRole('button', { name: '已收藏' }))
    fireEvent.click(await screen.findByText('正在追的'))
    await waitFor(() => expect(removeFromCollectionMock).toHaveBeenCalledWith(
      { baseUrl: 'http://api' }, 'col_video_following', { kind: 'tmdb', id: '1368337', media: 'movie' },
    ))

    fireEvent.click(await screen.findByRole('button', { name: '收藏' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(window.location.pathname).toBe('/video'))
    expect(screen.queryByRole('button', { name: '奥德赛' })).toBeNull() // gone from 正在追的
    vi.unstubAllGlobals()
  })

  /**
   * 影视这棵树过去一处对话入口都没有：指着一部剧说"帮我看看它的网盘"，用户只能自己把片名
   * 打一遍，而同名近名模型会搜错。详情页这颗按钮送的是 TMDb 坐标，零歧义。
   */
  it('详情页能把这部作品引用进对话（送坐标，不是送片名）', async () => {
    window.history.replaceState(null, '', '/video')
    const ops: AskChatOp[] = []
    setAskChatSink((op) => { ops.push(op) })
    collectionItemsMock.mockResolvedValue([
      { key: 'tmdb:tv:241453', kind: 'tmdb', domain: 'video', tmdbId: '241453', media: 'tv', title: '星卡梦少女', poster: '/o.jpg', firstCollectedAt: 1 },
    ])
    whereCollectedMock.mockResolvedValue({ item: null, collectionIds: ['col_video_following'] })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ detail: { metadata: { title: '星卡梦少女' }, images: {}, failures: [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))

    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [] }]} onReload={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '星卡梦少女' }))
    fireEvent.click(await screen.findByRole('button', { name: /在对话中引用/ }))

    await waitFor(() => expect(ops).toHaveLength(1))
    // 引用不是发送——引完用户还要接着说下一句。
    expect(ops[0]).toEqual({ kind: 'compose', text: '「星卡梦少女」(tmdb:tv:241453)' })
    setAskChatSink(undefined)
    vi.unstubAllGlobals()
  })
})

describe('正在追的 — 跨类型统一时间线 + tmdb 封面自愈(2026-07-24)', () => {
  const followingCollection = { id: 'col_video_following', domain: 'video' as const, label: '正在追的', system: 'following' as const, itemCount: 3, createdAt: 't', updatedAt: 't' }

  beforeEach(() => {
    itemsMock.mockReset().mockResolvedValue([episode('e1', '第 1 集')])
    collectionsMock.mockReset().mockResolvedValue([followingCollection])
    addToCollectionMock.mockReset().mockResolvedValue({})
    removeFromCollectionMock.mockReset().mockResolvedValue({ ok: true })
  })

  it('stream 关注与 tmdb 收藏按「正在追的」列表的 added_at 顺序交错,不再两段拼接', async () => {
    window.history.replaceState(null, '', '/video')
    // 服务端已按 added_at DESC:最新是 tmdb,中间是 stream 关注,最旧又是 tmdb
    collectionItemsMock.mockResolvedValue([
      { key: 'tmdb:movie:2', kind: 'tmdb', domain: 'video', tmdbId: '2', media: 'movie', title: '新收藏电影', poster: '/n.jpg', firstCollectedAt: 3 },
      { key: 'stream:work-1', kind: 'stream', domain: 'video', streamId: 'work-1', title: '示例作品', firstCollectedAt: 2 },
      { key: 'tmdb:movie:1', kind: 'tmdb', domain: 'video', tmdbId: '1', media: 'movie', title: '旧收藏电影', poster: '/o.jpg', firstCollectedAt: 1 },
    ])
    render(
      <MovieChannel
        conn={{ baseUrl: 'http://api' }}
        channels={[{
          id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{
            id: 'work-1', description: '示例作品', newCount: 2, sources: [], cadence_seconds: 1800, vault_subdir: 'work-1',
          }],
        }]} onReload={vi.fn()} />,
    )

    const newest = await screen.findByRole('button', { name: '新收藏电影' })
    const middle = await screen.findByRole('button', { name: '示例作品' })
    const oldest = await screen.findByRole('button', { name: '旧收藏电影' })
    // DOM 顺序 = 时间线顺序:tmdb(新) → stream → tmdb(旧)。旧实现里两个 tmdb 恒排在 stream 后面。
    expect(newest.compareDocumentPosition(middle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(middle.compareDocumentPosition(oldest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('已收藏但快照缺 poster、detail 这次解出了封面 → 自动补一次收藏刷新快照', async () => {
    window.history.replaceState(null, '', '/video/tmdb/movie/77')
    whereCollectedMock.mockResolvedValue({
      item: { key: 'tmdb:movie:77', kind: 'tmdb', domain: 'video', tmdbId: '77', media: 'movie', title: '奥德赛', firstCollectedAt: 1 }, // poster 为空 = 当年收藏时没抢到
      collectionIds: ['col_video_following'],
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ detail: { metadata: { title: '奥德赛' }, images: { poster: { url: '/healed.jpg' } }, failures: [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))

    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [] }]}  onReload={vi.fn()} />)

    await waitFor(() => expect(addToCollectionMock).toHaveBeenCalledWith(
      { baseUrl: 'http://api' }, 'col_video_following', { kind: 'tmdb', id: '77', media: 'movie' }, { title: '奥德赛', poster: '/healed.jpg' },
    ))
    vi.unstubAllGlobals()
  })

  it('快照已有 poster → 不做多余的补写', async () => {
    window.history.replaceState(null, '', '/video/tmdb/movie/77')
    whereCollectedMock.mockResolvedValue({
      item: { key: 'tmdb:movie:77', kind: 'tmdb', domain: 'video', tmdbId: '77', media: 'movie', title: '奥德赛', poster: '/already.jpg', firstCollectedAt: 1 },
      collectionIds: ['col_video_following'],
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ detail: { metadata: { title: '奥德赛' }, images: { poster: { url: '/fresh.jpg' } }, failures: [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))

    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [] }]}  onReload={vi.fn()} />)

    await screen.findAllByText('奥德赛')
    await waitFor(() => expect(whereCollectedMock).toHaveBeenCalled())
    expect(addToCollectionMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('找资源入口', () => {
  beforeEach(() => {
    itemsMock.mockReset()
    itemsMock.mockResolvedValue([
      episode('e1', '第 1 集', '/api/media/videos/resolve?id=e1'),
      episode('e2', '第 2 集'),
    ])
  })

  const openWork = async () => {
    render(
      <MovieChannel
        conn={{ baseUrl: 'http://api' }}
        channels={[{
          id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{
            id: 'work-1', description: '示例作品', newCount: 2, sources: [], cadence_seconds: 1800, vault_subdir: 'work-1',
          }],
        }]} onReload={vi.fn()} />,
    )
    fireEvent.click(await screen.findByRole('button', { name: '示例作品' }))
    await screen.findByText('分集')
  }

  it('未配上的灰卡给出下一步：一个「找资源」按钮', async () => {
    await openWork()
    // e2 是未配上的那一集；e1 已配上，不该有按钮 → 全页只有灰卡的 + hero 的两个
    expect(screen.getAllByRole('button', { name: '找资源' })).toHaveLength(2)
  })

  it('点灰卡的「找资源」→ 面板带该集标题打开', async () => {
    await openWork()
    const buttons = screen.getAllByRole('button', { name: '找资源' })
    fireEvent.click(buttons[1])
    expect(screen.getByTestId('resource-finder').textContent).toBe('第 2 集')
  })

  it('点 hero 的「找资源」→ 面板带整剧标题打开', async () => {
    await openWork()
    fireEvent.click(screen.getAllByRole('button', { name: '找资源' })[0])
    expect(screen.getByTestId('resource-finder').textContent).toBe('示例作品')
  })

  it('面板未打开时不渲染', async () => {
    await openWork()
    expect(screen.queryByTestId('resource-finder')).toBeNull()
  })
})

describe('找资源入口 — 榜单条目页', () => {
  beforeEach(() => {
    itemsMock.mockReset()
    itemsMock.mockResolvedValue([{
      ...episode('rank-1', '三国第一部：争洛阳'), stream_id: 'video-douban-playing',
      content: { archetype: 'gallery', text: '简介', meta: { source: 'douban', year: '2026' }, media: [{ kind: 'image', url: '/douban.jpg' }] },
    }])
  })

  const openRanking = async () => {
    window.history.replaceState(null, '', '/video')
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{ id: 'video-douban-playing', description: '豆瓣 · 正在热映', sources: [], cadence_seconds: 1800, vault_subdir: 'playing' }] }]}  onReload={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '三国第一部：争洛阳' }))
    await screen.findByText('简介')
  }

  // 榜单条目一份拷贝都没有,是最需要找资源的地方——RankingDetail 与 WorkDetail 是
  // 两个独立组件,只给后者接入口会漏掉这半个界面。
  it('榜单条目详情页也有「找资源」', async () => {
    await openRanking()
    expect(screen.getByRole('button', { name: '找资源' })).toBeTruthy()
  })

  it('点了带条目标题打开面板', async () => {
    await openRanking()
    fireEvent.click(screen.getByRole('button', { name: '找资源' }))
    expect(screen.getByTestId('resource-finder').textContent).toBe('三国第一部：争洛阳')
  })
})

// 标题右边那个外链按钮：**有权威 TMDb 身份就跳 TMDb**，没有才回落到发现源自己的页面。
// 回落那一份是真会咬人的：儿童频道的奖项名单里，item.url 是这部作品的**维基百科条目**，
// 用户点它想看的却是作品信息。
describe('详情页外链默认跳 TMDb', () => {
  afterEach(() => vi.unstubAllGlobals())

  const openRankingWith = async (detail: unknown) => {
    itemsMock.mockReset()
    itemsMock.mockResolvedValue([{
      ...episode('rank-1', '三国第一部：争洛阳'), stream_id: 'video-douban-playing',
      url: 'https://zh.wikipedia.org/wiki/三国',
      content: { archetype: 'gallery', text: '简介', meta: { source: 'douban' }, media: [{ kind: 'image', url: '/douban.jpg' }] },
    }])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail }), { status: 200, headers: { 'content-type': 'application/json' } })))
    window.history.replaceState(null, '', '/video')
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{ id: 'video-douban-playing', description: '豆瓣 · 正在热映', sources: [], cadence_seconds: 1800, vault_subdir: 'playing' }] }]}  onReload={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '三国第一部：争洛阳' }))
    await screen.findByText('简介')
  }

  it('榜单条目：identity 带 tmdb id → 链接指向 themoviedb.org（不是条目自己的维基页）', async () => {
    await openRankingWith({ metadata: { title: '三国第一部：争洛阳' }, images: {}, failures: [], identity: { kind: 'movie', externalIds: { tmdb: '123' } } })
    const link = await screen.findByRole('link', { name: '在 TMDB 查看' })
    expect(link.getAttribute('href')).toBe('https://www.themoviedb.org/movie/123')
  })

  it('榜单条目：没有 tmdb id → 回落到源链接', async () => {
    await openRankingWith({ metadata: { title: '三国第一部：争洛阳' }, images: {}, failures: [], canonical: { status: 'miss' }, identity: { kind: 'movie', externalIds: {} } })
    const link = await screen.findByRole('link', { name: '查看原始条目' })
    expect(link.getAttribute('href')).toBe('https://zh.wikipedia.org/wiki/三国')
    expect(screen.queryByRole('link', { name: '在 TMDB 查看' })).toBeNull()
  })

  // 剧集页(WorkDetail)是另一个组件，回落目标是「第一集的源链接」——同样该让位给 TMDb。
  const openWorkWith = async (detail: unknown) => {
    itemsMock.mockReset()
    itemsMock.mockResolvedValue([{ ...episode('e1', '第 1 集'), url: 'https://source.example/ep1' }])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ stream: { id: 'work-1', label: '权力的游戏' }, detail }), { status: 200, headers: { 'content-type': 'application/json' } })))
    window.history.replaceState(null, '', '/video')
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{ id: 'work-1', description: '示例作品', newCount: 0, sources: [], cadence_seconds: 1800, vault_subdir: 'work-1' }] }]}  onReload={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '示例作品' }))
  }

  it('剧集页：identity 是 series + tmdb id → 链接指向 /tv/<id>', async () => {
    await openWorkWith({ metadata: { title: '权力的游戏' }, images: {}, failures: [], identity: { kind: 'series', externalIds: { tmdb: '1399' } } })
    const link = await screen.findByRole('link', { name: '在 TMDB 查看' })
    expect(link.getAttribute('href')).toBe('https://www.themoviedb.org/tv/1399')
  })

  it('剧集页：没有 tmdb id → 回落到第一集的源链接', async () => {
    await openWorkWith({ images: {}, failures: [], canonical: { status: 'miss' } })
    const link = await screen.findByRole('link', { name: '查看原始条目' })
    expect(link.getAttribute('href')).toBe('https://source.example/ep1')
  })
})

describe('分季分集树（真剧集）', () => {
  beforeEach(() => {
    itemsMock.mockReset()
    itemsMock.mockResolvedValue([episode('e1', '第 1 集')])
  })
  afterEach(() => vi.unstubAllGlobals())

  const openSeasons = async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      stream: { id: 'work-1', label: '权力的游戏' }, episodes: [],
      detail: { metadata: { title: '权力的游戏' }, images: {}, failures: [] },
      seasons: [
        { season: 1, episodes: [
          { season: 1, episode: 1, title: '凛冬将至', leftKey: 'tmdb:1399:S01E01', playable: true, still: 'https://image.tmdb.org/t/p/w300/e1.jpg' },
          { season: 1, episode: 2, title: '国王大道', leftKey: 'tmdb:1399:S01E02', playable: false },
        ] },
        { season: 2, episodes: [{ season: 2, episode: 1, title: '北境不忘', leftKey: 'tmdb:1399:S02E01', playable: false }] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{ id: 'work-1', description: '示例作品', newCount: 0, sources: [], cadence_seconds: 1800, vault_subdir: 'work-1' }] }]}  onReload={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '示例作品' }))
  }

  it('seasons 非空 → 分季 tab + 分集列表；能播集给播放、灰集给找资源', async () => {
    await openSeasons()
    expect(await screen.findByText('凛冬将至')).toBeTruthy()
    // 两季 → 两个季 tab
    expect(screen.getByRole('button', { name: '第 1 季' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '第 2 季' })).toBeTruthy()
    // S1E1 已配上 → 可点的分集卡（MediaCard role=button，aria=集号+标题）；S1E2 未配上 → 找资源
    expect(screen.getByRole('button', { name: /凛冬将至/ })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '找资源' }).length).toBe(2)
    // 分集卡带 16:9 剧照（TMDb still，经 /api/media/image 代理）
    expect([...document.querySelectorAll('img')].some((i) => i.getAttribute('src')?.includes('e1.jpg'))).toBe(true)
  })

  it('切季 → 换成该季的分集', async () => {
    await openSeasons()
    await screen.findByText('凛冬将至')
    fireEvent.click(screen.getByRole('button', { name: '第 2 季' }))
    expect(await screen.findByText('北境不忘')).toBeTruthy()
    expect(screen.queryByText('凛冬将至')).toBeNull()
  })

  // 榜单条目页(RankingDetail)与追更页(WorkDetail)是两个组件；RankingDetail 手工组 payload,
  // 曾漏把 seasons 塞进去 → 详情页有 h1 却不长分集树。这条守住那个回归。
  it('榜单条目(真剧集)也渲染分季分集树', async () => {
    itemsMock.mockReset()
    itemsMock.mockResolvedValue([{ ...episode('rank-tv', '幸运女神', undefined), stream_id: 'video-tmdb-tv', content: { meta: { source: 'tmdb' } } }])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      detail: { metadata: { title: '幸运女神' }, images: {}, failures: [] },
      seasons: [{ season: 1, episodes: [{ season: 1, episode: 1, title: '脚踏实地', leftKey: 'tmdb:278624:S01E01', playable: false }] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{ id: 'video-tmdb-tv', description: 'TMDB · 剧集趋势', sources: [], cadence_seconds: 1800, vault_subdir: 'x' }] }]}  onReload={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '幸运女神' }))
    expect(await screen.findByText('脚踏实地')).toBeTruthy()
  })
})

describe('本地季 tab（非 TMDB、合并多季 Stream）', () => {
  beforeEach(() => {
    itemsMock.mockReset()
    itemsMock.mockResolvedValue([
      { id: 'e-s1-1', stream_id: 'show-1', type: 'post', title: '第1季 先导片', season: 1, timestamp: '2026-01-01T00:00:00.000Z', fetched_at: '2026-01-01T00:00:00.000Z', url: 'https://x/s1e1' },
      { id: 'e-s3-1', stream_id: 'show-1', type: 'post', title: '第3季 先导片', season: 3, timestamp: '2026-06-24T00:00:00.000Z', fetched_at: '2026-06-24T00:00:00.000Z', url: 'https://x/s3e1' },
    ])
  })
  afterEach(() => vi.unstubAllGlobals())

  const openLocalSeasons = async () => {
    // Deliberately NO `episodes` key in this response: `WorkDetail`'s `visibleEpisodes =
    // payload?.episodes ?? episodes` only falls back to the `episodes` prop (itemsMock's data,
    // which carries the `season` tags) when `payload.episodes` is nullish — an explicit `[]`
    // here would win over `??` and silently empty out `visibleEpisodes`, hiding the bug this
    // test exists to catch.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      stream: { id: 'show-1', label: '喜剧之王单口季' },
      detail: { canonical: { status: 'miss', provider: 'video-canonical' }, images: {}, failures: [{ provider: 'video-canonical', member: 'tmdb-canonical', phase: 'lookup', message: 'declined (no result)' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{ id: 'show-1', description: '喜剧之王单口季', image: '/cover.jpg', newCount: 0, sources: [], cadence_seconds: 1800, vault_subdir: 'show-1' }] }]}  onReload={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '喜剧之王单口季' }))
  }

  it('items 带 season → 渲染本地季 tab（不是 TMDb 树、不是扁平 grid）', async () => {
    await openLocalSeasons()
    expect(await screen.findByText('第3季 先导片')).toBeTruthy()
    expect(screen.getByRole('button', { name: '第 1 季' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '第 3 季' })).toBeTruthy()
    expect(screen.queryByText('第1季 先导片')).toBeNull() // season 3 selected by default (last)
  })

  it('未打 season 标签的老集不消失——并入最高季的 tab', async () => {
    // 迁移前抓的集没有 season 标签(schema 层面和"没有季数据"无法区分)。它们是迁移前唯一被追的
    // 那一季的真实历史剧集——真实场景里都是最高季(合并前追的正是最高季,新增的是更早的季)。
    itemsMock.mockResolvedValueOnce([
      { id: 'e-s1-1', stream_id: 'show-1', type: 'post', title: '第1季 先导片', season: 1, timestamp: '2026-01-01T00:00:00.000Z', fetched_at: '2026-01-01T00:00:00.000Z', url: 'https://x/s1e1' },
      { id: 'e-s3-1', stream_id: 'show-1', type: 'post', title: '第3季 先导片', season: 3, timestamp: '2026-06-24T00:00:00.000Z', fetched_at: '2026-06-24T00:00:00.000Z', url: 'https://x/s3e1' },
      { id: 'e-legacy-1', stream_id: 'show-1', type: 'post', title: '迁移前的老集', timestamp: '2026-05-01T00:00:00.000Z', fetched_at: '2026-05-01T00:00:00.000Z', url: 'https://x/legacy1' },
    ])
    await openLocalSeasons()
    // season 3 is selected by default (highest) — the untagged item merges into that bucket,
    // so it must be visible without switching tabs.
    expect(await screen.findByText('第3季 先导片')).toBeTruthy()
    expect(screen.getByText('迁移前的老集')).toBeTruthy()
  })

  it('切季 → 换成该季的分集', async () => {
    await openLocalSeasons()
    await screen.findByText('第3季 先导片')
    fireEvent.click(screen.getByRole('button', { name: '第 1 季' }))
    expect(await screen.findByText('第1季 先导片')).toBeTruthy()
    expect(screen.queryByText('第3季 先导片')).toBeNull()
  })

  it('canonical miss 但本地数据完整（poster+episodes）→ 不显示"部分详情来源暂不可用"横幅', async () => {
    await openLocalSeasons()
    await screen.findByText('第3季 先导片')
    expect(screen.queryByText('部分详情来源暂不可用，已显示现有数据。')).toBeNull()
  })
})

describe('MovieChannel title search (线A)', () => {
  const channels = [{ id: 'videos', label: '影视', kind: 'video' as const, present: 'video' as const, space_id: 'default-space', streams: [{ id: 'video-douban-weekly', description: '榜单', sources: [], cadence_seconds: 1800, vault_subdir: 'rank' }] }]
  beforeEach(() => {
    itemsMock.mockReset().mockResolvedValue([])
    videoTitleSearchMock.mockReset()
    window.history.pushState({}, '', '/video')
  })

  it('typing a query fetches candidates and clicking one routes to its tmdb detail', async () => {
    videoTitleSearchMock.mockResolvedValue({ candidates: [
      { title: '沙丘', kind: 'movie', year: 2021, poster: '/p.jpg', externalIds: { tmdb: '438631' }, sources: ['tmdb-title-search'], rating: 8.1 },
    ], warnings: [] })
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={channels}  onReload={vi.fn()} />)
    fireEvent.change(await screen.findByPlaceholderText('搜索影视…'), { target: { value: '沙丘' } })
    const card = await screen.findByRole('button', { name: '沙丘' })
    expect(videoTitleSearchMock).toHaveBeenCalledWith({ baseUrl: 'http://api' }, '沙丘')
    fireEvent.click(card)
    await waitFor(() => expect(window.location.pathname).toBe('/video/tmdb/movie/438631'))
  })

  it('shows the empty state when there are no candidates', async () => {
    videoTitleSearchMock.mockResolvedValue({ candidates: [], warnings: [] })
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={channels}  onReload={vi.fn()} />)
    fireEvent.change(await screen.findByPlaceholderText('搜索影视…'), { target: { value: 'zzz' } })
    expect(await screen.findByText('没有找到匹配的作品。')).toBeTruthy()
  })

  it('flags a failed search source via warnings', async () => {
    videoTitleSearchMock.mockResolvedValue({ candidates: [], warnings: [{ source: 'tmdb-title-search', reason: 'boom' }] })
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={channels}  onReload={vi.fn()} />)
    fireEvent.change(await screen.findByPlaceholderText('搜索影视…'), { target: { value: 'x' } })
    expect(await screen.findByText('搜索来源未配置或暂时失败。')).toBeTruthy()
  })
})

describe('「继续观看」墙(2026-07-24 review fix)', () => {
  const noChannels = [{ id: 'videos', label: '影视', kind: 'video' as const, present: 'video' as const, space_id: 'default-space', streams: [] }]

  beforeEach(() => {
    artPlayerPropsMock.mockReset()
  })

  it('渲染一张卡:标题/副标(集号+时间)/进度条百分比都对', async () => {
    watchProgressListMock.mockResolvedValue([
      { key: 'tmdb:1:S03E02', workKey: 'tmdb:1', workTitle: '某剧', epLabel: 'S03E02', position: 754, duration: 3000, updatedAt: 2 },
    ])
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={noChannels}  onReload={vi.fn()} />)
    expect(await screen.findByRole('button', { name: '某剧' })).toBeTruthy()
    expect(await screen.findByText('看到 S03E02 · 12:34')).toBeTruthy()
  })

  // 点一张卡 = 进作品详情页,**不是**直接全屏起播；起播是详情页上「继续播放」那一下。这条把
  // 两段串起来跑,顺带钉住 `?id=` vs `?key=`(stream: 打头的行 key 是不透明 inbox id,选错参数 404)。
  it('点卡 → 先进作品详情页(不起播);再点「继续播放」→ 走 ?id= 且身份不漂', async () => {
    itemsMock.mockReset().mockResolvedValue([])
    watchProgressListMock.mockResolvedValue([
      { key: 'e1', workKey: 'stream:work-1', workTitle: '看到一半的作品', epLabel: 'S01E01', position: 100, duration: 3000, updatedAt: 1 },
    ])
    render(
      <MovieChannel
        conn={{ baseUrl: 'http://api' }}
        channels={[{
          id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{
            id: 'work-1', description: '示例作品', newCount: 0, sources: [], cadence_seconds: 1800, vault_subdir: 'work-1',
          }],
        }]} onReload={vi.fn()} />,
    )
    fireEvent.click(await screen.findByRole('button', { name: '看到一半的作品' }))
    expect(await screen.findByText('示例作品')).toBeTruthy()
    expect(screen.queryByTestId('art-player')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '继续播放 S01E01' }))
    await waitFor(() => expect(screen.getByTestId('art-player')).toBeTruthy())
    const lastProps = artPlayerPropsMock.mock.calls.at(-1)![0]
    expect(lastProps.media.url).toBe('/api/media/videos/resolve?id=e1')
    // 身份原样来自那一行——从不透明 item id 反推会让每一集各自成一个"作品"。
    expect(lastProps.serverProgress.workKey).toBe('stream:work-1')
    expect(lastProps.serverProgress.epLabel).toBe('S01E01')
  })

  it('tmdb 行 → 落到 TMDb 作品详情页,「继续播放」走 ?key=', async () => {
    watchProgressListMock.mockResolvedValue([
      { key: 'tmdb:1:S03E02', workKey: 'tmdb:1', workTitle: '某剧', epLabel: 'S03E02', position: 754, duration: 3000, updatedAt: 2 },
    ])
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={noChannels}  onReload={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '某剧' }))
    fireEvent.click(await screen.findByRole('button', { name: '继续播放 S03E02' }))
    await waitFor(() => expect(screen.getByTestId('art-player')).toBeTruthy())
    const lastProps = artPlayerPropsMock.mock.calls.at(-1)![0]
    expect(lastProps.media.url).toBe('/api/media/videos/resolve?key=' + encodeURIComponent('tmdb:1:S03E02'))
    expect(lastProps.serverProgress.workKey).toBe('tmdb:1')
  })

  it('右键 →「从继续观看移除」:本地过滤掉这张卡,发 DELETE,不整体重拉', async () => {
    watchProgressListMock.mockResolvedValue([
      { key: 'tmdb:2', workKey: 'tmdb:2', workTitle: '某电影', position: 65, duration: 6000, updatedAt: 1 },
    ])
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={noChannels}  onReload={vi.fn()} />)
    const card = await screen.findByRole('button', { name: '某电影' })
    fireEvent.contextMenu(card)
    fireEvent.click(await screen.findByText('从继续观看移除'))
    await waitFor(() => expect(screen.queryByRole('button', { name: '某电影' })).toBeNull())
    expect(watchProgressRemoveMock).toHaveBeenCalledWith({ baseUrl: 'http://api' }, 'tmdb:2')
    expect(watchProgressListMock).toHaveBeenCalledTimes(1) // 只挂载时那一次,移除不重拉整段
  })

  it('空列表 → 整段不渲染', async () => {
    watchProgressListMock.mockResolvedValue([])
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={noChannels}  onReload={vi.fn()} />)
    await waitFor(() => expect(watchProgressListMock).toHaveBeenCalled())
    expect(screen.queryByText('继续观看')).toBeNull()
  })

  it('只拉这一屏的进度——儿童频道不该看见大人正在追的剧', async () => {
    watchProgressListMock.mockResolvedValue([])
    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'kids', label: '儿童', kind: 'video', present: 'video', space_id: 'default-space', streams: [] }]}  onReload={vi.fn()} />)
    await waitFor(() => expect(watchProgressListMock).toHaveBeenCalled())
    expect(watchProgressListMock).toHaveBeenCalledWith({ baseUrl: 'http://api' }, ['kids'])
  })

  it('播放时把「人在哪一屏」记进进度(channelId)', async () => {
    itemsMock.mockReset().mockResolvedValue([])
    watchProgressListMock.mockResolvedValue([
      { key: 'e1', workKey: 'stream:work-1', workTitle: '看到一半的作品', position: 100, duration: 3000, updatedAt: 1, channelId: 'kids' },
    ])
    render(
      <MovieChannel
        conn={{ baseUrl: 'http://api' }}
        channels={[{
          id: 'kids', label: '儿童', kind: 'video', present: 'video', space_id: 'default-space', streams: [{
            id: 'work-1', description: '示例作品', newCount: 0, sources: [], cadence_seconds: 1800, vault_subdir: 'work-1',
          }],
        }]} onReload={vi.fn()} />,
    )
    fireEvent.click(await screen.findByRole('button', { name: '看到一半的作品' }))
    fireEvent.click(await screen.findByRole('button', { name: '继续播放' }))
    await waitFor(() => expect(screen.getByTestId('art-player')).toBeTruthy())
    expect(artPlayerPropsMock.mock.calls.at(-1)![0].serverProgress).toMatchObject({ channelId: 'kids' })
  })
})

// 一次 Esc 只关一层 —— WorkDetail 之外的两个详情页同样得让开着的播放器拿走 Esc。
// 回归背景：这两页的 useEscape 漏了 `!playing` 门，播放中按 Esc 会同时关播放器和整个详情页
// （用户看到的是「退到一级页面」），而 WorkDetail 早就修对了——同一个 bug 修了一处漏两处。
describe('Esc 归属 — 播放器盖住的详情页交出 Esc(2026-07-24)', () => {
  const detailBody = (title: string) => ({
    detail: { metadata: { title }, images: {}, failures: [] },
    binding: {
      ref: { id: '1368337', media: 'movie' as const, title },
      binding: { id: 'b1', dirPath: '/movies/x', total: 1, matched: 1, playable: [{ leftKey: 'tmdb:1368337', title }] },
    },
  })

  // 播放器一挂载就去拉说话人 blocks——按 URL 分流，别让详情响应喂给它一个没有 blocks 的对象。
  const stubFetch = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(
    JSON.stringify(String(input).includes('/blocks') ? { blocks: [] } : body),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )))

  afterEach(() => { vi.unstubAllGlobals() })

  it('TmdbWorkDetail：播放中按 Esc 只关播放器，再按一次才离开详情页', async () => {
    window.history.replaceState(null, '', '/video/tmdb/movie/1368337')
    collectionItemsMock.mockResolvedValue([
      { key: 'tmdb:movie:1368337', kind: 'tmdb', domain: 'video', tmdbId: '1368337', media: 'movie', title: '奥德赛', poster: '/o.jpg', firstCollectedAt: 1 },
    ])
    stubFetch(detailBody('奥德赛'))

    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [] }]}  onReload={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: /播放/ }))
    await waitFor(() => expect(screen.getByTestId('art-player')).toBeTruthy())
    const path = window.location.pathname

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('art-player')).toBeNull())
    expect(window.location.pathname).toBe(path)

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(window.location.pathname).toBe('/video'))
  })

  it('RankingDetail：播放中按 Esc 只关播放器，再按一次才离开详情页', async () => {
    window.history.replaceState(null, '', '/video/item/rank-1')
    itemsMock.mockResolvedValue([{
      ...episode('rank-1', '痴迷'), stream_id: 'video-douban-playing',
      content: { archetype: 'gallery', text: '简介', meta: { source: 'douban', year: '2026' }, media: [{ kind: 'image', url: '/douban.jpg' }] },
    }])
    stubFetch(detailBody('痴迷'))

    render(<MovieChannel conn={{ baseUrl: 'http://api' }} channels={[{ id: 'videos', label: '影视', kind: 'video', present: 'video', space_id: 'default-space', streams: [{ id: 'video-douban-playing', description: '豆瓣 · 正在热映', sources: [], cadence_seconds: 1800, vault_subdir: 'playing' }] }]}  onReload={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: /播放/ }))
    await waitFor(() => expect(screen.getByTestId('art-player')).toBeTruthy())
    const path = window.location.pathname

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('art-player')).toBeNull())
    expect(window.location.pathname).toBe(path)

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(window.location.pathname).toBe('/video'))
  })
})
