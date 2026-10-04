import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { keepDevReloadAlive } from './dev-reload.ts'

// 这条通道的全部价值就在「断了会自己回来」——WXT 自带那条断了就不再连，而我们的 SW 永不回收，
// 等不到重启自愈（见 dev-reload.ts 头注）。所以测的就是重连和那条 reload 消息。

type Listener = (e: { data?: unknown }) => void

function fakeSocket() {
  const listeners = new Map<string, Listener[]>()
  return {
    ws: {
      addEventListener: (type: string, fn: Listener) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn])
      },
      close: vi.fn(),
    } as unknown as WebSocket,
    emit: (type: string, e: { data?: unknown } = {}) => listeners.get(type)?.forEach((fn) => fn(e)),
  }
}

describe('keepDevReloadAlive', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('收到 wxt:reload-extension 就 runtime.reload()', () => {
    const reload = vi.fn()
    vi.stubGlobal('chrome', { runtime: { reload } })
    const s = fakeSocket()
    keepDevReloadAlive(() => s.ws)
    s.emit('message', { data: JSON.stringify({ type: 'custom', event: 'wxt:reload-extension' }) })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('别的消息不重载（HMR 通道上什么都可能来）', () => {
    const reload = vi.fn()
    vi.stubGlobal('chrome', { runtime: { reload } })
    const s = fakeSocket()
    keepDevReloadAlive(() => s.ws)
    s.emit('message', { data: JSON.stringify({ type: 'update', updates: [] }) })
    s.emit('message', { data: 'not json' })
    expect(reload).not.toHaveBeenCalled()
  })

  it('socket 关掉后会重连——dev server 重启一次就再也收不到消息才是原来的 bug', () => {
    vi.stubGlobal('chrome', { runtime: { reload: vi.fn() } })
    const sockets = [fakeSocket(), fakeSocket()]
    let n = 0
    keepDevReloadAlive(() => sockets[Math.min(n++, sockets.length - 1)].ws)
    expect(n).toBe(1)
    sockets[0].emit('close')
    vi.advanceTimersByTime(2_000)
    expect(n).toBe(2) // 又连了一条
  })

  it('连都连不上（dev server 没起）也照样退避重试，不把 SW 弄挂', () => {
    vi.stubGlobal('chrome', { runtime: { reload: vi.fn() } })
    let attempts = 0
    keepDevReloadAlive(() => {
      attempts++
      throw new Error('ECONNREFUSED')
    })
    expect(attempts).toBe(1)
    vi.advanceTimersByTime(2_000)
    expect(attempts).toBe(2)
  })
})
