import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useTranslation } from 'react-i18next'
import i18n from './index.ts'
import { LangToggle } from '../components/LangToggle.tsx'

function Probe() {
  const { t } = useTranslation()
  return <div data-testid="x">{t('timeline.commentsEmpty')}</div>
}

describe('language switch propagation', () => {
  it('re-renders translated text + toggle label on switch', async () => {
    await act(async () => {
      await i18n.changeLanguage('zh')
    })
    render(
      <>
        <LangToggle />
        <Probe />
      </>
    )
    expect(screen.getByTestId('x').textContent).toBe('暂无评论')
    expect(screen.getByRole('button').textContent).toBe('EN')
    await act(async () => {
      fireEvent.click(screen.getByRole('button'))
    })
    expect(screen.getByTestId('x').textContent).toBe('No comments yet')
    expect(screen.getByRole('button').textContent).toBe('中')
  })
})
