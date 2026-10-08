import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { PluginConfigSheet, type PluginConfigTarget } from './PluginConfigSheet.tsx'

const fetchMock = vi.hoisted(() => vi.fn())

/** AList 配置面板 的后端依赖：内置实例的活探测（POST /api/settings/alist/test 空体）
 *  + 网盘挂载期望态（/api/netdisk/mounts）。AList 已统一内置托管 —— 没有 url+token 表单，也没有部署模式单选。 */
function routeFetch(url: string) {
  const u = String(url)
  if (u.includes('/api/settings/alist/test')) {
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
  }
  if (u.includes('/api/netdisk/mounts')) {
    return Promise.resolve({
      ok: true,
      json: async () => ({
        alistReachable: true,
        presets: [{ id: 'quark', label: '夸克网盘', driver: 'Quark', mountPath: '/夸克', cookieDomain: 'pan.quark.cn', status: 'cookieReady' }],
        mounts: [],
      }),
    })
  }
  // netdisk 绑定列表 + streams 列表都是数组端点——缺路由会让默认 {} 污染成非数组、子组件崩。
  if (u.includes('/api/netdisk/mappings') || u.includes('/api/streams')) {
    return Promise.resolve({ ok: true, json: async () => [] })
  }
  return Promise.resolve({ ok: true, json: async () => ({}) })
}

function plugin(id: string, overrides: Partial<PluginConfigTarget> = {}): PluginConfigTarget {
  return {
    id,
    name: id,
    status: 'ready',
    enabled: true,
    required: false,
    launch: { mode: 'external' },
    ...overrides,
  } as PluginConfigTarget
}

/** 网盘底座：判据只看 role，id 故意取一个不是 alist 的名字。 */
const netdiskBase = () => plugin('openlist', { name: 'OpenList', role: 'netdisk-base' })

const conn = { baseUrl: 'http://127.0.0.1:8900' }

describe('PluginConfigSheet', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation((url: string) => routeFetch(url))
    vi.stubGlobal('fetch', fetchMock)
  })

  it('hosts the netdisk mounts panel for the netdisk-base role, pointed at conn.baseUrl', async () => {
    render(<PluginConfigSheet open onOpenChange={vi.fn()} conn={conn} plugin={netdiskBase()} />)
    await waitFor(() => expect(screen.getByText('夸克网盘')).toBeTruthy())
    expect(screen.getByText('挂载网盘')).toBeTruthy()
    // apiBase 必须跟随 conn.baseUrl，桌面端连远程后端时不能打到同源。
    const mountsCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/netdisk/mounts'))
    expect(String(mountsCall![0])).toContain('http://127.0.0.1:8900/api/netdisk/mounts')
  })

  it('netdisk base is builtin-only: read-only instance status, no external form / deploy radio', async () => {
    render(<PluginConfigSheet open onOpenChange={vi.fn()} conn={conn} plugin={netdiskBase()} />)
    await waitFor(() => expect(screen.getByText('运行中')).toBeTruthy())
    expect(screen.getByText('内置实例')).toBeTruthy()
    // 探测不带任何字段：探的是现役那一份，没有「临时地址/凭据」这回事。
    const probe = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/settings/alist/test'))
    expect(JSON.parse(String((probe![1] as RequestInit).body))).toEqual({})
    // 外部接入入口彻底移除：无部署模式单选，无 URL/Token 可编辑表单，也不展示地址。
    expect(screen.queryByText('地址')).toBeNull()
    expect(screen.queryByLabelText('部署模式')).toBeNull()
    expect(screen.queryByText('接入已有实例')).toBeNull()
    expect(screen.queryByText('AList 地址')).toBeNull()
    expect(screen.queryByText('永久 Token')).toBeNull()
  })

  it('does not render the mounts panel for plugins without the netdisk-base role', async () => {
    render(<PluginConfigSheet open onOpenChange={vi.fn()} conn={conn} plugin={plugin('pansou')} />)
    await waitFor(() => expect(screen.getByText('此插件暂无可在此编辑的配置项。')).toBeTruthy())
    expect(screen.queryByText('挂载网盘')).toBeNull()
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/netdisk/mounts'))).toBe(false)
  })

  it('判据是 role 不是包 id：id 叫 alist 但没 role → 不出网盘块', async () => {
    render(<PluginConfigSheet open onOpenChange={vi.fn()} conn={conn} plugin={plugin('alist')} />)
    await waitFor(() => expect(screen.getByText('此插件暂无可在此编辑的配置项。')).toBeTruthy())
    expect(screen.queryByText('挂载网盘')).toBeNull()
  })
})
