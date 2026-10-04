import { beforeEach, expect, test, vi } from 'vitest'
import type { detailBundle as DetailBundleModule } from './detailBundle.ts'

// `detailBundle.load` 缓存在模块级的 `cached` 变量里（"装一次、全程复用"），跨测试用例
// 不会自己清零——每条用例都要一份**没被前一条用例污染过**的模块实例，否则第二条用例的
// "第一次失败"会撞见第一条用例早就缓存好的成功结果。`vi.resetModules()` + 动态 import
// 换一份全新实例，比给源码加一个只有测试用的 reset 钩子更干净。
let detailBundle: typeof DetailBundleModule

beforeEach(async () => {
  document.head.innerHTML = ''
  delete (globalThis as Record<string, unknown>).__streamPanelDetail
  vi.resetModules()
  ;({ detailBundle } = await import('./detailBundle.ts'))
})

/** 装 <script> 的浏览器行为 jsdom 不跑，测试里手动兑现"脚本加载完了"这一步。 */
function fulfilScript(): { mount: ReturnType<typeof vi.fn> } {
  const mount = vi.fn()
  const unmount = vi.fn()
  const el = document.querySelector('script[data-stream-panel-detail]')
  ;(globalThis as Record<string, unknown>).__streamPanelDetail = { mount, unmount }
  el?.dispatchEvent(new Event('load'))
  return { mount }
}

// 同 hosts/dsh 的 host.ts 第三轮修的那个坑（见 detailBundle.ts 头注指向它）：
// 失败留下的 <script> 是具尸体，装失败之后不摘掉它，下一次重试会再创建一个新的、
// 而不是复用死元素——但死的那个还留在 <head> 里，泄漏一份。这里钉住"只有一份"，
// 不是"新的没有复用死的"（那是 host.ts 的另一种失败形状，这个 loader 没有"已有
// script 复用"分支，不会卡死，但同样会泄漏 DOM 元素）。
test('装失败之后重试：<head> 里只留一份 script，不是两份', async () => {
  const first = detailBundle.load('http://127.0.0.1:8900')
  document.querySelector('script[data-stream-panel-detail]')?.dispatchEvent(new Event('error'))
  await expect(first).rejects.toThrow(/详情 bundle 加载失败/)

  const second = detailBundle.load('http://127.0.0.1:8900')
  fulfilScript()
  await expect(second).resolves.toBeDefined()

  expect(document.querySelectorAll('script[data-stream-panel-detail]')).toHaveLength(1)
})

test('装失败之后重试：第二次真的能成功，不会挂起', async () => {
  const first = detailBundle.load('http://127.0.0.1:8900')
  document.querySelector('script[data-stream-panel-detail]')?.dispatchEvent(new Event('error'))
  await expect(first).rejects.toThrow(/详情 bundle 加载失败/)

  const second = detailBundle.load('http://127.0.0.1:8900')
  const { mount } = fulfilScript()
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 300))
  const result = await Promise.race([second.then(() => 'resolved' as const), timeout])

  expect(result).toBe('resolved')
  const bundle = await second
  bundle.mount(document.createElement('div'), {
    backend: 'http://127.0.0.1:8900',
    item: {} as never,
    startMediaIndex: 0,
    autoPlayMedia: false,
    onClose: () => {},
  })
  expect(mount).toHaveBeenCalledOnce()
})

// "load 了但没导出全局"是第二个失败出口（同 host.ts）：error 事件永远不会来，
// 清理若只挂在 error 监听上就够不着这条路，同样会留下死元素。
test('load 了但没导出全局，之后重试：<head> 里只留一份 script', async () => {
  const first = detailBundle.load('http://127.0.0.1:8900')
  document.querySelector('script[data-stream-panel-detail]')?.dispatchEvent(new Event('load'))
  await expect(first).rejects.toThrow(/没有导出/)

  const second = detailBundle.load('http://127.0.0.1:8900')
  fulfilScript()
  await expect(second).resolves.toBeDefined()

  expect(document.querySelectorAll('script[data-stream-panel-detail]')).toHaveLength(1)
})
