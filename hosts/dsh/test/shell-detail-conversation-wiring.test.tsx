/**
 * 壳这一侧的**接线**：面板推过来的「主区被占满了」有没有真接到对话列的开合上，
 * 以及侧栏那段导航有没有真的交给面板的 `mountNav` 去画。
 *
 * 单测 controller 只证明"规则写对了"，证不了"有人调它"——这类漏接的症状是详情照常开、
 * 对话照常在，只是挤，没有任何一处会报错。所以这条测试从壳的真实渲染出发，只动
 * itemContext（面板唯一的那条推送通路），看几何状态跟不跟。
 *
 * 导航那半同理：树本身归面板（用例在 app 的 `nav/NavTree.test.tsx`），壳这边要钉的只有
 * "有没有挂、点一行有没有落到 `controller.pickRow`"——漏了照样是一片安静的空白。
 */
import { expect, test, vi, afterEach } from 'vitest'
import { act } from 'react'
import { cleanup, render } from '@testing-library/react'
import type { AskChatOp } from '../src/client/compose-into-conversation.ts'

vi.mock('../src/client/panel/host.ts', () => ({
  mountPanelInto: vi.fn(() => Promise.resolve({ unmount: () => {} })),
  mountNavInto: vi.fn(() => Promise.resolve({ unmount: () => {} })),
}))

const { makeStreamShell } = await import('../src/client/shell/StreamShell.tsx')
const { ShellLayoutController } = await import('../src/client/shell/layout-service.ts')
const { itemContext } = await import('../src/client/panel/item-context-store.ts')
const panelHost = await import('../src/client/panel/host.ts')

afterEach(() => { cleanup(); itemContext.clear() })

const ITEM = { id: 'i1', title: '一条' }

function renderShell(askChat: (op: AskChatOp) => Promise<void> = async () => {}): InstanceType<typeof ShellLayoutController> {
  vi.mocked(panelHost.mountPanelInto).mockClear()
  vi.mocked(panelHost.mountNavInto).mockClear()
  // 判"这格 key 注册过没有"在活体上是现取 `ctx.slots.entries('main')`；这里给一个认
  // 'plugins' 的替身，好让下面那条"选中全局面板"的用例有东西可选。
  const controller = new ShellLayoutController((id) => id === 'plugins')
  const Shell = makeStreamShell(controller, 'http://127.0.0.1:8900', () => {}, askChat)
  // 替身在 DOM 上留下槽名与 entryKey，好让下面按包含关系/判别键断言。
  const renderSlot = (key: string, _owner?: unknown, opts?: { entryKey?: string }): unknown =>
    <span data-slot={key} data-entry={opts?.entryKey ?? ''} />
  render(<Shell renderSlot={renderSlot as never} />)
  return controller
}

// 0.2.0 把中央区与右列都换成了 **root 作用域**的槽（`conversation`/`details` → keyed `main`
// 的保留键 + `rightbar`），于是旧那条"details 必须裹 SessionProvider"的守卫没有了对象。
// 取代它的静默坏法换成了两个，都在下面：
//  (1) 右列**必须常挂载**——`openRightbar` 是**占位者报告**，不挂载它就永远报不了，
//      列也就永远开不出来（0.1.2 是我们替它开，方向反了）；
//  (2) 对话走的是 keyed `main` 的保留键 `conversation`——漏了 entryKey，画出来的是别的
//      面板或一片空白，而槽本身"确实渲染了"。
test('右列常挂载（轨道为 0 时也画）：不挂载它就永远报不出 track', () => {
  const controller = renderShell()
  expect(controller.getSnapshot().rightbarTrack).toBe(false)
  expect(
    document.querySelector('[data-slot="rightbar"]'),
    '右列没挂载：占位者永远报不出 track，右列永远开不出来',
  ).not.toBeNull()
})

test('对话画在 keyed main 的保留键 conversation 上', () => {
  renderShell()
  expect(
    document.querySelector('[data-slot="main"][data-entry="conversation"]'),
    '对话没走 main 的保留键 conversation',
  ).not.toBeNull()
})

test('选中一个全局面板 → 中央区换成它；没选时中央区是我们的 Stream 主区', () => {
  const controller = renderShell()
  expect(document.querySelector('[data-slot="main"][data-entry="plugins"]')).toBeNull()
  act(() => { controller.selectPanel('plugins' as never) })
  expect(document.querySelector('[data-slot="main"][data-entry="plugins"]')).not.toBeNull()
})

test('面板报「详情开着」→ 对话列让位；报「关了」→ 回来', () => {
  const controller = renderShell()
  expect(controller.getSnapshot().conversationOpen).toBe(true)
  act(() => { itemContext.set({ open: ITEM, recent: [], fullscreen: true }) })
  expect(controller.getSnapshot().conversationOpen).toBe(false)
  act(() => { itemContext.set({ open: null, recent: [], fullscreen: false }) })
  expect(controller.getSnapshot().conversationOpen).toBe(true)
})

test('壳卸载时摘掉订阅——摘漏了，下一份壳会被上一份的推送遥控', () => {
  const controller = renderShell()
  cleanup()
  act(() => { itemContext.set({ open: ITEM, recent: [], fullscreen: true }) })
  expect(controller.getSnapshot().conversationOpen).toBe(true)
})

/** 壳递给面板的那个 askChat（mountPanelInto 的第 3 个参数）。 */
function handedToPanel(): (op: AskChatOp) => Promise<void> {
  const call = vi.mocked(panelHost.mountPanelInto).mock.calls.at(-1)
  if (call === undefined) throw new Error('面板还没挂上，拿不到 askChat')
  return call[2] as (op: AskChatOp) => Promise<void>
}

test('详情里点转成文字 → 对话列先露出来，那句话照样发下去', async () => {
  const sent: AskChatOp[] = []
  const controller = renderShell(async (op) => { sent.push(op) })
  act(() => { itemContext.set({ open: ITEM, recent: [], fullscreen: true }) })
  expect(controller.getSnapshot().conversationOpen).toBe(false)   // 详情把它收走了
  await act(async () => { await handedToPanel()({ kind: 'send', text: '转成文字' }) })
  expect(controller.getSnapshot().conversationOpen).toBe(true)
  expect(sent).toEqual([{ kind: 'send', text: '转成文字' }])
})

// 引用是塞进输入框、不发的——但"让位"这一步不能因此省掉：塞进了一个用户看不见的输入框，
// 和"什么都没发生"长得一模一样。
test('引用一条内容 → 对话列同样先露出来，op 原样递下去', async () => {
  const sent: AskChatOp[] = []
  const controller = renderShell(async (op) => { sent.push(op) })
  act(() => { itemContext.set({ open: ITEM, recent: [], fullscreen: true }) })
  expect(controller.getSnapshot().conversationOpen).toBe(false)
  await act(async () => { await handedToPanel()({ kind: 'ref-item', id: 'i1', label: '一条' }) })
  expect(controller.getSnapshot().conversationOpen).toBe(true)
  expect(sent).toEqual([{ kind: 'ref-item', id: 'i1', label: '一条' }])
})

test('发送失败照样抛给面板——面板那边要靠它弹 toast，吞了就成了"点了没反应"', async () => {
  const controller = renderShell(async () => { throw new Error('对话服务还没就位') })
  act(() => { itemContext.set({ open: ITEM, recent: [], fullscreen: true }) })
  await expect(handedToPanel()({ kind: 'send', text: '转成文字' })).rejects.toThrow('对话服务还没就位')
  // 露出来这一步在发送之前：发失败时用户看着的是那条会话 + 一句 toast，而不是一片没变化。
  expect(controller.getSnapshot().conversationOpen).toBe(true)
})

test('影视全屏看片：没有 item（open 恒 null）也要让位——壳读的是 fullscreen 不是 open', () => {
  const controller = renderShell()
  // 这正是看片那一档推过来的形状：主区被播放器占满，但没有任何一条 item 可引用。
  act(() => { itemContext.set({ open: null, recent: [], fullscreen: true }) })
  expect(controller.getSnapshot().conversationOpen).toBe(false)
  act(() => { itemContext.set({ open: null, recent: [], fullscreen: false }) })
  expect(controller.getSnapshot().conversationOpen).toBe(true)
})

test('侧栏不再有看板入口——看板已改回普通频道，不该再有侧栏特异入口', () => {
  renderShell()
  expect(document.querySelector('[data-stream-boards-entry]')).toBeNull()
})

// 导航树整棵归面板：壳只出一个容器 + 一次 mountNav。漏了这一步侧栏就是一片空白，
// 而面板照常在主区画着——没有任何一处会报错。
test('侧栏那段导航交给面板的 mountNav 去画，容器与后端地址原样递过去', () => {
  renderShell()
  expect(panelHost.mountNavInto).toHaveBeenCalledOnce()
  const [el, backend] = vi.mocked(panelHost.mountNavInto).mock.calls[0]!
  expect(el).toBeInstanceOf(HTMLElement)
  expect(backend).toBe('http://127.0.0.1:8900')
})

// 点频道行的布局联动（收起这一栏 / 让位）是**壳的**事，面板只报"点了哪一行"。
// 这条钉的就是那根线：面板报上来，controller.pickRow 有没有真被调到。
test('点一行频道 → 落到 controller.pickRow：点当前那行把这一栏收起来', () => {
  const controller = renderShell()
  const pick = vi.mocked(panelHost.mountNavInto).mock.calls[0]![2].onPickChannel
  expect(pick).toBeTypeOf('function')
  expect(controller.getSnapshot().streamOpen).toBe(true)
  act(() => { pick!(true) })
  expect(controller.getSnapshot().streamOpen).toBe(false)
})
