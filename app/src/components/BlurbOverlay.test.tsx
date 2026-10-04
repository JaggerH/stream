import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { BlurbOverlay } from './BlurbOverlay.tsx'

describe('BlurbOverlay', () => {
  it('默认折叠，点一下展开，再点收回', () => {
    render(<BlurbOverlay text="一段很长的简介" />)
    const box = screen.getByTestId('blurb-overlay')
    expect(box.getAttribute('data-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: /简介/ }))
    expect(box.getAttribute('data-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /简介/ }))
    expect(box.getAttribute('data-expanded')).toBe('false')
  })

  // 媒体台上的点击是「关详情页」。展开简介顺手把页面关掉是灾难，而且不会有任何报错。
  it('浮层里的点击不冒泡到外面', () => {
    const outer = vi.fn()
    render(
      <div onClick={outer}>
        <BlurbOverlay text="一段很长的简介" />
      </div>
    )
    fireEvent.click(screen.getByRole('button', { name: /简介/ }))
    expect(outer).not.toHaveBeenCalled()
  })
})
