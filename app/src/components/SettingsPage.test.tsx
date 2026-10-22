import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SettingsPage } from './SettingsPage.tsx'

const conn = { baseUrl: 'http://127.0.0.1:8900' } as never
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((url: string) => {
    if (String(url).endsWith('/api/settings/archive')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ root: '/data/audio', exists: true, writable: true, tracks: 3 }) })
    }
    // 采集浏览器 / 远程访问各自有测试，这里让它们停在加载中。
    return new Promise(() => {})
  })
  vi.stubGlobal('fetch', fetchMock)
})

describe('SettingsPage', () => {
  it('shows the audio archive path and status', async () => {
    render(<SettingsPage conn={conn} />)
    expect(await screen.findByText('/data/audio')).toBeTruthy()
    expect(screen.getByText('可写 · 3 首入库')).toBeTruthy()
  })

  it('does not offer switches that do nothing (debug panel, diagnostics, backend URL)', () => {
    render(<SettingsPage conn={conn} />)
    expect(screen.queryByText('Debug 面板')).toBeNull()
    expect(screen.queryByText('诊断记录')).toBeNull()
    expect(screen.queryByText('Backend URL')).toBeNull()
  })
})
