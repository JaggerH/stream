import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Warnings } from './Warnings.tsx'

describe('Warnings', () => {
  it('shows the one-liner and a copy button for an ordinary failure', () => {
    render(<Warnings warnings={[{ label: 'zuna', message: 'upstream 500' }]} />)
    expect(screen.getByText('upstream 500')).toBeTruthy()
    expect(screen.getByRole('button', { name: /复制 zuna/ })).toBeTruthy()
  })

  it('renders an action as a BUTTON when the warning is something the user can fix', () => {
    // 「小红书需要登录」不是故障，是缺前置条件。一行红字什么都改变不了；一个按钮可以。
    const onAct = vi.fn()
    render(<Warnings warnings={[
      { label: '小红书', message: '登录已失效', action: { text: '去登录', onAct } },
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: '去登录' }))
    expect(onAct).toHaveBeenCalledTimes(1)
  })

  it('keeps the copy button available alongside an action', () => {
    // 能修不代表不用报告——两个都留着，别为了好看砍掉诊断路径。
    render(<Warnings warnings={[
      { label: '小红书', message: '登录已失效', action: { text: '去登录', onAct: () => {} } },
    ]} />)
    expect(screen.getByRole('button', { name: '去登录' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /复制 小红书/ })).toBeTruthy()
  })

  it('renders nothing at all when there are no warnings', () => {
    const { container } = render(<Warnings warnings={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
