import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CoreVersionMismatchPrompt } from './CoreVersionMismatchPrompt.tsx'

describe('CoreVersionMismatchPrompt', () => {
  it('shows the required and found core versions', () => {
    render(<CoreVersionMismatchPrompt required="2.0.0" found="1.9.2" onDismiss={() => {}} />)
    expect(screen.getByText(/2\.0\.0/)).toBeTruthy()
    expect(screen.getByText(/1\.9\.2/)).toBeTruthy()
  })

  it('prompts the user to refresh the core', () => {
    render(<CoreVersionMismatchPrompt required="2.0.0" found="1.9.2" onDismiss={() => {}} />)
    expect(screen.getByText(/刷新/)).toBeTruthy()
  })

  it('calls onDismiss when acknowledged', () => {
    const onDismiss = vi.fn()
    render(<CoreVersionMismatchPrompt required="2.0.0" found="1.9.2" onDismiss={onDismiss} />)
    fireEvent.click(screen.getByText('知道了'))
    expect(onDismiss).toHaveBeenCalled()
  })
})
