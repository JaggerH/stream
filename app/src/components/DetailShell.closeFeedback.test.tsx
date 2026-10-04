// 详情页左上那颗关闭键（黑药丸 + ←）必须**三态都有反馈**：hover / 按下 / 键盘聚焦。
//
// 为什么值得钉一条测试：它踩过一个会静默复发的坑。这颗按钮用的是 acrylic Button 的 ghost
// variant，而 ghost 自带的 hover 是 `bg-[var(--acr-chip)]`（rgba(0,0,0,.06)）——盖到实心黑
// 药丸上会把它洗成一块几乎透明的灰，所以当初写了 `hover:!bg-black active:!bg-black` 去压。
// 压是对的，压完没给新的才是错：那两行把**整个 hover/active 态**压平成静止态，鼠标移上去零
// 反馈。而它看起来完全正常——类名里有 `hover:` 字样，读代码的人不会起疑，也没有任何测试会红。
//
// 反馈因此挪到 `::before` 的白色薄层上（底下那层黑保持不动）。断言写成**语义不变量**而不是钉死
// 颜色：承载反馈的那一层，hover / active 的值必须和静止态不同。换配色不会误伤它，把 ::before
// 那几个类删掉、或让 hover 又等于静止态，会当场变红。
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DetailShell } from './DetailShell.tsx'

/**
 * 取 className 里某个变体前缀下**最终生效**的背景值：
 * `before:bg-white/0` + 前缀 `before:` → `white/0`；`hover:before:bg-white/20` → `white/20`。
 *
 * 不能取第一个命中就返回：这颗按钮的类名里，ghost variant 自己的 `bg-transparent` /
 * `hover:bg-[var(--acr-chip)]` 和调用点的 `!bg-...` 同时在场，靠 `!important` 分胜负。取第一个
 * 会读到被压掉的那一个——写这条测试时正是先掉进这个坑：三条断言在旧类名下照样全绿，靠"把旧类名
 * 改回去看它红不红"才发现（天然绿的测试等于没有测试）。判决规则跟 CSS 一致：先看
 * `!important`，同级再看谁在后面。
 */
function bgOf(className: string, prefix: string): string | null {
  let plain: string | null = null
  let important: string | null = null
  for (const token of className.split(/\s+/)) {
    if (prefix === '') {
      // 静止态且无伪元素 = 类名本身就以 bg- / !bg- 开头，不带任何变体前缀
      if (!/^!?bg-/.test(token)) continue
    } else if (!token.startsWith(prefix)) {
      continue
    }
    const m = /^(!?)bg-(.+)$/.exec(token.slice(prefix.length))
    if (!m) continue
    if (m[1] === '!') important = m[2]
    else plain = m[2]
  }
  return important ?? plain
}

function closeButton() {
  render(
    <DetailShell media={<div>媒体</div>} onClose={() => {}} />
  )
  return screen.getByRole('button', { name: '返回' })
}

describe('详情页关闭键的三态反馈', () => {
  it('hover 时承载反馈的那一层和静止态不是同一个值', () => {
    const cls = closeButton().className
    const rest = bgOf(cls, 'before:')
    const hover = bgOf(cls, 'hover:before:')
    expect(rest).toBeTruthy()
    expect(hover).toBeTruthy()
    expect(hover).not.toBe(rest)
  })

  it('按下有自己的值,也不等于静止态和 hover', () => {
    const cls = closeButton().className
    const rest = bgOf(cls, 'before:')
    const hover = bgOf(cls, 'hover:before:')
    const active = bgOf(cls, 'active:before:')
    expect(active).toBeTruthy()
    expect(active).not.toBe(rest)
    expect(active).not.toBe(hover)
  })

  // 反馈层是 ::before，而底下那层实心黑**必须原样保住**——它是这颗按钮浮在任意媒体上还能看清
  // 的唯一依靠。把 hover 做成"改底色"实测是零变化：按钮浮在 bg-black/80 的媒体窗格上，黑压黑。
  it('底下那层黑三态不变——反馈不靠改底色', () => {
    const cls = closeButton().className
    expect(bgOf(cls, '')).toBe('black')
    expect(bgOf(cls, 'hover:')).toBe('black')
    expect(bgOf(cls, 'active:')).toBe('black')
  })

  // 键盘用户看不到 hover。焦点环来自 acrylic Button 自身，这里钉的是"没被 className 覆盖掉"。
  it('键盘聚焦有焦点环', () => {
    expect(closeButton().className).toContain('focus-visible:ring-2')
  })

  // 真发生过：给 ::before 找定位参照时顺手加了 `relative`，而类名里已经有 `fixed`。两个定位类
  // 同时在场，谁赢看**样式表里的顺序**、不看 className 里写的顺序——`relative` 赢的那一刻这颗
  // 按钮就从"浮着"变成"占位置"，详情页左边凭空多出一块空白。`fixed` 自己就是 ::before 的定位
  // 参照，`relative` 从来就是多余的。
  it('只能有一个定位类——fixed 已经是 ::before 的参照,别再叠 relative', () => {
    const tokens = closeButton().className.split(/\s+/)
    expect(tokens).toContain('fixed')
    expect(tokens).not.toContain('relative')
  })
})
