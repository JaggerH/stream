// app/src/research/views/text.ts — text view:artifact.data 是一段 markdown。
// 真实数据里占 230/1158,复用仓里已有的 Markdown 渲染,不引新依赖(见 markdown-host.tsx)。
import { renderMarkdownInto } from './markdown-host.tsx'
import type { Artifact } from '../artifact.ts'

export function render(root: HTMLElement, artifact: Artifact, _theme: 'light' | 'dark'): void {
  renderMarkdownInto(root, typeof artifact.data === 'string' ? artifact.data : String(artifact.data ?? ''))
}
