import { afterEach, describe, expect, it, vi } from 'vitest'
import { profileLine, readProfileLine } from './profile-line.ts'

afterEach(() => vi.unstubAllGlobals())

describe('profileLine', () => {
  it('环境 · profile 名', () => {
    expect(profileLine({ nodeId: 'node_a', profileDir: 'Profile 1', profileName: 'Profile 1' }, { environment: '工作' }))
      .toEqual({ title: '工作 · Profile 1', claimed: true })
  })

  it('没标环境只说 profile 名；后端那边的名字（用户起的、最新认领的）优先', () => {
    expect(profileLine({ nodeId: 'node_a', profileDir: 'Default', profileName: 'Jagger' }, undefined)).toEqual({ title: 'Jagger', claimed: true })
    expect(profileLine({ nodeId: 'node_a', profileDir: 'Default', profileName: 'Jagger' }, { label: '主力', profileName: 'Jagger' })).toEqual({ title: '主力', claimed: true })
  })

  it('没认领过：未识别的 profile + 一行怎么识别', () => {
    const l = profileLine({ nodeId: 'node_a' }, { environment: '工作' })
    expect(l.title).toBe('未识别的 profile')
    expect(l.claimed).toBe(false)
    expect(l.hint).toContain('识别 profile')
  })

  it('扩展这边忘了（存储被清过）但后端认领过：照后端的说', () => {
    expect(profileLine({ nodeId: 'node_a' }, { profileName: 'Jagger', profileDir: 'Default' })).toEqual({ title: 'Jagger', claimed: true })
  })
})

describe('readProfileLine', () => {
  const stub = (node: unknown, nodes: unknown, ok = true) => {
    vi.stubGlobal('chrome', { storage: { local: { get: async (k: string) => (node && k === 'node' ? { node } : {}) } } })
    const fetchMock = vi.fn(async () => ({ ok, json: async () => ({ nodes }) }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('读自己的存储，再问后端自己那一行的环境', async () => {
    const f = stub({ nodeId: 'node_a', profileDir: 'Default', profileName: 'Jagger' }, [
      { nodeId: 'node_b', environment: '个人' },
      { nodeId: 'node_a', environment: '工作', profileName: 'Jagger', profileDir: 'Default' },
    ])
    expect(await readProfileLine('http://127.0.0.1:8900/')).toEqual({ title: '工作 · Jagger', claimed: true })
    expect(f).toHaveBeenCalledWith('http://127.0.0.1:8900/api/devices/nodes')
  })

  it('后端问不着：只用存储里的', async () => {
    stub({ nodeId: 'node_a', profileDir: 'Default', profileName: 'Jagger' }, null, false)
    expect(await readProfileLine('http://127.0.0.1:8900')).toEqual({ title: 'Jagger', claimed: true })
  })

  it('还没有 nodeId（SW 没跑过）：不画', async () => {
    stub(undefined, [])
    expect(await readProfileLine('http://127.0.0.1:8900')).toBeNull()
  })
})
