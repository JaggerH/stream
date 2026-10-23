import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { IdentitiesSettings } from './IdentitiesSettings.tsx'
import { ago, groupIdentities } from './identities.ts'
import type { IdentityRow } from '../../lib/api.ts'

const conn = { baseUrl: 'http://127.0.0.1:8900' } as never
const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
const json = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body })

const NOW = Date.now()
const row = (over: Partial<IdentityRow>): IdentityRow => ({
  facility: 'xhs', nodeId: 'node_a', accountId: 'u1', displayName: '工作号', state: 'signed-in', verifiedAt: NOW - 120_000, online: true, profileName: 'Jagger', ...over,
})

describe('groupIdentities', () => {
  it('同一账号登在两个 profile 里是一个身份、两个节点；登出的另起一组', () => {
    const g = groupIdentities([
      row({}),
      row({ nodeId: 'node_b', profileName: '小号', online: false, verifiedAt: NOW - 60_000 }),
      row({ nodeId: 'node_c', accountId: 'u2', displayName: '个人号', state: 'signed-out', profileName: '旧' }),
      row({ facility: 'bilibili', accountId: undefined, displayName: undefined, state: 'signed-out', nodeId: 'node_a' }),
    ], [{ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a', label: '主力', isDefault: false, firstSeenAt: 0, lastSeenAt: 0, online: true }])
    expect(g.map((x) => [x.facility, x.name, x.signedIn, x.nodes.map((n) => n.name)])).toEqual([
      ['bilibili', '（已登出）', false, ['主力']],
      ['xhs', '个人号', false, ['旧']],
      ['xhs', '工作号', true, ['主力', '小号']],
    ])
    expect(g[2].verifiedAt).toBe(NOW - 60_000)
  })

  it('ago', () => {
    expect(ago(NOW - 5_000, NOW)).toBe('刚刚')
    expect(ago(NOW - 180_000, NOW)).toBe('3 分钟前')
    expect(ago(NOW - 2 * 3600_000, NOW)).toBe('2 小时前')
  })
})

describe('IdentitiesSettings', () => {
  it('列出账号、所在 profile、上次核对与已登出；刷新 → POST 并换上新表', async () => {
    let refreshed = false
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/api/identities/refresh') && init?.method === 'POST') {
        refreshed = true
        return json({ results: [{ facility: 'xhs', nodeId: 'node_a', result: { state: 'signed-in', accountId: 'u3', name: '新号' } }],
          identities: [row({ accountId: 'u3', displayName: '新号', verifiedAt: NOW })] })
      }
      if (u.endsWith('/api/identities')) return json({ identities: [row({}), row({ nodeId: 'node_c', accountId: 'u2', displayName: '个人号', state: 'signed-out', profileName: '旧' })] })
      if (u.endsWith('/api/devices/nodes')) return json({ nodes: [], claimable: [] })
      return json({})
    })
    render(<IdentitiesSettings conn={conn} />)
    expect(await screen.findByText('工作号')).toBeTruthy()
    expect(screen.getByText('Jagger')).toBeTruthy()
    expect(screen.getAllByText('2 分钟前')).toHaveLength(2)
    expect(screen.getByText('已登出')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByText('新号')).toBeTruthy()
    expect(refreshed).toBe(true)
    await waitFor(() => expect(screen.queryByText('工作号')).toBeNull())
  })

  it('身份表不可用（503）：只说原因，不画刷新键', async () => {
    fetchMock.mockImplementation((url: string) => (String(url).includes('/api/identities')
      ? json({ error: '身份表不可用（stream.db 打不开）' }, 503)
      : json({ nodes: [], claimable: [] })))
    render(<IdentitiesSettings conn={conn} />)
    expect(await screen.findByText('身份表不可用（stream.db 打不开）')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull()
  })
})
