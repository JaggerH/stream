/**
 * `ctx.layout` 的服务契约（`ILayout`，ui-layout 0.2.0 版）。
 *
 * 这个服务是 ui-sidebar / ui-conversation / ui-sidebar-right 的**硬 inject 门**：缺一格
 * 成员，它们整个不装载——而表现是"那几块 UI 不见了"，没有一处会报错。所以每一格都要有
 * 一条钉着它的用例，尤其**0.2.0 新加的那三格**（`panelInfo` / `selectPanel` /
 * `beginNavigation`）和**语义被反过来那一格**（`openRightbar` 是报告不是命令）。
 *
 * 类型层（"真的 implements ILayout"）由 `tsc --noEmit` 执行，这里只管运行期语义。
 */
import { expect, test } from 'vitest'
import { ShellLayoutController } from '../src/client/shell/layout-service.ts'

test('selectPanel 记下选中的全局面板，panelInfo 跟着走', () => {
  const c = new ShellLayoutController(() => true)
  expect(c.panelInfo.getSnapshot().activePanelId).toBeNull()
  c.selectPanel('plugins' as never)
  expect(c.panelInfo.getSnapshot().activePanelId).toBe('plugins')
  c.selectPanel(null)
  expect(c.panelInfo.getSnapshot().activePanelId).toBeNull()
})

test('selectPanel 选一个没注册的 key 必须**抛**（契约要求），且不改动当前选择', () => {
  const c = new ShellLayoutController((id) => id === 'ok')
  c.selectPanel('ok' as never)
  // 静默记下一个没人渲染的 key，表现是"点了没反应"，而调用方拿不到任何反馈。
  expect(() => { c.selectPanel('nope' as never) }).toThrow()
  expect(c.panelInfo.getSnapshot().activePanelId).toBe('ok')
})

test('判"这个 key 注册过没有"是**现取**的——注册表随插件进出，存下来就冻住了那一刻的答案', () => {
  const registered = new Set<string>(['later'])
  const c = new ShellLayoutController((id) => registered.has(id as string))
  registered.add('arrived')
  c.selectPanel('arrived' as never)
  expect(c.panelInfo.getSnapshot().activePanelId).toBe('arrived')
})

test('panelInfo 的快照引用只在真变了的时候换——每次现拼新对象会让 useSyncExternalStore 无限重渲染', () => {
  const c = new ShellLayoutController(() => true)
  const first = c.panelInfo.getSnapshot()
  // 与面板无关的状态变化不许动这个引用。
  c.toggleSidebar()
  expect(c.panelInfo.getSnapshot()).toBe(first)
  // 相关的变化才换，而且换成一个新对象（值也跟着变）。
  c.selectPanel('x' as never)
  expect(c.panelInfo.getSnapshot()).not.toBe(first)
  expect(c.panelInfo.getSnapshot().activePanelId).toBe('x')
})

test('panelInfo 的订阅与 controller 自己的订阅同源（下面那排图标才会跟着重画）', () => {
  const c = new ShellLayoutController(() => true)
  let notified = 0
  const stop = c.panelInfo.subscribe(() => { notified += 1 })
  c.selectPanel('x' as never)
  expect(notified).toBe(1)
  stop()
  c.selectPanel(null)
  expect(notified).toBe(1)
})

test('beginNavigation 取代上一趟：先来的那趟信号被中止，回来的那趟不是', () => {
  const c = new ShellLayoutController()
  const first = c.beginNavigation()
  const second = c.beginNavigation()
  expect(first.aborted).toBe(true)
  expect(second.aborted).toBe(false)
})

test('dispose 把还挂着的那趟导航中止掉——它的 await 结束后不能接着动一个已经拆了的壳', () => {
  const c = new ShellLayoutController()
  const signal = c.beginNavigation()
  c.dispose()
  expect(signal.aborted).toBe(true)
})

test('dispose 之后再 beginNavigation 仍能拿到一个没被中止的信号（不是一次性开关）', () => {
  const c = new ShellLayoutController()
  c.dispose()
  expect(c.beginNavigation().aborted).toBe(false)
})

test('toggleSidebar 来回切（原壳那一格的语义没变）', () => {
  const c = new ShellLayoutController()
  expect(c.getSnapshot().sidebarCollapsed).toBe(false)
  c.toggleSidebar()
  expect(c.getSnapshot().sidebarCollapsed).toBe(true)
  c.toggleSidebar()
  expect(c.getSnapshot().sidebarCollapsed).toBe(false)
})
