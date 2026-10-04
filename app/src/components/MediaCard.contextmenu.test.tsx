/**
 * `MediaCard` 必须把不认识的属性转发到根节点。
 *
 * **为什么值得单独一条**：Radix 的 `asChild` 把 `onContextMenu` 之类交给子组件，靠子组件
 * 自己落到真 DOM 上。`MediaCard` 的 props 是一张封闭清单，不转发时 Radix 递过来的东西被
 * 静默吃掉——菜单注册着、右键毫无反应、控制台一个字都没有。活体上就是这么坏的：播客卡上
 * 的「在对话中引用」怎么点都不出来，而 `SubscriptionContextMenu` 和 `MediaCard` 两边的代码
 * 单看都完全正确。
 *
 * 所以这条用例**不测属性有没有落在 DOM 上，测右键到底弹不弹**——前者换个 Radix 版本就可能
 * 失去意义，后者是用户真正在做的那个动作。
 */
import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MediaCard } from './MediaCard.tsx'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu.tsx'

function wrapped(node: React.ReactNode) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{node}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>在对话中引用</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

const rightClick = (el: Element) => fireEvent.contextMenu(el, { bubbles: true })

describe('MediaCard 包在 ContextMenuTrigger asChild 里', () => {
  it('可点击那一档（onOpen）：右键弹得出菜单', async () => {
    render(wrapped(<MediaCard ratio="1 / 1" title="春典JARGON" ariaLabel="春典JARGON" onOpen={() => {}} />))
    rightClick(screen.getByRole('button', { name: '春典JARGON' }))
    expect(await screen.findByText('在对话中引用')).toBeTruthy()
  })

  it('纯展示那一档（既无 href 也无 onOpen）：同样弹得出', async () => {
    const { container } = render(wrapped(<MediaCard ratio="1 / 1" title="只展示" />))
    rightClick(container.querySelector('[data-nested-surface]')!)
    expect(await screen.findByText('在对话中引用')).toBeTruthy()
  })

  it('链接那一档（href）：同样弹得出', async () => {
    render(wrapped(<MediaCard ratio="1 / 1" title="外链" href="https://example.com" />))
    rightClick(screen.getByRole('link'))
    expect(await screen.findByText('在对话中引用')).toBeTruthy()
  })
})
