import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { DevicesSettings } from './DevicesSettings.tsx'
import { CLAIM_POLL_MS } from './devices/ProfileClaim.tsx'

const conn = { baseUrl: 'http://127.0.0.1:8900' } as never
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

const json = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body })

const NAS = { deviceId: 'linux:nas', name: 'NAS', platform: 'linux', paired: true, online: true }
const DESKTOP = { deviceId: 'desktop:pc', name: 'PC', platform: 'windows', paired: false, online: true }

const node = (over: Record<string, unknown>) => ({
  nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a', isDefault: false, firstSeenAt: 1, lastSeenAt: 2, online: true, ...over,
})

interface World {
  nodes: Array<Record<string, unknown>>
  claimable: string[]
  bindings?: unknown[]
  patches: Array<{ nodeId: string; body: unknown }>
  extra?: (url: string, init?: RequestInit) => unknown
}

function backend(w: World) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url)
    const hit = w.extra?.(u, init)
    if (hit !== undefined) return hit
    const m = /\/api\/devices\/nodes\/([^/]+)$/.exec(u)
    if (m && init?.method === 'PATCH') {
      const nodeId = decodeURIComponent(m[1])
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      w.patches.push({ nodeId, body })
      w.nodes = w.nodes.map((n) => (n.nodeId === nodeId ? { ...n, ...body } : n))
      return json(w.nodes.find((n) => n.nodeId === nodeId))
    }
    if (init?.method === 'PUT' || init?.method === 'DELETE') return Promise.resolve({ ok: true, status: 204, json: async () => null })
    if (u.endsWith('/api/devices/nodes')) return json({ nodes: w.nodes, claimable: w.claimable })
    if (u.endsWith('/api/ext/bindings')) return json({ bindings: w.bindings ?? [] })
    return json({ devices: [NAS, DESKTOP] })
  })
  return w
}

describe('DevicesSettings — browser nodes', () => {
  it('本机卡列出本机的 profile：名字 → profile 名 → 未识别；Stream Desktop 并进本机卡', async () => {
    backend({
      nodes: [
        node({ profileDir: 'Default', profileName: 'Jagger', label: '主力', environment: '工作' }),
        node({ nodeId: 'node_b', bindingId: 'local:node_b', profileDir: 'Profile 1', profileName: '小号', online: false }),
        node({ nodeId: 'node_c', bindingId: 'local:node_c' }),
      ],
      claimable: [], patches: [],
    })
    render(<DevicesSettings conn={conn} />)
    expect(await screen.findByText('本机')).toBeTruthy()
    expect(screen.getByText('主力')).toBeTruthy()
    expect(screen.getByText('小号')).toBeTruthy()
    expect(screen.getByText('未识别的 profile')).toBeTruthy()
    expect(screen.getByText('（Profile 1）')).toBeTruthy()
    expect((screen.getByLabelText('主力 的环境') as HTMLSelectElement).value).toBe('工作')
    // Stream Desktop 不再单列一张没有动作的卡
    expect(screen.getByText('Stream Desktop · PC')).toBeTruthy()
    expect(screen.queryByText('PC')).toBeNull()
    // 不能识别时不画键，只说缺什么
    expect(screen.queryByRole('button', { name: '本机 识别 profile' })).toBeNull()
    expect(screen.getByText(/需要这台机器上的 Stream Desktop 在线/)).toBeTruthy()
  })

  it('环境：选预置 → PATCH；选「未标」→ null；自定义 → 输入回车 → PATCH，之后进别的节点的下拉', async () => {
    const w = backend({ nodes: [node({ profileName: 'Jagger' }), node({ nodeId: 'node_b', bindingId: 'local:node_b', profileName: '小号' })], claimable: [], patches: [] })
    render(<DevicesSettings conn={conn} />)
    fireEvent.change(await screen.findByLabelText('Jagger 的环境'), { target: { value: '工作' } })
    await waitFor(() => expect(w.patches).toEqual([{ nodeId: 'node_a', body: { environment: '工作' } }]))
    await waitFor(() => expect((screen.getByLabelText('Jagger 的环境') as HTMLSelectElement).value).toBe('工作'))
    fireEvent.change(screen.getByLabelText('Jagger 的环境'), { target: { value: '' } })
    await waitFor(() => expect(w.patches[1]).toEqual({ nodeId: 'node_a', body: { environment: null } }))

    fireEvent.change(screen.getByLabelText('小号 的环境'), { target: { value: '__custom' } })
    const input = screen.getByLabelText('小号 的环境') as HTMLInputElement
    expect(input.tagName).toBe('INPUT')
    fireEvent.change(input, { target: { value: '客户 A' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(w.patches[2]).toEqual({ nodeId: 'node_b', body: { environment: '客户 A' } }))
    // 在用的环境进下拉，另一个节点也能直接选
    await waitFor(() => expect(within(screen.getByLabelText('Jagger 的环境')).getByRole('option', { name: '客户 A' })).toBeTruthy())
  })

  it('改名：回车 PATCH label；清空 = null（回到 profile 名）', async () => {
    const w = backend({ nodes: [node({ profileName: 'Jagger' })], claimable: [], patches: [] })
    render(<DevicesSettings conn={conn} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Jagger 改名' }))
    const input = screen.getByLabelText('Jagger 的名字')
    fireEvent.change(input, { target: { value: '主力' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(w.patches).toEqual([{ nodeId: 'node_a', body: { label: '主力' } }]))
    fireEvent.click(await screen.findByRole('button', { name: '主力 改名' }))
    const again = screen.getByLabelText('主力 的名字')
    fireEvent.change(again, { target: { value: '' } })
    fireEvent.keyDown(again, { key: 'Enter' })
    await waitFor(() => expect(w.patches[1]).toEqual({ nodeId: 'node_a', body: { label: null } }))
  })

  it('本机节点设为默认走它的绑定 id（local:<nodeId>）', async () => {
    backend({ nodes: [node({ profileName: 'Jagger' })], claimable: [], patches: [] })
    render(<DevicesSettings conn={conn} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Jagger 设为默认' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8900/api/ext/bindings/local%3Anode_a/default', expect.objectContaining({ method: 'PUT' })))
  })

  it('配对设备的浏览器行并上节点：显示 profile 名与环境，仍可撤销', async () => {
    backend({
      nodes: [node({ nodeId: 'node_n', deviceId: 'linux:nas', bindingId: 'ext:a', profileName: 'NAS 上的 Chrome', environment: '个人' })],
      bindings: [{ bindingId: 'ext:a', deviceId: 'linux:nas', name: 'Chrome', pairedAt: 1, online: true, default: false }],
      claimable: [], patches: [],
    })
    render(<DevicesSettings conn={conn} />)
    expect(await screen.findByText('NAS 上的 Chrome')).toBeTruthy()
    expect((screen.getByLabelText('NAS 上的 Chrome 的环境') as HTMLSelectElement).value).toBe('个人')
    fireEvent.click(screen.getByRole('button', { name: '撤销浏览器 NAS 上的 Chrome' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8900/api/ext/bindings/ext%3Aa', expect.objectContaining({ method: 'DELETE' })))
  })

  it('识别 profile：先列出 profile 让人挑（预选装了扩展且没认领的），只为挑中的开认领页 → 轮询到结束，重读节点', async () => {
    let polls = 0
    const posted: unknown[] = []
    const w = backend({
      nodes: [node({})], claimable: ['local'], patches: [],
      extra: (u, init) => {
        if (u.endsWith('/api/devices/local/profiles') && !init?.method) {
          return json({ deviceId: 'desktop:pc', userDataDir: 'C:\\U', profiles: [
            { dir: 'Default', name: 'Jagger', active: true, hasExtension: true },
            { dir: 'Profile 1', name: '小号', active: false, hasExtension: true },
            { dir: 'Profile 2', name: '老号', active: false, hasExtension: true, nodeId: 'node_old' },
            { dir: 'Profile 3', name: '空的', active: false, hasExtension: false },
            { dir: 'Profile 4', name: '说不清', active: false },
          ] })
        }
        if (u.endsWith('/api/devices/local/profiles/claim') && init?.method === 'POST') {
          posted.push(JSON.parse(String(init.body)))
          return json({ claimId: 'c1', deviceId: 'local', startedAt: 1, expiresAt: 2, done: false, profiles: [
            { dir: 'Default', name: 'Jagger', state: 'pending' },
            { dir: 'Profile 4', name: '说不清', state: 'pending' },
          ] })
        }
        if (u.endsWith('/api/devices/local/profiles/claim/c1')) {
          polls++
          return json({ claimId: 'c1', deviceId: 'local', startedAt: 1, expiresAt: 2, done: true, profiles: [
            { dir: 'Default', name: 'Jagger', state: 'claimed', nodeId: 'node_a' },
            { dir: 'Profile 4', name: '说不清', state: 'missing', reason: '扩展未安装或未连上' },
          ] })
        }
        return undefined
      },
    })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      render(<DevicesSettings conn={conn} />)
      // 配对设备 NAS 不在 claimable 里：不画
      await screen.findByText('NAS')
      expect(screen.queryByRole('button', { name: 'NAS 识别 profile' })).toBeNull()
      fireEvent.click(await screen.findByRole('button', { name: '本机 识别 profile' }))
      const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement
      await screen.findByRole('checkbox', { name: 'Jagger（Default）' })
      // 只列不开窗
      expect(posted).toEqual([])
      expect(box('Jagger（Default）').checked).toBe(true)
      expect(box('小号（Profile 1）').checked).toBe(true)
      expect(box('老号（Profile 2）').checked).toBe(false)
      expect(box('空的（Profile 3）').checked).toBe(false)
      expect(box('说不清（Profile 4）').checked).toBe(true)
      expect(screen.getByText('已识别过')).toBeTruthy()
      expect(screen.getByText(/没装 Stream 扩展——先在这个 profile 里装上/)).toBeTruthy()
      fireEvent.click(box('小号（Profile 1）'))
      fireEvent.click(screen.getByRole('button', { name: '为 2 个 profile 打开认领页' }))
      expect(await screen.findAllByText('等待中…')).toHaveLength(2)
      expect(posted).toEqual([{ dirs: ['Default', 'Profile 4'] }])
      const nodeReads = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/devices/nodes')).length
      const before = nodeReads()
      w.nodes = [node({ profileDir: 'Default', profileName: 'Jagger' })]
      await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS)
      expect(await screen.findByText('已识别')).toBeTruthy()
      expect(screen.getByText('扩展未安装或未连上')).toBeTruthy()
      await waitFor(() => expect(nodeReads()).toBeGreaterThan(before))
      // 结束了就不再问
      await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS * 3)
      expect(polls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('识别 profile：一个都没挑时不能开；取消回到按钮', async () => {
    backend({
      nodes: [], claimable: ['local'], patches: [],
      extra: (u, init) => (u.endsWith('/api/devices/local/profiles') && !init?.method
        ? json({ deviceId: 'desktop:pc', userDataDir: 'C:\\U', profiles: [{ dir: 'Default', name: 'Jagger', active: true, hasExtension: false }] })
        : undefined),
    })
    render(<DevicesSettings conn={conn} />)
    fireEvent.click(await screen.findByRole('button', { name: '本机 识别 profile' }))
    await screen.findByRole('checkbox', { name: 'Jagger（Default）' })
    expect((screen.getByRole('button', { name: '为 0 个 profile 打开认领页' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByRole('button', { name: '本机 识别 profile' })).toBeTruthy()
  })

  it('识别被后端拒（远处打开面板）：原话显示', async () => {
    backend({
      nodes: [], claimable: ['local'], patches: [],
      extra: (u) => (u.endsWith('/api/devices/local/profiles')
        ? json({ error: '只能在运行 Stream 的那台机器上识别 profile' }, 403) : undefined),
    })
    render(<DevicesSettings conn={conn} />)
    fireEvent.click(await screen.findByRole('button', { name: '本机 识别 profile' }))
    expect(await screen.findByText('只能在运行 Stream 的那台机器上识别 profile')).toBeTruthy()
  })

  it('Stream 在后台打开着的 profile：有 wokenAt 才出这一节，带说明', async () => {
    backend({ nodes: [node({ profileName: 'Jagger' }), node({ nodeId: 'node_b', bindingId: 'local:node_b', profileName: '小号', wokenAt: Date.now() })], claimable: [], patches: [] })
    render(<DevicesSettings conn={conn} />)
    const h = await screen.findByText('Stream 在后台打开着的 profile')
    const section = h.closest('section')!
    expect(within(section).getByText('小号')).toBeTruthy()
    expect(within(section).queryByText('Jagger')).toBeNull()
    expect(within(section).getByText(/Chrome 完全退出时卸载/)).toBeTruthy()
  })

  it('节点行说出这个 profile 没给 Stream 的登录态域，并指去扩展弹窗里点「允许」', async () => {
    backend({
      nodes: [
        node({ profileName: 'Jagger' }),
        node({ nodeId: 'node_b', bindingId: 'local:node_b', profileName: '小号', cookieGaps: { refused: ['bilibili.com'], noAccess: ['xiaohongshu.com'], at: 1 } }),
      ],
      claimable: [], patches: [],
    })
    render(<DevicesSettings conn={conn} />)
    const gap = await screen.findByText(/读不到 bilibili\.com、xiaohongshu\.com 的登录态/)
    expect(gap.textContent).toMatch(/在这个 profile 里打开 Stream 扩展的弹窗，点「允许」/)
    expect(screen.getAllByText(/读不到/)).toHaveLength(1)
  })

  it('没有唤起着的 profile：这一节不出现', async () => {
    backend({ nodes: [node({ profileName: 'Jagger' })], claimable: [], patches: [] })
    render(<DevicesSettings conn={conn} />)
    await screen.findByText('Jagger')
    expect(screen.queryByText('Stream 在后台打开着的 profile')).toBeNull()
  })
})
