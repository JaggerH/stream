// app/src/research/views/html.ts — html view:artifact.data 是一整段 HTML(matplotlib 导出
// 的图是 base64 PNG 塞在 <img> 里)。进 iframe 且**只给 allow-scripts、绝不给 allow-same-origin**:
// 两个一起给等于没有沙箱——同源意味着 iframe 里的脚本能拿到宿主页面的 cookie/localStorage/DOM。
import type { Artifact } from '../artifact.ts'

export function render(root: HTMLElement, artifact: Artifact, _theme: 'light' | 'dark'): void {
  const html = typeof artifact.data === 'string' ? artifact.data : ''
  if (!html) {
    const p = document.createElement('div')
    p.style.cssText = 'padding:8px;font-size:12px;opacity:.7'
    p.textContent = '这个 artifact 没有 HTML 内容'
    root.appendChild(p)
    return
  }
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.title = artifact.name
  iframe.style.cssText = 'width:100%;height:70vh;border:none;border-radius:8px'
  iframe.srcdoc = html
  root.appendChild(iframe)
}
