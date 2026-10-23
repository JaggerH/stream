import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
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

const IDENTITIES = [
  { facility: 'xhs', nodeId: 'node_a', accountId: 'u_work', displayName: '工作号', state: 'signed-in', verifiedAt: 1, online: true },
  { facility: 'xhs', nodeId: 'node_b', accountId: 'u_old', displayName: '旧号', state: 'signed-out', verifiedAt: 1, online: true },
  { facility: 'bilibili', nodeId: 'node_a', accountId: '42', displayName: 'B 站号', state: 'signed-in', verifiedAt: 1, online: true },
]
const NODES = [
  { nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a', environment: '工作', isDefault: false, firstSeenAt: 0, lastSeenAt: 0, online: true },
  { nodeId: 'node_b', deviceId: 'local', bindingId: 'local:node_b', environment: '个人', isDefault: false, firstSeenAt: 0, lastSeenAt: 0, online: true },
]

type Target = { deviceId?: string; accountId?: string; environment?: string }

/** 绑定表放在闭包里：PUT / DELETE 真的改它，之后的 GET 读到改过的。 */
function backend(initial: Record<string, Target | string>, onPut?: (facility: string, body: Target) => unknown) {
  const bound: Record<string, Target> = Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, typeof v === 'string' ? { deviceId: v } : v]))
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url)
    const m = /\/api\/devices\/bindings\/([^/]+)$/.exec(u)
    if (m && init?.method === 'PUT') {
      const facility = decodeURIComponent(m[1])
      const body = JSON.parse(String(init.body)) as Target
      const refused = onPut?.(facility, body)
      if (refused) return refused
      bound[facility] = body
      return json({ facility, ...body })
    }
    if (m && init?.method === 'DELETE') {
      delete bound[decodeURIComponent(m[1])]
      return Promise.resolve({ ok: true, status: 204, json: async () => null })
    }
    if (u.endsWith('/api/devices/facilities')) {
      return json({ facilities: ['bilibili', 'eastmoney', 'xhs'].map((f) => ({ facility: f, packageId: `@streamapp/${f}`, ...(bound[f] ?? { deviceId: 'local' }) })) })
    }
    if (u.endsWith('/api/identities')) return json({ identities: IDENTITIES })
    if (u.endsWith('/api/devices/nodes')) return json({ nodes: NODES, claimable: [] })
    return json({ devices: DEVICES })
  })
  return bound
}

const options = (el: HTMLElement) => within(el).getAllByRole('option').map((o) => o.textContent)

describe('FacilityDevicesSettings', () => {
  it('lists only the facilities placed off this machine, each with where it runs', async () => {
    backend({ eastmoney: 'linux:nas' })
    render(<FacilityDevicesSettings conn={conn} />)
    const select = (await screen.findByLabelText('eastmoney 在哪里执行')) as HTMLSelectElement
    expect(select.value).toBe('d:linux:nas')
    expect(screen.queryByLabelText('bilibili 在哪里执行')).toBeNull()
    // 离线的设备也能选，但标出来
    expect(screen.getAllByRole('option', { name: 'PC（离线）' }).length).toBeGreaterThan(0)
  })

  it('moving a facility to another device PUTs; moving it back to this machine DELETEs and drops the row', async () => {
    const bound = backend({ eastmoney: 'linux:nas' })
    render(<FacilityDevicesSettings conn={conn} />)
    const select = await screen.findByLabelText('eastmoney 在哪里执行')
    fireEvent.change(select, { target: { value: 'd:linux:pc' } })
    await waitFor(() => expect(bound.eastmoney).toEqual({ deviceId: 'linux:pc' }))
    fireEvent.change(select, { target: { value: 'd:local' } })
    await waitFor(() => expect(bound.eastmoney).toBeUndefined())
    await waitFor(() => expect(screen.queryByLabelText('eastmoney 在哪里执行')).toBeNull())
  })

  it('adds a facility through the picker', async () => {
    const bound = backend({})
    render(<FacilityDevicesSettings conn={conn} />)
    fireEvent.change(await screen.findByLabelText('账号'), { target: { value: 'xhs' } })
    const where = screen.getByLabelText('在哪里执行')
    // 选「本机」= 什么都不改：不让按
    fireEvent.change(where, { target: { value: 'd:local' } })
    expect((screen.getByRole('button', { name: '指定' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(where, { target: { value: 'd:linux:nas' } })
    fireEvent.click(screen.getByRole('button', { name: '指定' }))
    await waitFor(() => expect(bound.xhs).toEqual({ deviceId: 'linux:nas' }))
    expect(await screen.findByLabelText('xhs 在哪里执行')).toBeTruthy()
  })

  it('a refusal shows the backend words and leaves the row where it was', async () => {
    backend({ eastmoney: 'linux:nas' }, () => json({ error: '没有这台设备：linux:pc' }, 400))
    render(<FacilityDevicesSettings conn={conn} />)
    const select = (await screen.findByLabelText('eastmoney 在哪里执行')) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'd:linux:pc' } })
    expect(await screen.findByText('没有这台设备：linux:pc')).toBeTruthy()
    await waitFor(() => expect(select.value).toBe('d:linux:nas'))
  })

  it('an identity target is shown as that identity, never as this machine; the identity group lists only this facility', async () => {
    backend({ xhs: { accountId: 'u_work' } })
    render(<FacilityDevicesSettings conn={conn} />)
    const select = (await screen.findByLabelText('xhs 在哪里执行')) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('i:u_work'))
    const opts = options(select)
    expect(opts).toContain('工作号')
    expect(opts).toContain('旧号（已登出）')
    // 别的账号体系的身份不进来
    expect(opts).not.toContain('B 站号')
    // 环境组是节点上标过的
    expect(opts).toContain('环境「工作」')
    expect(opts).toContain('环境「个人」')
  })

  it('picking an identity PUTs accountId; picking an environment PUTs environment', async () => {
    const bound = backend({ xhs: 'linux:nas' })
    render(<FacilityDevicesSettings conn={conn} />)
    const select = await screen.findByLabelText('xhs 在哪里执行')
    await waitFor(() => expect(options(select)).toContain('工作号'))
    fireEvent.change(select, { target: { value: 'i:u_work' } })
    await waitFor(() => expect(bound.xhs).toEqual({ accountId: 'u_work' }))
    fireEvent.change(select, { target: { value: 'e:个人' } })
    await waitFor(() => expect(bound.xhs).toEqual({ environment: '个人' }))
    await waitFor(() => expect((screen.getByLabelText('xhs 在哪里执行') as HTMLSelectElement).value).toBe('e:个人'))
  })

  it('without identities or environments those groups do not appear (old backend)', async () => {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.endsWith('/api/devices/facilities')) return json({ facilities: [{ facility: 'xhs', packageId: 'p', deviceId: 'linux:nas' }] })
      if (u.endsWith('/api/identities') || u.endsWith('/api/devices/nodes')) return json({ error: 'not found' }, 404)
      return json({ devices: DEVICES })
    })
    render(<FacilityDevicesSettings conn={conn} />)
    const select = await screen.findByLabelText('xhs 在哪里执行')
    await waitFor(() => expect(options(select)).toContain('NAS'))
    expect(select.querySelector('optgroup[label="身份"]')).toBeNull()
    expect(select.querySelector('optgroup[label="环境"]')).toBeNull()
  })
})
