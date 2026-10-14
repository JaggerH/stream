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
})
