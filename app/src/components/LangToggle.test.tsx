import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import i18n from '../i18n'
import { LangToggle } from './LangToggle.tsx'

describe('LangToggle', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })

  it('toggles the i18next language between zh and en', async () => {
    render(<LangToggle />)
    const btn = screen.getByRole('button', { name: /language/i })
    expect(i18n.language).toBe('zh')
    fireEvent.click(btn)
    expect(i18n.language).toBe('en')
    fireEvent.click(btn)
    expect(i18n.language).toBe('zh')
  })
})
