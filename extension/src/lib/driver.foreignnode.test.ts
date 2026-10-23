import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { VERIFY_PREFIX } from './backend-identity.ts'

// 配对绑定只属于一个节点（browser-identity D1）：实例以 4004 关掉连接 = token 被拷到了别的 profile。
// 扩展要停下重连、把绑定标成 foreignNode，popup 据此说「这条绑定属于另一个 profile」。

const TOKEN = 'paired-token'
const PAIRED = {
  id: 'ext:a', kind: 'paired', baseUrl: 'https://main.example', token: TOKEN, label: 'NAS',
  domains: [], requiredDomains: [], approvedDomains: [], autoSync: true,
}

function makeChrome() {
  const local: Record<string, unknown> = { config: { baseUrl: '', domains: [], autoSync: true }, bindings: [PAIRED] }
  return {
    storage: {
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      local: {
        get: vi.fn(async (key: string) => ({ [key]: local[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(local, obj) }),
      },
    },
    tabs: { query: vi.fn(async () => []), onUpdated: { addListener: vi.fn() } },
    tabGroups: { onUpdated: { addListener: vi.fn() }, query: vi.fn(async () => []) },
    debugger: { onEvent: { addListener: vi.fn() }, detach: vi.fn(async () => {}) },
    windows: { create: vi.fn(), getAll: vi.fn(async () => [{ id: 1 }]) },
    runtime: { lastError: undefined },
    _local: local,
  }
}

/** 配对实例的挑战应答：key 是 token 的哈希（实例只存哈希）。 */
function honestPairedBackend() {
  const key = createHash('sha256').update(TOKEN).digest('hex')
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith('/api/ext/verify')) return { ok: false, status: 404, json: async () => ({}) }
    const { nonce } = JSON.parse(String(init?.body)) as { nonce: string }
    return { ok: true, status: 200, json: async () => ({ proof: createHmac('sha256', key).update(`${VERIFY_PREFIX}${nonce}`).digest('hex') }) }
  })
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('配对绑定被实例以 4004 拒绝', () => {
  it('标 foreignNode、不再重连；握手带着这个 profile 的 nodeId', async () => {
    const chrome = makeChrome()
    vi.stubGlobal('chrome', chrome)
    vi.stubGlobal('fetch', honestPairedBackend())
    const built: Array<{ url: string; fire: (code: number) => void }> = []
    class FakeSocket {
      private onClose: ((ev: { code: number }) => void) | null = null
      constructor(public url: string) {
        built.push({ url, fire: (code) => this.onClose?.({ code }) })
      }
      addEventListener(type: string, fn: (ev: { code: number }) => void) { if (type === 'close') this.onClose = fn }
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket)
    vi.resetModules()
    const mod = await import('./driver.ts')
    await mod.startBinding('ext:a')
    await flush()
    expect(built).toHaveLength(1)
    expect(new URL(built[0]!.url).searchParams.get('nodeId')).toMatch(/^node_/)

    vi.useFakeTimers()
    built[0]!.fire(mod.FOREIGN_NODE_CLOSE_CODE)
    await vi.advanceTimersByTimeAsync(60_000)
    vi.useRealTimers()
    await flush()
    expect(built).toHaveLength(1) // 没有重连
    expect((chrome._local.bindings as Array<{ foreignNode?: boolean }>)[0]?.foreignNode).toBe(true)
  })
})
