/**
 * 面板内容区的频道切换。两件事：切换把分页整批重来、上一个频道的在途请求落不进新频道。
 *
 * **这棵树里没有频道切换条**：切频道归导航（`mountNav` 那个挂载点，见 nav/NavTree.tsx），
 * 内容区只是 `channelStore` 的一个读者。所以这里一律用 `channelStore.setActive` 触发切换——
 * 那就是导航点一行之后发生的事，没有第二条路径。
 */
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { StreamPanel } from './StreamPanel.tsx'
import { panelSupportsChannel, orderChannels } from './nav/support.ts'
import { channelStore } from './nav/channel-store.ts'
import { api } from '../lib/api.ts'
import { DEFAULT_TIMELINE_CHANNEL_ID, type ChannelView, type Item } from '../lib/types.ts'

beforeEach(() => {
  // 名录/当前频道住在模块级 store（见 nav/channel-store.ts），跨用例活着——不清就是上一条
  // 用例切到的频道漏进下一条，这一整组关于"切频道"的断言全都会读到别人的起点。
  channelStore.reset()
  vi.spyOn(api, 'enrich').mockResolvedValue({ comments: [], total: 0 })
})

function channel(id: string, label: string, present: ChannelView['present'], system = false): ChannelView {
  return { id, label, present, system, kind: 'timeline', streams: [], space_id: 'default-space' } as ChannelView
}

// 「阅读」是第二个 **timeline** 频道，下面切换/分页那几条都拿它当落点：`audio` 档在壳态下画的
// 是歌单视图（MusicChannel，见 StreamPanel.music.test.tsx），压根不走 PostFeed 这条分页路径——
// 拿它当落点等于把这几条用例挪到一条不存在的路上，它们守的东西就没人守了。
const CHANNELS = [
  channel('default-audio', '音乐/播客', 'audio', true),
  channel(DEFAULT_TIMELINE_CHANNEL_ID, '时间线', 'timeline', true),
  channel('default-video', '影视', 'video', true),
  channel('default-search', '资源搜索', 'search', true),
  channel('reading', '阅读', 'timeline'),
  channel('kids', '儿童', 'video'),
]

function item(id: string, title: string): Item {
  return {
    id,
    stream_id: 'panel-test',
    type: 'post',
    title,
    url: `https://example.com/${id}`,
    timestamp: '2026-08-17T00:00:00Z',
    fetched_at: '2026-08-17T00:00:00Z',
    published_at: '2026-08-17T00:00:00Z',
  } as Item
}

function scrollNearBottom(el: HTMLElement) {
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true })
  el.scrollTop = 950
  fireEvent.scroll(el)
}

test('判据本身：timeline/audio/video 受理，search 不受理', () => {
  expect(panelSupportsChannel(channel('a', 'A', 'timeline'))).toBe(true)
  expect(panelSupportsChannel(channel('b', 'B', 'audio'))).toBe(true)
  expect(panelSupportsChannel(channel('c', 'C', 'video'))).toBe(true)
  expect(panelSupportsChannel(channel('d', 'D', 'search'))).toBe(false)
})

test('时间线排头，系统频道在自建频道前面', () => {
  expect(orderChannels(CHANNELS).map((c) => c.id))
    .toEqual([DEFAULT_TIMELINE_CHANNEL_ID, 'default-audio', 'default-video', 'default-search', 'reading', 'kids'])
})

// 「不支持的频道灰着列出来、点不动」是导航那一层的事，钉在 nav/NavTree.test.tsx；这里只钉
// 内容区这一侧的第二道闸：切给它一个伺候不了的频道，它不动、也不去取。
test('切到面板伺候不了的频道：静默不动，不发取数', async () => {
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [item('a', '第一条')] })
  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('第一条')).toBeTruthy())

  const before = vi.mocked(api.channelItems).mock.calls.length
  act(() => { channelStore.setActive('default-search') })
  expect(channelStore.getSnapshot().active).toBe(DEFAULT_TIMELINE_CHANNEL_ID)
  expect(vi.mocked(api.channelItems).mock.calls.length).toBe(before)
})

test('切频道用新频道的 id 从第一页重取，且不带上一个频道的 cursor', async () => {
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  vi.spyOn(api, 'channelItems').mockImplementation(async (_c, id) =>
    id === DEFAULT_TIMELINE_CHANNEL_ID
      ? { items: [item('t1', '时间线的条目')], next_cursor: 'timeline-cursor' }
      : { items: [item('a1', '阅读的条目')] })
  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('时间线的条目')).toBeTruthy())

  act(() => { channelStore.setActive('reading') })

  await waitFor(() => expect(screen.getByText('阅读的条目')).toBeTruthy())
  // 上一个频道的内容必须消失：两个频道的条目混在一列里，读的人无从分辨。
  expect(screen.queryByText('时间线的条目')).toBeNull()
  expect(api.channelItems).toHaveBeenLastCalledWith(expect.anything(), 'reading', { limit: 60 })
})

// 这一条是**这次改动的主要风险**：游标属于频道，一次在途的续页带回来的是上一个频道的
// 内容和游标。没有那道序号闸，它会 append 进新频道的列表（内容混），并把新频道的游标
// 覆盖成旧频道的（接着分页从别处继续）——两样都不会报错，只是内容悄悄错了。
test('上一个频道在途的续页迟到落地时，整页丢掉：不混进新频道，也不覆盖它的游标', async () => {
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  let resolveStale!: (v: { items: Item[]; next_cursor?: string }) => void
  const stale = new Promise<{ items: Item[]; next_cursor?: string }>((r) => { resolveStale = r })
  vi.spyOn(api, 'channelItems')
    // 1) 时间线第一页（带 cursor，好让滚到底能发续页）
    .mockResolvedValueOnce({ items: [item('t1', '时间线的条目')], next_cursor: 'timeline-cursor' })
    // 2) 时间线的续页——挂起，等切完频道再 resolve
    .mockReturnValueOnce(stale)
    // 3) 阅读第一页（没有 next_cursor：这个频道到底了，不该再有任何续页）
    .mockResolvedValueOnce({ items: [item('a1', '阅读的条目')] })

  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('时间线的条目')).toBeTruthy())

  scrollNearBottom(screen.getByTestId('panel-scroll'))
  await waitFor(() => expect(api.channelItems).toHaveBeenCalledTimes(2))

  act(() => { channelStore.setActive('reading') })
  await waitFor(() => expect(screen.getByText('阅读的条目')).toBeTruthy())

  // 迟到的那一页现在才回来，还带着一个新游标
  resolveStale({ items: [item('t2', '时间线的第二页')], next_cursor: 'stale-cursor' })
  await waitFor(() => expect(screen.getByText('阅读的条目')).toBeTruthy())

  expect(screen.queryByText('时间线的第二页')).toBeNull() // 内容没混进来
  // 游标没被覆盖：阅读频道首页没给 next_cursor = 已到底，再滚也不该发第四个请求。
  scrollNearBottom(screen.getByTestId('panel-scroll'))
  await new Promise((r) => setTimeout(r, 0))
  expect(api.channelItems).toHaveBeenCalledTimes(3)
})

// 同一道闸的另一半：迟到的是上一个频道的**第一页**（用户在首页还没回来时就切走了）。
// 没有闸，它会把新频道的列表整批替换掉，并把游标换成旧频道的。
test('上一个频道在途的首页迟到落地时，不覆盖新频道的列表和游标', async () => {
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  let resolveStale!: (v: { items: Item[]; next_cursor?: string }) => void
  const stale = new Promise<{ items: Item[]; next_cursor?: string }>((r) => { resolveStale = r })
  vi.spyOn(api, 'channelItems')
    .mockReturnValueOnce(stale)                                     // 时间线首页：挂起
    .mockResolvedValueOnce({ items: [item('a1', '阅读的条目')] })     // 阅读首页：已到底

  render(<StreamPanel />)
  // 名录到货前 setActive 不受理任何 id（判据在 store 里），所以先等名录。
  await waitFor(() => expect(channelStore.getSnapshot().channels.length).toBe(6))
  act(() => { channelStore.setActive('reading') })
  await waitFor(() => expect(screen.getByText('阅读的条目')).toBeTruthy())

  resolveStale({ items: [item('t1', '时间线的条目')], next_cursor: 'stale-cursor' })
  await new Promise((r) => setTimeout(r, 0))

  expect(screen.queryByText('时间线的条目')).toBeNull()
  expect(screen.getByText('阅读的条目')).toBeTruthy()
  scrollNearBottom(screen.getByTestId('panel-scroll'))
  await new Promise((r) => setTimeout(r, 0))
  expect(api.channelItems).toHaveBeenCalledTimes(2) // 没有继承旧频道的游标去发续页
})

// 单飞标志也归"这一轮"：旧频道那次续页收尾时若无差别地把标志清成 false，新频道正在途的
// 那次续页就被解锁了，同一页会取两遍（后一遍还会被去重逻辑吃掉——看不出来，只是白打一次）。
test('旧频道续页收尾不解锁新频道在途的续页', async () => {
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  let resolveStale!: (v: { items: Item[]; next_cursor?: string }) => void
  const stale = new Promise<{ items: Item[]; next_cursor?: string }>((r) => { resolveStale = r })
  const pendingReadingMore = new Promise<{ items: Item[]; next_cursor?: string }>(() => {})
  vi.spyOn(api, 'channelItems')
    .mockResolvedValueOnce({ items: [item('t1', '时间线的条目')], next_cursor: 't-c1' })
    .mockReturnValueOnce(stale)                                                        // 旧频道续页，挂起
    .mockResolvedValueOnce({ items: [item('a1', '阅读第一页')], next_cursor: 'a-c1' })
    .mockReturnValueOnce(pendingReadingMore)                                           // 新频道续页，永远挂起

  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('时间线的条目')).toBeTruthy())
  scrollNearBottom(screen.getByTestId('panel-scroll'))
  await waitFor(() => expect(api.channelItems).toHaveBeenCalledTimes(2))

  act(() => { channelStore.setActive('reading') })
  await waitFor(() => expect(screen.getByText('阅读第一页')).toBeTruthy())
  scrollNearBottom(screen.getByTestId('panel-scroll'))
  await waitFor(() => expect(api.channelItems).toHaveBeenCalledTimes(4))

  resolveStale({ items: [item('t2', '时间线第二页')] }) // 旧频道那次收尾
  await new Promise((r) => setTimeout(r, 0))
  scrollNearBottom(screen.getByTestId('panel-scroll'))
  await new Promise((r) => setTimeout(r, 0))
  expect(api.channelItems).toHaveBeenCalledTimes(4) // 新频道那次仍在途，没有被解锁重发
})

test('新频道的续页仍然照常工作（闸门没把正常路径一起关掉）', async () => {
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  vi.spyOn(api, 'channelItems')
    .mockResolvedValueOnce({ items: [item('t1', '时间线的条目')] })
    .mockResolvedValueOnce({ items: [item('a1', '阅读第一页')], next_cursor: 'reading-c1' })
    .mockResolvedValueOnce({ items: [item('a2', '阅读第二页')] })
  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('时间线的条目')).toBeTruthy())

  act(() => { channelStore.setActive('reading') })
  await waitFor(() => expect(screen.getByText('阅读第一页')).toBeTruthy())

  scrollNearBottom(screen.getByTestId('panel-scroll'))
  await waitFor(() => expect(screen.getByText('阅读第二页')).toBeTruthy())
  expect(api.channelItems).toHaveBeenNthCalledWith(
    3, expect.anything(), 'reading', { limit: 60, cursor: 'reading-c1' }
  )
})

// 一个频道读不出来，用户唯一的出路是切到别的频道去——导航是另一棵树，内容区这一侧的错误
// 页盖不住它，所以切过去必须真的把错误页换掉。
test('取数失败之后切到别的频道能救回来', async () => {
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  vi.spyOn(api, 'channelItems')
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValueOnce({ items: [item('a1', '阅读的条目')] })
  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByTestId('panel-error').textContent).toContain('boom'))

  await waitFor(() => expect(channelStore.getSnapshot().channels.length).toBe(6))
  act(() => { channelStore.setActive('reading') })
  await waitFor(() => expect(screen.getByText('阅读的条目')).toBeTruthy())
  expect(screen.queryByTestId('panel-error')).toBeNull()
})

// 名录是"能切到哪"，不是"这一页画什么"。拉不到名录只该让导航空着，不该让内容区变白板。
test('名录拉不到：默认时间线照常读出来', async () => {
  vi.spyOn(api, 'channels').mockRejectedValue(new Error('名录挂了'))
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [item('t1', '时间线的条目')] })
  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('时间线的条目')).toBeTruthy())
})

// 导航归面板之后，内容区里再也没有第二份频道切换器——两处的选中态曾经只会互相说谎。
test('内容区不画任何频道切换条', async () => {
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [] })
  render(<StreamPanel />)
  await waitFor(() => expect(channelStore.getSnapshot().channels.length).toBe(6))
  expect(screen.queryByTestId('panel-channel-bar')).toBeNull()
  expect(screen.queryByRole('tablist', { name: '频道' })).toBeNull()
})
