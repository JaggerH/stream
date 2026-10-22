import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FacilityDevicesSettings } from './FacilityDevicesSettings.tsx'

const conn = { baseUrl: 'http://127.0.0.1:8900' } as never
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

const json = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body })

const DEVICES = [
  { deviceId: 'linux:nas', name: 'NAS', platform: 'linux', paired: true, online: true },
  { deviceId: 'linux:pc', name: 'PC', platform: 'linux', paired: true, online: false },
]

/** 绑定表放在闭包里：PUT / DELETE 真的改它，之后的 GET 读到改过的。 */
function backend(initial: Record<string, string>, onPut?: (facility: string, deviceId: string) => unknown) {
  const bound = { ...initial }
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url)
    const m = /\/api\/devices\/bindings\/([^/]+)$/.exec(u)
    if (m && init?.method === 'PUT') {
      const facility = decodeURIComponent(m[1])
      const { deviceId } = JSON.parse(String(init.body)) as { deviceId: string }
      const refused = onPut?.(facility, deviceId)
      if (refused) return refused
      bound[facility] = deviceId
      return json({ facility, deviceId })
    }
    if (m && init?.method === 'DELETE') {
      delete bound[decodeURIComponent(m[1])]
      return Promise.resolve({ ok: true, status: 204, json: async () => null })
    }
    if (u.endsWith('/api/devices/facilities')) {
      return json({ facilities: ['bilibili', 'eastmoney', 'xhs'].map((f) => ({ facility: f, packageId: `@streamapp/${f}`, deviceId: bound[f] ?? 'local' })) })
    }
    return json({ devices: DEVICES })
  })
  return bound
}

describe('FacilityDevicesSettings', () => {
  it('lists only the facilities bound off this machine, each with its device', async () => {
    backend({ eastmoney: 'linux:nas' })
    render(<FacilityDevicesSettings conn={conn} />)
    const select = (await screen.findByLabelText('eastmoney 在哪台设备上执行')) as HTMLSelectElement
    expect(select.value).toBe('linux:nas')
    expect(screen.queryByLabelText('bilibili 在哪台设备上执行')).toBeNull()
    // 离线的设备也能选，但标出来
    expect(screen.getAllByRole('option', { name: 'PC（离线）' }).length).toBeGreaterThan(0)
  })

  it('moving a facility to another device PUTs; moving it back to this machine DELETEs and drops the row', async () => {
    const bound = backend({ eastmoney: 'linux:nas' })
    render(<FacilityDevicesSettings conn={conn} />)
    const select = await screen.findByLabelText('eastmoney 在哪台设备上执行')
    fireEvent.change(select, { target: { value: 'linux:pc' } })
    await waitFor(() => expect(bound.eastmoney).toBe('linux:pc'))
    fireEvent.change(select, { target: { value: 'local' } })
    await waitFor(() => expect(bound.eastmoney).toBeUndefined())
    await waitFor(() => expect(screen.queryByLabelText('eastmoney 在哪台设备上执行')).toBeNull())
  })

  it('adds a facility through the picker', async () => {
    const bound = backend({})
    render(<FacilityDevicesSettings conn={conn} />)
    fireEvent.change(await screen.findByLabelText('账号'), { target: { value: 'xhs' } })
    fireEvent.change(screen.getByLabelText('设备'), { target: { value: 'linux:nas' } })
    fireEvent.click(screen.getByRole('button', { name: '指定' }))
    await waitFor(() => expect(bound.xhs).toBe('linux:nas'))
    expect(await screen.findByLabelText('xhs 在哪台设备上执行')).toBeTruthy()
  })

  it('a refusal shows the backend words and leaves the row where it was', async () => {
    backend({ eastmoney: 'linux:nas' }, () => json({ error: '没有这台设备：linux:pc' }, 400))
    render(<FacilityDevicesSettings conn={conn} />)
    const select = (await screen.findByLabelText('eastmoney 在哪台设备上执行')) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'linux:pc' } })
    expect(await screen.findByText('没有这台设备：linux:pc')).toBeTruthy()
    await waitFor(() => expect(select.value).toBe('linux:nas'))
  })
})
