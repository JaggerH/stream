import { beforeEach, expect, test, vi } from 'vitest'
import { mountNavInto, mountPanelInto } from '../src/client/panel/host.ts'
import { itemContext } from '../src/client/panel/item-context-store.ts'

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  delete (globalThis as Record<string, unknown>).__streamPanel
})

/** 装 <script> 的浏览器行为 jsdom 不跑，测试里手动兑现"脚本加载完了"这一步。 */
function fulfilScript(
  mount = vi.fn(),
  unmount = vi.fn(),
  mountNav = vi.fn(),
  unmountNav = vi.fn(),
): { mount: typeof mount; mountNav: typeof mountNav; unmountNav: typeof unmountNav } {
  const el = document.querySelector('script[data-stream-panel]')
  ;(globalThis as Record<string, unknown>).__streamPanel = { mount, unmount, mountNav, unmountNav }
  el?.dispatchEvent(new Event('load'))
  return { mount, mountNav, unmountNav }
}

/** 脚本 load 了，但导出的是一份**没有导航挂载点**的老 bundle（后端比插件旧）。 */
function fulfilOldScript(): void {
  const el = document.querySelector('script[data-stream-panel]')
  ;(globalThis as Record<string, unknown>).__streamPanel = { mount: vi.fn(), unmount: vi.fn() }
  el?.dispatchEvent(new Event('load'))
}

function container(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

test('挂一次：样式表、脚本各一份，mount 收到调用方的容器与后端地址', async () => {
  const el = container()
  const p = mountPanelInto(el, 'http://127.0.0.1:8900')
  const { mount } = fulfilScript()
  await p
  expect(document.querySelectorAll('link[data-stream-panel]')).toHaveLength(1)
  expect(document.querySelectorAll('script[data-stream-panel]')).toHaveLength(1)
  // onItemContext 必须在：`@` 引用的候选全靠面板经它推过来，漏了它这条路整条是哑的
  // （打 @ 一条候选都没有，而且没有任何一处会报错）。
  expect(mount).toHaveBeenCalledWith(
    el,
    { backend: 'http://127.0.0.1:8900', manageWidth: false, onItemContext: itemContext.set },
  )
})

// 导航是**第二个挂载点**，走同一份 loader：脚本仍然只装一份，opts 原样递给 bundle。
test('挂导航：脚本复用同一份，mountNav 收到容器、后端地址与 opts', async () => {
  const el = container()
  const p = mountNavInto(el, 'http://127.0.0.1:8900', { onPickChannel: () => {}, collapsible: true })
  const { mountNav } = fulfilScript()
  await p
  expect(document.querySelectorAll('script[data-stream-panel]')).toHaveLength(1)
  expect(mountNav).toHaveBeenCalledOnce()
  const [gotEl, opts] = mountNav.mock.calls[0]! as [HTMLElement, { backend: string; collapsible?: boolean }]
  expect(gotEl).toBe(el)
  expect(opts.backend).toBe('http://127.0.0.1:8900')
  expect(opts.collapsible).toBe(true)
})

// 导航**不碰样式表**：它自己的样式由 bundle 注一份 <style>，而 panel.css 的生命周期
// 跟着内容区那一次挂载走。两边都摘一次的话，内容区还挂着就已经没样式了。
test('挂导航不种 panel.css，卸导航也不摘走内容区的那份', async () => {
  const p = mountPanelInto(container(), 'http://127.0.0.1:8900')
  fulfilScript()
  await p
  expect(document.querySelectorAll('link[data-stream-panel]')).toHaveLength(1)
  const nav = await mountNavInto(container(), 'http://127.0.0.1:8900', { onPickChannel: () => {} })
  expect(document.querySelectorAll('link[data-stream-panel]')).toHaveLength(1)
  nav.unmount()
  expect(document.querySelectorAll('link[data-stream-panel]')).toHaveLength(1)
})

// 后端比插件旧（panel bundle 还没有导航挂载点）：这里必须**说人话**。静默 no-op 的表现
// 是侧栏一片空白，和"后端挂了"、"样式没加载"长得一模一样。
test('老 bundle 没有 mountNav：报一句说得清的错，不静默留空白', async () => {
  const p = mountNavInto(container(), 'http://127.0.0.1:8900', { onPickChannel: () => {} })
  fulfilOldScript()
  await expect(p).rejects.toThrow(/导航/)
})

// 样式表跟着挂载走、脚本是全局单例：unmount 摘样式表，重挂必须能把它种回去,
// 且脚本不重装（loadOnce 的 bundle() 早退分支仍生效）。曾经的坑：补种挂在早退分支
// 背后，重挂之后页面停在没样式的样子直到整页刷新。
test('卸了再挂：样式表能重新种回去，脚本不会被重装', async () => {
  const p = mountPanelInto(container(), 'http://127.0.0.1:8900')
  fulfilScript()
  const { unmount } = await p
  unmount()
  expect(document.querySelectorAll('link[data-stream-panel]')).toHaveLength(0)

  await mountPanelInto(container(), 'http://127.0.0.1:8900')
  expect(document.querySelectorAll('link[data-stream-panel]')).toHaveLength(1)
  expect(document.querySelectorAll('script[data-stream-panel]')).toHaveLength(1)
})

// 后端没起 → 第一次挂载合理地 reject；起起来再挂第二次该正常成功。曾经的坑：失败留下的
// <script> 是具尸体——真实浏览器里一个已经 fire 过 error 的 <script> 不会再 fire load、
// 也不会重试 src。下一次 loadOnce 若撞见这具尸体走进"已有 script"分支，会把新监听挂到
// 一个再也不会 settle 的元素上——重试永久 pending，只能刷新整页。
test('脚本加载失败之后重试：第二次该换一个全新的 script，不会卡死在死元素上', async () => {
  const first = mountPanelInto(container(), 'http://127.0.0.1:8900')
  const deadScript = document.querySelector('script[data-stream-panel]')
  deadScript?.dispatchEvent(new Event('error'))
  await expect(first).rejects.toThrow(/panel bundle/)

  const second = mountPanelInto(container(), 'http://127.0.0.1:8900')
  const retryScript = document.querySelector('script[data-stream-panel]')
  expect(retryScript).not.toBe(deadScript)

  const { mount } = fulfilScript()
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 300))
  const result = await Promise.race([second.then(() => 'resolved' as const), timeout])
  expect(result).toBe('resolved')
  expect(mount).toHaveBeenCalledOnce()
})

// 第二个失败出口，同一个根因的另一个入口：script 真的 load 了，但没设出 __streamPanel
// （构建产物过期、发错文件之类）——这条路上 error 事件永远不会来，清理若只挂在 error
// 监听器上就永远够不着这个出口。
test('脚本 load 了但没导出全局，之后重试：第二次该换一个全新的 script', async () => {
  const first = mountPanelInto(container(), 'http://127.0.0.1:8900')
  const deadScript = document.querySelector('script[data-stream-panel]')
  deadScript?.dispatchEvent(new Event('load')) // 没设 __streamPanel 就直接 load
  await expect(first).rejects.toThrow(/没有导出/)

  const second = mountPanelInto(container(), 'http://127.0.0.1:8900')
  const retryScript = document.querySelector('script[data-stream-panel]')
  expect(retryScript).not.toBe(deadScript)

  const { mount } = fulfilScript()
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 300))
  const result = await Promise.race([second.then(() => 'resolved' as const), timeout])
  expect(result).toBe('resolved')
  expect(mount).toHaveBeenCalledOnce()
})
