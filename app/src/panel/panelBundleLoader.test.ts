/**
 * `createPanelBundleLoader` 的单例语义。这份工厂是详情和影视两个附属 bundle 共用的装载
 * 逻辑（见 `panelBundleLoader.ts` 头注），所以这里钉的每一条对两边同时生效。
 */
import { beforeEach, expect, test } from 'vitest'
import { createPanelBundleLoader } from './panelBundleLoader.ts'

const BACKEND = 'http://127.0.0.1:8900'

function makeLoader(marker: string, globalName: string, file: string) {
  return createPanelBundleLoader<{ ok: true }>({ marker, globalName, file, label: '测试' })
}

/** jsdom 不会真的取网执行 `<script src>`，手动兑现"脚本加载完了"这一步。 */
function fulfil(marker: string, globalName: string): void {
  ;(globalThis as Record<string, unknown>)[globalName] = { ok: true }
  document.querySelector(`script[${marker}]`)?.dispatchEvent(new Event('load'))
}

beforeEach(() => {
  document.head.innerHTML = ''
  delete (globalThis as Record<string, unknown>).__testBundleA
  delete (globalThis as Record<string, unknown>).__testBundleB
})

// 「切走再切回不重复装」这条**用户可见**的性质，落在代码里就是这一条：同一个 loader 装
// 第二次不该再往 `<head>` 里插一份。装两份的后果不是报错，是那份 2.6MB 的 IIFE 又被下载、
// 解析、执行一遍，而且第二次执行会把全局上的 `mount` 换成新模块实例的那一份——外面已经
// 挂着的那棵树从此归一个再也没人引用的模块管。
test('装第二次复用第一次：同一个 promise，<head> 里只有一份 script 和一份 link', async () => {
  const loader = makeLoader('data-test-bundle-a', '__testBundleA', 'panel-test-a')
  const first = loader.load(BACKEND)
  fulfil('data-test-bundle-a', '__testBundleA')
  await expect(first).resolves.toEqual({ ok: true })

  const second = loader.load(BACKEND)

  expect(second).toBe(first)
  await expect(second).resolves.toEqual({ ok: true })
  expect(document.querySelectorAll('script[data-test-bundle-a]')).toHaveLength(1)
  expect(document.querySelectorAll('link[data-test-bundle-a]')).toHaveLength(1)
})

// 还在装的半路上又被要一次（切进影视 → 立刻切走 → 立刻切回来，2.6MB 还没下完）：
// 同样只能有一份在飞，不能因为"还没 resolve"就再插一个 script。
test('第一次还没装完就再要一次：不会插第二份 script', async () => {
  const loader = makeLoader('data-test-bundle-a', '__testBundleA', 'panel-test-a')
  const first = loader.load(BACKEND)
  const second = loader.load(BACKEND)

  expect(document.querySelectorAll('script[data-test-bundle-a]')).toHaveLength(1)

  fulfil('data-test-bundle-a', '__testBundleA')
  await expect(first).resolves.toEqual({ ok: true })
  await expect(second).resolves.toEqual({ ok: true })
})

// 详情和影视是两份产物、两个全局名。工厂造出来的两个 loader 必须各认各的标记——否则先装
// 好的那一份会把后要的那份"当成已经装好了"，表现是切到影视画出来的是详情，或者直接
// `mount is not a function`。
test('两个 loader 各认各的标记，互不冒领', async () => {
  const a = makeLoader('data-test-bundle-a', '__testBundleA', 'panel-test-a')
  const b = makeLoader('data-test-bundle-b', '__testBundleB', 'panel-test-b')

  const pa = a.load(BACKEND)
  fulfil('data-test-bundle-a', '__testBundleA')
  await pa

  const pb = b.load(BACKEND)
  // A 已经装好了，但 B 还得自己插一份 script——没有它这条 promise 永远不 settle。
  expect(document.querySelectorAll('script[data-test-bundle-b]')).toHaveLength(1)
  const bScript = document.querySelector('script[data-test-bundle-b]') as HTMLScriptElement
  expect(bScript.src).toContain('/panel/panel-test-b.js')

  fulfil('data-test-bundle-b', '__testBundleB')
  await expect(pb).resolves.toEqual({ ok: true })
})

test('装失败之后重试：<head> 里只留一份 script（工厂层，详情/影视共享这条清理）', async () => {
  const loader = makeLoader('data-test-bundle-a', '__testBundleA', 'panel-test-a')
  const first = loader.load(BACKEND)
  document.querySelector('script[data-test-bundle-a]')?.dispatchEvent(new Event('error'))
  await expect(first).rejects.toThrow(/测试 bundle 加载失败/)

  const second = loader.load(BACKEND)
  fulfil('data-test-bundle-a', '__testBundleA')
  await expect(second).resolves.toEqual({ ok: true })

  expect(document.querySelectorAll('script[data-test-bundle-a]')).toHaveLength(1)
})
