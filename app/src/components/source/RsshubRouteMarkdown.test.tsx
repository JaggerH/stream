import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Markdown } from './RsshubRouteMarkdown.tsx'

// 钉住 source-config 抽屉的原始映射：Task 9 把研究页面 text view 接进这份共享渲染器时，顺手把
// `#` 的层级映射从「#→h2」改成了「#→h1」，波及了抽屉里的 route 文档渲染（没有测试钉住，
// 「39 个测试还是绿」这句话根本没覆盖到这里）。Markdown 不传 headingBase 时必须保持这份映射
// 字节级不变——抽屉里不该出现和抽屉标题抢位的整版 h1。
describe('Markdown（默认 headingBase，source-config 抽屉用）', () => {
  it('# 渲染成 h2、16px semibold，不是 h1/18px bold', () => {
    const { container } = render(<Markdown text="# 标题" />)
    const h2 = container.querySelector('h2')
    expect(h2?.textContent).toBe('标题')
    expect(h2?.className).toContain('text-[16px]')
    expect(h2?.className).toContain('font-semibold')
    expect(container.querySelector('h1')).toBeNull()
  })

  it('## 渲染成 h3，### 和更深的都封顶在 h4', () => {
    const { container: c2 } = render(<Markdown text="## 二级" />)
    expect(c2.querySelector('h3')?.textContent).toBe('二级')

    const { container: c3 } = render(<Markdown text="### 三级" />)
    expect(c3.querySelector('h4')?.textContent).toBe('三级')

    const { container: c4 } = render(<Markdown text="#### 四级" />)
    expect(c4.querySelector('h4')?.textContent).toBe('四级')
  })
})

describe('Markdown（headingBase=1，研究页面 text view 用）', () => {
  it('# 渲染成真的 h1、18px bold', () => {
    const { container } = render(<Markdown text="# 标题" headingBase={1} />)
    const h1 = container.querySelector('h1')
    expect(h1?.textContent).toBe('标题')
    expect(h1?.className).toContain('text-[18px]')
    expect(h1?.className).toContain('font-bold')
  })
})
