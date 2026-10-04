import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { StreamPanel } from './StreamPanel.tsx'
import { api } from '../lib/api.ts'
import { detailBundle } from './detailBundle.ts'
import { DEFAULT_TIMELINE_CHANNEL_ID } from '../lib/types.ts'
import type { Item } from '../lib/types.ts'

// 详情里那条 source-blind 的富化（正文/评论）会真发请求；面板测试不验它，统一按"没有可富化的"
// 应答，免得每条用例各挂一次。
//
// detailBundle.load 在生产里是真的网络脚本加载（第二个 IIFE，见 detailBundle.ts 头注），
// jsdom 不会真的取网执行 <script src>。测试换成直接 import 源码级的 detail-entry.tsx——
// 跳过网络加载这一层壳，mount/unmount 本身仍是真实实现，不是自造的假的。
beforeEach(async () => {
  vi.spyOn(api, 'enrich').mockResolvedValue({ comments: [], total: 0 })
  const detailEntry = await import('./detail-entry.tsx')
  vi.spyOn(detailBundle, 'load').mockResolvedValue(detailEntry)
})

function item(id: string, title: string): Item {
  // stream_id/type/timestamp/fetched_at 都是 Item 的必填字段，brief 原始 fixture 漏了它们：
  // stream_id 缺失会在渲染期让 PostCard 的 enrich 分支（isBili 等）抛 TypeError（无空值兜底），
  // 其余三个是纯类型层面的必填，tsc 会直接拒绝 `as Item` 的类型断言。
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

// jsdom 不排版，scrollHeight/clientHeight 恒为 0——手动定义成"已经滚到底"，
// 复用 App.tsx onListScroll 的同一条判据（scrollHeight - scrollTop - clientHeight < clientHeight）。
function scrollNearBottom(el: HTMLElement) {
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true })
  el.scrollTop = 950
  fireEvent.scroll(el)
}

test('拉到 items 就把它们画成瀑布流卡', async () => {
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [item('a', '第一条'), item('b', '第二条')] })
  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('第一条')).toBeTruthy())
  expect(screen.getByText('第二条')).toBeTruthy()
  expect(api.channelItems).toHaveBeenCalledWith(expect.anything(), DEFAULT_TIMELINE_CHANNEL_ID, { limit: 60 })
})

// 面板活在别人的页面里，取数失败必须**看得见**：一块什么都没有的白板和"后端没起"
// 长得一模一样，而这一针的全部目的就是读数——读不到就得说出来。
test('取数失败画出可读的错，而不是空白', async () => {
  vi.spyOn(api, 'channelItems').mockRejectedValue(new Error('boom'))
  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByTestId('panel-error').textContent).toContain('boom'))
})

test('滚到底带着上一页的 cursor 取下一页并追加，不是替换', async () => {
  vi.spyOn(api, 'channelItems')
    .mockResolvedValueOnce({ items: [item('a', '第一条')], next_cursor: 'c1' })
    .mockResolvedValueOnce({ items: [item('b', '第二条')] })
  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('第一条')).toBeTruthy())

  scrollNearBottom(screen.getByTestId('panel-scroll'))

  await waitFor(() => expect(screen.getByText('第二条')).toBeTruthy())
  expect(screen.getByText('第一条')).toBeTruthy() // 追加，不是替换
  expect(api.channelItems).toHaveBeenNthCalledWith(
    2, expect.anything(), DEFAULT_TIMELINE_CHANNEL_ID, { limit: 60, cursor: 'c1' }
  )
})

test('一次续页在途时再次滚到底不发第二个请求', async () => {
  let resolveSecond!: (v: { items: Item[]; next_cursor?: string }) => void
  const second = new Promise<{ items: Item[]; next_cursor?: string }>((resolve) => { resolveSecond = resolve })
  vi.spyOn(api, 'channelItems')
    .mockResolvedValueOnce({ items: [item('a', '第一条')], next_cursor: 'c1' })
    .mockReturnValueOnce(second)
  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('第一条')).toBeTruthy())

  const scroller = screen.getByTestId('panel-scroll')
  scrollNearBottom(scroller) // 发出第 2 个请求，挂起未 resolve
  await waitFor(() => expect(api.channelItems).toHaveBeenCalledTimes(2))
  scrollNearBottom(scroller) // 在途中再滚一次
  expect(api.channelItems).toHaveBeenCalledTimes(2) // 没有变成 3

  resolveSecond({ items: [item('b', '第二条')] })
  await waitFor(() => expect(screen.getByText('第二条')).toBeTruthy())
})

/** 带正文的图文条目：详情里能看见的那句正文就是这一格。 */
function textItem(id: string, title: string, body: string): Item {
  return { ...item(id, title), content: { archetype: 'text', text: body } } as Item
}

test('点一张卡开出这条的详情，正文画在里面', async () => {
  vi.spyOn(api, 'channelItems').mockResolvedValue({
    items: [textItem('a', '第一条', '第一条的正文'), textItem('b', '第二条', '第二条的正文')],
  })
  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('第二条')).toBeTruthy())

  fireEvent.click(screen.getByText('第二条'))

  // 详情是自带 role=dialog 的那一层；开的必须是**被点的那条**，不是列表第一条。
  await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('第二条的正文')
  expect(dialog.textContent).not.toContain('第一条的正文')
})

test('关掉详情回到列表，列表原样还在、不重新拉一遍', async () => {
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [textItem('a', '第一条', '第一条的正文')] })
  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('第一条')).toBeTruthy())

  fireEvent.click(screen.getByText('第一条'))
  await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: '返回' }))

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByTestId('panel-scroll')).toBeTruthy()
  expect(screen.getByText('第一条')).toBeTruthy()
  // 列表整棵树一直挂着（详情盖在它上面），所以关闭不该触发第二次取数——
  // 真去重拉一遍的表现是：滚了半天的位置和已经翻出来的好几页一起没了。
  expect(api.channelItems).toHaveBeenCalledTimes(1)
})

test('开详情把面板加宽，关掉退回 420px', async () => {
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [textItem('a', '第一条', '第一条的正文')] })
  const widths: string[] = []
  render(<StreamPanel onWidthChange={(w) => widths.push(w)} />)
  await waitFor(() => expect(screen.getByText('第一条')).toBeTruthy())
  expect(widths.at(-1)).toBe('420px') // 挂载即报一次基准宽度

  fireEvent.click(screen.getByText('第一条'))
  await waitFor(() => expect(widths.at(-1)).not.toBe('420px'))
  const opened = widths.at(-1)!

  fireEvent.click(screen.getByRole('button', { name: '返回' }))
  await waitFor(() => expect(widths.at(-1)).toBe('420px'))
  expect(opened).not.toBe('420px')
})

test('到底（next_cursor 缺失）之后再滚不会继续发请求', async () => {
  vi.spyOn(api, 'channelItems').mockResolvedValueOnce({ items: [item('a', '第一条')] }) // 首页即到底
  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('第一条')).toBeTruthy())

  scrollNearBottom(screen.getByTestId('panel-scroll'))
  await new Promise((r) => setTimeout(r, 0))
  expect(api.channelItems).toHaveBeenCalledTimes(1) // 仍然只有首页那一次
})

// 详情那层 `transform` 是**承重的**：靠它成为 `Detail` 那个 `fixed inset-0` 的包含块，
// 详情才关得在面板这一列里；没有它就盖住 DSH 整页。
// jsdom 不做布局，验不了这个**效果**——但验得了它**还在不在**。这条挡的是"后面某次重构
// 顺手把这层 div 或这个 class 删了"，而那种删除在单测里不会有任何一处变红。
test('详情外面那层 transform 包装还在——它是把 fixed 关进面板的唯一依据', async () => {
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [textItem('a', '第一条', '第一条的正文')] })
  const { container } = render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('第一条')).toBeTruthy())

  fireEvent.click(screen.getByText('第一条'))
  await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())

  const wrapper = container.querySelector('[class*="translateZ"]')
  expect(wrapper).not.toBeNull()
  expect(wrapper!.contains(screen.getByRole('dialog'))).toBe(true) // 包装层必须真的包着详情
})

// 详情是第二个独立打包的 IIFE bundle（见 detailBundle.ts），装它是一次真的网络请求，
// 会失败。失败必须**看得见**：一块盖住列表的空白和"面板挂了"长得一模一样。
test('详情 bundle 装不上，画出可读的错，而不是空白', async () => {
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [textItem('a', '第一条', '第一条的正文')] })
  vi.spyOn(detailBundle, 'load').mockRejectedValue(new Error('详情 bundle 加载失败'))
  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('第一条')).toBeTruthy())

  fireEvent.click(screen.getByText('第一条'))

  await waitFor(() => expect(screen.getByText(/详情加载失败/)).toBeTruthy())
  expect(screen.getByText(/详情 bundle 加载失败/)).toBeTruthy()
})

// 装 bundle 是异步的：面板（或整个工作台）可能在它装完之前就被卸载。没有 cancelled
// 这道闸，迟到的 mount 会在组件树已经不在了之后才发生。这条不是防"崩溃"（React 对
// 卸载后 setState 已经有告警/兜底），是防"迟到的挂载真的把详情画出来了"——那是比崩溃
// 更隐蔽的一种错：没有任何报错，只是多出一份没人能再关掉的 DOM。
test('组件在详情 bundle 还没装完时整体卸载，迟到的 mount 不会落地', async () => {
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [textItem('a', '第一条', '第一条的正文')] })
  let resolveLoad!: (v: Awaited<ReturnType<typeof detailBundle.load>>) => void
  const pending = new Promise<Awaited<ReturnType<typeof detailBundle.load>>>((resolve) => { resolveLoad = resolve })
  const mountSpy = vi.fn()
  vi.spyOn(detailBundle, 'load').mockReturnValue(pending)

  const { unmount } = render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('第一条')).toBeTruthy())
  fireEvent.click(screen.getByText('第一条'))
  await waitFor(() => expect(screen.getByText('加载中…')).toBeTruthy())

  unmount()
  resolveLoad({ mount: mountSpy, unmount: vi.fn() })
  await Promise.resolve()
  expect(mountSpy).not.toHaveBeenCalled()
})
