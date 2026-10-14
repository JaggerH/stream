import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PhoneDevicesSettings } from './PhoneDevicesSettings.tsx'

const conn = { baseUrl: 'http://127.0.0.1:8900' } as never
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

const json = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body })

describe('PhoneDevicesSettings', () => {
  it('lists devices with their online state and revokes a paired phone', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.resolve({ ok: true, status: 204, json: async () => null })
      return json({ devices: [
        { deviceId: 'android:1', name: 'K80', platform: 'android', paired: true, online: true },
        { deviceId: 'desktop:pc', name: 'PC', platform: 'windows', paired: false, online: true },
      ] })
    })
    render(<PhoneDevicesSettings conn={conn} />)
    expect(await screen.findByText('K80')).toBeTruthy()
    expect(screen.getByText('PC')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '撤销 PC' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '撤销 K80' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8900/api/devices/android%3A1', expect.objectContaining({ method: 'DELETE' })))
  })

  it('shows the code and one QR per backend address after "添加手机"', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith('/api/devices/pairing-code')) {
        return json({ code: '123456', expiresAt: Date.now() + 300_000, qr: [
          JSON.stringify({ stream: 'pair', v: 1, backend: 'http://10.9.8.21:8900', code: '123456' }),
        ] })
      }
      return json({ devices: [] })
    })
    const { container } = render(<PhoneDevicesSettings conn={conn} />)
    fireEvent.click(await screen.findByRole('button', { name: '添加手机' }))
    expect(await screen.findByText('123456')).toBeTruthy()
    expect(screen.getByText('http://10.9.8.21:8900')).toBeTruthy()
    expect(container.querySelectorAll('svg[data-pair-qr]')).toHaveLength(1)
  })

  it('re-lists devices every 3 seconds while a pairing code is shown', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith('/api/devices/pairing-code')) {
        return json({ code: '123456', expiresAt: Date.now() + 300_000, qr: [] })
      }
      return json({ devices: [] })
    })
    // Fake only the interval so findBy*/waitFor keep running on real timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      render(<PhoneDevicesSettings conn={conn} />)
      fireEvent.click(await screen.findByRole('button', { name: '添加手机' }))
      await screen.findByText('123456')
      const listCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/devices')).length
      const before = listCalls()
      await vi.advanceTimersByTimeAsync(3000)
      expect(listCalls()).toBe(before + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a newly paired device clears the code and stops polling', async () => {
    let paired = false
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith('/api/devices/pairing-code')) {
        return json({ code: '123456', expiresAt: Date.now() + 300_000, qr: [] })
      }
      return json({ devices: paired
        ? [{ deviceId: 'android:new', name: 'K80', platform: 'android', paired: true, online: true }]
        : [] })
    })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      render(<PhoneDevicesSettings conn={conn} />)
      fireEvent.click(await screen.findByRole('button', { name: '添加手机' }))
      await screen.findByText('123456')
      paired = true
      await vi.advanceTimersByTimeAsync(3000)
      await waitFor(() => expect(screen.queryByText('123456')).toBeNull())
      const listCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/devices')).length
      const before = listCalls()
      await vi.advanceTimersByTimeAsync(9000)
      expect(listCalls()).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an expired code is replaced by the expiry text and polling stops', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith('/api/devices/pairing-code')) {
        return json({ code: '123456', expiresAt: Date.now() + 4000, qr: [] })
      }
      return json({ devices: [] })
    })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      render(<PhoneDevicesSettings conn={conn} />)
      fireEvent.click(await screen.findByRole('button', { name: '添加手机' }))
      await screen.findByText('123456')
      await vi.advanceTimersByTimeAsync(6000)
      await waitFor(() => expect(screen.getByText('配对码已过期，点「添加手机」重新生成')).toBeTruthy())
      expect(screen.queryByText('123456')).toBeNull()
      const listCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/devices')).length
      const before = listCalls()
      await vi.advanceTimersByTimeAsync(9000)
      expect(listCalls()).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})
