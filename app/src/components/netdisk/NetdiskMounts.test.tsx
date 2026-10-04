import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NetdiskMounts } from './NetdiskMounts.tsx'
import type { NetdiskMountPreset, NetdiskReconcileResult } from '../../lib/types.ts'

const fetchMock = vi.hoisted(() => vi.fn())

const preset = (over: Partial<NetdiskMountPreset> & Pick<NetdiskMountPreset, 'id' | 'status'>): NetdiskMountPreset => ({
  label: over.id, driver: 'D', cookieDomain: `${over.id}.com`, mountPath: `/${over.id}`, hasCookie: over.status !== 'noCookie', ...over,
})

let presets: NetdiskMountPreset[] = []
let alistReachable = true
const reconcile: NetdiskReconcileResult = { ok: [], created: [], healed: [], missingCookie: [] }

/** GET 挂载视图（presets + 健康）；POST reconcile 返回分桶结果。 */
function routeFetch(url: string, init?: RequestInit) {
  const u = String(url)
  if (u.includes('/api/netdisk/mounts/reconcile')) return Promise.resolve({ ok: true, json: async () => reconcile })
  if (u.includes('/api/netdisk/mounts') && (!init?.method || init.method === 'GET'))
    return Promise.resolve({ ok: true, json: async () => ({ presets, mounts: [], alistReachable }) })
  return Promise.resolve({ ok: true, json: async () => ({}) })
}

describe('NetdiskMounts', () => {
  beforeEach(() => {
    presets = []
    alistReachable = true
    fetchMock.mockReset()
    fetchMock.mockImplementation((url: string, init?: RequestInit) => routeFetch(url, init))
    vi.stubGlobal('fetch', fetchMock)
  })

  it('renders a mounted netdisk with its Health badge and mount path', async () => {
    presets = [preset({ id: 'quark', label: '夸克网盘', mountPath: '/夸克', status: 'mounted' })]
    render(<NetdiskMounts />)
    await waitFor(() => expect(screen.getByText('夸克网盘')).toBeTruthy())
    expect(screen.getByText('已挂载')).toBeTruthy()
    expect(screen.getByText('/夸克')).toBeTruthy()
  })

  it('shows the extension-sync empty state when no netdisk has a cookie', async () => {
    presets = [preset({ id: '115', label: '115 网盘', status: 'noCookie' }), preset({ id: 'quark', label: '夸克网盘', status: 'noCookie' })]
    render(<NetdiskMounts />)
    await waitFor(() => expect(screen.getByText('还没有可挂载的网盘')).toBeTruthy())
    expect(screen.getByText(/用浏览器扩展同步/)).toBeTruthy()
    expect(screen.getByText('115 网盘 · 夸克网盘')).toBeTruthy()
    // 全 noCookie：不自动 reconcile
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).includes('/reconcile') && (i as RequestInit)?.method === 'POST')).toBe(false)
  })

  it('auto-mounts on load when a preset has a cookie but is not yet mounted', async () => {
    presets = [preset({ id: 'quark', label: '夸克网盘', status: 'cookieReady' })]
    render(<NetdiskMounts />)
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, i]) => String(u).includes('/reconcile') && (i as RequestInit)?.method === 'POST')).toBe(true),
    )
  })

  it('surfaces an error heal hint for a failed mount', async () => {
    presets = [preset({ id: 'quark', label: '夸克网盘', status: 'error' })]
    render(<NetdiskMounts />)
    await waitFor(() => expect(screen.getByText('挂载失效')).toBeTruthy())
    expect(screen.getByText(/cookie 可能已失效/)).toBeTruthy()
  })

  it('warns when AList is unreachable', async () => {
    alistReachable = false
    presets = [preset({ id: 'quark', label: '夸克网盘', status: 'noCookie' })]
    render(<NetdiskMounts />)
    await waitFor(() => expect(screen.getByText(/AList 服务不可达/)).toBeTruthy())
  })

  it('shows an error message when the mounts endpoint fails', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('挂载配置不可用')))
    render(<NetdiskMounts />)
    await waitFor(() => expect(screen.getByText('挂载配置不可用')).toBeTruthy())
  })
})
