// app/src/research/views/markdown-host.ts — 把已有的 `Markdown` React 组件挂进裸 DOM 节点的薄适配。
// text view(占真实 artifact 的 230/1158)不引 react-markdown——仓里
// app/src/components/source/RsshubRouteMarkdown.tsx 已有一份能处理标题/列表/代码/表格/链接的实现。
//
// 静态字符串渲染(renderToStaticMarkup),不开嵌套 React root。`Markdown` 本身是纯展示、
// 无状态无副作用(没有 hook,没有事件处理——链接就是静态 <a href>),不需要 React 自己的
// 生命周期来维护它。早先版本用 createRoot()+flushSync 挂了个嵌套 root:单张卡测试时没事,
// 但详情页一次挂多张 text 卡、随后一起卸载时,外层 React 树连根拔掉这段 DOM 和嵌套 root
// 自己同步 unmount() 会撞在同一次 commit 里——React 自己报警("Attempted to synchronously
// unmount a root while React was already rendering"),往下炸成 DOM 的 NotFoundError。
// 两个独立的 reconciler 抢着管同一段 DOM 本来就没有官方支持的安全退出路径;根治办法不是
// 把 unmount 挪个时机去赌不撞车,而是压根不开第二个 reconciler。
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../../components/source/RsshubRouteMarkdown.tsx'

export function renderMarkdownInto(root: HTMLElement, markdown: string): void {
  root.innerHTML = renderToStaticMarkup(<Markdown text={markdown} headingBase={1} />)
}
