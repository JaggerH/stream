import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import '@/assets/globals.css'
import { showBootError, dismissWhenMounted } from './boot-fallback.ts'

/**
 * index.html 里那份纯静态兜底（`#boot-fallback`）负责"JS 一行都没跑起来"的情形；这里负责
 * 另外两半：**跑起来了就把它摘掉**、**跑起来但炸了就把报错写进去**。
 *
 * 摘除用 MutationObserver 盯 `#root` 的第一个子节点，而不是 `render()` 之后直接删：
 * `createRoot().render()` 是排期的，返回时 DOM 还可能是空的——那一刻删掉兜底，就又回到
 * 340×0 的隐形弹窗，只是窗口从"永远"缩成了"渲染前那几十毫秒 + 渲染抛错时的永远"。
 * 判据必须是"真的有东西画出来了"，不是"我调用过 render 了"。
 */
dismissWhenMounted()

// 顶层异常/未捕获 rejection 也要看得见：popup 的 devtools 要右键「检查弹出内容」才开得出来，
// 而弹窗一失焦就关——真正会去看控制台的用户接近于零，所以错误得画在弹窗自己身上。
window.addEventListener('error', (e) => showBootError(e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => showBootError(e.reason))

try {
  createRoot(document.getElementById('root')!).render(<App />)
} catch (e) {
  showBootError(e)
}
