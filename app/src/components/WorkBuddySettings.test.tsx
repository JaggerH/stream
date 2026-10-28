import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkBuddySettings } from './WorkBuddySettings.tsx'

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((input: string, init?: RequestInit) => {
    const path = new URL(input).pathname
    if (path === '/api/workbuddy/state') return Promise.resolve(Response.json({
      accounts: [{ id: 'one', displayName: '我的号', version: 'cn', enabled: true, status: 'ready', balance: 120,
        lastCheckin: 'confirmed', lastCheckinDate: '2026-10-29', lastPointsAt: '2026-10-29T00:00:00Z' }],
      settings: { scheduleEnabled: false, scheduleTime: '09:15' }, summary: { accounts: 1, enabled: 1, balance: 120 }, serverTime: '2026-10-29',
    }))
    if (path === '/api/tasks') return Promise.resolve(Response.json({ tasks: [], actions: ['workbuddy:checkin'] }))
    if (path === '/api/workbuddy/claim-schedule') return Promise.resolve(Response.json({ ok: true }))
    if (path === '/api/tasks/workbuddy-daily-checkin') return Promise.resolve(Response.json({ task: JSON.parse(String(init?.body)) }))
    throw new Error(`unexpected ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})

describe('WorkBuddy management', () => {
  it('shows each account balance and signs up Stream as the only scheduler', async () => {
    render(<WorkBuddySettings apiBase="http://127.0.0.1:8900" />)
    expect(await screen.findByText('我的号')).toBeTruthy()
    expect(screen.getByText(/120 积分/)).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: '每日自动签到' }))
    fireEvent.click(screen.getByRole('button', { name: '保存排期' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8900/api/workbuddy/claim-schedule', expect.objectContaining({ method: 'POST' })))
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8900/api/tasks/workbuddy-daily-checkin', expect.objectContaining({ method: 'PUT' }))
  })

  it('still shows the saved Stream schedule when Helper is offline', async () => {
    fetchMock.mockImplementation((input: string) => {
      const path = new URL(input).pathname
      if (path === '/api/workbuddy/state') return Promise.resolve(Response.json({ error: 'offline' }, { status: 502 }))
      if (path === '/api/tasks') return Promise.resolve(Response.json({ tasks: [{
        id: 'workbuddy-daily-checkin', source: 'user', enabled: true, schedule: '0 15 9 * * *', action: 'workbuddy:checkin',
      }], actions: ['workbuddy:checkin'] }))
      throw new Error(`unexpected ${path}`)
    })
    render(<WorkBuddySettings apiBase="http://127.0.0.1:8900" />)
    await waitFor(() => expect((screen.getByRole('checkbox', { name: '每日自动签到' }) as HTMLInputElement).checked).toBe(true))
    expect(screen.getByRole('alert').textContent).toContain('offline')
  })
})
