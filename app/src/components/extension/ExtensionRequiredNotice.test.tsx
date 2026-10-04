import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ExtensionRequiredNotice } from './ExtensionRequiredNotice.tsx'
import type { ExtensionOnboardingActions } from './ExtensionOnboardingCard.tsx'
import { shouldPrompt, promptRecord, recordPrompted } from '../../lib/extensionPrompt.ts'

const fakeActions = (): ExtensionOnboardingActions => ({
  materialize: vi.fn(async () => ({ dir: 'C:\\data\\extension', source: 'repo' })),
  install: vi.fn(async () => ({ status: 'connected' as const })),
  decline: vi.fn(async () => {}),
})

describe('动作现场的扩展提示', () => {
  it('动作因为扩展没连而失败 → 就地给出安装入口，不是丢进通知中心', () => {
    render(<ExtensionRequiredNotice actions={fakeActions()} />)
    expect(screen.getByText(/这一步需要 Chrome 扩展/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '帮我装' })).toBeTruthy()
  })
})

describe('shouldPrompt', () => {
  const now = new Date('2026-08-30T10:00:00Z')

  it('同一个能力一天最多提一次——第二次静默（防烦，也防它变成背景噪音）', () => {
    expect(shouldPrompt('subscribe', { lastPromptedAt: '2026-08-30T09:00:00Z' }, now)).toBe(false)
    expect(shouldPrompt('subscribe', { lastPromptedAt: '2026-08-29T09:00:00Z' }, now)).toBe(true)
    expect(shouldPrompt('subscribe', {}, now)).toBe(true)
  })

  it('节流是按能力分开的——订阅提过不该把采集那次也吞掉', () => {
    const seen: Record<string, { lastPromptedAt?: string }> = {
      subscribe: { lastPromptedAt: '2026-08-30T09:00:00Z' },
    }
    expect(shouldPrompt('subscribe', seen.subscribe, now)).toBe(false)
    expect(shouldPrompt('harvest', seen.harvest ?? {}, now)).toBe(true)
  })

  it('记录坏掉（存了个不是时间的东西）→ 提，不静默', () => {
    expect(shouldPrompt('harvest', { lastPromptedAt: '这不是时间' }, now)).toBe(true)
  })
})

describe('节流记录的落盘', () => {
  beforeEach(() => localStorage.clear())

  it('记一笔之后读得回来，且只影响那一个能力', () => {
    const now = new Date('2026-08-30T10:00:00Z')
    recordPrompted('harvest', now)
    expect(shouldPrompt('harvest', promptRecord('harvest'), now)).toBe(false)
    expect(shouldPrompt('subscribe', promptRecord('subscribe'), now)).toBe(true)
  })
})
