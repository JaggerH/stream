/**
 * 「主区被一块全屏覆盖层占着」这一声由 `DetailShell` **自己**报（`lib/overlayPresence.ts`），
 * 工作台的对话列据此让位。
 *
 * 为什么钉在这一层：影视频道的播放入口有好几个（继续观看 / 作品详情 / TMDb 详情），将来还会
 * 加；它们的共同点是都渲染这个组件。报到写在调用方就得每加一个入口记得接一次线，漏了不报错，
 * 只是那一处看片时对话列不让位——最难发现的那种。
 */
import { render } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DetailShell } from './DetailShell.tsx'
import { overlayOpen, resetOverlayPresence } from '../lib/overlayPresence.ts'

// 模块级计数跨用例会串。
beforeEach(() => { resetOverlayPresence() })
afterEach(() => { resetOverlayPresence() })

test('在场即报到，卸载即撤销', () => {
  expect(overlayOpen()).toBe(false)
  const { unmount } = render(<DetailShell media={<div>片</div>} onClose={() => {}} />)
  expect(overlayOpen()).toBe(true)
  unmount()
  expect(overlayOpen()).toBe(false)
})

test('两层叠着时先关的那一层不许把"还占着"清掉', () => {
  const a = render(<DetailShell media={<div>一</div>} onClose={() => {}} />)
  const b = render(<DetailShell media={<div>二</div>} onClose={() => {}} />)
  expect(overlayOpen()).toBe(true)
  a.unmount()
  // 还有一层在，主区仍然是被占满的——这里若变成 false，对话列会在看片途中自己弹回来。
  expect(overlayOpen()).toBe(true)
  b.unmount()
  expect(overlayOpen()).toBe(false)
})
