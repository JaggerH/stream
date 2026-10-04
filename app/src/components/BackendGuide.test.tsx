import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BackendGuide } from './BackendGuide.tsx'
import * as backend from '../lib/backend.tsx'

describe('BackendGuide', () => {
  it('shows docker guidance + reprobe status + Reconnect triggers reconnect', () => {
    const reconnect = vi.fn()
    vi.spyOn(backend, 'useBackend').mockReturnValue({
      status: 'disconnected',
      upstream: '',
      reloadToken: 0,
      reconnect,
      reportFailure: vi.fn(),
    })
    render(<BackendGuide />)
    expect(screen.getByText(/docker compose up/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /reconnect|重连/i }))
    expect(reconnect).toHaveBeenCalled()
  })

  it('probing shows a searching state', () => {
    vi.spyOn(backend, 'useBackend').mockReturnValue({
      status: 'probing',
      upstream: '',
      reloadToken: 0,
      reconnect: vi.fn(),
      reportFailure: vi.fn(),
    })
    render(<BackendGuide />)
    expect(screen.getByText(/probing|正在查找|搜索/i)).toBeTruthy()
  })
})
