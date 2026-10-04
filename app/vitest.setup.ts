import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
// initialize i18n (side-effect import) so t() resolves to real strings in tests;
// without it the react-i18next hook is never wired up and t() echoes the key.
import i18n from './src/i18n/index.ts'
// jsdom's navigator reports en-US, so the LanguageDetector would pick 'en'. Pin to
// 'zh' (the app's default/fallback + primary user locale) for deterministic renders.
void i18n.changeLanguage('zh')

// 这份 setup 全是给 jsdom 补 DOM 的；但个别测试必须跑 node 环境（`// @vitest-environment node`，
// 如 src/panel/panel-css.build.test.ts 要在测试里真跑一次 vite/esbuild 构建，而 jsdom 的
// TextEncoder 会让 esbuild 拒绝启动）。setupFiles 是全局的、对它们也照跑，所以这里必须先问一句
// 有没有 DOM——否则 node 档的测试连收集都进不去（`ReferenceError: window is not defined`）。
const hasDom = typeof window !== 'undefined'

// node 档测试如果需要 import 到面板 custom element(`class X extends HTMLElement`，见
// boards/panels/base.ts)，`extends` 子句在模块求值时就要求 HTMLElement 这个标识符存在——
// 跟"渲染进不进 DOM"无关，纯粹是 class 声明能不能求值。panel-boards.build.test.ts 在
// node 环境下直接 import register.ts 取 BUILTIN_ELEMENT_TAGS 就撞上这个，只补最小 stub，
// 不引入 jsdom（否则又踩回 panel-css.build.test.ts 那条 TextEncoder 坑）。
if (!hasDom && typeof globalThis.HTMLElement === 'undefined') {
  globalThis.HTMLElement = class {} as unknown as typeof HTMLElement
}

if (hasDom && !window.matchMedia) {
  window.matchMedia = () => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}

// jsdom lacks the pointer-capture / scroll APIs Radix menus call when opening.
if (hasDom) {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {}
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
}

// Artplayer 换源时无条件 `URL.revokeObjectURL(oldUrl)`（blob 源用得上），而 jsdom 的 URL 上
// 压根没有这两个方法——真渲染一次播放器就会抛，而且抛在库内部的异步路径上，表现成一条
// "Unhandled Rejection" 把整份运行判成红，测试本身却全绿（最难查的形状）。
if (hasDom) {
  if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:jsdom'
  if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {}
}

// cmdk (Command / Combobox) observes its list with ResizeObserver, which jsdom lacks.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

afterEach(() => {
  if (!hasDom) return
  cleanup()
  // reset the URL so a test's route writes (replaceState) don't leak into the next one
  window.history.replaceState(null, '', '/')
})
