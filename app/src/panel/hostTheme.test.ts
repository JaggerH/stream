import { afterEach, expect, test } from 'vitest'
import { HOST_DARK_ATTRIBUTE, watchHostTheme } from './hostTheme.ts'

afterEach(() => {
  document.body.removeAttribute(HOST_DARK_ATTRIBUTE)
  document.body.classList.remove('dark')
})

// —— body 这一半：Radix 的浮层（Sheet/Dialog/Popover/…）portal 到 DSH 的 body，
//    在 DOM 上没有任何 `.dark` 祖先。只挂面板根的话它们永远是浅色档——暗色宿主下
//    「管理频道」sheet 整片白底黑字。下面三条钉住"body 也要挂、也要跟、也要收干净"。

test('body 也拿到 dark class——否则 portal 出去的浮层没有任何 .dark 祖先', () => {
  document.body.setAttribute(HOST_DARK_ATTRIBUTE, '')
  const stop = watchHostTheme(document.createElement('div'))
  expect(document.body.classList.contains('dark')).toBe(true)
  stop()
})

test('宿主运行时切主题，body 上那个类跟着变', async () => {
  const stop = watchHostTheme(document.createElement('div'))
  expect(document.body.classList.contains('dark')).toBe(false)

  document.body.setAttribute(HOST_DARK_ATTRIBUTE, '')
  await Promise.resolve()
  expect(document.body.classList.contains('dark')).toBe(true)

  document.body.removeAttribute(HOST_DARK_ATTRIBUTE)
  await Promise.resolve()
  expect(document.body.classList.contains('dark')).toBe(false)

  stop()
})

// body 上的类是留在**宿主页面**上的共享状态：面板卸载了还留着，等于我们走了
// 却把别人的页面按在暗色档上。停止函数必须连它一起收掉，不只是断开观察者。
test('停止函数把 body 上那个类摘掉，不给宿主留残留', () => {
  document.body.setAttribute(HOST_DARK_ATTRIBUTE, '')
  const stop = watchHostTheme(document.createElement('div'))
  expect(document.body.classList.contains('dark')).toBe(true)
  stop()
  expect(document.body.classList.contains('dark')).toBe(false)
})

test('挂载时同步一次——宿主是暗色，面板根拿到 dark class', () => {
  document.body.setAttribute(HOST_DARK_ATTRIBUTE, '')
  const root = document.createElement('div')
  const stop = watchHostTheme(root)
  expect(root.classList.contains('dark')).toBe(true)
  stop()
})

test('挂载时同步一次——宿主是亮色（没有那个属性），面板根不带 dark class', () => {
  const root = document.createElement('div')
  const stop = watchHostTheme(root)
  expect(root.classList.contains('dark')).toBe(false)
  stop()
})

// 用户能在面板开着的时候切 DSH 的主题——一次性快照会漏掉这次切换，
// 必须靠 MutationObserver 跟。MutationObserver 的回调是异步微任务，
// 等一次 await 才会 flush。
test('运行时宿主切换主题，面板根跟着变——不是挂载时的一次性快照', async () => {
  const root = document.createElement('div')
  const stop = watchHostTheme(root)
  expect(root.classList.contains('dark')).toBe(false)

  document.body.setAttribute(HOST_DARK_ATTRIBUTE, '')
  await Promise.resolve()
  expect(root.classList.contains('dark')).toBe(true)

  document.body.removeAttribute(HOST_DARK_ATTRIBUTE)
  await Promise.resolve()
  expect(root.classList.contains('dark')).toBe(false)

  stop()
})

// 这条钉住"卸载真的收掉了观察者"——不是形式上返回一个函数，而是调用之后
// MutationObserver 真的不再响应后续变化。反例：如果 stop() 只是个空函数，
// 这条用例会失败（root 会继续被同步），证明它有牙。
test('调用停止函数之后，观察者不再响应宿主的主题变化', async () => {
  const root = document.createElement('div')
  const stop = watchHostTheme(root)
  stop()

  document.body.setAttribute(HOST_DARK_ATTRIBUTE, '')
  await Promise.resolve()
  expect(root.classList.contains('dark')).toBe(false)
})
