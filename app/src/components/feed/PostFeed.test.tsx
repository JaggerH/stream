// PostFeed 是 layout 的唯一入口。两条:两种布局都必须渲染出**全部**条目(分列不能吞卡),
// 以及各自的结构标记要能区分开(App 的用例和以后的活体检查都靠它定位)。
// ResizeObserver 在 jsdom 里并不是"不存在"——vitest.setup.ts 用一个 no-op class 做了
// polyfill。真正起作用的是 jsdom 不跑真实布局、el.clientWidth/entry.contentRect 恒为 0：
// 这里测的是"宽度测不出来"时 columnCountFor(0) 兜到下界 2 这条路径，PostFeed.tsx 里
// `typeof ResizeObserver === 'undefined'` 那条 guard 没有任何测试会走到。
import { describe, it, expect, vi } from 'vitest'
import type { ReactElement } from 'react'
import { render as rtlRender, screen } from '@testing-library/react'
import { PostFeed } from './PostFeed.tsx'
import { assignColumns } from '../../lib/masonry.ts'
import type { Item } from '../../lib/types.ts'

const render = (ui: ReactElement, options?: Parameters<typeof rtlRender>[1]) => rtlRender(ui, options)

vi.mock('../../lib/masonry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/masonry.ts')>()
  return { ...actual, assignColumns: vi.fn(actual.assignColumns) }
})

const items: Item[] = Array.from({ length: 7 }, (_, i) => ({
  id: `i${i}`, stream_id: 's1', type: 'post', title: `标题${i}`,
  timestamp: '2026-07-29T00:00:00.000Z', fetched_at: '2026-07-29T00:00:00.000Z',
}) as Item)

const noop = () => {}
const renderFeed = (layout: 'list' | 'waterfall') =>
  render(
    <PostFeed
      items={items}
      layout={layout}
      channelId="default-timeline"
      onOpen={noop}
     
    />
  )

describe('PostFeed', () => {
  it('list 布局渲染全部条目,且不出现瀑布流容器', () => {
    const { container } = renderFeed('list')
    for (let i = 0; i < 7; i++) expect(screen.getByText(`标题${i}`)).toBeTruthy()
    expect(container.querySelector('[data-slot="post-feed-masonry"]')).toBeNull()
  })

  it('waterfall 布局渲染全部条目,一张不丢', () => {
    const { container } = renderFeed('waterfall')
    expect(container.querySelector('[data-slot="post-feed-masonry"]')).toBeTruthy()
    for (let i = 0; i < 7; i++) expect(screen.getByText(`标题${i}`)).toBeTruthy()
    expect(container.querySelectorAll('[data-item-id]').length).toBe(7)
  })

  it('waterfall 下每张卡恰好落在一列里', () => {
    const { container } = renderFeed('waterfall')
    const cols = container.querySelectorAll('[data-slot="post-feed-column"]')
    expect(cols.length).toBeGreaterThanOrEqual(2)
    const ids = [...cols].flatMap((c) => [...c.querySelectorAll('[data-item-id]')].map((n) => n.getAttribute('data-item-id')))
    // 先锁总数再锁去重后的集合大小：只判 Set 大小的话,一张卡被同时塞进两列(重复渲染)
    // 会让 ids 里出现两条相同 id,Set 折叠后仍然是 7,反而测不出"落在不止一列"这件事——
    // 加上 length===7 才能让"重复"和"丢卡"两种坏情况都必然触发失败。
    expect(ids.length).toBe(7)
    expect(new Set(ids).size).toBe(7)
  })

  it('空列表两种布局都不炸', () => {
    for (const layout of ['list', 'waterfall'] as const) {
      const { container } = render(
        <PostFeed items={[]} layout={layout} channelId="default-timeline" onOpen={noop} />
      )
      expect(container.querySelectorAll('[data-item-id]').length).toBe(0)
    }
  })

  it('切换布局时把滚动容器拉回顶部(两种布局的滚动位置没有对应关系),但同一 layout 重渲染不重复触发', () => {
    const scroller = document.createElement('div')
    scroller.setAttribute('data-slot', 'shell-content')
    document.body.appendChild(scroller)
    const scrollTo = vi.fn()
    Object.defineProperty(scroller, 'scrollTo', { value: scrollTo, writable: true })

    const { rerender } = render(
      <PostFeed items={items} layout="list" channelId="default-timeline" onOpen={noop} />,
      { container: scroller }
    )
    // 挂载时不该触发(见 PostFeed.tsx 里的注释:挂载时机和 App.tsx 恢复滚动位置的
    // useLayoutEffect 抢跑,会把刚恢复的位置冲掉)。
    expect(scrollTo).not.toHaveBeenCalled()

    rerender(
      <PostFeed items={items} layout="waterfall" channelId="default-timeline" onOpen={noop} />
    )
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 })

    // 同一个 layout 再渲染一次(比如 items 变了触发的重渲染)不该再拉一次顶——只有
    // layout 真的变化才触发,不是"没有 dep 数组"那种每次渲染都触发。
    scrollTo.mockClear()
    rerender(
      <PostFeed items={items.slice(0, 3)} layout="waterfall" channelId="default-timeline" onOpen={noop} />
    )
    expect(scrollTo).not.toHaveBeenCalled()

    scroller.remove()
  })

  // 切频道 + 布局跟着频道一起变(布局是按频道存的)时,这一下拉顶会把 App.tsx 刚在
  // useLayoutEffect 里恢复好的 scrollTop 冲掉——被动 effect 排在 layout effect 之后,
  // 同一次 commit 里必然是它赢。挂载那一次早就守住了,切频道是同一个碰撞的另一副面孔。
  it('切频道且新频道的布局不同时不拉顶(滚动位置归 App 的按频道记忆管)', () => {
    const scroller = document.createElement('div')
    scroller.setAttribute('data-slot', 'shell-content')
    document.body.appendChild(scroller)
    const scrollTo = vi.fn()
    Object.defineProperty(scroller, 'scrollTo', { value: scrollTo, writable: true })

    const { rerender } = render(
      <PostFeed items={items} layout="list" channelId="default-timeline" onOpen={noop} />,
      { container: scroller }
    )
    // 时间线(list) → hn(waterfall)：layout 和 channelId 在同一次 commit 里一起变
    rerender(
      <PostFeed items={items} layout="waterfall" channelId="hn" onOpen={noop} />
    )
    expect(scrollTo).not.toHaveBeenCalled()
    // 反方向同样(回到时间线也要还原它自己记住的位置)
    rerender(
      <PostFeed items={items} layout="list" channelId="default-timeline" onOpen={noop} />
    )
    expect(scrollTo).not.toHaveBeenCalled()

    // 但留在同一个频道里手动按布局开关,照常拉顶——上面的守卫不能把这条一起关掉。
    rerender(
      <PostFeed items={items} layout="waterfall" channelId="default-timeline" onOpen={noop} />
    )
    expect(scrollTo).toHaveBeenCalledTimes(1)

    scroller.remove()
  })

  it('waterfall 追加条目:已经上屏的卡片列序号不因追加而挪位(见 masonry.ts 的增量追加约定)', () => {
    // 高度差异明显的 metrics 组合:有图的(且比例出带、被夹到 MEDIA_RATIO_MAX)、纯文字短的、
    // 纯文字长的——让贪心分列在"从零重算"和"接着上次的高度算"之间一旦轨迹不同就必然
    // 分流到不同列,而不是凑巧撞在一起。
    const tallImage = (id: string): Partial<Item> => ({
      content: { media: [{ kind: 'image', url: `https://x/${id}.jpg`, w: 200, h: 2000 }] } as Item['content'],
    })
    const longText = (id: string): Partial<Item> => ({
      content: { text: `${id} `.repeat(60) } as Item['content'],
    })
    const shortText = (): Partial<Item> => ({ content: { text: '短' } as Item['content'] })

    const makeItems = (n: number, offset = 0): Item[] =>
      Array.from({ length: n }, (_, i) => {
        const idx = i + offset
        const id = `w${idx}`
        const shape = [tallImage, longText, shortText][idx % 3](id)
        return {
          id, stream_id: 's1', type: 'post', title: `瀑布${idx}`,
          timestamp: '2026-07-29T00:00:00.000Z', fetched_at: '2026-07-29T00:00:00.000Z',
          ...shape,
        } as Item
      })

    const initial = makeItems(6)
    const { container, rerender } = render(
      <PostFeed items={initial} layout="waterfall" channelId="default-timeline" onOpen={noop} />
    )

    const columnOf = (root: ParentNode) => {
      const cols = root.querySelectorAll('[data-slot="post-feed-column"]')
      const map = new Map<string, number>()
      cols.forEach((col, i) => {
        col.querySelectorAll('[data-item-id]').forEach((n) => map.set(n.getAttribute('data-item-id')!, i))
      })
      return map
    }

    const before = columnOf(container)
    expect(before.size).toBe(6)

    const appended = makeItems(3, 6)
    const merged = [...initial, ...appended]
    rerender(
      <PostFeed items={merged} layout="waterfall" channelId="default-timeline" onOpen={noop} />
    )
    const after = columnOf(container)

    for (const item of initial) expect(after.get(item.id)).toBe(before.get(item.id))
    for (const item of appended) expect(after.has(item.id)).toBe(true)

    // 上面这段"列序号不变"的断言，在本测试环境里其实对 `prevRef.current = state` 这一行
    // 被删掉不敏感：assignColumns 是贪心左折叠，只要 colCount/colWidth 不变（这里两者
    // 全程恒定，jsdom 测不出真实宽度），"从头整段重算"和"接着上次高度往后追加"在数学上
    // 输出完全相同的列分配——删掉那一行，PostFeed 每次都会传 prev=undefined 强制整段重算，
    // 但重算结果和增量结果字节相同，上面的断言仍然会通过，抓不出这个回归。
    // 真正被 ref 撑住的是：assignColumns 收到的 prev 参数从"有值"退化成"永远 undefined"，
    // 即 canAppend 分支从此再也走不到——这一点只能靠下面这条对调用参数的断言来钉住。
    const calls = vi.mocked(assignColumns).mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(2)
    const lastCall = calls[calls.length - 1]
    const prevArg = lastCall[3]
    expect(prevArg).toBeTruthy()
    expect(prevArg?.itemCount).toBe(initial.length)
  })
})
