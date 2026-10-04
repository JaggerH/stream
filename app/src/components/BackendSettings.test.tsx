import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BackendSettings } from './BackendSettings.tsx'
import * as backend from '../lib/backend.tsx'

const fetchMock = vi.hoisted(() => vi.fn())

/** Settings dialog 里各个 section 的后端依赖：归档状态。
 *  （网盘挂载面板已搬去 PluginConfigDialog —— 它是 AList 插件的配置，不是全局后端设置。） */
function routeFetch(url: string) {
  const u = String(url)
  if (u.includes('/api/settings/archive')) {
    return Promise.resolve({ ok: true, json: async () => ({ root: '/data/audio', exists: true, writable: true, tracks: 3 }) })
  }
  return Promise.resolve({ ok: true, json: async () => ({}) })
}

function stubBackend(overrides: Partial<ReturnType<typeof backend.useBackend>> = {}) {
  vi.spyOn(backend, 'useBackend').mockReturnValue({
    status: 'connected',
    upstream: 'http://127.0.0.1:8900',
    reloadToken: 1,
    reconnect: vi.fn(),
    reportFailure: vi.fn(),
    ...overrides,
  })
}

describe('BackendSettings', () => {
  beforeEach(() => {
    window.localStorage.clear()
    fetchMock.mockReset()
    fetchMock.mockImplementation((url: string) => routeFetch(url))
    vi.stubGlobal('fetch', fetchMock)
  })

  it('persists backend_url and triggers reconnect on save', () => {
    const reconnect = vi.fn()
    stubBackend({ reconnect })
    render(<BackendSettings open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox', { name: /backend url/i }), {
      target: { value: 'http://remote:4555' },
    })
    fireEvent.click(screen.getByRole('button', { name: /save|保存/i }))
    expect(window.localStorage.getItem('stream.backend_url')).toBe('http://remote:4555')
    expect(reconnect).toHaveBeenCalled()
  })

  it('empty value clears the override', () => {
    window.localStorage.setItem('stream.backend_url', 'http://old:1')
    stubBackend({ upstream: '', reloadToken: 0 })
    render(<BackendSettings open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox', { name: /backend url/i }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /save|保存/i }))
    expect(window.localStorage.getItem('stream.backend_url')).toBeNull()
  })

  it('does NOT host the netdisk mounts panel (it lives in the AList plugin config)', () => {
    stubBackend()
    render(<BackendSettings open onClose={vi.fn()} />)
    expect(screen.queryByText('挂载网盘')).toBeNull()
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/netdisk/mounts'))).toBe(false)
  })
})
